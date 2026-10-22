# The Middleware is the sole path to BankOne, and the Bank hosts it

BankOne is cloud-hosted, so nothing technically forces an on-premise integration component. We are building one anyway: a single Middleware, deployed on the Bank's own infrastructure, as the only component permitted to hold BankOne credentials or call BankOne.

The reason is a single choke point, not the network topology. Every call that reads or moves money passes through one component, which is what makes a complete audit trail obtainable and what keeps BankOne credentials in one place rather than wherever a feature happened to need them.

> **Corrected.** This ADR originally justified the split on a regulatory *perimeter*: Avni as vendor, the Bank as licensee, credentials kept inside the Bank's walls and out of ours. That reasoning was wrong — every deployable runs on the Bank's infrastructure, so there is no vendor side to keep data away from. The decision stands; [ADR-0006](0006-secrets-and-security-records-live-outside-the-platform.md) restates the reason as blast radius, isolating credentials from the Platform because the Platform is the prompt-injection surface.

## Consequences

We ship a deployment we do not operate. That imposes real constraints: the Middleware needs a versioned release artifact, structured logs we can actually obtain, and a deliberately small API surface — because every change to it is someone else's deploy. Per [ADR-0006](0006-secrets-and-security-records-live-outside-the-platform.md) this applies to all three deployables, not only this one. It also means BankOne may IP-allowlist the Bank's egress address, which would make this the only available topology regardless.
