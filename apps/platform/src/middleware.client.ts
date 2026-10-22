import { Inject, Injectable } from "@nestjs/common";

import type {
  Intent,
  IntentOutcome,
  OpenedConversation,
  SealedSurfaceAddress,
  SurfaceNotApplicable,
} from "@avni/intent";

import type { PlatformConfig } from "@avni/config";
import type {
  ConnectorResult,
  OfferedConnector,
  LibrarySection,
  SupportMessage,
} from "@avni/platform-support";

import { PLATFORM_CONFIG } from "./tokens";

/**
 * A sealed surface, as the courier sees it: two opaque strings and a word for
 * what it is for. There is nothing here the Platform could act on, which is the
 * point — the account, the code and the Transaction PIN all live on the far side
 * of it ([ADR-0007](../../../docs/adr/0007-flow-confirmations-terminate-at-the-middleware.md)).
 */
export type SurfaceResponse =
  | ({
      readonly outcome: "surface";
      readonly purpose: "enrollment" | "renewal" | "pin_reset";
    } & SealedSurfaceAddress)
  | { readonly outcome: "locked_out" }
  | {
      readonly outcome: "not_applicable";
      /**
       * **A code, not a sentence.** The Middleware is the only layer that knows
       * why there is no surface, and this is the only layer that renders words
       * — so it says which, and the words are chosen here. Left as free text it
       * would either be shown to a Customer, which is a Middleware string in a
       * Customer's chat, or ignored, which is what it was.
       *
       * The union is `@avni/intent`'s, so this and the Middleware compile
       * against one closed set rather than two that have to be kept in step.
       */
      readonly reason: SurfaceNotApplicable;
    };

export type UnlinkResponse = { readonly outcome: "unlinked" | "not_linked" };

/**
 * Who is answering this conversation. **Asked every turn and never remembered**
 * — a cached `agent` is a bot talking over a Support Officer.
 */
export type ConversationOwner = "agent" | "officer";

/**
 * The four triggers this deployable may claim.
 *
 * Re-typed here rather than imported, and neither half of that is arbitrary.
 * **The Platform may not depend on `@avni/middleware`** — the prompt-injection
 * surface reaching into the deployable that holds every credential is what
 * [ADR-0006](../../../docs/adr/0006-secrets-and-security-records-live-outside-the-platform.md)
 * exists to prevent, and `tests/module-boundaries.test.ts` refuses the import.
 * And this is not an Intent, so it does not belong in `@avni/intent`, which is
 * the one type both deployables genuinely share.
 *
 * The copy is safe because the Middleware refuses anything outside its own set:
 * a drift is a refused request rather than a silent escalation.
 */
export type PlatformHandoffTrigger =
  | "customer_asked"
  | "agent_unable"
  | "channel_cannot_fulfil"
  | "repeated_failure";

/**
 * What the Middleware answers when a Handoff is raised.
 *
 * **The hours arrive as a rendered fragment, not as the setting.** The Bank's
 * opening hours are configuration the Middleware holds, and this layer composes
 * the sentence around them — the same division that makes a `not_applicable`
 * reason a code rather than a sentence.
 */
export type HandoffRaised =
  | { readonly outcome: "raised"; readonly waiting: "now" }
  | { readonly outcome: "raised"; readonly waiting: "out_of_hours"; readonly hours: string }
  | { readonly outcome: "already_open" }
  | { readonly outcome: "no_such_conversation" };

/** Where a file went, as the courier that moved it reports it. */
export interface StoredAttachment {
  readonly key: string;
  readonly mediaType: string;
  readonly name: string;
}

/** An outbound message a Customer has not been handed yet. Words and an id. */
export interface WaitingMessage {
  readonly id: string;
  readonly text: string;
}

/**
 * What opening an in-app conversation answers.
 *
 * A refusal and nothing more. An edited account number, a stale envelope and
 * one signed with a retired secret are the same answer here, because none of
 * them is this layer's to distinguish and the Customer sees one plain message
 * for all three.
 */
export type OpenedInAppConversation =
  | ({ readonly outcome: "opened" } & OpenedConversation)
  | { readonly outcome: "refused" };

/**
 * The Platform's only route to the Middleware, and therefore its only route to
 * anything that knows who a Customer is.
 *
 * Everything about the trust boundary shows up in this file's types: the
 * Platform sends a channel identity and an Intent, and receives a conversation
 * id, a bit, and an outcome. There is no method here that returns an account
 * number, because there is no endpoint that would.
 *
 * A Middleware outage stops the Platform knowing who anyone is, not merely
 * from moving money. That is the cost ADR-0006 accepted.
 */
@Injectable()
export class MiddlewareClient {
  private readonly baseUrl: string;

  public constructor(@Inject(PLATFORM_CONFIG) config: PlatformConfig) {
    this.baseUrl = config.middlewareBaseUrl.replace(/\/+$/, "");
  }

  public async openConversation(
    channel: "whatsapp" | "in_app_chat",
    channelIdentity: string,
  ): Promise<OpenedConversation> {
    return this.post<OpenedConversation>("/platform/conversations", {
      channel,
      channelIdentity,
    });
  }

  /**
   * Opens an in-app chat conversation from a signed identity envelope.
   *
   * The envelope's type here is the whole of what this deployable is trusted
   * with: `string`. The account number is inside it and the HMAC that proves it
   * is too, and **the secret that verifies the HMAC lives on the far side of
   * this call** — putting it in the Platform would put it in the
   * prompt-injection surface, which is exactly what
   * [ADR-0006](../../../../docs/adr/0006-secrets-and-security-records-live-outside-the-platform.md)
   * exists to prevent.
   *
   * A refusal comes back with no reason. Why it failed is in the Middleware's
   * audit table, where the Bank's mobile engineer can read it and a Customer's
   * words cannot reach it.
   */
  public async openInAppConversation(identity: string): Promise<OpenedInAppConversation> {
    return this.post<OpenedInAppConversation>("/platform/conversations/in-app", { identity });
  }

  /**
   * Whether the Widget may drive this conversation — read from the Channel the
   * Middleware stored, never from anything this deployable remembers.
   */
  /**
   * Whether this conversation reaches an account, without opening a new one.
   *
   * Asked on every message from a Customer this layer has not seen identified,
   * because enrollment finishes at the Middleware and nothing tells the
   * Platform. One bit comes back and never the account number.
   */
  public async isIdentified(conversationId: string): Promise<boolean> {
    const { identified } = await this.get<{ identified: boolean }>(
      `/platform/conversations/${conversationId}/identity`,
    );
    return identified;
  }

  public async isInAppConversation(conversationId: string): Promise<boolean> {
    const { inApp } = await this.get<{ inApp: boolean }>(
      `/platform/conversations/${encodeURIComponent(conversationId)}/in-app`,
    );
    return inApp;
  }

  public async submitIntent(conversationId: string, intent: Intent): Promise<IntentOutcome> {
    return this.post<IntentOutcome>(
      `/platform/conversations/${encodeURIComponent(conversationId)}/intents`,
      { intent },
    );
  }

  /**
   * Asks for the sealed surface that links a number, renews a dormant Binding or
   * resets a forgotten PIN.
   *
   * **Which of the three comes back is not this layer's decision.** It says what
   * the Customer asked for; the Middleware knows whether there is a Binding and
   * whether it has gone quiet, and this deployable is not allowed to.
   */
  public async requestSurface(
    conversationId: string,
    want: "link" | "pin_reset",
  ): Promise<SurfaceResponse> {
    return this.post<SurfaceResponse>(
      `/platform/conversations/${encodeURIComponent(conversationId)}/surface`,
      { want },
    );
  }

  /**
   * Reports one message from the Customer, and asks **who owns the
   * conversation**.
   *
   * One call rather than two on purpose. This deployable must not be able to
   * answer a message before it has been told the owner, and bundling the record
   * with the answer makes skipping the check impossible rather than merely
   * discouraged.
   *
   * `officer` means the Agent has left and this turn reaches no model at all.
   */
  public async recordInbound(
    conversationId: string,
    message: {
      readonly kind: "said" | "chose" | "event";
      readonly body: string;
      readonly attachment?: StoredAttachment;
    },
  ): Promise<{ owner: ConversationOwner }> {
    return this.post<{ owner: ConversationOwner }>(
      `/platform/conversations/${encodeURIComponent(conversationId)}/inbound`,
      message,
    );
  }

  /**
   * Reports what the Agent answered, so an Officer sees what was already tried.
   *
   * `understood` is the whole of Handoff trigger 6 and the count is kept on the
   * far side of this call. A tally in this process would reset on a restart and
   * differ on a second replica, and the Customer would rephrase forever.
   */
  public async recordAgentReply(
    conversationId: string,
    body: string,
    understood: boolean,
  ): Promise<{ handoff: HandoffRaised | null }> {
    return this.post<{ handoff: HandoffRaised | null }>(
      `/platform/conversations/${encodeURIComponent(conversationId)}/outbound`,
      { body, understood },
    );
  }

  /**
   * Asks for a human, on one of the four triggers this layer can honestly see.
   *
   * The other two are the Middleware's. This deployable never sees a Transaction
   * PIN and never dispatches a transfer, so it cannot know a Gated Connector was
   * failed or that money is missing — and the endpoint refuses those claims
   * rather than trusting that nothing here would make them.
   */
  public async requestHandoff(
    conversationId: string,
    trigger: PlatformHandoffTrigger,
    summary: string,
  ): Promise<HandoffRaised> {
    return this.post<HandoffRaised>(
      `/platform/conversations/${encodeURIComponent(conversationId)}/handoff`,
      { trigger, summary },
    );
  }

  /**
   * What is waiting for a Customer who has to come and fetch it — in-app chat's
   * whole delivery model, and never WhatsApp's.
   */
  public async waitingFor(
    conversationId: string,
    after: string,
  ): Promise<readonly WaitingMessage[]> {
    const { messages } = await this.get<{ messages: readonly WaitingMessage[] }>(
      `/platform/conversations/${encodeURIComponent(conversationId)}/waiting` +
        `?after=${encodeURIComponent(after)}`,
    );
    return messages;
  }

  /**
   * **What the Support Agent may quote**, for one turn.
   *
   * The Library is Bank-wide and identical for every Customer, which is why this
   * takes a query and no Customer identifier — and why a Customer's own
   * conversation history is not Library material and is never returned here. An
   * empty list is the answer that matters: it is what makes the Agent say it
   * cannot confirm rather than assert a policy it has no source for.
   *
   * The conversation id is in the path for the audit row and for the ownership
   * check on the far side. It scopes nothing that is read.
   */
  public async searchLibrary(
    conversationId: string,
    query: string,
  ): Promise<readonly LibrarySection[]> {
    const { sections } = await this.post<{ sections: readonly LibrarySection[] }>(
      `/platform/conversations/${encodeURIComponent(conversationId)}/library`,
      { query },
    );
    return sections;
  }

  /**
   * Earlier turns of **this** conversation, for the Support Agent's context.
   *
   * Not retrieval, and not a Library. It is the current conversation, which the
   * model already had within a turn — bounded, scoped by the conversation id,
   * and stripped on the far side of everything a model must not read: a `chose`,
   * an `event`, an Officer's words, and anything that arrived with a file.
   */
  public async agentContext(conversationId: string): Promise<readonly SupportMessage[]> {
    const { messages } = await this.get<{ messages: readonly SupportMessage[] }>(
      `/platform/conversations/${encodeURIComponent(conversationId)}/agent-context`,
    );
    return messages;
  }

  /**
   * **What the Support Agent may call**, this turn.
   *
   * A name, a sentence and a field list per Connector — no endpoint and no
   * credential, because this deployable is the one that reads Customer text into
   * a model. Asked per turn rather than cached, so a Connector an Administrator
   * retires is out of reach in the very next one.
   *
   * It carries no conversation and no Customer identifier, exactly as the
   * registry itself does not: the list is Bank-wide and identical for everyone.
   */
  public async connectors(): Promise<readonly OfferedConnector[]> {
    const { connectors } = await this.get<{ connectors: readonly OfferedConnector[] }>(
      "/platform/connectors",
    );
    return connectors;
  }

  /**
   * Asks for one, on behalf of a conversation.
   *
   * **The account is not a parameter of this method and could not be.** The
   * conversation id is what the Middleware resolves an account from, so the
   * Agent's arguments cannot name a person — which is what turns *"the model is
   * wrong one time in three"* into a failed call rather than a stranger's card
   * being blocked.
   *
   * A Gated Connector comes back as `authorisation_required` with two opaque
   * strings, couriered to the handset exactly as a transfer's are. The
   * Transaction PIN never passes through here (ADR-0007).
   */
  public callConnector(
    conversationId: string,
    connectorId: string,
    args: Readonly<Record<string, unknown>>,
  ): Promise<ConnectorResult> {
    return this.post<ConnectorResult>(
      `/platform/conversations/${encodeURIComponent(conversationId)}/connectors/` +
        `${encodeURIComponent(connectorId)}`,
      { arguments: args },
    );
  }

  /** Destroys the Binding this conversation reaches, whichever one that is. */
  public async unlink(conversationId: string): Promise<UnlinkResponse> {
    return this.post<UnlinkResponse>(
      `/platform/conversations/${encodeURIComponent(conversationId)}/unlink`,
      {},
    );
  }

  private async get<T>(path: string): Promise<T> {
    const response = await fetch(`${this.baseUrl}${path}`, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(20_000),
    });

    if (!response.ok) {
      throw new Error(`The Middleware declined ${path}: HTTP ${response.status}`);
    }
    return (await response.json()) as T;
  }

  private async post<T>(path: string, body: unknown): Promise<T> {
    const response = await fetch(`${this.baseUrl}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(20_000),
    });

    if (!response.ok) {
      throw new Error(`The Middleware declined ${path}: HTTP ${response.status}`);
    }
    return (await response.json()) as T;
  }
}
