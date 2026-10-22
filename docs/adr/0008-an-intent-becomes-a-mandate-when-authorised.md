# An Intent becomes a Mandate when the Customer authorises it

What the LLM produces and what the Bank executes are two different things, and they get two different types. The Orchestration Layer emits an **Intent**: what the Customer asked for, and nothing else. The Middleware resolves it, shows the Customer what will happen, takes the Transaction PIN, and builds a **Mandate**. Only a Mandate reaches BankOne.

The alternative is one type carrying a status field. It reads as simpler and it is worse, because every function that touches it has to remember to check the status, and nothing catches the one that forgets. With two types, the function that calls BankOne cannot be *called* with an unauthorised request — the mistake stops being a code review problem and becomes impossible to express.

What makes this more than a typing preference is **which fields exist on which type**. An Intent carries the request only:

```
{ kind: "transfer_to_beneficiary", amount: 5000, beneficiaryName: "Musa" }
{ kind: "transfer_to_account",     amount: 2000, accountNumber: "2124955312", bankName: "Access Bank" }
{ kind: "check_balance" }
{ kind: "list_transactions", period: "last_month" }
```

No source account — the Binding names exactly one, so there is nothing to choose. No Customer identifier — [ADR-0006](0006-secrets-and-security-records-live-outside-the-platform.md) forbids the Platform naming whose account to debit. No confirmation flag — that would be the decorative version of [ADR-0001](0001-no-ai-in-the-banking-layer.md).

A Mandate carries what the Middleware determined for itself:

```
{ mandateId, sourceAccount, destinationAccount, destinationBank,
  destinationName, amount, reference, createdAt }
```

`sourceAccount` comes from the Binding. `destinationAccount` comes from resolving the Intent — a Beneficiary lookup, or the account number the Customer gave. `destinationName` comes from **name enquiry**, never from the Beneficiary's saved label: that label is text the Customer typed once, and someone who saved "Musa" against a fraudster's account would otherwise see "Musa" on the confirmation screen and approve it. `reference` is minted here, at most 12 characters, because BankOne's `RetrievalReference` caps there and nothing documents BankOne deduplicating on it (ticket 06) — so the Middleware dedupes itself and reuses the same value for the status query.

So the two types are not the same data in two states. **Every field an attacker would want to control exists only on the Mandate, and only the Middleware writes it.** A prompt-injected Intent can ask for the wrong thing; it cannot name the account, the identity, or the reference.

Two variants for transfers rather than one with nullable fields, because Groq's `strict: true` requires every property present ([`groq-model-selection.md`](../research/groq-model-selection.md)). A single variant would force the model to emit nulls it has to reason about; each variant here is either fully populated or not chosen. The same constraint makes the union closed and every object `additionalProperties: false`, which suits this design rather than fighting it.

## Considered Options

- **One type with a status field.** Rejected: the compiler cannot help, and the fields an attacker wants would exist on the object before anyone authorised anything.
- **The Intent carries the resolved account, and the Middleware verifies it.** Rejected: it holds only while someone remembers to write the check, and it puts the account under the Platform's control in the meantime.

## Consequences

The Middleware, not the Orchestration Layer, resolves a Beneficiary name to an account. The LLM extracts the string "Musa"; it never reads the Beneficiary store. When several Beneficiaries match, the disambiguation screen is the Middleware's to drive.

`strict: true` guarantees the Intent's *shape*, never its *values* — Groq will happily emit a perfectly-formed Intent with the wrong amount in it. Nothing in this ADR fixes that, and nothing can. The confirmation screen is what protects the Customer, which is why [ADR-0007](0007-flow-confirmations-terminate-at-the-middleware.md) cares so much about where it terminates.

Adding a banking capability means adding a variant to this union, which every module compiles against. That is the intended friction: [ADR-0001](0001-no-ai-in-the-banking-layer.md) says a new capability belongs in the Banking Layer, not in the prompt, and a closed union is how that gets enforced rather than merely stated.
