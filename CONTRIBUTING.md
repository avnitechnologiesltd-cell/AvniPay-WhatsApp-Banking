# Contributing to Avni

Thanks for helping. This is software that moves people's money, so the bar for
a change is that it is correct and that a test proves it.

## Getting set up

```sh
corepack enable
pnpm install
pnpm db:up
pnpm typecheck && pnpm test
```

## Before you open a pull request

1. **Read the vocabulary and the decisions.** [`CONTEXT.md`](CONTEXT.md) defines
   the terms (Customer, Binding, Mandate, Handoff, …) — use them. The ADRs in
   [`docs/adr/`](docs/adr/) record why things are the way they are; if your change
   contradicts one, say so in the PR and explain why it should be reopened.
2. **Test through the real edges.** The fakes in `packages/fakes` are HTTP
   servers, not mocked classes. A test that would still pass after the money
   went to the wrong account is testing the wrong thing.
3. **No new datastore, and no AI in the banking layer.** See ADR-0001 and
   ADR-0002.
4. **No environment branches and no hard-coded deployment values.** Everything
   that differs between banks belongs in `.env` (see `.env.example`).
   `tests/configuration-not-constants.test.ts` enforces it.
5. `pnpm typecheck` and `pnpm test` pass.

## Reporting bugs and proposing features

Open a GitHub issue with what you expected, what happened, and how to reproduce
it. Never include real account numbers, phone numbers, tokens or keys.

## Licence

By contributing you agree that your contributions are licensed under the
[Apache License 2.0](LICENSE).
