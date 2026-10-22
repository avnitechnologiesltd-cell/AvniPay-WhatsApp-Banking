import { Inject, Injectable, Logger } from "@nestjs/common";

import type { PlatformConfig } from "@avni/config";
import {
  MENU_BUTTONS,
  MENU_CHOICES,
  MENU_PROMPT,
  formatNaira,
  type BankingIntent,
  type IntentOutcome,
} from "@avni/intent";
import type { Chose, Inbound, Outbound, Said } from "@avni/platform-channels";
import { WhatsAppSender } from "@avni/platform-channels";
import { IntentResolver } from "@avni/platform-orchestration";
import { citationsInWords, type SupportAgent } from "@avni/platform-support";

import { AttachmentCourier } from "./attachments";
import {
  MiddlewareClient,
  type HandoffRaised,
  type OpenedInAppConversation,
  type PlatformHandoffTrigger,
  type WaitingMessage,
} from "./middleware.client";
import { describeTransactions } from "./transactions";
import { INTENT_RESOLVER, PLATFORM_CONFIG, SUPPORT_AGENT, WHATSAPP_SENDER } from "./tokens";

/**
 * The composer: the one place channels, orchestration and the Middleware meet.
 *
 * It lives in the application rather than in any of the three module packages,
 * because none of them may import a sibling ([ADR-0003](../../../docs/adr/0003-one-repo-three-deployables.md)).
 * That constraint is what keeps this file the only thing that would have to
 * change if one of them were ever split out.
 *
 * The routing here is the `said`/`chose`/`event` split made operational:
 * only `said` reaches a model, `chose` is handled by code, and `event` is
 * recorded and answered with nothing at all.
 */
@Injectable()
export class ConversationService {
  private readonly logger = new Logger(ConversationService.name);

  /**
   * Conversation ids, **in memory and never persisted**. A copy of identity
   * inside the injection surface is precisely what ADR-0006 exists to prevent,
   * and this holds the Middleware's opaque id rather than a Binding in any case.
   */
  private readonly conversations = new Map<string, string>();

  public constructor(
    @Inject(PLATFORM_CONFIG) private readonly config: PlatformConfig,
    @Inject(MiddlewareClient) private readonly middleware: MiddlewareClient,
    @Inject(INTENT_RESOLVER) private readonly resolver: IntentResolver,
    @Inject(SUPPORT_AGENT) private readonly agent: SupportAgent,
    @Inject(WHATSAPP_SENDER) private readonly whatsapp: WhatsAppSender,
    @Inject(AttachmentCourier) private readonly attachments: AttachmentCourier,
  ) {}

  /** WhatsApp: resolve the conversation, answer, and send the reply out. */
  public async receive(inbound: Inbound): Promise<void> {
    if (inbound.kind === "event") {
      // Not a message. Never acted on, never shown to a model — and **it opens
      // no conversation**, which is the one rule that decides where it is
      // recorded. A delivery receipt for a number that never wrote to us must
      // not conjure a conversation row for them.
      //
      // So it joins a conversation that already exists and is otherwise only
      // logged. That is not a rounding-down: the history an Officer reads is
      // `said`/`chose`/`event`, and *the Flow the Customer completed* and *the
      // message they never received* are exactly the kind of thing the Officer
      // is about to be asked about.
      this.logger.log({
        event: "inbound_event",
        kind: inbound.event,
        externalId: inbound.externalId,
      });

      const known = this.conversations.get(inbound.channelIdentity);
      if (known) {
        await this.middleware.recordInbound(known, {
          kind: "event",
          body: inbound.event,
        });
      }
      return;
    }

    // Read receipt and typing dots, together, before anything slow happens —
    // a model call, a BankOne round trip. **WhatsApp's alone**: it is a Graph
    // API call, and in-app chat renders its own waiting state in the Widget.
    // Best-effort, so a Customer whose dots failed still gets their answer.
    void this.whatsapp
      .showTyping(inbound.externalId)
      .catch((error: unknown) =>
        this.logger.warn({
          event: "typing_indicator_failed",
          reason: error instanceof Error ? error.message : String(error),
        }),
      );

    const conversationId = await this.conversationFor(inbound.channelIdentity);

    const reply = await this.answer(conversationId, inbound);
    // **Silence is an answer here.** While a Support Officer owns the
    // conversation the Agent has left, and the Officer's own reply goes out
    // from the Middleware — a courtesy line from the bot in between would be
    // the platform talking over a member of the Bank's staff.
    if (reply) await this.whatsapp.send(inbound.channelIdentity, reply);
  }

  /**
   * **The composer, and it does not know which Channel it is on.**
   *
   * Everything above this line differs between WhatsApp and in-app chat — how a
   * message arrives, how a conversation is opened, how a reply is delivered.
   * Nothing below it does. What comes back is an `Outbound` verb, and the
   * adapter renders it: WhatsApp as a Graph API message, the Widget as markup.
   *
   * That is the whole of the difference between the two Channels, and keeping
   * it the whole of it is why this method takes a conversation id rather than a
   * channel identity — there is no value in here to branch on.
   */
  public async answer(
    conversationId: string,
    inbound: Said | Chose,
  ): Promise<Outbound | undefined> {
    // **The file leaves this deployable before anything else happens**, and it
    // is never opened on the way. What survives into the conversation is a key
    // and a media type.
    const attachment =
      inbound.kind === "said" && inbound.attachment
        ? await this.attachments.carry(conversationId, inbound.attachment)
        : undefined;

    // Recorded and the owner asked, in one call, before a single token of this
    // is shown to anything. `officer` means the Agent has left: **no model call
    // is made for this turn at all**, and the injection surface closes at
    // exactly the moment a human is being asked to trust what they are reading.
    const { owner } = await this.middleware.recordInbound(conversationId, {
      kind: inbound.kind,
      body: inbound.kind === "said" ? inbound.text : inbound.id,
      ...(attachment ? { attachment } : {}),
    });
    if (owner === "officer") return undefined;

    // **A Customer we cannot identify is greeted, not interpreted.**
    //
    // Nothing here works without a Binding, so there is no answer to give a
    // stranger's words — and running them through a model to arrive at that
    // costs a Groq call and opens the injection surface to anyone who knows the
    // number. The greeting asks the one question the platform cannot answer for
    // itself, and offers two taps.
    //
    // It cannot fire on in-app chat, and structurally rather than by a check:
    // that Channel arrives already identified, because the Bank's own
    // application signed the Customer in (ADR-0010).
    //
    // **Below the owner check**, so it never talks over a Support Officer.
    if (inbound.kind === "said" && !(await this.isIdentified(conversationId))) {
      return this.greeting();
    }

    // **"Hi" is not a question.** A greeting gets the menu rather than a model
    // call: it costs nothing, it answers faster, and the three things most
    // Customers want are one tap away. Matched on the whole message, so "hi"
    // opens the menu and "hi, where is my transfer" reaches the Agent.
    if (inbound.kind === "said" && isGreeting(inbound.text)) {
      return this.menu();
    }

    // A file the Agent will never be allowed to read is a request it cannot
    // answer, which is what trigger 4 *is*. The caption goes nowhere near the
    // model either — a sentence beside a document is the most natural place in
    // the product to hide an instruction.
    if (inbound.kind === "said" && inbound.attachment) {
      return this.handOff(
        conversationId,
        "agent_unable",
        "The Customer sent a file. It is in the conversation and I have not opened it.",
      );
    }



    const reply =
      inbound.kind === "chose"
        ? // An id we minted, routed by code with no model involved.
          await this.answerChose(conversationId, inbound.id)
        : await this.answerSaid(conversationId, inbound.text);

    return this.recordAndMaybeHandOff(conversationId, reply);
  }

  /**
   * Reports the Agent's reply, and lets the Middleware's count decide whether
   * this was the third turn in a row it did not understand.
   *
   * **Trigger 6 is counted there and not here**, because a tally in this process
   * resets on a restart and differs on a second replica — and a Customer
   * rephrasing into a counter that keeps resetting never gets a human.
   */
  private async recordAndMaybeHandOff(
    conversationId: string,
    reply: AgentReply,
  ): Promise<Outbound> {
    const { handoff } = await this.middleware.recordAgentReply(
      conversationId,
      wordsOf(reply.outbound),
      reply.understood,
    );

    return handoff?.outcome === "raised"
      ? { verb: "say", text: `${wordsOf(reply.outbound)} ${handoffWords(handoff)}`.trim() }
      : reply.outbound;
  }

  /**
   * Asks for a human, and says something true either way.
   *
   * The Middleware answers whether somebody will pick it up now or the Bank's
   * real hours if they will not. **The hours come from configuration** — the
   * prior art hardcoded *"Business hours: Mon–Fri, 8am–6pm WAT"* into a message
   * string, which is the same sentence with none of it true.
   */
  private async handOff(
    conversationId: string,
    trigger: PlatformHandoffTrigger,
    summary: string,
  ): Promise<Outbound> {
    const raised = await this.middleware.requestHandoff(conversationId, trigger, summary);
    return { verb: "say", text: handoffWords(raised) };
  }

  /**
   * What is waiting for a Customer who has to come and fetch it.
   *
   * In-app chat's whole delivery model, and the reason that Channel needs no
   * approved template: there is no window, so an Officer's reply written at 9am
   * is simply there when the Customer next opens the Bank's application.
   */
  public waitingFor(conversationId: string, after: string): Promise<readonly WaitingMessage[]> {
    return this.middleware.waitingFor(conversationId, after);
  }

  /**
   * A control the Customer tapped.
   *
   * **This is where anything destructive happens**, and never in `answerSaid`.
   * A model that can revoke a Binding is one injected instruction away from
   * revoking it, so the model's `unlink` becomes a question and the *tap*
   * becomes the act.
   */
  private async answerChose(conversationId: string, id: string): Promise<AgentReply> {
    switch (id) {
      case CHOICES.link:
      // **Yes, they bank here.** The same surface the `link` control opens —
      // one enrollment walk, reached from two places, rather than a second one
      // that could drift from it.
      case CHOICES.hasAccountYes:
        return understood(await this.offerSurface(conversationId, "link"));

      // **No, they do not bank here.** Sent to open an account, and told plainly
      // what to do afterwards. Nothing else here can help them: every read and
      // every transfer needs an account this Bank holds.
      case CHOICES.hasAccountNo:
        return understood({
          verb: "say",
          text:
            `You can open an account with ${this.config.bankName} here:\n` +
            `${this.config.bankSignupUrl}\n\n` +
            "Once you have your account number, message me and I will link it to this number.",
        });

      // **The menu's three buttons.** Each is the same act the Customer could
      // have asked for in words — the tap simply skips the model, and skips any
      // chance of it mishearing them.
      case MENU_CHOICES.sendMoney:
        // **Asked for in words, because a transfer needs two things this tap
        // does not carry.** An Intent with a zero amount and an empty account
        // number is not a transfer anybody asked for, and the sealed surface is
        // opened *from* an Intent — so the honest step is to collect them. The
        // example is there because "how much and to whom" invites a sentence
        // the resolver then has to guess at.
        return understood({
          verb: "say",
          text:
            "Who are you sending to, and how much?\n\n" +
            "For example: *send 5000 to 1234567890 Access Bank*",
        });

      case MENU_CHOICES.checkBalance:
        return understood(await this.actOn(conversationId, { kind: "check_balance" }));

      case MENU_CHOICES.buyAirtime:
        // **Airtime does not exist yet**, and this says so rather than opening
        // something that cannot finish. It is not an Intent, there is no
        // endpoint for it and no Flow — see the note on `MENU_CHOICES`. The
        // button is here because the Bank asked for the menu it will have.
        return understood({
          verb: "say",
          text: "Buying airtime is coming soon. You can send money or check your balance now.",
        });

      case CHOICES.unlinkYes: {
        const result = await this.middleware.unlink(conversationId);
        // The one place identity goes from true back to false. Forgotten here
        // so the next message re-asks the Middleware rather than trusting a bit
        // that has just stopped being true.
        return understood({
          verb: "say",
          text:
            result.outcome === "unlinked"
              ? "This number is no longer linked. You can link it again whenever you like."
              : "This number was not linked to an account.",
        });
      }

      case CHOICES.unlinkNo:
        return understood({
          verb: "say",
          text: "Nothing has changed — this number is still linked.",
        });

      default:
        this.logger.warn({ event: "unrecognised_choice", id });
        // An id we minted and no longer recognise. Not a misunderstanding of
        // anything the Customer *said*, so it does not count towards the run
        // that becomes a Handoff — they tapped a stale button, which is our
        // fault and not a conversation going nowhere.
        return understood({
          verb: "say",
          text: "That option has expired. Please tell me what you need.",
        });
    }
  }

  private async answerSaid(conversationId: string, said: string): Promise<AgentReply> {
    const resolution = await this.resolver.resolve(said);
    if (resolution.outcome === "unavailable") {
      this.logger.error({ event: "intent_resolution_unavailable", reason: resolution.reason });
      // The model could not be reached. **Not a misunderstanding** — nothing
      // read the Customer's words at all — so it does not build towards the
      // repeated-failure Handoff, which is about a conversation going nowhere
      // rather than about an outage.
      return understood({
        verb: "say",
        text: "I cannot do that just now. Please try again in a moment.",
      });
    }
    if (resolution.outcome === "unresolved") {
      return {
        understood: false,
        outbound: {
          verb: "say",
          // The only place the product says what it can do, so it names both
          // reads rather than the one that shipped first.
          text: "I did not understand that. You can ask me for your balance, or for your recent transactions.",
        },
      };
    }

    // **The Customer asked for a person.** Trigger 2, and arguing with somebody
    // who has asked for a human is worse support than transferring them.
    if (resolution.intent.kind === "talk_to_human") {
      return understood(
        await this.handOff(
          conversationId,
          "customer_asked",
          "The Customer asked to speak to somebody.",
        ),
      );
    }

    // Neither of these reaches the Banking Layer, and neither is acted on here.
    // Unlinking asks for a tap; a forgotten PIN opens the sealed surface and a
    // code goes to the contact already on record.
    if (resolution.intent.kind === "unlink") {
      return understood({
        verb: "ask",
        question:
          "Unlinking means this number can no longer reach your account. Are you sure?",
        choices: [
          { id: CHOICES.unlinkYes, label: "Yes, unlink" },
          { id: CHOICES.unlinkNo, label: "No, keep it" },
        ],
      });
    }
    if (resolution.intent.kind === "reset_pin") {
      return understood(await this.offerSurface(conversationId, "pin_reset"));
    }

    // **A question rather than an instruction**, and therefore the Support
    // Agent's — a second model call, on a larger model, with tools and no
    // schema. Groq permits either constrained decoding or tool use and never
    // both, so the two calls are not a design preference: the Agent that reads
    // the Library physically cannot emit an Intent, which is ADR-0001's rule
    // enforced by the provider.
    if (resolution.intent.kind === "ask_support") {
      return this.answerAsSupport(conversationId, said);
    }

    return understood(await this.actOn(conversationId, resolution.intent));
  }

  /**
   * Submits an Intent and turns the outcome into words.
   *
   * Extracted so that **a tap and a sentence take the same path**: the menu's
   * Check Balance button is the same act as saying *"what is my balance"*, and
   * routing them differently is how the two quietly grow apart.
   */
  private async actOn(conversationId: string, intent: BankingIntent): Promise<Outbound> {
    const outcome = await this.middleware.submitIntent(conversationId, intent);

    // **The Agent judges itself unable.** Trigger 4, and it makes good on a
    // promise the prior art made and did not keep: this outcome already told
    // Customers *"a member of our team can help — reply HELP"*, and HELP reached
    // nobody. The sentence about what could not be done is still said first —
    // being handed to a human is not an answer to *what happened to my
    // question* — and the Handoff follows it.
    if (outcome.kind === "not_available") {
      const passing = await this.handOff(
        conversationId,
        "agent_unable",
        `The Customer asked for ${intent.kind.replace(/_/g, " ")} ` +
          "and the Bank's system does not carry it.",
      );
      const cannot = this.wordsFor(outcome, intent.kind);
      return { verb: "say", text: `${wordsOf(cannot)} ${wordsOf(passing)}`.trim() };
    }

    return this.wordsFor(outcome, intent.kind);
  }

  /**
   * **The Support Agent's turn**, and the one place a Customer's question is
   * answered rather than executed.
   *
   * The rule that carries it is a refusal rule and not a citation style: *it may
   * not state a Bank policy it cannot cite.* The Agent enforces that itself —
   * nothing retrieved means no assertion, and a figure it was not given is
   * refused before the words leave this process. What arrives here is one of
   * three answers, and only one of them is words for the Customer.
   *
   * A refusal is **trigger 4**. That is not a fallback: it is the whole design.
   * *The model found nothing* becomes a named human, where *the model made
   * something up* used to become a Customer acting on a fee the Bank never
   * charged.
   */
  private async answerAsSupport(conversationId: string, said: string): Promise<AgentReply> {
    const answer = await this.agent.answer({
      said,
      // The current conversation, bounded and fetched fresh. Never remembered
      // here: this process is restarted and replicated, and a half-remembered
      // conversation is worse than none.
      history: await this.middleware.agentContext(conversationId),
      // **Bound to this conversation, and to nothing else about the Customer.**
      // The Library is Bank-wide and identical for everyone, so there is nothing
      // here to scope by — which is exactly why conversation history is not
      // Library material and cannot be reached through this.
      search: (query) => this.middleware.searchLibrary(conversationId, query),
      // **What the Bank has registered**, read per turn. Empty is ordinary: v1
      // ships with zero Connectors, and a Bank with none is an ordinary Bank.
      connectors: await this.middleware.connectors(),
      // Bound the same way, and for a stronger reason. The account this acts on
      // comes from the conversation on the far side of this call, so there is no
      // argument here through which a model could name somebody else.
      call: (connectorId, args) =>
        this.middleware.callConnector(conversationId, connectorId, args),
    });

    switch (answer.outcome) {
      case "answered": {
        // **The citation is written here, from the rows that were retrieved.**
        // The model is told not to write one, and this is why that instruction
        // is safe to give: a model that composes its own citations composes
        // plausible ones, and a Support Officer checking what a Customer was
        // told needs the real document, section and version date.
        const source = citationsInWords(answer.citations);
        return understood({
          verb: "say",
          text: source ? `${answer.text}\n\n${source}` : answer.text,
        });
      }

      case "cannot_confirm": {
        const passing = await this.handOff(conversationId, "agent_unable", answer.summary);
        return understood({
          verb: "say",
          // The honest sentence first, and then the human. Being handed to
          // somebody is not an answer to *what happened to my question*.
          text: `${CANNOT_CONFIRM} ${wordsOf(passing)}`.trim(),
        });
      }

      case "authorisation_required":
        // **A Gated Connector**, and this layer is a courier again. The words
        // beside the button say nothing about what is being authorised — the
        // Middleware renders that inside the sealed surface, from the request it
        // stored, because everything here passed through a model.
        return understood({
          verb: "secure",
          purpose: "Enter your Transaction PIN to authorise this.",
          token: answer.token,
          flowId: answer.flowId,
          surfaceUrl: answer.surfaceUrl,
          callToAction: "Authorise",
        });

      case "unavailable":
        this.logger.error({ event: "support_agent_unavailable", reason: answer.reason });
        // Nothing read the Customer's words at all, so this is not a
        // misunderstanding and does not build towards trigger 6 — the same rule
        // the Intent path already applies to an outage.
        return understood({
          verb: "say",
          text: "I cannot do that just now. Please try again in a moment.",
        });
    }
  }

  /**
   * Couriers a sealed surface, without ever learning what it is for.
   *
   * The Middleware decides whether this is an enrollment, a renewal or a PIN
   * reset, because it is the only thing that knows whether a Binding exists and
   * whether it has gone quiet. What comes back here is two opaque strings.
   */
  private async offerSurface(
    conversationId: string,
    want: "link" | "pin_reset",
  ): Promise<Outbound> {
    const surface = await this.middleware.requestSurface(conversationId, want);

    switch (surface.outcome) {
      case "surface":
        return {
          verb: "secure",
          purpose: SURFACE_WORDS[surface.purpose],
          // Three fields carried and none of them read. Which of them the
          // handset uses is the adapter's business, and this layer could not
          // choose between them without being told which Channel it is on.
          token: surface.token,
          flowId: surface.flowId,
          surfaceUrl: surface.surfaceUrl,
          callToAction: surface.purpose === "pin_reset" ? "Set a new PIN" : "Continue",
        };

      case "locked_out":
        return {
          verb: "say",
          text: "Too many attempts. Please try again in an hour.",
        };

      case "not_applicable": {
        // **From the reason, not from what was asked for.** Inferring it here
        // was correct while there was one Channel and wrong the moment there
        // were two: a Customer typing *"I forgot my PIN"* inside their bank's
        // application was told about a phone number they had not mentioned and
        // this platform had never seen.
        const words = NO_SURFACE_WORDS[surface.reason];

        // One of the four is not an answer, it is a dead end: there is no code
        // path to a new PIN where nothing was ever enrolled, and the Customer
        // still cannot send money. **The Agent is unable**, which is trigger 4
        // — and saying so without raising one is exactly the promise the prior
        // art made and did not keep.
        if (surface.reason !== "pin_is_chosen_at_first_transfer") {
          return { verb: "say", text: words };
        }

        const passing = await this.handOff(
          conversationId,
          "agent_unable",
          "The Customer has forgotten a Transaction PIN there is no reset path for.",
        );
        return { verb: "say", text: `${words} ${wordsOf(passing)}`.trim() };
      }
    }
  }

  /**
   * What the Customer is told, per outcome.
   *
   * Short, plain and unhedged. Nothing here states a fee, a limit or a timeframe
   * — every figure comes from the Banking Layer or is not said at all.
   *
   * `asked` is the kind of thing they wanted, and it is here for one sentence:
   * a Customer told *"I cannot get that"* deserves to hear **what** — and the
   * outcome deliberately does not say, because it is a closed union shared by
   * every read.
   */
  private wordsFor(outcome: IntentOutcome, asked: BankingIntent["kind"]): Outbound {
    switch (outcome.kind) {
      case "balance":
        return {
          verb: "say",
          text: `Your available balance is ${formatNaira(outcome.availableBalance)}.`,
        };

      case "transactions":
        // Rendered, and never read back to a model. The narrations in here are
        // the only strings on this path the Bank did not write.
        return { verb: "say", text: describeTransactions(outcome.period, outcome.rows) };

      case "authorisation_required":
        // A sealed surface, couriered without being opened. **The words beside
        // the button say nothing about the transfer** — not the amount, not who
        // is being paid — because this layer was never told, and it was never
        // told because a Customer's text is read into a model here. What the
        // transfer is is on the Confirmation screen, which the Middleware
        // renders inside the envelope.
        return {
          verb: "secure",
          purpose: "Check the details and enter your Transaction PIN to send this.",
          token: outcome.token,
          flowId: outcome.flowId,
          surfaceUrl: outcome.surfaceUrl,
          callToAction: "Review and send",
        };

      case "beneficiary_choice_required":
        // A sealed surface again, and again couriered without being opened.
        // **This layer is not told whether several of the Customer's saved
        // recipients matched or none did** — who a Customer pays is exactly the
        // sort of thing the injection surface has no business holding, and the
        // rows themselves are rendered by the Middleware inside the envelope.
        return {
          verb: "secure",
          purpose:
            outcome.purpose === "forget"
              ? "Choose who you want removed from your saved names."
              : "Choose who you meant, or enter an account number.",
          token: outcome.token,
          flowId: outcome.flowId,
          surfaceUrl: outcome.surfaceUrl,
          callToAction: outcome.purpose === "forget" ? "Choose" : "Choose recipient",
        };

      case "no_such_beneficiary":
        // Only ever the answer to *"forget Musa"*. A transfer to a name nobody
        // matches does not come back here — it opens the same screen anyway,
        // because that screen carries an account-number form.
        return {
          verb: "say",
          text: "I do not have anyone saved under that name.",
        };

      case "beneficiary_unreachable":
        // Not "check the number": they did not type one. The ten digits behind
        // the name are ones this platform stored, and a closed account is the
        // ordinary reason this happens.
        return {
          verb: "say",
          text:
            "I could not reach the account saved under that name. " +
            "You can send to an account number instead.",
        };

      case "destination_unknown":
        // Actionable, and deliberately so: an account number that does not
        // resolve is usually a mistyped one. The Bank's own words about why are
        // in the audit table, not in this sentence.
        return {
          verb: "say",
          text: "I could not find that account. Please check the number and try again.",
        };

      case "bank_unknown":
        // Not "check the number": the number may be perfect. A Customer told to
        // check the wrong half of what they said retypes it until they give up,
        // and the Middleware refuses an unrecognised bank rather than guessing
        // at which one was meant.
        return {
          verb: "say",
          text: "I do not recognise that bank. Please check the bank's name and try again.",
        };

      case "not_identified":
        // A control rather than a keyword. "Reply LINK" invites the Customer to
        // type a word that then has to be told apart from something they meant
        // as a sentence; a tap comes back as an id this layer minted, and is
        // routed without a model reading it at all.
        return {
          verb: "ask",
          question: "I do not have this number linked to an account yet.",
          choices: [{ id: CHOICES.link, label: "Link my account" }],
        };

      case "not_available":
        // Told plainly, rather than shown an error or an empty list. The Bank's
        // token does not carry transaction history today (ticket 16), and a
        // Customer who is shown nothing concludes nothing happened.
        //
        // **It no longer ends "reply HELP".** It used to, and HELP reached
        // nobody — the promise-without-a-keeper this platform's prior art is
        // remembered for. The caller raises a Handoff and appends what is
        // actually happening, so the offer of a human is now made by the code
        // that has just made one appear.
        return {
          verb: "say",
          text:
            asked === "list_transactions"
              ? "I cannot show your transaction history at the moment."
              : "I cannot get that at the moment.",
        };

      case "unsupported":
        return { verb: "say", text: "I cannot do that yet." };

      case "failed":
        return { verb: "say", text: "Something went wrong on our side. Please try again shortly." };
    }
  }

  /**
   * The Middleware issues the conversation id; this quotes it and never mints
   * one. Cached for the life of the process, which is the life of a
   * conversation as far as this layer is concerned.
   */
  private async conversationFor(channelIdentity: string): Promise<string> {
    const known = this.conversations.get(channelIdentity);
    if (known) return known;

    const opened = await this.middleware.openConversation("whatsapp", channelIdentity);
    this.conversations.set(channelIdentity, opened.conversationId);
    return opened.conversationId;
  }

  /**
   * Whether this conversation reaches an account, **asked every time**.
   *
   * Not cached, in either direction, and both directions are why. A Customer
   * enrols *during* a conversation, so a cached `false` would greet them as a
   * stranger for as long as this process lives. And a Binding stops reaching an
   * account without anyone telling this layer — it goes dormant after ninety
   * silent days, and a Customer reporting a stolen handset revokes it
   * mid-conversation — so a cached `true` would outlive the thing it describes,
   * which is exactly the case that must not linger.
   *
   * It is a read rather than another `openConversation`: that one *mints* a
   * conversation every time it is called, and the Customer would lose the
   * thread the Support Agent and any Handoff read back.
   */
  private async isIdentified(conversationId: string): Promise<boolean> {
    return this.middleware.isIdentified(conversationId);
  }

  /**
   * What a number we do not know is told, before anything reads their words.
   *
   * The Bank's own name comes from configuration rather than from here: this is
   * the first sentence every Customer reads and the name on it is not ours to
   * write down.
   */
  /** The three things most Customers came for, one tap each. */
  private menu(): Outbound {
    return {
      verb: "ask",
      question: MENU_PROMPT,
      choices: MENU_BUTTONS.map((button) => ({ id: button.id, label: button.title })),
    };
  }

  private greeting(): Outbound {
    return {
      verb: "ask",
      question:
        `Welcome to *${this.config.bankName}*.\n\n` +
        "Do you have a bank account with us?",
      choices: [
        { id: CHOICES.hasAccountYes, label: "Yes, I do" },
        { id: CHOICES.hasAccountNo, label: "No, not yet" },
      ],
    };
  }



  /**
   * Opens an in-app chat conversation from the envelope the Bank's backend
   * signed.
   *
   * **The envelope is forwarded, not read.** It is one opaque string here, and
   * that is structural rather than stylistic: the account number is inside it,
   * and this deployable is the prompt-injection surface. Whether it verifies is
   * the Middleware's to say, and this layer is not told why it did not
   * ([ADR-0010](../../../../docs/adr/0010-the-in-app-chat-snippet-carries-a-signed-identity.md)).
   *
   * There is no channel identity to cache against and nothing to remember
   * between sessions — the Bank's application states who the Customer is every
   * time, which is the reason this Channel has no Binding at all.
   */
  public async openInApp(identity: string): Promise<OpenedInAppConversation> {
    const opened = await this.middleware.openInAppConversation(identity);
    if (opened.outcome === "refused") this.logger.warn({ event: "in_app_conversation_refused" });
    return opened;
  }

  /**
   * Whether the Widget may drive this conversation.
   *
   * **A security control, and asked of the Middleware every time.** A handset
   * that quoted a *WhatsApp* conversation's id would be reading whichever
   * Customer holds that Binding, which is the exact class of thing signing an
   * identity exists to prevent — so the answer comes from the conversation's
   * stored Channel and never from anything this deployable remembers.
   *
   * It was a `Set` in this process first. That was wrong twice: it did not
   * survive a restart, and a second Platform replica would hold a different
   * one — so the guard would have failed open on whichever instance had not
   * seen the conversation.
   */
  public isInAppConversation(conversationId: string): Promise<boolean> {
    return this.middleware.isInAppConversation(conversationId);
  }

  /** Exposed for the Platform's own health surface; carries no Customer data. */
  public get openConversationCount(): number {
    return this.conversations.size;
  }

  /** The Groq models this Platform is configured against. */
  public get models(): { readonly intent: string; readonly support: string } {
    return { intent: this.config.groq.intentModel, support: this.config.groq.supportModel };
  }
}

/**
 * One turn's answer, and **whether the Agent made sense of the question**.
 *
 * The second field is not decoration on the first. It is the input to Handoff
 * trigger 6, and separating the two is what stops "the Agent replied" and "the
 * Agent understood" being the same fact — a model outage and a Customer being
 * misunderstood produce the same apology and must not produce the same tally.
 */
interface AgentReply {
  readonly outbound: Outbound;
  readonly understood: boolean;
}

/** The ordinary case: the Agent knew what was being asked. */
const understood = (outbound: Outbound): AgentReply => ({ outbound, understood: true });

/** The words the Customer actually saw, for the history an Officer reads back. */
const wordsOf = (outbound: Outbound): string => {
  switch (outbound.verb) {
    case "say":
      return outbound.text;
    case "ask":
      return outbound.question;
    case "send":
      return outbound.caption ?? "";
    case "secure":
      return outbound.purpose;
  }
};

/**
 * What a Customer is told when a human is being found for them.
 *
 * **Nothing here states hours the platform invented.** Out of hours it repeats a
 * fragment the Middleware rendered from the Bank's own setting, and a Bank that
 * has configured none is not given a plausible-sounding timetable — it simply
 * does not promise a time.
 */
const handoffWords = (raised: HandoffRaised): string => {
  switch (raised.outcome) {
    case "raised":
      return raised.waiting === "out_of_hours" && raised.hours
        ? `I am passing you to a member of our team. They are available ${raised.hours}, ` +
            "and will reply here."
        : "I am passing you to a member of our team. They will reply here shortly.";

    case "already_open":
      // Somebody already owns this conversation. Saying it again is noise, and
      // saying it as if it were new would be the platform pretending to act.
      return "A member of our team already has this and will reply here.";

    case "no_such_conversation":
      return "I cannot do that just now. Please try again in a moment.";
  }
};

/**
 * **What a Customer is told when the Agent has no source.**
 *
 * Plain, and it does not apologise or hedge. It is the sentence that exists
 * instead of an invented policy: the prior art asserted a ₦1,000,000 transfer
 * limit and a ₦30 fee in a hardcoded prompt, told both to Customers with total
 * confidence, and both were made up — limits are KYC-tier and not observable at
 * all. This costs the Bank a Handoff and buys a Customer an answer that is true.
 */
const CANNOT_CONFIRM = "I cannot confirm that from the Bank's published information.";

/**
 * The ids this layer mints and renders.
 *
 * They come back as a `chose` — an identifier the platform itself minted,
 * returned unchanged by the handset — which is what lets the branches above be
 * routed by code with no model anywhere near them.
 */
const CHOICES = {
  link: "enroll_link",
  /**
   * **Does the Customer bank with us at all** — not "have you linked yet",
   * which is a thing the platform already knows.
   *
   * This is the one question about a Customer that cannot be answered from
   * here. A Binding is absent both for somebody who banks here and has not
   * linked, and for somebody who has never heard of the Bank, and BankOne
   * cannot tell them apart from a phone number either: it answers about account
   * numbers, and the account number is what enrollment is *for*. So it is
   * asked, once, and the two answers go different ways.
   */
  hasAccountYes: "has_account_yes",
  hasAccountNo: "has_account_no",
  unlinkYes: "unlink_confirm",
  unlinkNo: "unlink_cancel",
} as const;

/**
 * What a Customer is told when there is no surface to open.
 *
 * Four sentences for four reasons, and no Channel named in any of them. Two are
 * about a Binding and are only ever reached where one could exist; two are
 * about a Customer their bank's own application has already signed in, and are
 * only ever reached where it has. **This layer is not told which is which** —
 * it renders the reason it was given, which is the whole reason the reason is a
 * code.
 */
const NO_SURFACE_WORDS = {
  no_binding: "I do not have this number linked to an account yet.",
  already_linked: "This number is already linked to an account.",
  already_identified: "You are already signed in to your account here.",
  /**
   * The honest answer, and it is *not* an offer to reset. There is no code path
   * to a new PIN where nothing was ever enrolled, so a Customer is told what
   * they can do instead rather than sent round a loop that ends nowhere.
   *
   * It used to end *"reply HELP"*, and HELP reached nobody — the same
   * promise-without-a-keeper the prior art is remembered for. The caller now
   * raises a Handoff and appends what is actually happening, so this sentence
   * stops at the fact and leaves the offer to the code that keeps it.
   */
  pin_is_chosen_at_first_transfer:
    "You choose your Transaction PIN the first time you send money here.",
} as const;

/** The words beside the button that opens a sealed surface. */
const SURFACE_WORDS = {
  enrollment: "Let us link this number to your account. It takes a minute.",
  renewal: "It has been a while. Confirm a code to keep WhatsApp banking active.",
  pin_reset: "We will send a code to the contact on your account, then you can set a new PIN.",
} as const;

/**
 * A message that is only a hello.
 *
 * **Matched on the whole message, not on a prefix.** "hi" is a greeting and
 * "hi, where is my money" is a question — treating the second as the first
 * would answer a worried Customer with a menu. Punctuation and an emoji are
 * stripped because a Customer typing "Hello!" has still only said hello.
 */
const GREETINGS = new Set([
  "hi",
  "hii",
  "hey",
  "helo",
  "hello",
  "yo",
  "sup",
  "whatsup",
  "wassup",
  "whatsapp",
  "good morning",
  "good afternoon",
  "good evening",
  "how far",
  "menu",
  "start",
  "hi there",
  "hello there",
]);

const isGreeting = (said: string): boolean =>
  GREETINGS.has(
    said
      .toLowerCase()
      .replace(/[^a-z\s]/g, "")
      .trim()
      .replace(/\s+/g, " "),
  );
