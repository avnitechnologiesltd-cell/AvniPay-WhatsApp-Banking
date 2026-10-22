# A Gated Connector takes the Transaction PIN

A Connector carries one checkbox, named **Gated**. When it is ticked, the Middleware takes the Customer's **Transaction PIN** before it dispatches the request — every execution, not once per conversation. When it is not, the Connector runs on the strength of the Binding alone.

This replaces **Verify User**, which [ADR-0005](0005-connector-execution-and-verification-live-in-the-middleware.md) and ticket 05 defined as three Bank-supplied APIs each asking one security question, all three of which had to pass. That model is withdrawn.

Verify User failed on its own terms. Ticket 18 had already written the objection while specifying it: *a date of birth and a mother's maiden name are findable, and three findable facts are not three factors.* It was authentication built from public information, and its remedy — pushing the Bank to make one of the three an OTP — was a recommendation we could not enforce.

It was also expensive. Three endpoints the Bank had to build before any Connector could be protected, question wording on the registration form, a verification record with a thirty-minute idle clock, and a second WhatsApp Flow beside the transaction one. All of that existed to establish something the Transaction PIN establishes better, using a Flow that already exists.

**The PIN is per execution, not per conversation.** Ticket 10 settled this argument for transfers and rejected tiering: a Binding lives on a handset, so one tap on an unlocked stolen phone is the whole attack, and a Customer who learns that things sometimes happen without their PIN has learned the habit an attacker wants. A Gated Connector is a write against a bank account. The argument transfers unchanged.

**Gated attempts share the transfer lockout counter** — three failures, one hour. Separate counters would give an attacker six guesses at four digits instead of three. It is one secret, so it gets one budget. The coupling is real: a Customer who fumbles a support action cannot transfer money for an hour. We accept that rather than double the guessing budget.

## Consequences

Gated holds **no state**. There is no verification record, no expiry, and no notion of verification lasting a conversation. That removes the verification record from the identity store (ticket 03) and removes the question of whether a Support Officer inherits a Customer's verified state (ticket 12).

The Bank builds nothing. Verify User was one of two things the first deployment's Bank had to construct before this platform was useful; only the identity API (ticket 20) remains.

The Support Agent's role shrinks to nothing here, which is the point. Under Verify User it asked the questions and relayed the answers without judging them — a narrow rule that had to hold under a model ticket 04 measured as following instructions poorly. Under Gated it asks the Middleware to run a Connector and the Middleware does the rest. There is no relay step to get wrong.

**The Transaction PIN's blast radius widens.** It authorised money movement; it now also authorises every Gated Connector the Bank registers. This is contained by the fact that the PIN is still only ever entered into a Flow or widget terminating at the Middleware ([ADR-0007](0007-flow-confirmations-terminate-at-the-middleware.md)) — the Customer enters it nowhere new — but a leaked PIN now costs more than it did.

**It does not fix the contact-change hole.** A Connector is an opaque URL, so the platform still cannot know that one of them changes a phone number, and still cannot force Gated on. The rule that re-verification goes to the contact already on record survives as documentation and the Bank's own care. Gated makes the hole shallower rather than closing it: a PIN is a stronger gate than three findable facts.

Ticket 05's model is superseded except for the parts that did not depend on the questions — that the Middleware makes every Connector call and holds the credentials, that "Officer only" is expressed by not registering a Connector at all, that a Connector's description is untrusted model-facing text, and that the Support Agent chooses worse as the list grows.
