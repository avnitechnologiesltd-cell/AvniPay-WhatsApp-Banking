# Avni

Open-source WhatsApp and in-app chat banking for microfinance banks on
[BankOne](https://mybankone.com), with AI customer support and a staff Dashboard.

First deployed at a licensed Nigerian microfinance bank. Nothing is tied to that
bank — its name, codes, keys and endpoints all come from configuration.

## What customers can do

- **Check their balance** and recent transactions in chat
- **Link their account** — account number, a one-time code, and a Transaction PIN
- **Send money** to any account, at this bank or another (NIP via BankOne)
- **Pay saved beneficiaries by name** — *"send 5000 to Musa"*
- **Talk to a human** — the AI hands the conversation to a named staff member
- **Send files** for support, stored without the AI ever opening them

## What the bank's staff get

- A **Dashboard** with two roles, password + TOTP sign-in, and a full audit log
- A shared **Inbox** for conversations handed over by the AI
- **Settings** for fees, business hours, alerts and staff accounts — no code change needed
- **Connectors**: plug the bank's own HTTP APIs into the AI assistant, safely

## How it's built

| Part | What it does |
| --- | --- |
| `apps/middleware` | The only part that talks to BankOne and holds credentials or PINs (NestJS) |
| `apps/platform` | WhatsApp and in-app chat, the AI assistant, and support (NestJS) |
| `apps/dashboard` | The staff web app (Next.js) |
| `packages/*` | Shared config, database, intents, and test fakes |

- **TypeScript** throughout, one pnpm workspace
- **Postgres** is the only datastore; S3-compatible storage holds attachments
- **No AI in the banking layer** — the model only reads what the customer means; the Middleware decides and moves money
- Every transfer is confirmed on a sealed WhatsApp Flow screen showing the recipient's real name, then authorised with a PIN

## Quick start

You need Node 22.12+, pnpm 9 (`corepack enable`) and Docker.

```sh
git clone https://github.com/avnitechnologiesltd-cell/AvniPay-WhatsApp-Banking.git avni
cd avni
pnpm install
pnpm db:up        # Postgres in Docker
pnpm typecheck
pnpm test         # runs the whole platform against fake BankOne, WhatsApp, Groq and identity APIs
```

No bank account, WhatsApp number or API key is needed to run the tests.

## Deploying for a bank

```sh
cp .env.example .env                          # fill in every value
docker compose run --rm migrate               # set up the database
docker compose run --rm setup-administrator   # create the first admin
docker compose up -d
```

- **What you'll need:** BankOne API access, a WhatsApp Business account, a Groq API key, and the bank's identity API — see [what the bank must supply](docs/reference/what-the-bank-must-supply.md)
- **Configuration:** every setting is explained in [`.env.example`](.env.example)
- **Operations:** releases, rollbacks and backups are in the [runbook](docs/runbook.md)

## Learn more

- [`docs/overview.md`](docs/overview.md) — the full tour: features, security, configuration and tests
- [`CONTEXT.md`](CONTEXT.md) — the vocabulary (Customer, Binding, Mandate, Handoff…)
- [`docs/adr/`](docs/adr/) — why things are built the way they are

## Contributing

Contributions are welcome — see [`CONTRIBUTING.md`](CONTRIBUTING.md). Report
security issues privately as described in [`SECURITY.md`](SECURITY.md).

## Licence

[Apache License 2.0](LICENSE). Copyright 2026 Avni Technologies Ltd.
