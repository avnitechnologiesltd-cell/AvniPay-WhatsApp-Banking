# The Banking Layer contains no AI

Every money-moving instruction in this platform originates in natural language, which means an LLM is somewhere upstream of a debit. We decided the LLM resolves **Intent** only — it produces a structured, validated instruction and never executes one. Deterministic, non-AI code in the Banking Layer performs the operation, and the Customer confirms it through a WhatsApp Flow the model cannot skip or forge.

This also binds the Support Agent: it may write, but only by emitting an Intent through the same path as the chatbot. There is exactly one money path, with one audit answer to "what authorised this debit?"

## Considered Options

- **Rigid menus, no language understanding.** Rejected: a USSD menu wearing WhatsApp clothing, and it wastes the channel.
- **Fully agentic — the LLM calls banking APIs as tools.** Rejected: close to undefendable in front of a licensed bank's risk committee, and it makes prompt injection a path to money movement.

## Consequences

Any future feature that wants the model to "just do it" is a violation of this ADR, not a shortcut. If the Support Agent gains a genuinely new capability, the capability belongs in the Banking Layer as a new Intent — not in the prompt.
