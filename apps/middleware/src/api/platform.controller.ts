import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Get,
  Inject,
  Param,
  Post,
  Query,
} from "@nestjs/common";
import { z } from "zod";

import type { MiddlewareConfig } from "@avni/config";
import {
  isBankingIntent,
  safeParseIntent,
  type IntentOutcome,
  type OpenedConversation,
  type SealedSurfaceAddress,
  type SurfaceNotApplicable,
} from "@avni/intent";

import { AuditRepository } from "../audit/audit.repository";
import { BankingService } from "../banking/banking.service";
import {
  ConnectorsService,
  type ConnectorCallOutcome,
  type OfferedConnector,
} from "../connectors/connectors.service";
import { EnrollmentService } from "../enrollment/enrollment.service";
import { BindingsRepository } from "../identity/bindings.repository";
import {
  ConversationsService,
  type OpenedInAppConversation,
} from "../identity/conversations.service";
import type { RetrievedSection } from "../library/library.repository";
import { LibraryService } from "../library/library.service";
import { widgetSurfaceUrl } from "../surfaces/address";
import { PLATFORM_TRIGGERS } from "../support/handoff";
import {
  HandoffService,
  type ConversationOwner,
  type HandoffRaised,
} from "../support/handoff.service";
import { MessagesRepository } from "../support/messages.repository";
import { MIDDLEWARE_CONFIG } from "../tokens";

/**
 * The Middleware's inward face — what the **Platform** may ask for, and nothing
 * more.
 *
 * The shape of every call is the shape of the trust boundary. The Platform names
 * a channel identity and gets back an id and a bit; it then quotes that id and
 * submits an Intent, asks for a sealed surface, or asks for a Binding to be
 * destroyed. At no point does it name an account, and at no point is it told one
 * ([ADR-0006](../../../../docs/adr/0006-secrets-and-security-records-live-outside-the-platform.md)).
 *
 * The two calls added by enrollment keep that property exactly. A **surface** is
 * an opaque token and a Flow id, and everything it goes on to do happens inside
 * the sealed channel that terminates here. An **unlink** names a conversation,
 * and the Middleware resolves it to a Binding itself — the Platform could not
 * revoke somebody else's Binding if it tried, because it cannot name one.
 */

const openBody = z.object({
  channel: z.enum(["whatsapp", "in_app_chat"]),
  channelIdentity: z.string().trim().min(1),
});

/**
 * One opaque string, and deliberately typed as one.
 *
 * The envelope carries the account number inside it, and the Platform is the
 * prompt-injection surface. Accepting it as a string the Platform forwards
 * without parsing — rather than as `{ accountNumber, expiresAt, signature }` —
 * is what makes it structurally impossible for anything in that deployable to
 * read an account out of an in-app message.
 */
const inAppBody = z.object({ identity: z.string().trim().min(1).max(4096) });

const intentBody = z.object({ intent: z.unknown() });

const surfaceBody = z.object({ want: z.enum(["link", "pin_reset"]) });

/**
 * One inbound message, as the Platform reports it.
 *
 * `kind` is the `said`/`chose`/`event` split kept intact across the wire, and
 * that is the whole reason this endpoint takes a shape rather than a string: a
 * Customer who *typed* `menu_transfer` and one who *tapped* that button must
 * still be different things by the time they reach the Officer who reads them
 * back six weeks later.
 *
 * The attachment is a **key and a media type**, never bytes. The Platform has
 * already moved the file into object storage without opening it, and what
 * arrives here is the fact that it exists.
 */
const inboundBody = z.object({
  kind: z.enum(["said", "chose", "event"]),
  body: z.string().max(8_000).default(""),
  attachment: z
    .object({
      key: z.string().trim().min(1).max(512),
      mediaType: z.string().trim().min(1).max(255),
      name: z.string().trim().max(255).default(""),
    })
    .optional(),
});

/**
 * What the Agent said back, and **whether it understood the turn**.
 *
 * The second field is the whole of Handoff trigger 6. It is counted here rather
 * than in the Platform because the Platform is restarted and replicated, and a
 * run of three that resets under the Customer is a run that never completes.
 */
const outboundBody = z.object({
  body: z.string().max(8_000),
  understood: z.boolean(),
});

/**
 * A Handoff the Platform is asking for.
 *
 * **Only the four triggers the Platform can honestly observe.** A `pending`
 * transfer and a failed PIN on a Gated Connector are the Middleware's own — the
 * Platform never sees a Transaction PIN and never dispatches a transfer, so a
 * route that let it claim either would let a Customer's text page the Bank's
 * operations desk with a sentence.
 */
const handoffBody = z.object({
  trigger: z.enum(PLATFORM_TRIGGERS),
  summary: z.string().trim().max(2_000).default(""),
});

/**
 * What the Support Agent is asking the **Library** for.
 *
 * A query, and nothing else. There is no Customer identifier on this shape and
 * no field to scope by, which is the structural half of *"one Customer's stored
 * conversation can never reach another Customer's retrieval"*: a Library is
 * Bank-wide and identical for every Customer, and this endpoint could not read
 * per-Customer data if the code behind it wanted to.
 *
 * The conversation id in the path is for the **audit row** and for the ownership
 * check below. It scopes nothing that is read.
 */
const librarySearchBody = z.object({
  query: z.string().trim().min(1).max(500),
});

/**
 * What the model produced, and **only** what the model produced.
 *
 * `unknown` on purpose: whether these arguments match what the Bank declared is
 * the Middleware's question, answered against the registered parameter list —
 * and a shape asserted here would be a second, weaker answer to it. There is no
 * account field, and there is nowhere to add one: the Middleware injects it.
 */
const connectorCallBody = z.object({ arguments: z.unknown() });

/**
 * How many earlier messages of the current conversation the Agent is shown.
 *
 * Bounded here rather than in the Platform, because the bound is a cost control
 * against Groq's 250K TPM and the Platform is the thing being controlled. Ten
 * messages is roughly five exchanges, which is longer than a support
 * conversation that is going well and shorter than one that should already have
 * become a Handoff.
 */
const AGENT_CONTEXT_TURNS = 10;

/** What the Platform couriers to the handset. Never a value it can act on. */
export type SurfaceOutcome =
  | ({
      readonly outcome: "surface";
      readonly purpose: "enrollment" | "renewal" | "pin_reset";
    } & SealedSurfaceAddress)
  | { readonly outcome: "locked_out" }
  | { readonly outcome: "not_applicable"; readonly reason: SurfaceNotApplicable };

export type UnlinkOutcome = { readonly outcome: "unlinked" | "not_linked" };

@Controller("platform")
export class PlatformController {
  public constructor(
    @Inject(ConversationsService) private readonly conversations: ConversationsService,
    @Inject(BankingService) private readonly banking: BankingService,
    @Inject(EnrollmentService) private readonly enrollment: EnrollmentService,
    @Inject(BindingsRepository) private readonly bindings: BindingsRepository,
    @Inject(AuditRepository) private readonly audit: AuditRepository,
    @Inject(MIDDLEWARE_CONFIG) private readonly config: MiddlewareConfig,
    @Inject(HandoffService) private readonly handoff: HandoffService,
    @Inject(LibraryService) private readonly library: LibraryService,
    @Inject(MessagesRepository) private readonly messages: MessagesRepository,
    @Inject(ConnectorsService) private readonly connectorsService: ConnectorsService,
  ) {}

  /**
   * One message from the Customer, recorded — and **who owns the conversation
   * now**.
   *
   * The two halves are one call on purpose. The Platform must not be able to
   * answer a message it has not yet been told the owner of, and bundling them
   * makes "record, check, then answer" a single round trip that cannot be
   * performed in the wrong order or skipped under load.
   *
   * `officer` means the Platform makes **no model call at all** about this turn.
   * The Agent has left; the injection surface closes at exactly the moment a
   * human is being asked to trust what they are reading.
   */
  @Post("conversations/:conversationId/inbound")
  public async recordInbound(
    @Param("conversationId") conversationId: string,
    @Body() body: unknown,
  ): Promise<{ owner: ConversationOwner }> {
    const parsed = inboundBody.safeParse(body);
    if (!parsed.success) throw new BadRequestException("a message kind is required");

    const conversation = await this.conversations.findById(conversationId);
    if (!conversation) throw new BadRequestException("no such conversation");

    if (parsed.data.attachment) {
      // Recorded here rather than in the Platform, like every other row: the
      // audit table has one writer. What is recorded is that a file exists and
      // where it went — never a byte of it, and never anything read out of it.
      await this.audit.record({
        action: "attachment.stored",
        actor: { kind: "platform" },
        outcome: "succeeded",
        conversationId,
        detail: {
          mediaType: parsed.data.attachment.mediaType,
          bytesRead: false,
        },
      });
    }

    return this.handoff.receiveFromCustomer({
      conversationId,
      kind: parsed.data.kind,
      body: parsed.data.body,
      ...(parsed.data.attachment ? { attachment: parsed.data.attachment } : {}),
    });
  }

  /**
   * What the Agent answered, so an Officer picking the conversation up sees
   * what has already been tried rather than starting from nothing.
   *
   * It answers with a Handoff when this reply was the third the Agent did not
   * understand — trigger 6, which the Platform could not have counted itself.
   */
  @Post("conversations/:conversationId/outbound")
  public async recordOutbound(
    @Param("conversationId") conversationId: string,
    @Body() body: unknown,
  ): Promise<{ handoff: HandoffRaised | null }> {
    const parsed = outboundBody.safeParse(body);
    if (!parsed.success) throw new BadRequestException("a reply and an outcome are required");

    const conversation = await this.conversations.findById(conversationId);
    if (!conversation) throw new BadRequestException("no such conversation");

    const raised = await this.handoff.recordAgentReply(
      conversationId,
      parsed.data.body,
      parsed.data.understood,
    );
    return { handoff: raised ?? null };
  }

  /**
   * The part of this conversation the Support Agent may be shown.
   *
   * **Bounded, and scoped by the conversation id in the path** — there is no
   * other parameter, so there is no shape of this request that reaches a second
   * Customer. What comes back is what the Customer typed and what the Agent
   * answered, and nothing else: see `MessagesRepository.agentContext` for the
   * four things that are left out and why each of them is a security decision
   * rather than a tidying one.
   *
   * This is **not** retrieval and the history is not a Library. A Library is
   * Bank-wide and identical for every Customer; this is one conversation's own
   * words, which is exactly the distinction that stops one mechanism serving two
   * incompatible access rules.
   */
  @Get("conversations/:conversationId/agent-context")
  public async agentContext(
    @Param("conversationId") conversationId: string,
  ): Promise<{ messages: readonly { from: "customer" | "agent"; text: string }[] }> {
    if ((await this.handoff.ownerOf(conversationId)) === "officer") {
      throw new ConflictException("a Support Officer owns this conversation");
    }

    const messages = await this.messages.agentContext(conversationId, AGENT_CONTEXT_TURNS);
    return {
      messages: messages.map((message) => ({
        from: message.author === "agent" ? "agent" : "customer",
        text: message.body,
      })),
    };
  }

  /**
   * **What the Support Agent may quote**, for one turn of one conversation.
   *
   * Live versions only, ranked, and capped by the Bank's configured token
   * budget. Nothing here is scoped to a Customer because there is nothing to
   * scope: a Library is Bank-wide and identical for everyone, which is exactly
   * why a Customer's own conversation history is not one.
   *
   * **An empty list is an ordinary answer and the most important one.** It is
   * what makes the Agent say it cannot confirm and hand off, instead of
   * asserting a policy it has no source for — the mechanism that turns *the
   * model made something up* into *the model found nothing*.
   *
   * A conversation an Officer owns is refused rather than answered. Retrieval
   * only ever happens on the way to a model call, and
   * [ADR-0012](../../../../docs/adr/0012-a-handoff-transfers-ownership-and-the-model-stops-reading.md)
   * says there are none while a human holds the conversation. The Platform
   * already checks the owner before it reaches the Agent, so this is the second
   * lock on the same door — and it is loud rather than empty, because a quiet
   * refusal here would look exactly like a corpus with no answer in it.
   */
  @Post("conversations/:conversationId/library")
  public async searchLibrary(
    @Param("conversationId") conversationId: string,
    @Body() body: unknown,
  ): Promise<{ sections: readonly RetrievedSection[] }> {
    const parsed = librarySearchBody.safeParse(body);
    if (!parsed.success) throw new BadRequestException("a query is required");

    const conversation = await this.conversations.findById(conversationId);
    if (!conversation) throw new BadRequestException("no such conversation");

    if ((await this.handoff.ownerOf(conversationId)) === "officer") {
      throw new ConflictException("a Support Officer owns this conversation");
    }

    return {
      sections: await this.library.retrieve(parsed.data.query, {
        budgetTokens: this.config.library.retrievalBudgetTokens,
        conversationId,
      }),
    };
  }

  /**
   * **What the Support Agent may call**, and nothing about how.
   *
   * A name, a sentence and a field list per Connector. **No endpoint and no
   * credential** — this is the prompt-injection surface, and a tool list
   * carrying an address would put the Bank's own API one injected instruction
   * away ([ADR-0006](../../../../docs/adr/0006-secrets-and-security-records-live-outside-the-platform.md)).
   *
   * It takes no conversation and no Customer identifier, exactly as Library
   * retrieval does, and for the same reason: the registry is Bank-wide and
   * identical for everyone. There is no argument here to scope by, which is what
   * makes *"one Customer's Connector list can never be another's"* structural.
   *
   * An empty list is the ordinary answer. **v1 ships with zero Connectors
   * registered**, and a Bank with none is an ordinary Bank rather than an
   * incomplete one.
   */
  @Get("connectors")
  public async connectors(): Promise<{ connectors: readonly OfferedConnector[] }> {
    return { connectors: await this.connectorsService.catalogue() };
  }

  /**
   * The Support Agent asking for a Connector, on this Customer's behalf.
   *
   * **The account is not in this request and cannot be.** The conversation id in
   * the path is what the Middleware resolves an account from; the body carries
   * only what the model produced. The Agent can be wrong about *what* — and it
   * will be, about a third of the time — and there is no field here through
   * which it could be wrong about *who*.
   *
   * A Gated Connector answers `authorisation_required` with two opaque strings,
   * which the Platform couriers exactly as it couriers a transfer's: the
   * Transaction PIN is entered inside a sealed surface that terminates here
   * ([ADR-0007](../../../../docs/adr/0007-flow-confirmations-terminate-at-the-middleware.md)).
   */
  @Post("conversations/:conversationId/connectors/:connectorId")
  public async callConnector(
    @Param("conversationId") conversationId: string,
    @Param("connectorId") connectorId: string,
    @Body() body: unknown,
  ): Promise<ConnectorCallOutcome> {
    const parsed = connectorCallBody.safeParse(body);
    if (!parsed.success) throw new BadRequestException("arguments are required");

    const conversation = await this.conversations.findById(conversationId);
    if (!conversation) throw new BadRequestException("no such conversation");

    // A conversation a human owns reaches no model and takes no action on the
    // Customer's behalf. The Platform checks the owner before it reaches the
    // Agent at all; this is the second lock on the same door, and it is on the
    // door that *does something* rather than the one that reads
    // ([ADR-0012](../../../../docs/adr/0012-a-handoff-transfers-ownership-and-the-model-stops-reading.md)).
    if ((await this.handoff.ownerOf(conversationId)) === "officer") {
      throw new ConflictException("a Support Officer owns this conversation");
    }

    return this.connectorsService.call({
      conversationId,
      connectorId,
      arguments: parsed.data.arguments,
    });
  }

  /**
   * The Platform asking for a human, on one of the four triggers it can see.
   *
   * What comes back is enough to say something true and no more: whether
   * somebody will pick it up now, or the Bank's real hours if they will not.
   * **The hours are a rendered fragment**, because the Middleware holds the
   * setting and the Platform composes the sentence — the same division that made
   * `SurfaceNotApplicable` a code rather than a sentence.
   */
  @Post("conversations/:conversationId/handoff")
  public async raiseHandoff(
    @Param("conversationId") conversationId: string,
    @Body() body: unknown,
  ): Promise<HandoffRaised> {
    const parsed = handoffBody.safeParse(body);
    if (!parsed.success) {
      // Naming the four is deliberate: the Platform asking for a trigger it may
      // not claim is a defect worth a legible message, and the refusal itself is
      // the security property.
      throw new BadRequestException(
        `trigger must be one of ${PLATFORM_TRIGGERS.join(", ")}`,
      );
    }

    return this.handoff.raise(conversationId, parsed.data.trigger, parsed.data.summary);
  }

  /**
   * What is waiting for a Customer who has to come and fetch it.
   *
   * **In-app chat's whole delivery model.** There is no window on that Channel,
   * so an Officer's reply written at 9am is simply there when the Customer next
   * opens the Bank's application — and the Widget asks this on open and while it
   * is open. WhatsApp never uses it: a reply there is pushed through the Graph
   * API by the Middleware itself.
   */
  @Get("conversations/:conversationId/waiting")
  public async waiting(
    @Param("conversationId") conversationId: string,
    @Query("after") after?: string,
  ): Promise<{ messages: readonly { id: string; text: string }[] }> {
    const conversation = await this.conversations.findById(conversationId);
    if (!conversation) throw new BadRequestException("no such conversation");

    const waiting = await this.messages.outboundSince(conversationId, after ?? "0");
    // Only the words. The Platform is not told who wrote them — an Officer's
    // name is already in the sentence the Customer was sent, and everything else
    // about a Handoff is the Middleware's.
    return { messages: waiting.map((message) => ({ id: message.id, text: message.body })) };
  }

  @Post("conversations")
  public async openConversation(@Body() body: unknown): Promise<OpenedConversation> {
    const parsed = openBody.safeParse(body);
    if (!parsed.success) throw new BadRequestException("channel and channelIdentity are required");

    // **A conversation a Support Officer is holding is handed back rather than
    // replaced.** The Platform caches conversation ids in memory, so a restarted
    // process — or a second replica — asks for one it has forgotten. Minting a
    // fresh conversation there would leave the Handoff on the old one and set
    // the Agent answering over an Officer who is still typing.
    const held = await this.handoff.conversationHeldByAnOfficer(
      parsed.data.channel,
      parsed.data.channelIdentity,
    );
    if (held) {
      return {
        conversationId: held,
        identified: (await this.conversations.accountFor(held)) !== undefined,
      };
    }

    return this.conversations.open(parsed.data.channel, parsed.data.channelIdentity);
  }

  /**
   * Whether this conversation is one the Widget may drive.
   *
   * **The Widget must not be able to quote a WhatsApp conversation's id.** That
   * Channel resolves its account through a Binding, so a handset that named one
   * would be reading whichever Customer holds it — and the whole reason in-app
   * chat signs an identity is that a handset's owner picks what it sends.
   *
   * The answer is a bit, and it comes from the conversation's stored `channel`
   * rather than from anything the Platform remembers. An in-memory set in the
   * Platform was the first version of this and was wrong twice over: it does not
   * survive a restart, and a second Platform replica would hold a different one.
   */
  /**
   * Whether this conversation reaches an account, asked without opening one.
   *
   * `POST /platform/conversations` mints a conversation every time it is
   * called, so it cannot be used to re-check identity: the Platform would get a
   * fresh thread per message and the Support Agent's history would vanish. This
   * is the read, and it answers **one bit** — never the account number, which
   * would walk identity through the prompt-injection surface on every turn.
   *
   * It exists because enrollment finishes *here* and the Platform is never told.
   * Without it, a Customer who has just linked keeps being greeted as a
   * stranger for as long as that process lives.
   */
  @Get("conversations/:conversationId/identity")
  public async conversationIdentity(
    @Param("conversationId") conversationId: string,
  ): Promise<{ identified: boolean }> {
    // `accountFor` is the existing answer to "does this reach an account", and
    // it re-reads the Binding every time — so a Customer who enrolled a moment
    // ago is identified from their very next message. **Only the bit crosses
    // this boundary**; the account number it was derived from does not.
    return { identified: (await this.conversations.accountFor(conversationId)) !== undefined };
  }

  @Get("conversations/:conversationId/in-app")
  public async isInAppConversation(
    @Param("conversationId") conversationId: string,
  ): Promise<{ inApp: boolean }> {
    const conversation = await this.conversations.findById(conversationId);
    return { inApp: conversation?.channel === "in_app_chat" };
  }

  /**
   * Opens an in-app chat conversation from the identity the Bank's backend
   * signed.
   *
   * A separate route from the one above rather than a variant of it, because
   * the two are not the same request: WhatsApp names a channel identity we
   * resolve to a Binding, and in-app chat presents an envelope we verify. The
   * envelope is where every secret on this Channel lives, and putting it behind
   * the same body schema as a phone number would make it possible to reach the
   * WhatsApp path with one.
   *
   * **A refusal is a 200 carrying `refused`, not an error.** The Customer sees
   * a plain message either way, and a 4xx here would be a Platform exception
   * for something that is an ordinary answer.
   */
  @Post("conversations/in-app")
  public async openInAppConversation(@Body() body: unknown): Promise<OpenedInAppConversation> {
    const parsed = inAppBody.safeParse(body);
    if (!parsed.success) throw new BadRequestException("a signed identity is required");

    return this.conversations.openInApp(parsed.data.identity);
  }

  @Post("conversations/:conversationId/intents")
  public async submitIntent(
    @Param("conversationId") conversationId: string,
    @Body() body: unknown,
  ): Promise<IntentOutcome> {
    const envelope = intentBody.safeParse(body);
    if (!envelope.success) throw new BadRequestException("an intent is required");

    // The union is closed and validated here as well as at the model boundary.
    // Constrained decoding removes the malformed class upstream; this is the
    // Middleware declining to trust that it did.
    const intent = safeParseIntent(envelope.data.intent);
    if (!intent.ok) throw new BadRequestException("not a recognised intent");

    await this.conversations.touch(conversationId);

    if (!isBankingIntent(intent.intent)) {
      // `unlink` and `reset_pin` are resolved by the model and acted on by
      // neither layer: one becomes a control the Customer taps, the other a
      // sealed surface and a code to the contact on record. Arriving here means
      // the Platform sent an identity Intent to the banking endpoint, which is
      // recorded and refused rather than quietly obliged.
      await this.audit.record({
        action: "intent.submitted",
        actor: { kind: "platform" },
        outcome: "refused",
        conversationId,
        detail: { kind: intent.intent.kind, reason: "not a banking Intent" },
      });
      return { kind: "unsupported" };
    }

    return this.banking.execute(conversationId, intent.intent);
  }

  /**
   * Mints the sealed surface for linking, renewing or resetting a PIN.
   *
   * **Which of the three it is, is the Middleware's to decide**, from the state
   * of the Binding it holds and the Platform does not. The Platform says what
   * the Customer asked for and gets back a token it cannot open.
   */
  @Post("conversations/:conversationId/surface")
  public async surface(
    @Param("conversationId") conversationId: string,
    @Body() body: unknown,
  ): Promise<SurfaceOutcome> {
    const parsed = surfaceBody.safeParse(body);
    if (!parsed.success) throw new BadRequestException("want must be link or pin_reset");

    const conversation = await this.conversations.findById(conversationId);
    if (!conversation) throw new BadRequestException("no such conversation");

    // **In-app chat has no enrollment**, no OTP and no Binding, so there is
    // nothing here to link, renew or revoke — the Bank's application already
    // authenticated the Customer (ADR-0010). A Transaction PIN on this Channel
    // is *chosen* on the Confirmation screen at a Customer's first transfer,
    // and there is no OTP path by which a forgotten one could be replaced.
    //
    // The reason is answered rather than the request refused flatly, because
    // the Platform renders the words and has no way to know which of these two
    // it is: it is not told which Channel it is on, and a sentence inferred
    // from what the Customer asked for is how *"I forgot my PIN"* came to be
    // answered here with a sentence about a phone number.
    if (conversation.channel === "in_app_chat") {
      return {
        outcome: "not_applicable",
        reason: parsed.data.want === "pin_reset" ? "pin_is_chosen_at_first_transfer" : "already_identified",
      };
    }

    const begun = await this.enrollment.begin(conversation.channelIdentity, parsed.data.want);

    switch (begun.outcome) {
      case "started":
        return {
          outcome: "surface",
          purpose: begun.purpose,
          token: begun.token,
          flowId: this.config.whatsapp.flows.enrollmentFlowId,
          // Carried for the same reason every sealed surface carries it, and
          // never reached on this one: enrollment is WhatsApp's alone, and the
          // branch above answers `not_applicable` to a Widget that asks. It is
          // here so that the courier's type is one type rather than two.
          surfaceUrl: widgetSurfaceUrl(this.config.publicBaseUrl),
        };
      case "locked_out":
        return { outcome: "locked_out" };
      case "not_applicable":
        return { outcome: "not_applicable", reason: begun.reason };
    }
  }

  /**
   * Self-serve unlink.
   *
   * Self-serve rather than Handoff-only for the same reason enrolling a new
   * number is: a lost phone cannot wait until Monday. The Platform asks on
   * behalf of a conversation and the Middleware resolves the Binding, so nothing
   * in the prompt-injection surface ever names what is being destroyed.
   */
  @Post("conversations/:conversationId/unlink")
  public async unlink(
    @Param("conversationId") conversationId: string,
  ): Promise<UnlinkOutcome> {
    const binding = await this.conversations.bindingFor(conversationId);
    if (!binding) return { outcome: "not_linked" };

    await this.bindings.revoke(binding.id, { kind: "customer" });
    return { outcome: "unlinked" };
  }
}
