# NestJS and TypeScript across all three deployables

All three deployables — `middleware`, `platform`, `dashboard` — are TypeScript, with `middleware` and `platform` built on NestJS.

> **Amendment, ticket 24.** This ADR's title says "across all three deployables" and its body only ever committed NestJS for two. Building the workspace forced the question the gap left open, and the **Dashboard is Next.js** — it is a web application, and Nest has nothing to say about rendering one. The Bank's team operates it the same way: one container, one `.env`, stdout logs. The stack commitment this ADR actually makes — TypeScript everywhere, NestJS where there is a server to build — is unchanged.

The decisive reason is operability, not preference. [ADR-0002](./0002-middleware-is-the-sole-path-to-bankone.md) puts the Middleware on the Bank's own infrastructure, deployed and operated by the Bank's team — and that team is a NestJS shop. Shipping them a service in a stack they do not run contradicts a decision already made: they have to restart it, read its logs, and diagnose it at three in the morning. Beyond that, Nest's module system maps closely onto the four-module decomposition, its DI container makes the Banking Layer's deterministic execution path straightforward to isolate and test, and one language across all three deployables lets the Intent contract be a shared type rather than a documented convention re-implemented twice.

**The stack is chosen for the Bank's ability to operate the system, not for the vendor's leverage over it.** A future reader wondering why this repo follows the client's conventions rather than the author's should read that as deliberate. Continuity of maintenance belongs in the support contract, where the Bank's vendor-risk obligations expect to find it — not in a technology choice engineered to be hard to replace.

## Considered Options

- **Python, porting `omari core` wholesale.** A working implementation exists and this was the fastest-looking path. Rejected: of its ~11K lines, only around 450 survive review (see ticket 15), the tree is mid-refactor with an abandoned duplicate, and the Bank could not operate the result.

## Consequences

The harvest from `omari core` becomes a port rather than a copy. `whatsapp_flow.py` is ~58 lines of `cryptography` calls and rewrites to roughly 40 lines of Node's built-in `crypto` — its value was always the knowledge (RSA-OAEP/SHA-256 unwrap, AES-128-GCM, response re-encrypted under the **same key with a bit-flipped IV**), not the source. `bankone.py` at 394 lines is genuine porting work, guided by [`docs/reference/bankone-api.md`](../reference/bankone-api.md).
