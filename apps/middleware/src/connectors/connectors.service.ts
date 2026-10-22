import { Inject, Injectable, Logger } from "@nestjs/common";

import type { MiddlewareConfig } from "@avni/config";
import type { SealedSurfaceAddress } from "@avni/intent";
import { CLOCK, type Clock } from "@avni/service";

import type { Actor } from "../audit/actions";
import { AuditRepository } from "../audit/audit.repository";
import { unavailableScreen, type FlowScreen } from "../flows/screen";
import { ConversationsService, type Channel } from "../identity/conversations.service";
import { TransactionPinService } from "../pin/transaction-pin.service";
import { NotificationsService } from "../notifications/notifications.service";
import { HandoffService } from "../support/handoff.service";
import { widgetSurfaceUrl } from "../surfaces/address";
import { CONNECTOR_DISPATCHER, MIDDLEWARE_CONFIG } from "../tokens";
import {
  ConnectorsRepository,
  type Connector,
  type ConnectorChanges,
  type ConnectorRequest,
} from "./connectors.repository";
import type { ConnectorDispatcher, DispatchOutcome } from "./dispatcher";
import { endpointProblem } from "./egress";
import {
  checkArguments,
  declarationProblem,
  type ArgumentValue,
  type ConnectorParameter,
} from "./parameters";

/**
 * **Connector registration and dispatch** — the way the Bank adds capability
 * without a release from us, and the single call every rule about it sits
 * behind.
 *
 * An Administrator registers an HTTP API; the Support Agent may ask for it by
 * name; and everything between those two sentences happens here, because the
 * Platform must not be able to skip any of it. Registration, credential
 * resolution, argument checking, the Transaction PIN, egress and the audit row
 * are one method to the caller — {@link call} — and there is no route that
 * performs a subset.
 *
 * Two sentences carry the whole of it:
 *
 * - **Check the number, not the name.** Validating a URL as text is the version
 *   that looks solved and is not; the deny runs on the resolved address, at
 *   connect time, in `dispatcher.ts`.
 * - **Never let the model say who.** The account is injected from the
 *   conversation and the Support Agent cannot supply one — so it can get *what*
 *   wrong and never *who*, which is what makes a ~68% tool-calling rate a failed
 *   call rather than an account takeover.
 *
 * **Gated holds no state.** A `connector_requests` row is the request itself,
 * not a record that anybody verified: there is no expiry to extend, no window
 * lasting a conversation, and nothing a second call can inherit
 * ([ADR-0009](../../../../docs/adr/0009-a-gated-connector-takes-the-transaction-pin.md)).
 */

/** What the Support Agent is told about a Connector. Never the endpoint. */
export interface OfferedConnector {
  readonly id: string;
  readonly name: string;
  /** **Untrusted model-facing text**, wrapped as data on the way to the model. */
  readonly description: string;
  readonly gated: boolean;
  readonly parameters: readonly ConnectorParameter[];
}

/**
 * Roughly where the Support Agent starts choosing badly.
 *
 * Ticket 05's *watch the count*: selection reliability degrades as the list
 * grows, and this is the number the Dashboard warns the Bank at. It bounds
 * nothing — a Bank may register more, and their Agent will simply be worse at
 * picking.
 */
export const CROWDED_CONNECTOR_COUNT = 10;

/**
 * How long a Gated request stands before the Customer has to ask again.
 *
 * The same three hours an unauthorised Mandate gets, and for the same reason:
 * staleness cannot cause a wrong action, because the PIN is still required and
 * the arguments are read from the stored row rather than from the handset.
 * **It is the request's lifetime and not a verification's** — there is no
 * verification here to expire.
 */
const REQUEST_LIFETIME_MS = 3 * 60 * 60 * 1000;

export type RegistrationOutcome =
  | { readonly outcome: "registered"; readonly connector: Connector }
  | { readonly outcome: "changed"; readonly connector: Connector }
  | { readonly outcome: "retired"; readonly connector: Connector }
  | { readonly outcome: "refused"; readonly problem: string };

/**
 * What asking for a Connector produces.
 *
 * Four of the five are refusals of one kind or another, which is the shape this
 * path was designed to have: the model is wrong about a third of the time, and
 * every one of those has to end somewhere honest rather than in a retry loop.
 */
export type ConnectorCallOutcome =
  /** It ran. The body is the Bank's, and is untrusted text on its way back. */
  | { readonly outcome: "answered"; readonly status: number; readonly body: string }
  /**
   * **Gated.** The Customer must enter their Transaction PIN in the same sealed
   * surface a transfer uses, and the Platform couriers two opaque strings.
   */
  | ({ readonly outcome: "authorisation_required" } & SealedSurfaceAddress)
  /** The arguments did not match, or there is no such Connector. A Handoff. */
  | { readonly outcome: "refused"; readonly problem: string }
  /** This conversation reaches no account, so there is no *who* to act on. */
  | { readonly outcome: "not_identified" }
  /** The Bank's endpoint refused, failed, or was never reachable. A Handoff. */
  | { readonly outcome: "unavailable" };

export interface ConnectorScreen extends FlowScreen {
  readonly screen: "CONFIRM" | "DONE" | "LOCKED" | "UNAVAILABLE";
}

/** What a Customer reads on the sealed surface, in the words they will see. */
export const CONNECTOR_WORDS = {
  authorise: "Enter your Transaction PIN to authorise this.",
  wrongPin: "That PIN is not right.",
  attemptsLeft: (left: number) => `${left} ${left === 1 ? "attempt" : "attempts"} left.`,
  lockedOut: "Too many attempts. Please try again in an hour.",
  /**
   * A Customer who has never set a PIN. Only reachable on in-app chat, where
   * there is no enrollment — and it is answered rather than turned into a
   * second place a PIN can be created, because a PIN chosen on a support action
   * is a PIN chosen somewhere nobody decided it could be.
   */
  noPin: "You choose your Transaction PIN the first time you send money here.",
  expired: "This has expired. Please ask again.",
  done: "That's done.",
  didNotGoThrough: "That did not go through. I am passing you to a member of our team.",
} as const;

@Injectable()
export class ConnectorsService {
  private readonly logger = new Logger(ConnectorsService.name);

  public constructor(
    @Inject(ConnectorsRepository) private readonly connectors: ConnectorsRepository,
    @Inject(CONNECTOR_DISPATCHER) private readonly dispatcher: ConnectorDispatcher,
    @Inject(ConversationsService) private readonly conversations: ConversationsService,
    @Inject(TransactionPinService) private readonly pins: TransactionPinService,
    @Inject(HandoffService) private readonly handoff: HandoffService,
    @Inject(NotificationsService) private readonly notifications: NotificationsService,
    @Inject(AuditRepository) private readonly audit: AuditRepository,
    @Inject(MIDDLEWARE_CONFIG) private readonly config: MiddlewareConfig,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  // --- What an Administrator registers ---------------------------------------

  /**
   * Registers a Connector, credential and all.
   *
   * Everything checkable is checked here rather than at the form, because the
   * form is one caller: the endpoint's scheme, the declared parameters, and the
   * rule that **the Customer's identity is never an argument**.
   */
  public async register(
    registration: {
      readonly name: string;
      readonly description: string;
      readonly endpoint: string;
      readonly gated: boolean;
      readonly parameters: readonly ConnectorParameter[];
      readonly credentialHeader: string;
      readonly credential: string;
    },
    by: Actor,
  ): Promise<RegistrationOutcome> {
    const problem = this.registrationProblem(registration);
    if (problem) {
      return this.refuseRegistration("connector.registered", by, problem, {
        connector: registration.name,
      });
    }

    try {
      const connector = await this.connectors.register({ ...registration, by: staffId(by) });

      await this.audit.record({
        action: "connector.registered",
        actor: by,
        outcome: "succeeded",
        detail: {
          connectorId: connector.id,
          connector: connector.name,
          endpoint: connector.endpoint,
          gated: connector.gated,
          parameters: connector.parameters.map((parameter) => parameter.name),
          credentialHeader: connector.credentialHeader,
        },
      });

      return { outcome: "registered", connector };
    } catch (error) {
      // The one refusal Postgres owns: `connectors_one_active_per_name`. Two
      // Connectors answering to one name is the Support Agent reaching whichever
      // row the planner found first.
      return this.refuseRegistration(
        "connector.registered",
        by,
        isDuplicateName(error)
          ? `A Connector called "${registration.name}" is already registered.`
          : "That Connector could not be registered.",
        { connector: registration.name },
      );
    }
  }

  /**
   * Changes one, and **never its name**.
   *
   * The credential is the interesting field: absent leaves the sealed one alone,
   * present replaces it, and there is no third case — because there is no route
   * that reads one back to compare against.
   */
  public async change(
    id: string,
    changes: Omit<ConnectorChanges, "by">,
    by: Actor,
  ): Promise<RegistrationOutcome> {
    const problem = this.changeProblem(changes);
    if (problem) {
      return this.refuseRegistration("connector.changed", by, problem, { connectorId: id });
    }

    const connector = await this.connectors.change(id, { ...changes, by: staffId(by) });
    if (!connector) {
      return this.refuseRegistration(
        "connector.changed",
        by,
        "No such Connector, or it has been retired.",
        { connectorId: id },
      );
    }

    await this.audit.record({
      action: "connector.changed",
      actor: by,
      outcome: "succeeded",
      detail: {
        connectorId: connector.id,
        connector: connector.name,
        // **What changed, by name**, and never a credential's value. The one
        // fact worth recording about a credential is that somebody replaced it.
        changed: Object.keys(changes).filter((key) => key !== "credential"),
        credentialReplaced: changes.credential !== undefined,
        gated: connector.gated,
        endpoint: connector.endpoint,
      },
    });

    return { outcome: "changed", connector };
  }

  /** Takes it out of the Support Agent's reach, in the very next turn. */
  public async retire(id: string, by: Actor): Promise<RegistrationOutcome> {
    const connector = await this.connectors.retire(id, staffId(by));
    if (!connector) {
      return this.refuseRegistration(
        "connector.retired",
        by,
        "No such Connector, or it was already retired.",
        { connectorId: id },
      );
    }

    await this.audit.record({
      action: "connector.retired",
      actor: by,
      outcome: "succeeded",
      detail: { connectorId: connector.id, connector: connector.name },
    });

    return { outcome: "retired", connector };
  }

  /** Everything ever registered, for the Dashboard. Never a credential. */
  public all(): Promise<readonly Connector[]> {
    return this.connectors.all();
  }

  /**
   * What the Support Agent may be offered this turn.
   *
   * **No endpoint and no credential** — the Platform is the prompt-injection
   * surface, and a tool list that carried an address would put the Bank's own
   * API behind one injected instruction
   * ([ADR-0006](../../../../docs/adr/0006-secrets-and-security-records-live-outside-the-platform.md)).
   * What it gets is a name, a sentence and a field list.
   */
  public async catalogue(): Promise<readonly OfferedConnector[]> {
    const active = await this.connectors.active();

    return active.map((connector) => ({
      id: connector.id,
      name: connector.name,
      description: connector.description,
      gated: connector.gated,
      parameters: connector.parameters,
    }));
  }

  // --- What the Support Agent asks for ---------------------------------------

  /**
   * The Support Agent asking for a Connector, on a Customer's behalf.
   *
   * The order below is the design. The account is resolved from the
   * **conversation** before anything else, the arguments are checked against
   * what the Bank declared and **never repaired**, and only then does anything
   * leave this deployable — either straight out to the Bank's endpoint, or into
   * a sealed surface that will take the Customer's Transaction PIN first.
   */
  public async call(request: {
    readonly conversationId: string;
    readonly connectorId: string;
    readonly arguments: unknown;
  }): Promise<ConnectorCallOutcome> {
    const connector = await this.connectors.find(request.connectorId);

    if (!connector || connector.status !== "active") {
      return this.refuseCall(request.conversationId, connector, "no such Connector is registered");
    }

    // **Never from the arguments.** The Middleware injects the account from the
    // conversation, which is what collapses the model's whole error class into
    // *a failed call* — it can be wrong about what to do and cannot be wrong
    // about whose account it is done to.
    const accountNumber = await this.conversations.accountFor(request.conversationId);
    if (!accountNumber) {
      await this.audit.record({
        action: "connector.called",
        actor: { kind: "platform" },
        outcome: "refused",
        conversationId: request.conversationId,
        detail: {
          connectorId: connector.id,
          connector: connector.name,
          reason: "this conversation reaches no account",
        },
      });
      return { outcome: "not_identified" };
    }

    const checked = checkArguments(connector.parameters, request.arguments);
    if (checked.outcome === "refused") {
      // **Refused, never coerced**, and refused *loudly*: this row is how the
      // Bank sees what its Support Agent is getting wrong, and the caller turns
      // it into a Handoff rather than another attempt.
      this.logger.warn({
        event: "connector_arguments_refused",
        connector: connector.name,
        problem: checked.problem,
      });
      await this.audit.record({
        action: "connector.called",
        actor: { kind: "platform" },
        outcome: "refused",
        accountNumber,
        conversationId: request.conversationId,
        detail: {
          connectorId: connector.id,
          connector: connector.name,
          gated: connector.gated,
          // The problem names the field and never quotes the value: a Connector
          // argument is text a model composed out of a Customer's words.
          rejected: checked.problem,
        },
      });
      return { outcome: "refused", problem: checked.problem };
    }

    await this.audit.record({
      action: "connector.called",
      actor: { kind: "platform" },
      outcome: "succeeded",
      accountNumber,
      conversationId: request.conversationId,
      detail: {
        connectorId: connector.id,
        connector: connector.name,
        gated: connector.gated,
        parameters: Object.keys(checked.values),
      },
    });

    if (!connector.gated) {
      return this.toOutcome(
        await this.dispatch(connector, {
          conversationId: request.conversationId,
          accountNumber,
          parameters: checked.values,
          actor: { kind: "platform" },
        }),
      );
    }

    // **Gated: the PIN comes first, every execution.** Nothing has been sent
    // anywhere yet — this mints the sealed surface and stores the arguments,
    // because a value the server holds is not a value the handset can change.
    const token = await this.connectors.requestDispatch({
      connectorId: connector.id,
      conversationId: request.conversationId,
      accountNumber,
      arguments: checked.values,
    });

    return { outcome: "authorisation_required", ...this.surfaceAt(token) };
  }

  // --- The sealed surface, which is the transfer's own -----------------------

  /**
   * Whose sealed surface a token names, so each door drives only its Channel's.
   *
   * The same control the transfer surface is under, and asked of both doors for
   * the same reason: a WhatsApp exchange arrives inside a payload Meta signed
   * and encrypted, the Widget's is plain HTTPS, and a token minted on one must
   * not be authorisable through the other.
   */
  public async surfaceOwner(
    token: string | undefined,
  ): Promise<{ readonly conversationId: string; readonly channel: Channel } | undefined> {
    const request = await this.connectors.requestByToken(token);
    if (!request) return undefined;

    const conversation = await this.conversations.findById(request.conversationId);
    return conversation
      ? { conversationId: request.conversationId, channel: conversation.channel }
      : undefined;
  }

  /** Opening the surface, and going back a screen: *render where I am*. */
  public async open(token: string | undefined): Promise<ConnectorScreen | undefined> {
    const request = await this.connectors.requestByToken(token);
    if (!request) return undefined;

    const connector = await this.connectors.find(request.connectorId);
    if (!connector) return unavailableScreen(CONNECTOR_WORDS.expired);

    const past = await this.spent(request, connector);
    return past ?? this.confirm(request, connector);
  }

  /**
   * The Transaction PIN, on the same sealed surface and against the **same
   * lockout counter** a transfer draws on.
   *
   * Three failures and one hour, shared — one secret gets one budget, because
   * two counters would give an attacker six guesses at four digits instead of
   * three (ADR-0009). The cost is real and accepted: a Customer who fumbles a
   * support action cannot transfer money for an hour.
   */
  public async submitPin(
    token: string | undefined,
    pin: string,
  ): Promise<ConnectorScreen | undefined> {
    const request = await this.connectors.requestByToken(token);
    if (!request) return undefined;

    const connector = await this.connectors.find(request.connectorId);
    if (!connector) return unavailableScreen(CONNECTOR_WORDS.expired);

    // Expiry and replay before the PIN, so a request that could never run does
    // not spend one of the Customer's three attempts.
    const past = await this.spent(request, connector);
    if (past) return past;

    // **Re-asked, never trusted from when the request was written.** A Customer
    // who reports a stolen handset has their Binding revoked in the middle of
    // one of these, and a Gated Connector is a write against their account.
    if ((await this.conversations.accountFor(request.conversationId)) !== request.accountNumber) {
      return unavailableScreen(CONNECTOR_WORDS.expired);
    }

    if (!(await this.pins.isSet(request.accountNumber))) {
      return unavailableScreen(CONNECTOR_WORDS.noPin);
    }

    const check = await this.pins.verify(request.accountNumber, pin, {
      conversationId: request.conversationId,
    });

    switch (check.outcome) {
      case "wrong":
        return this.confirm(
          request,
          connector,
          `${CONNECTOR_WORDS.wrongPin} ${CONNECTOR_WORDS.attemptsLeft(check.attemptsLeft)}`,
        );

      case "locked_out":
        // **Handoff trigger 3**, raised here and reachable from nowhere else:
        // the Platform never sees a PIN, so it cannot know one was wrong. They
        // are locked out for an hour and still need whatever they came for.
        await this.handoff.gatedPinFailed(
          request.conversationId,
          connector.name,
          `The Customer could not authorise ${connector.name} with their Transaction PIN.`,
        );
        return {
          screen: "LOCKED",
          data: { message: CONNECTOR_WORDS.lockedOut },
          terminal: true,
        };

      case "not_set":
        return unavailableScreen(CONNECTOR_WORDS.noPin);

      case "verified":
        break;
    }

    // **Claimed rather than checked.** Two taps on one screen race here, and the
    // loser must not become a second call against the Bank's API.
    const claimed = await this.connectors.claim(request.id);
    if (!claimed) return unavailableScreen(CONNECTOR_WORDS.expired);

    const dispatched = await this.dispatch(connector, {
      conversationId: request.conversationId,
      accountNumber: request.accountNumber,
      parameters: request.arguments as Readonly<Record<string, ArgumentValue>>,
      // The Customer, because they authorised it with a secret only they hold —
      // where an ungated dispatch is the Platform asking on the Agent's behalf.
      actor: { kind: "customer" },
    });

    const succeeded = dispatched.outcome === "answered" && isSuccess(dispatched.status);

    if (!succeeded) {
      // Whatever the Bank's endpoint did, the Customer authorised something that
      // did not happen — which is a human's problem rather than a retry.
      await this.handoff.raise(
        request.conversationId,
        "agent_unable",
        `${connector.name} did not go through after the Customer authorised it.`,
        { connector: connector.name },
      );
    }

    return this.tell(
      request,
      succeeded ? CONNECTOR_WORDS.done : CONNECTOR_WORDS.didNotGoThrough,
    );
  }

  // --- Dispatch --------------------------------------------------------------

  /**
   * The call itself, and the row it leaves behind.
   *
   * **The envelope is ours; the field names inside `parameters` are the Bank's.**
   * The Middleware always sends `POST` with a JSON body — imposing costs a
   * third-party API a thin shim and costs the Bank's own APIs nothing, and it
   * leaves something on our side to validate against rather than pushing every
   * malformed call through to their endpoint.
   */
  private async dispatch(
    connector: Connector,
    call: {
      readonly conversationId: string;
      readonly accountNumber: string;
      readonly parameters: Readonly<Record<string, ArgumentValue>>;
      readonly actor: Actor;
    },
  ): Promise<DispatchOutcome> {
    const credential = await this.connectors.credentialFor(connector.id);
    if (credential === undefined) {
      return { outcome: "refused", problem: "that Connector has no credential stored" };
    }

    const outcome = await this.dispatcher.send({
      endpoint: connector.endpoint,
      headers: { [connector.credentialHeader]: credential },
      body: {
        connector: connector.name,
        // Injected here, and this line is the whole of *never let the model say
        // who*. There is no path by which the Support Agent's arguments reach
        // this field, because it is not one of them.
        account_number: call.accountNumber,
        gated: connector.gated,
        parameters: call.parameters,
      },
    });

    await this.audit.record({
      action: "connector.dispatched",
      actor: call.actor,
      outcome: recordedOutcome(outcome),
      accountNumber: call.accountNumber,
      conversationId: call.conversationId,
      detail: {
        connectorId: connector.id,
        connector: connector.name,
        // Whether Gated fired, which is one of the five things ticket 18 asked
        // this row for.
        gated: connector.gated,
        // **The status only, never the body.** A response body is the Bank's
        // data, we have no reason to retain it, and this table is the one place
        // the Bank looks during an investigation.
        ...(outcome.outcome === "answered" ? { status: outcome.status } : {}),
        ...(outcome.outcome === "answered" ? {} : { problem: outcome.problem }),
      },
    });

    if (outcome.outcome !== "answered") {
      this.logger.warn({
        event: "connector_dispatch_failed",
        connector: connector.name,
        reason: outcome.problem,
      });
    }

    return outcome;
  }

  /** What the Support Agent is told, from what the Bank's endpoint did. */
  private toOutcome(dispatched: DispatchOutcome): ConnectorCallOutcome {
    if (dispatched.outcome !== "answered") return { outcome: "unavailable" };

    // A non-2xx is the Bank's endpoint saying no. It is **not** handed to the
    // Agent as content: an error body read as an answer is how *"your card is
    // blocked"* gets said about a call that failed.
    return isSuccess(dispatched.status)
      ? { outcome: "answered", status: dispatched.status, body: dispatched.body }
      : { outcome: "unavailable" };
  }

  // --- Screens ---------------------------------------------------------------

  /**
   * The Confirmation screen for a Gated Connector: what is about to happen, and
   * four digits.
   *
   * **What the Customer is shown is what they are authorising**, which is the
   * same reason a transfer's Confirmation screen exists. The values come from
   * the stored request rather than from the handset, and they are the arguments
   * a *model* produced — so they are shown as short, labelled fields rather than
   * as a sentence, and nothing here is read back off the payload.
   */
  private async confirm(
    request: ConnectorRequest,
    connector: Connector,
    error?: string,
  ): Promise<ConnectorScreen> {
    return {
      screen: "CONFIRM",
      data: {
        action: connector.name,
        details: detailsOf(connector, request.arguments),
        pin_note: CONNECTOR_WORDS.authorise,
        ...(error ? { error_message: error } : {}),
      },
      terminal: false,
    };
  }

  /**
   * Says it on the screen and in the conversation.
   *
   * The screen is what the Customer is looking at; the message is what is still
   * there when they close the Flow. In the Widget the sealed surface *is* the
   * conversation, so there is nothing to send — the same division the transfer
   * surface is under.
   */
  private async tell(request: ConnectorRequest, message: string): Promise<ConnectorScreen> {
    const conversation = await this.conversations.findById(request.conversationId);

    if (conversation?.channel === "whatsapp") {
      await this.notifications.connectorOutcome(
        conversation.channelIdentity,
        request.accountNumber,
        message,
      );
    }

    return { screen: "DONE", data: { message }, terminal: true };
  }

  /** A request that has been used, or stood too long. Both are terminal. */
  private async spent(
    request: ConnectorRequest,
    connector: Connector,
  ): Promise<ConnectorScreen | undefined> {
    const stale =
      this.clock.now().getTime() - request.createdAt.getTime() > REQUEST_LIFETIME_MS;

    if (request.dispatchedAt || stale || connector.status !== "active") {
      await this.audit.record({
        // **`refused`, not `called`.** The Agent asking is one event with the
        // Platform against it; a Customer presenting a spent or expired
        // authorisation is another, with the Customer against it — the same
        // split `transfer.proposed` and `transfer.refused` already draw.
        action: "connector.refused",
        actor: { kind: "customer" },
        outcome: "refused",
        accountNumber: request.accountNumber,
        conversationId: request.conversationId,
        detail: {
          connectorId: connector.id,
          connector: connector.name,
          reason: request.dispatchedAt
            ? "already authorised"
            : stale
              ? "expired"
              : "the Connector was retired",
        },
      });
      return unavailableScreen(CONNECTOR_WORDS.expired);
    }

    return undefined;
  }

  private surfaceAt(token: string): SealedSurfaceAddress {
    return {
      token,
      // Gated reuses the **transaction PIN Flow**: the Customer enters their PIN
      // where they already enter it, and no second Flow was published for this
      // (ADR-0009).
      flowId: this.config.whatsapp.flows.sendMoneyFlowId,
      surfaceUrl: widgetSurfaceUrl(this.config.publicBaseUrl),
    };
  }

  // --- Refusals, recorded ----------------------------------------------------

  private registrationProblem(registration: {
    readonly description: string;
    readonly endpoint: string;
    readonly parameters: readonly ConnectorParameter[];
    readonly credential: string;
  }): string | undefined {
    const endpoint = endpointProblem(registration.endpoint);
    if (endpoint) return endpoint;

    const parameters = declarationProblem(registration.parameters);
    if (parameters) return parameters;

    if (registration.credential.trim().length === 0) {
      return "A Connector needs a credential. It is entered once and cannot be read back.";
    }

    if (registration.description.trim().length === 0) {
      return "A Connector needs a description. It is what the Support Agent reads to decide whether to call it.";
    }

    return undefined;
  }

  private changeProblem(changes: Omit<ConnectorChanges, "by">): string | undefined {
    if (changes.endpoint !== undefined) {
      const problem = endpointProblem(changes.endpoint);
      if (problem) return problem;
    }

    if (changes.parameters !== undefined) {
      const problem = declarationProblem(changes.parameters);
      if (problem) return problem;
    }

    if (changes.credential !== undefined && changes.credential.trim().length === 0) {
      return "A credential cannot be blank. Leave the field empty to keep the one already stored.";
    }

    return undefined;
  }

  /**
   * @param names Which Connector, **under whichever name the caller has**. A
   * registration is refused before a row exists, so all it can say is the name
   * somebody typed; a change or a retirement names the id it was aimed at. They
   * are separate keys rather than one, because a reader filtering
   * `detail.connector` for a Connector's name should not find a uuid sitting in
   * it.
   */
  private async refuseRegistration(
    action: "connector.registered" | "connector.changed" | "connector.retired",
    by: Actor,
    problem: string,
    names: { readonly connector?: string; readonly connectorId?: string },
  ): Promise<RegistrationOutcome> {
    await this.audit.record({
      action,
      actor: by,
      outcome: "refused",
      detail: { ...names, rejected: problem },
    });
    return { outcome: "refused", problem };
  }

  private async refuseCall(
    conversationId: string,
    connector: Connector | undefined,
    reason: string,
  ): Promise<ConnectorCallOutcome> {
    await this.audit.record({
      action: "connector.called",
      actor: { kind: "platform" },
      outcome: "refused",
      conversationId,
      detail: { ...(connector ? { connectorId: connector.id, connector: connector.name } : {}), reason },
    });
    return { outcome: "refused", problem: reason };
  }
}

/** 2xx and nothing else. A redirect never reaches here; see the dispatcher. */
const isSuccess = (status: number): boolean => status >= 200 && status < 300;

/**
 * How each dispatch ending is recorded.
 *
 * `refused` is ours — egress, a redirect, a missing credential — and is not a
 * failure of the Bank's endpoint. `failed` is nobody answering. A status the
 * endpoint chose is `succeeded` as a *dispatch*, whatever the number says; what
 * the number was is in the row.
 */
const recordedOutcome = (outcome: DispatchOutcome): "succeeded" | "failed" | "refused" => {
  switch (outcome.outcome) {
    case "answered":
      return isSuccess(outcome.status) ? "succeeded" : "failed";
    case "refused":
      return "refused";
    case "unreachable":
      return "failed";
  }
};

/**
 * What the Customer sees they are authorising: one short line per argument.
 *
 * Truncated per field, because these values were produced by a model out of a
 * Customer's own words and this screen is the one place they are rendered back.
 * A long one would be a paragraph of attacker-influenced text on a screen that
 * is asking for a Transaction PIN.
 */
const detailsOf = (
  connector: Connector,
  supplied: Readonly<Record<string, unknown>>,
): string =>
  connector.parameters
    .filter((parameter) => supplied[parameter.name] !== undefined)
    .map((parameter) => `${parameter.name}: ${String(supplied[parameter.name]).slice(0, 60)}`)
    .join("\n");

/** Postgres' unique-violation code, which is the one refusal it owns here. */
const isDuplicateName = (error: unknown): boolean =>
  typeof error === "object" && error !== null && (error as { code?: string }).code === "23505";

/**
 * The staff id every registration is attributed to.
 *
 * **Refused rather than defaulted**, exactly as the Library's is: these columns
 * reference `staff_accounts`, every caller is a Dashboard route that has already
 * resolved a session, and this exists so a future caller that has not cannot
 * write an unattributed row about a capability being granted to the Agent.
 */
const staffId = (by: Actor): string => {
  if (!by.id) throw new Error("A Connector change must be attributed to a member of staff.");
  return by.id;
};
