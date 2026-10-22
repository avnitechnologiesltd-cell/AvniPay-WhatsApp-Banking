# One repo, three deployables

The platform decomposes into four modules — middleware, channels, orchestration, support — plus a dashboard. We are shipping them as **three** deployables in **one** repository (pnpm workspaces; NestJS and TypeScript per [ADR-0004](./0004-nestjs-typescript-across-all-deployables.md)):

1. `middleware` — alone, because it holds every credential and every security record, and must stay out of the Platform's blast radius (see [ADR-0006](./0006-secrets-and-security-records-live-outside-the-platform.md)). All three deployables run on the Bank's infrastructure; the separation is a trust boundary, not an ownership one.
2. `platform` — channels, orchestration and support in a single process, with module boundaries enforced in code rather than over the network.
3. `dashboard` — alone, because it is a web application.

The four-module mental model survives intact; what we decline to pay upfront is the distributed-systems tax — five pipelines, five secret stores, and distributed tracing before anything has shipped. Splitting a well-bounded module out later is a day's work. Un-splitting a premature microservice is not.

## Consequences

The module boundaries inside `platform` are load-bearing and must be enforced, not merely intended. If they erode into a ball of mud, the option to split later is lost — which is the entire justification for starting merged.
