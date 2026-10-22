# Flow confirmations terminate at the Middleware

A Customer authorises a transfer by entering a **Transaction PIN** into a WhatsApp Flow. Flows in endpoint mode post their contents, encrypted, to a URL we choose. **That URL is the Middleware's, not the Platform's.** The Platform learns that a Mandate was authorised; it never sees the PIN, and it never carries the authorisation.

[ADR-0001](0001-no-ai-in-the-banking-layer.md) promises the Customer confirms through "a Flow the model cannot skip or forge". That promise is only as good as the path the confirmation travels. If the confirmation arrives at the Platform and the Platform then tells the Middleware "the Customer agreed", the Banking Layer is trusting an assertion made by the component that reads attacker-controlled text — and [ADR-0006](0006-secrets-and-security-records-live-outside-the-platform.md) exists precisely because that component is the prompt-injection surface.

The Transaction PIN settles it beyond argument. A PIN is a secret shared between the Customer and the Bank. Routing the Flow through the Platform would put every Customer's PIN, in plaintext, through the layer running the LLM, on every single transfer. No amount of care downstream recovers from that.

The cost is a configuration value. The endpoint URL is already per-deployment — ticket 02 established that Flow ids, phone number ids and key paths must all be configuration rather than constants, because the Bank's WhatsApp account differs from the development one. Pointing that URL at the Middleware changes nothing about how the Flow is built.

## Considered Options

- **The Platform receives the confirmation and passes it on.** Rejected. It makes the invariant an assertion rather than a fact, and it exposes the PIN to the injection surface.
- **The Platform receives it, but carries a token the Middleware verifies.** Rejected. Better than the above, but a compromised Platform that can obtain or replay a token defeats it, and it still sees the PIN. It adds a mechanism without removing the exposure.

## Consequences

The Middleware owns the Flows encryption keypair and the decryption path — the RSA-OAEP unwrap, AES-GCM decrypt, and the bit-flipped-IV re-encryption harvested from `omari core` (ticket 15). That code lands in the Middleware, not the Platform.

The Middleware now has an inbound path from the public internet, which it did not have before. It is a single endpoint that accepts only WhatsApp's encrypted payloads and verifies their signature, but it is exposure that needs to be designed and reviewed rather than assumed.

The Platform must be told when a Mandate completes, because the conversation lives there and the Customer is waiting in it. That notification is the Middleware's to send.

In-app chat has no Flow. It needs an equivalent surface — a widget that posts the PIN to the Middleware directly, never through the Platform — following the pattern [ADR-0005](0005-connector-execution-and-verification-live-in-the-middleware.md) already set for Connector verification. *(That pattern has since collapsed into this one: [ADR-0009](0009-a-gated-connector-takes-the-transaction-pin.md) makes a Gated Connector take the Transaction PIN, so it reuses this surface rather than needing its own.)* *(Written as "live chat"; ticket 11 established that surface is inside the Bank's own mobile application rather than a public web page. The widget is unchanged — only where it lives.)*
