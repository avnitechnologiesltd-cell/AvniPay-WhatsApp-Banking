# Avni

Open-source conversational banking and AI customer support for microfinance
banks running on [BankOne](https://mybankone.com). Customers check balances,
link their account, and send money over **WhatsApp** or **in-app chat**; the
Bank's staff answer handed-off conversations from a web **Dashboard**.

It was built for, and first deployed at, a licensed Nigerian microfinance bank.
Nothing in the code is tied to that bank: its name, codes, keys and endpoints
all come from configuration.

Read [`CONTEXT.md`](CONTEXT.md) for the vocabulary and [`docs/adr/`](docs/adr/)
for the decisions.

## Quick start

You need Node 22.12+, pnpm 9 (`corepack enable`), and Docker.

```sh
git clone <this repository> avni && cd avni
pnpm install
pnpm db:up          # Postgres 16 in Docker, on localhost:5432
pnpm typecheck
pnpm test           # boots the whole platform against fake BankOne, WhatsApp, Groq and identity APIs
```

The tests are the fastest way to see it work end to end — no bank account,
WhatsApp number or API key needed. To deploy it for a real bank, read
[Running it](#running-it) below and [`docs/runbook.md`](docs/runbook.md), and
[`docs/reference/what-the-bank-must-supply.md`](docs/reference/what-the-bank-must-supply.md)
for what a bank has to provide.

## What is in here

Three deployables in one pnpm workspace, TypeScript throughout
([ADR-0003](docs/adr/0003-one-repo-three-deployables.md),
[ADR-0004](docs/adr/0004-nestjs-typescript-across-all-deployables.md)):

| Path | Package | What it is |
| --- | --- | --- |
| `apps/middleware` | `@avni/middleware` | The only component that speaks to BankOne, and the only one holding a credential or a security record. NestJS. |
| `apps/platform` | `@avni/platform` | Channels, orchestration and support in one process. NestJS. |
| `apps/dashboard` | `@avni/dashboard` | The web application the Bank's staff sign in to. Next.js. |

The Platform's three modules are separate workspace packages —
`@avni/platform-channels`, `@avni/platform-orchestration`,
`@avni/platform-support` — so the boundaries between them are dependency
boundaries. A forbidden import is one that was never declared, and it fails to
resolve rather than failing review. `tests/module-boundaries.test.ts` holds the
rule; ADR-0003 explains why it is load-bearing.

Shared: `@avni/config` (the one place `process.env` is read), `@avni/db`
(Postgres and the migration step), `@avni/service` (stdout logging, health,
bootstrap, and the S3 object store the two deployables see through different
one-method interfaces), `@avni/intent` (the closed Intent union both the Platform
and the Middleware compile against), and `@avni/fakes` (BankOne, Groq, the
WhatsApp Graph API, the Bank's identity API and the object store as HTTP servers
— test-only, and kept out of every image by a test).

## What works today

A Customer sends *"what's my balance"* to the Bank's WhatsApp number and is told
it. That path cuts every layer, and `tests/balance-enquiry.test.ts` drives it
through the real webhook.

The Bank's staff can sign in — two roles, argon2id, TOTP required for an
Administrator, and server-side sessions that can be killed without a redeploy.
Every Dashboard action writes an audit row, reads included.

A Customer can **link their number**: an account number, a code to a contact
already on record, and a Transaction PIN, all inside a Flow that terminates at
the Middleware. An account number the Bank does not hold walks the same silent
path to the same failure wording, on decoys derived from the account number and
a key; a mistyped digit is caught locally before any call leaves the platform.
Three attempts then an hour, on the number. Linking an account on a new handset
revokes the old Binding and tells both the old number and the contact on record.
A Binding goes quiet after ninety days without Customer-initiated contact and is
renewed by a code alone. A Customer can unlink themselves, and reset a forgotten
PIN over the same code path. `tests/enrollment.test.ts` and
`tests/bindings.test.ts` drive all of it through the real edges.

**The Bank builds five endpoints** for this — `resolve`, `send-otp`,
`verify-otp`, `notify` and `alert-operations`, specified in
[`docs/reference/bank-identity-api.md`](docs/reference/bank-identity-api.md).
BankOne can support none of it. Their service sends the code and the platform
never learns the contact.

A Customer can **send money** to an account number, at this Bank or at another
one. They say it in
their own words; the Middleware runs name enquiry, renders a Confirmation screen
carrying the amount, both accounts, the bank and **the name that account holds
now**, takes the Transaction PIN inside the sealed surface, builds the Mandate
itself and dispatches it. It then polls BankOne's status query inline and answers
in the same turn — and past the poll bound it says the transfer is being followed
up rather than claiming it worked. The Mandate is single-use, expires after three
hours, and carries a reference the Middleware mints and dedupes on, because
BankOne guarantees no idempotency of its own.

**A tampered payload changes nothing.** The only value read out of a returned
payload is the PIN; every other value comes from the Middleware's own stored
Mandate. The published prior-art Flow echoes the amount and the account number
back from the screen the server rendered, which is a ₦900,000 debit against a
₦5,000 confirmation — so the Flows are **republished, not reused**.
`tests/intra-bank-transfer.test.ts` drives all of it, and the attacks are the
tests that matter most in it.

**Whether a transfer is intra- or inter-bank is the Middleware's decision, from
the bank code alone.** The Intent carries no variant for it — that would push a
BankOne implementation detail into the LLM's job — so the bank a Customer named
becomes a NIBSS code first, and the code chooses the endpoint. Inter-bank is NIP
brokered by BankOne, so there is **no separate NIBSS integration**: a second
endpoint, an interbank name enquiry for the recipient's real name, and an
entitlement on the Bank's own token. The codes come from **the Bank's own NIBSS
list**, kept verbatim in the repository so a refresh is a file swap rather than
an edit; a bank that list cannot place is refused, and the Customer is told
*that* rather than told to check a number that may be perfect.
`tests/inter-bank-transfer.test.ts` drives it, and the fake resolves one account
number to a **different person at each bank** — because the first deployment's staging does
not, and the name on that screen is the whole defence.

**The fee on that screen is the Bank's own figure or no figure at all.** An
Administrator enters the tariff on the Dashboard — bands per route, VAT on the
fee — and it is a screen rather than deploy-time configuration because a bank
changes its fees under its own regulator, on its own schedule. With none entered
the screen shows the amount and says fees apply per the account tariff. **It
never invents a number**, which is enforced by there being nowhere for one to
come from except the Bank's own hand.

A Customer can also **send money to somebody they have paid before, by name**.
*"Send 5000 to Musa"* carries only the name and the amount; the Middleware
searches the Customer's own **Beneficiaries** and **resolving one decides what is
offered, never what is sent** — none, one and several all end at the same
Confirmation screen and the same PIN. Several open the **Disambiguation screen**,
which is the Flow's own server-fed list rather than a message the Platform sends,
so the layer that reads Customer text into a model never learns who a Customer
pays and cannot reorder the rows. Nothing matching lands on the account-number
form on that same screen, which is where every Customer's first transfer goes.

**A Beneficiary exists only as the by-product of a PIN-authorised transfer**,
saved at submission and removed again if that transfer is confirmed failed. There
is no save-without-paying, so planting one costs an attacker a real transfer.
The optional *"Save as"* label is captured **inside the Flow**, never asked for
in conversation, because a Customer replying `Musa` to a question is
indistinguishable from a malformed Intent to the model that would read it — so
the one Customer-typed string the resolver searches never passes through the
Platform at all. Records are keyed on the **account**, so revoking a Binding does
not delete them; and when an account's name has changed since it was saved,
**both names are said before the PIN**. *"Forget Musa"* opens the same screen and
a tap is what deletes. `tests/beneficiaries.test.ts` drives all of it.

When the Agent cannot help, the conversation is **handed to a named human** —
and a Handoff is a transfer of ownership rather than a mode. Six triggers, in
urgency order, and no sentiment threshold anywhere. The Support Agent leaves
completely: while an Officer owns the conversation the Platform makes **no model
call about it at all**, which closes the injection surface at exactly the moment
a human is being asked to trust what they are reading
([ADR-0012](docs/adr/0012-a-handoff-transfers-ownership-and-the-model-stops-reading.md)).
Ownership passes when the Handoff is raised rather than when it is claimed, so
nobody queueing for a person is answered by a bot in the meantime.

The Officer works one shared **Inbox**. A claim is exclusive, and it expires when
they go quiet — returning the conversation to the queue, never to the Agent. They
receive the `said`/`chose`/`event` history rather than a flat transcript, the
Agent's own summary, which trigger fired, the account number and the Channel; the
conversation id is preserved rather than minted fresh. **The Customer is told by
name in both directions**, which is why Officers have display names.

Out of hours a Customer is told the Bank's **real** hours, read from a setting
rather than from a string we wrote — the prior art hardcoded *"Mon–Fri, 8am–6pm
WAT"* into a message. A WhatsApp conversation answered after the 24-hour window
is reopened with the one approved template, with the Officer's real words held
until the Customer replies; in-app chat has no window and the reply simply waits.
**A stuck transfer does not queue at all** — it pages an operations address the
Bank configures, outside the Inbox, so a Customer's missing money is never
sitting silently at 3am.

A Customer can send a **file**, which is ordinary support and is also a prompt
injection with a file extension. The Platform moves the bytes into object storage
**without opening them** and only the Dashboard reads one back — the two
deployables are handed different interfaces, so the injection surface's inability
to read a Customer's documents is a compile error rather than a bucket policy.
`tests/handoff.test.ts` and `tests/inbox.test.ts` drive all of it.

The **Settings** screen is the configuration a bank changes without asking a
vendor: the tariff above, the business hours the out-of-hours message reads, the
operations alert address, and Officer accounts with the display names a Customer
is told. Administrator-writes throughout, a Support Officer reads, and every
change writes a row saying who, when, from what and to what.
`tests/settings.test.ts` drives it.

The Library is its own slice.

**Connectors** are how the Bank adds capability without a release from us. An
Administrator registers an HTTP API — endpoint, credential, description,
declared parameters and one **Gated** checkbox — and the Support Agent may call
it for a Customer. The Middleware makes every call, so a Bank credential never
rests in the deployable that reads Customer text into a model, and it is
write-only: unreadable afterwards by anyone, including the Administrator who
entered it and including the Dashboard.

Two sentences carry it. **Check the number, not the name** — the egress deny runs
on the *resolved* address at connect time, the socket goes to that exact address,
the name is never resolved twice, redirects are never followed, and it is HTTPS
with verification on. Validating the URL as text is the version that looks solved
and is not, because a hostname resolves at call time and whoever owns it chooses
what comes back. And **never let the model say who** — the Middleware injects the
account from the conversation, a parameter that names the Customer is refused at
the form, and arguments that do not match the declaration are refused rather than
coerced. `"five thousand"` is not read as `5000`, a refused call becomes a
Handoff rather than a retry, and a Gated Connector takes the Transaction PIN on
every execution through the same sealed surface a transfer uses, against the same
three-attempt, one-hour lockout. Every dispatch writes a row saying who, which
Connector, which Customer, whether Gated fired, and the response **status only,
never the body**. `tests/connectors.test.ts` drives it end to end; the egress
rules are proved against injected DNS in
`apps/middleware/src/connectors/dispatcher.test.ts`, because a fake Bank API is
on loopback and the whole point is that loopback is refused.

**v1 ships with zero Connectors registered**, and the registration screen ships
anyway. A Bank with none is an ordinary Bank rather than an incomplete one.

## Running it

**One VM running Docker Compose is the supported topology** — three containers
plus Postgres and an object store in one file. Compose to Kubernetes is a
migration; Kubernetes down to a VM is a rewrite.

[`docs/runbook.md`](docs/runbook.md) is the operations document: installing,
releasing, rolling back, rotating a credential, what to back up, and **what
staging cannot show you**. This section is the short version.

The object store holds the files Customers send. MinIO in development because it
speaks S3 and runs on the same VM; the Bank may point `ATTACHMENT_STORE_ENDPOINT`
at whatever they run instead. **In production the two credentials must be
asymmetric** — the Platform's write-only against that bucket and the
Middleware's read-only. Compose cannot express a bucket policy, so the bundle
gives both the root credential and the split is held by the interfaces the two
deployables are handed.

```sh
cp .env.example .env                             # every key is required
docker compose run --rm migrate                  # explicit, not part of `up`
docker compose run --rm setup-administrator      # the first Administrator
docker compose up -d
```

Both middle steps are deliberate, and neither runs on `up`. A deployment that migrates itself turns a bad
deploy into a bad database; a deployment that creates an account on its own is
reachable with a known password until somebody notices. `setup-administrator` declines if any
account already exists.

A deployable started against an un-migrated database refuses to serve and says
which migrations are missing.

**Three database logins, not one.** `DATABASE_URL` owns the schema and belongs
to the migration step; the Middleware and the Platform each connect as their
own. The migration step creates those two roles and applies the grants after
every release — the Middleware reads and writes every table and cannot change
the schema, and **the Platform may connect and read `schema_migrations` and
nothing else at all**. It reads that one table because a deployable that refuses
to start against an un-migrated database has to be able to ask whether it was
migrated; the rest is the whole of what it does with Postgres, since it persists
nothing. ADR-0006 says "'The Platform is untrusted' has to be enforced, not
merely intended", and a shared login would leave the Binding and the hashed
Transaction PIN one `SELECT` from the prompt-injection surface.
`tests/database-roles.test.ts` asks Postgres itself, over every table the
migrations create. The step refuses to run if the three URLs do not name three
different logins.

Health checks: `GET /health` on the Middleware and Platform (liveness),
`GET /health/ready` (readiness, which is Postgres and nothing else), and
`GET /api/health` on the Dashboard. Operational logs go to stdout as JSON lines.
Anything load-bearing — enrollment's failure cause, the Mandate lifecycle, every
Dashboard read — goes to the audit table instead, because a table the Dashboard
reads is reachable from a deployment we do not operate and a file on a box is
not.

### Without Docker

```sh
pnpm install
docker compose up -d postgres minio   # the two things that still want a container
pnpm migrate
pnpm --filter @avni/middleware start
pnpm --filter @avni/platform start
pnpm --filter @avni/dashboard dev
```

## Migrations

Versioned, forward-only, additive-first, and never at boot. See
[`packages/db/migrations/README.md`](packages/db/migrations/README.md) for the
naming rule and the reasoning.

**Rollback is redeploying the previous image.** There is no reverse migration to
write, and the runner refuses a directory that contains one. That is only true
while migrations stay additive — add the column, backfill it, switch reads to
it, drop the old one in a later release — so that the previous image can still
serve the newer schema. The `version` field in the health body says which image
is actually running. The full procedure, including what a half-applied release
looks like, is in [`docs/runbook.md`](docs/runbook.md).

## Configuration

One `.env`, against the documented list in
[`.env.example`](.env.example). Key material is **mounted** — `.env` holds the
paths and never the contents, and a value that looks like a PEM is refused at
boot.

Every Flow id, phone number id, key path, external base URL, bank code,
institution code, product code and officer code is read from there, because the
Bank's WhatsApp account and BankOne tenancy are not the development ones.
Staging and production differ only by this file; **no code path branches on
environment**, which is a test rather than a convention —
`tests/configuration-not-constants.test.ts` refuses a source file that writes
the name of an environment or compares one to anything. `DEPLOYMENT_ENVIRONMENT`
exists so a log line and a health body can say where they came from, and a
staging deployment that behaved differently because it knew it was staging would
have stopped being a rehearsal of production.

**What staging cannot show you is written down** rather than discovered:
interbank name enquiry appears stubbed, transaction history is unentitled, and
no staging account is funded — so the name on the Confirmation screen, the
single most important anti-fraud element in the transfer path, cannot be
exercised until production. [`docs/runbook.md`](docs/runbook.md) has the list and
the evidence behind each one.

Two of those keys are worth reading the comments on. `NUBAN_BANK_CODE` is the
Bank's **three-digit CBN** code and not `BANK_CODE`, which is the six-digit NIBSS
one; the NUBAN check digit is computed over the first and pointing it at the
second would reject every real Customer. `ENROLLMENT_DECOY_SECRET` is what keeps
the decoy destinations deterministic without also making them derivable by
anyone who has read the source.

Postgres is the only datastore. No Redis, no second store, no search service.

## Tests

```sh
pnpm test        # needs Postgres: docker compose up -d postgres
pnpm typecheck
```

The seam is the four systems we do not own — BankOne, Groq, the WhatsApp Graph
API, and the Bank's identity API. Everything we build stays real: real Platform,
real Middleware, real Postgres, real HTTP between them.

**The fakes are HTTP servers, not mocked classes**, and that distinction is
load-bearing. BankOne returns `"1,000,000.00"` with separators — `parseFloat` on
that is `1` — spells its success flag two ways, and answers an unentitled
operation with HTTP 200. A mocked adapter class would skip precisely the code
that has to survive all of it.

`tests/harness.ts` boots the whole platform for one test.

The rule of thumb: **if a test would still pass after the money went to the
wrong account, it is testing the wrong thing.**

Some tests guard properties rather than behaviour, and each was checked against
a real violation rather than assumed to work:

| Test | What it refuses |
| --- | --- |
| `module-boundaries` | a Platform module importing a sibling |
| `configuration-not-constants` | a base URL, Flow id or key path written into code, or a branch on which deployment this is |
| `workspace-wiring` | a package missing from one of four hand-kept lists |
| `dependency-injection` | an injected parameter without an explicit token |
| `audit-is-append-only` | a delete, truncate or drop against the audit table |
| `sealed-channel` | the Platform gaining a Flows route or key material |
| `database-roles` | the Platform's login reaching any table the Middleware holds |

Three ports carry **known vectors from outside this codebase**, because a
round-trip through our own code would pass just as happily if the port were
wrong: the Flows crypto (`crypto.test.ts`, `interop.test.ts`) and TOTP
(`totp.test.ts`, against RFC 4226 and RFC 6238).

## Contributing

Contributions are welcome — see [`CONTRIBUTING.md`](CONTRIBUTING.md). To report
a security problem, follow [`SECURITY.md`](SECURITY.md) rather than opening a
public issue.

## Licence

[Apache License 2.0](LICENSE). Copyright 2026 Avni Technologies Ltd.
