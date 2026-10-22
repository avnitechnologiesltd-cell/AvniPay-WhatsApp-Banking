import { Logger } from "@nestjs/common";

import type { WhatsAppConfig } from "@avni/config";

/**
 * The Middleware's own outbound WhatsApp, and the reason it has one at all.
 *
 * The Platform sends replies; the Middleware sends the handful of things the
 * Platform is not allowed to know about. A transfer's outcome, because the
 * authorisation terminated here (ADR-0007). A Binding revoked by somebody
 * enrolling on a new number. And now a Support Officer's words, because an
 * Officer's reply must not pass through the layer a Customer's text is read into
 * by a model.
 *
 * Two shapes, and the second one exists for one rule. **Past WhatsApp's 24-hour
 * window only an approved template may be sent** — a template is pre-approved
 * wording with variables, not free text, which is exactly why the real content
 * cannot simply be squeezed into one and is held instead.
 *
 * Best-effort throughout. Nothing here may fail the thing that triggered it: a
 * Customer whose money has moved must not have that turn on whether the Graph
 * API accepted a message, and an Officer's reply that WhatsApp declined is still
 * a reply the audit table knows about.
 */

const logger = new Logger("WhatsAppOutbound");

const messagesUrl = (config: WhatsAppConfig): string =>
  `${config.graphApiBaseUrl.replace(/\/+$/, "")}/${config.phoneNumberId}/messages`;

/**
 * A short list of buttons under a line of text.
 *
 * The Platform renders the same shape from an `Outbound` verb, and this is the
 * one place the Middleware needs it: the menu that follows enrollment is sent
 * from *here*, because the walk that earned it terminated here and the Platform
 * is never told it finished.
 *
 * **WhatsApp allows three reply buttons and truncates a title past 20
 * characters.** Both are its limits rather than ours, so they are stated where
 * the payload is built.
 */
export const sendWhatsAppButtons = async (
  config: WhatsAppConfig,
  to: string,
  text: string,
  buttons: readonly { readonly id: string; readonly title: string }[],
): Promise<boolean> =>
  send(config, {
    messaging_product: "whatsapp",
    to,
    type: "interactive",
    interactive: {
      type: "button",
      body: { text },
      action: {
        buttons: buttons.slice(0, 3).map((button) => ({
          type: "reply",
          reply: { id: button.id, title: button.title.slice(0, 20) },
        })),
      },
    },
  });

export const sendWhatsAppText = async (
  config: WhatsAppConfig,
  to: string,
  text: string,
): Promise<boolean> =>
  send(config, { messaging_product: "whatsapp", to, type: "text", text: { body: text } });

/**
 * The one approved template, which reopens a conversation whose window shut.
 *
 * *"We have an update about your transfer, reply to continue."* Since transfers
 * no longer need it (ticket 10), **a late-resolved Handoff is now its only
 * user** — and it still has to be submitted to Meta for approval, which is lead
 * time the Bank has to plan for rather than discover at launch.
 *
 * It carries **no variables**, deliberately. A template with a slot for the
 * Officer's words would be a way to render free text as pre-approved wording,
 * which is the thing the approval process exists to stop.
 */
export const sendWhatsAppReopenTemplate = async (
  config: WhatsAppConfig,
  to: string,
): Promise<boolean> =>
  send(config, {
    messaging_product: "whatsapp",
    to,
    type: "template",
    template: {
      name: config.reopenTemplate.name,
      language: { code: config.reopenTemplate.language },
    },
  });

const send = async (
  config: WhatsAppConfig,
  body: Readonly<Record<string, unknown>>,
): Promise<boolean> => {
  try {
    const response = await fetch(messagesUrl(config), {
      method: "POST",
      headers: {
        authorization: `Bearer ${config.apiToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });

    if (!response.ok) {
      logger.warn({ event: "outbound_not_delivered", status: response.status });
      return false;
    }
    return true;
  } catch (error) {
    logger.warn({
      event: "outbound_not_delivered",
      reason: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
};
