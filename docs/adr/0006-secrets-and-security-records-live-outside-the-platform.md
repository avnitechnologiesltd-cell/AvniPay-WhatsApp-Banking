# Secrets and security records live outside the Platform

Every deployable — Middleware, Platform and Dashboard — runs on the Bank's infrastructure. Earlier ADRs assumed otherwise, and justified isolating the Middleware on a vendor perimeter: keep regulated data inside the licence holder's walls and out of ours. There are no walls of ours. That reasoning is void, and [ADR-0002](0002-middleware-is-the-sole-path-to-bankone.md) and [ADR-0005](0005-connector-execution-and-verification-live-in-the-middleware.md) have been corrected accordingly.

The isolation stands on different ground. The Platform holds the conversation, which means it feeds attacker-controlled text to an LLM on every inbound message. It is the prompt-injection surface of the system, and the selected model's instruction-following is measurably weak (see `docs/research/groq-model-selection.md`). The Middleware reads no Customer text at all. That asymmetry, not who owns the servers, is what the separation buys — and unlike the perimeter argument it survives any change in hosting.

So the Middleware holds everything an attacker would want and the Platform holds none of it: BankOne credentials, Connector credentials, the Binding between a channel identity and a bank account, and the hashed Transaction PIN. *(Written as "the Verify User record"; [ADR-0009](0009-a-gated-connector-takes-the-transaction-pin.md) withdrew Verify User, and Gated holds no record at all — the PIN it takes is the security record that lives here instead.)* The Platform may cache a Binding in memory for the life of a conversation; it may not persist one.

Two consequences follow that would otherwise look like over-engineering. The Middleware, not the Platform, **issues the conversation id** that security state is keyed to — otherwise the component running the LLM names its own security context, and a Customer who talks the Support Agent into quoting a different id inherits someone else's verified session. And the Middleware answers "which Customer is this channel identity?" on request rather than replicating the Binding table into the Platform, because a copy inside the injection surface is the thing this ADR exists to prevent.

## Consequences

The Platform pays a Middleware round-trip to resolve identity at the start of each conversation. Same infrastructure, and cacheable for that conversation, so the cost is small — but it means a Middleware outage now stops the Platform from knowing who anyone is, not merely from moving money. The Middleware's availability bounds every path, which [ADR-0005](0005-connector-execution-and-verification-live-in-the-middleware.md) already began to concede for the support path.

"The Platform is untrusted" has to be enforced, not merely intended. Any future feature that wants a Customer's account list, name or history close at hand will push toward a local copy, and each such push has to be refused or this ADR decays into a comment.

The Bank now operates all three deployables, not just the Middleware. Release, versioning and log access — which [ADR-0002](0002-middleware-is-the-sole-path-to-bankone.md) treated as a Middleware-specific tax — apply to everything we ship.
