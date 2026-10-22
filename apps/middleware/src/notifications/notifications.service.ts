import { Inject, Injectable } from "@nestjs/common";

import type { MiddlewareConfig } from "@avni/config";
import { MENU_BUTTONS, MENU_PROMPT, welcomeAfterEnrollment } from "@avni/intent";

import { AuditRepository } from "../audit/audit.repository";
import { BankIdentityClient } from "../enrollment/bank-identity.client";
import { BANK_IDENTITY_CLIENT, MIDDLEWARE_CONFIG } from "../tokens";
import { sendWhatsAppButtons, sendWhatsAppText } from "./whatsapp";

/**
 * The one thing the Middleware says to a Customer without being asked.
 *
 * It exists for a single rule, and the rule is worth the machinery. Enrolling an
 * account on a new number **auto-revokes** the Binding on the old one, which
 * closes the stolen-phone window from ninety days to minutes. The cost is that a
 * SIM-swap attacker who can receive the Customer's code enrols on their own
 * number and locks the real Customer out as a side effect — and a Handoff would
 * not have prevented that, because the attacker passed the same code an Officer
 * would have relied on.
 *
 * **The mitigation is telling both.** The revoked number hears it from us,
 * because that is a WhatsApp number and we hold it. The contact already on
 * record hears it from the Bank, because we deliberately do not. Between them,
 * a silent takeover becomes one the Customer can report.
 *
 * It is deliberately not a general outbound-messaging service. The Platform
 * sends replies; this sends notices, and there are three of them.
 *
 * The third is a transfer's outcome. It is here rather than in the Platform for
 * the same reason as the other two: the authorisation terminates at the
 * Middleware ([ADR-0007](../../../../docs/adr/0007-flow-confirmations-terminate-at-the-middleware.md)),
 * so the Middleware is the only component that knows what happened, and telling
 * the Platform in order to have it repeat the sentence would walk a Customer's
 * transfer back through the layer the sealed channel exists to bypass.
 */
@Injectable()
export class NotificationsService {
  public constructor(
    @Inject(MIDDLEWARE_CONFIG) private readonly config: MiddlewareConfig,
    @Inject(BANK_IDENTITY_CLIENT) private readonly identity: BankIdentityClient,
    @Inject(AuditRepository) private readonly audit: AuditRepository,
  ) {}

  /**
   * Tells the displaced number, and asks the Bank to tell the contact on record.
   *
   * **Best-effort, both halves.** A Customer whose phone was stolen must be able
   * to enroll on the replacement even if WhatsApp or the Bank's notification
   * service is down, so nothing here can fail the enrollment that triggered it.
   * What did and did not go out is recorded either way — a revocation nobody
   * could be told about is still a revocation the audit table knows.
   */
  public async bindingRevokedByNewEnrollment(
    revokedChannelIdentity: string,
    accountNumber: string,
    requestId: string,
  ): Promise<void> {
    // No account number in the words. This message may be arriving at a handset
    // somebody else now holds, which is the whole reason it is being sent.
    const toldTheOldNumber = await this.say(
      revokedChannelIdentity,
      "WhatsApp banking on this number has been switched off, because the account " +
        "was linked to a different number just now. If that was not you, contact " +
        "the bank immediately.",
    );

    const toldTheContactOnRecord = await this.identity.notify(
      accountNumber,
      "binding_revoked_by_new_enrollment",
      requestId,
    );

    await this.audit.record({
      action: "customer.notified",
      actor: { kind: "system" },
      outcome:
        toldTheOldNumber && toldTheContactOnRecord.outcome === "sent" ? "succeeded" : "unavailable",
      accountNumber,
      requestId,
      detail: {
        event: "binding_revoked_by_new_enrollment",
        revokedNumberTold: toldTheOldNumber,
        contactOnRecordTold: toldTheContactOnRecord.outcome === "sent",
      },
    });
  }

  /**
   * Tells the Customer what became of their transfer, in the conversation they
   * were already in.
   *
   * The Flow's last screen says it too, but a Flow closes and a conversation
   * does not: this is the sentence still there when they come back to look. It
   * is **not Customer-initiated contact** and never refreshes a Binding's
   * dormancy — a message we sent keeping a Binding alive is the failure that
   * rule exists to prevent.
   *
   * Best-effort, like the others. A Customer whose money has moved must not
   * have the outcome of that turn on whether WhatsApp accepted a message, and
   * the audit table records what did and did not go out.
   */
  /**
   * The sentence and the menu a Customer gets the moment they are linked.
   *
   * **Sent from here because enrollment terminates here.** The Flow's last
   * screen says it worked; this says what they can now do, beside the buttons
   * that do it — and the Platform is never told the walk finished, so it cannot
   * send this itself.
   *
   * Best-effort like everything else on this path: a Customer who is linked is
   * linked whether or not the Graph API accepted these two messages.
   */
  public async enrollmentCompleted(
    channelIdentity: string,
    accountNumber: string,
    bankName: string,
  ): Promise<void> {
    const told = await this.say(channelIdentity, welcomeAfterEnrollment(bankName));
    const menuShown = await sendWhatsAppButtons(
      this.config.whatsapp,
      channelIdentity,
      MENU_PROMPT,
      MENU_BUTTONS,
    );

    await this.audit.record({
      action: "customer.notified",
      actor: { kind: "system" },
      outcome: told ? "succeeded" : "unavailable",
      accountNumber,
      detail: { event: "enrollment_completed", told, menuShown },
    });
  }

  public async transferOutcome(
    channelIdentity: string,
    accountNumber: string,
    message: string,
  ): Promise<void> {
    const told = await this.say(channelIdentity, message);

    await this.audit.record({
      action: "customer.notified",
      actor: { kind: "system" },
      outcome: told ? "succeeded" : "unavailable",
      accountNumber,
      detail: { event: "transfer_outcome", told },
    });
  }

  /**
   * The same sentence-after-the-Flow for a **Gated Connector**, and a separate
   * method rather than a shared one with a caller-supplied event name.
   *
   * They are different acts against a Customer's account and the Bank will
   * count them apart: *"what happened to my money"* and *"what was done on my
   * account through support"* are two questions, and a single row type answering
   * both is one that answers neither on the first query.
   */
  public async connectorOutcome(
    channelIdentity: string,
    accountNumber: string,
    message: string,
  ): Promise<void> {
    const told = await this.say(channelIdentity, message);

    await this.audit.record({
      action: "customer.notified",
      actor: { kind: "system" },
      outcome: told ? "succeeded" : "unavailable",
      accountNumber,
      detail: { event: "connector_outcome", told },
    });
  }

  private say(to: string, text: string): Promise<boolean> {
    return sendWhatsAppText(this.config.whatsapp, to, text);
  }
}
