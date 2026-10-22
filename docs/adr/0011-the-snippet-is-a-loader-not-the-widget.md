# The Snippet is a loader, not the Widget

[ADR-0010](0010-the-in-app-chat-snippet-carries-a-signed-identity.md) puts a **Snippet** in the Bank's mobile application. Once it ships inside an app on a Customer's handset it **cannot be recalled or force-upgraded** — some Customers will not update for years, and we serve whatever is out there for as long as they do not.

That made it the only commitment on this map that cannot be fixed after the fact. **So the Snippet contains as close to nothing as possible.**

The pasted code is a **loader**: it fetches the real Widget from the Platform at runtime and hands it the signed identity. Everything that might need to change — the Confirmation screen, the Disambiguation screen, PIN entry, PIN creation, wording, layout, a security fix — lives on our side and reaches every Customer at once.

What we freeze is only the **contract between the loader and the server**: a version string and the signed identity envelope. That is the thing we commit to supporting indefinitely, and it is small enough to be worth committing to.

This turns *"we can never change the Widget"* into *"we can never change four lines."*

## Considered Options

- **A self-contained Snippet carrying the Widget code.** Rejected. Every fix would need the Bank to ship a new version of their mobile application, and then wait for Customers to install it. A security fix in a PIN entry screen would land on some handsets in a week and others never.
- **A loader with an auto-updating pinned version.** Rejected as a middle path that keeps the worst of both: still a version to reason about per handset, and still a chance the pinned version is one we want gone.

## Consequences

**In-app chat requires the Platform to be reachable at runtime.** This adds no dependency that was not already there — a chat surface cannot function without the server it talks to — but it does add a failure mode with a face: the loader runs, the Widget does not arrive, and the Customer sees a broken panel inside their bank's app rather than nothing at all. The loader needs a defined failure state, and it should be a plain message rather than an empty box.

**The loader contract is now a public API in the strictest sense.** It is versioned, it is never broken, and it is the one interface on this map with no deprecation path. Treat a change to it as a new version served alongside the old, never as an edit.

**Widget code is served to a mobile application from the Platform**, which is the prompt-injection surface ([ADR-0006](0006-secrets-and-security-records-live-outside-the-platform.md)). The Widget still posts to the **Middleware** and never through the Platform ([ADR-0007](0007-flow-confirmations-terminate-at-the-middleware.md), ADR-0010) — serving the code and receiving the secret stay separate, and that separation is the reason this is safe to do.

> **Clarified 2026-08-22 (ticket 34).** *"The Widget posts to the Middleware and never through the Platform"* — here and in ADR-0010 — is about the **authorisation surfaces**, not about chat. It is the Flow's rule restated, and a Flow's rule has always been about the sealed payload: an ordinary WhatsApp message goes to the Platform and only a Flow's *contents* terminate at the Middleware ([ADR-0007](0007-flow-confirmations-terminate-at-the-middleware.md)). In-app chat is symmetric. A Customer's words go to the Platform, because that is the layer that runs the model and there is nowhere else for them to go; the Confirmation screen, the Disambiguation screen, the "Save as" label and the Transaction PIN post **directly to the Middleware** and never touch it.
>
> Read as *"no in-app byte may reach the Platform"* the sentence would be self-contradicting: the Platform serves the Widget, and a chat surface that could not talk to the layer running the Support Agent could not chat. The invariant that is actually load-bearing is unchanged and is now enforced in code — **the Platform never holds the signing secret and never parses the identity envelope**, which it receives and forwards as one opaque string.

**The Bank installs once.** After the first paste, they never need to ship an app update on our account again, which is worth more to them than to us.
