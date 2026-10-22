# The in-app chat snippet carries a signed identity, not an account number

The Bank adds in-app chat by copying a **snippet** from the Dashboard into their mobile application. The snippet takes the Customer's account number, so the platform knows who it is talking to. Everything WhatsApp renders as a **Flow**, in-app chat renders as a **widget** we ship — the bot logic is identical and only the rendering differs.

That is the shape, and it is the right one. **The account number must not travel as a plain value.**

The snippet runs on a Customer's handset, inside an application we do not build. Whatever it sends, the handset's owner can change — that is not a flaw in the Bank's app, it is what client-side code is. And a forged account number is not a small prize here: ticket 10 established that **reads are silent** — balance enquiry and transaction history build no Mandate and take no Transaction PIN, because there is nothing to authorise. So a snippet that trusts the number it is handed is an endpoint that returns any Customer's balance and full transaction history to anyone who edits one field.

**The Bank's own backend signs the identity.** The Dashboard issues a secret when the Bank generates the snippet; the Bank's backend returns an HMAC over the account number and an expiry; the snippet passes that instead. **The Middleware verifies it** and refuses anything unsigned or stale. This is how Intercom's identity verification works, and a bank's security team will recognise it.

> **Amended 2026-08-21.** This sentence originally read *"the platform verifies it"*, which is ambiguous in the one place it must not be: read as the **Platform** deployable it would put the HMAC signing secret inside the prompt-injection surface, which is exactly what [ADR-0006](0006-secrets-and-security-records-live-outside-the-platform.md) exists to prevent. The verifier is the **Middleware**, alongside every other secret. The Platform forwards the envelope when it opens a conversation and receives back a conversation id and the `identified` flag — the same shape ticket 03 already established for the Middleware issuing conversation ids. Nothing else in this ADR changes.

It is roughly five lines on the Bank's side, and they already have somewhere to put them — ticket 20 has them building the identity API for enrollment. This adds no new system to their estate.

## In-app chat has no Binding

A [Binding](../../CONTEXT.md) exists because WhatsApp arrives carrying a phone number that means nothing to us, so the link to an account has to be *stored*. **The Bank's app states the account on every message, so there is nothing to remember and nothing to store.**

This deletes work rather than adding it:

- **No enrollment on in-app chat** — no account-number entry, no OTP, no NUBAN check digit, no enumeration-resistant decoys. The Bank's app already authenticated the Customer.
- **No 90-day inactivity expiry, no renewal, no revocation** on this Channel.
- **Opening the Bank's app does not disturb a WhatsApp Binding.** Had in-app chat created one, ticket 09's one-live-Binding-per-account rule would have revoked a Customer's WhatsApp access every time they opened the app.

The **Transaction PIN** does not follow the Binding, and still applies — a transfer takes the PIN on both Channels. A Customer who has only ever used in-app chat has never enrolled and so has no PIN; the widget sets one at their first transfer, which is enrollment's final step minus the OTP, because the Bank's app has already done that authentication.

## Considered Options

- **The snippet passes a raw account number.** Rejected — this ADR's subject. It reads as the simplest option and is simplest only until someone edits a request.
- **The platform authenticates the Customer itself** — its own login inside the widget. Rejected. It makes a Customer sign in twice inside an application that has already signed them in, and it puts a second credential for a bank account inside a vendor's product.
- **In-app chat creates a Binding like WhatsApp does.** Rejected. Uniformity for its own sake: it would store a fact restated on every message, and collide with one-live-Binding-per-account.

## Consequences

**The widget carries every surface a Flow does**, because the bot logic is shared: the **Confirmation screen**, the **Disambiguation screen**, the optional "Save as" label from ticket 21, the PIN entry, and PIN set-up. Like the Flow, **it posts directly to the Middleware and never through the Platform** ([ADR-0007](0007-flow-confirmations-terminate-at-the-middleware.md)) — the reason is unchanged and is stronger here, since the widget also carries PIN *creation*.

**WhatsApp's constraints are WhatsApp's alone.** In-app chat has no 24-hour window and no template approval, so nothing outbound on this Channel waits on Meta. The approved template ticket 12 inherits is needed for WhatsApp only.

**The snippet is the first code we ship that runs somewhere we do not operate at all.** It needs a version, and a snippet already pasted into a shipped mobile application cannot be recalled or force-upgraded — the platform will be serving an old one for as long as some Customer has not updated the Bank's app. That is a compatibility commitment, and it belongs to the deployment and release decision rather than here.

**The Dashboard gains a snippet-generation screen**, and it issues a signing secret — which makes it a second high-privilege surface alongside Connector registration.

**Commercially, this is the least transferable form of the product.** The Bank embeds a surface; the logic stays with us.
