# A Handoff transfers ownership, and the model stops reading

A **Handoff** is the transfer of a live conversation from the Support Agent to a Support Officer. The question the design turns on is what the Agent does next, and there were three plausible answers: stay silent but keep reading, stay and suggest replies to the Officer, or leave.

**It leaves.** While an open Handoff exists on a conversation, **the Platform makes no model call about that conversation at all** — not to classify, not to summarise, not to draft. The `owner` of a conversation is asked of the Middleware on every single turn and never remembered, and `officer` means the turn is recorded and answered with nothing.

## Why the security case decides it, rather than the product case

Silent-but-listening costs the same as leaving and buys nothing. The history is stored either way — a model does not have to be *reading* a conversation to be handed it later — so the only thing the extra model call buys is a live inference on text the platform has no use for yet.

Suggestion mode is a genuine capability increase, and it rests on the same ~68% figure ticket 04 measured, aimed this time at a human who will be inclined to trust it.

The deciding argument is neither of those. **A Handoff is the moment a well-crafted message has the most to gain.** Something has gone wrong enough that a human is being brought in, that human is about to act on what they read, and the conversation is about to be shown to somebody with a Dashboard session. Keeping a model reading through exactly that window is keeping the injection surface open at its most valuable moment. Closing it costs one boolean.

## What follows for everything downstream

This is not a fact about the Handoff slice. It is a constraint on every later one:

- **The Support Agent** (ticket 39) may not be given a suggest-a-reply surface without reopening this decision. There is no *"the Agent is still there, just quiet"* state for it to hook into, because there is no such state.
- **Connectors** (ticket 40) are dispatched by the Agent on a Customer's behalf. A conversation an Officer owns dispatches none, because nothing is resolving intent on it.
- **Attachments** are the same rule with a file attached, and they generalise it: a document handed to the layer running the LLM is an injection vector with a file extension. The Platform downloads the bytes from WhatsApp's media API and writes them to object storage **without opening them**; only the Dashboard reads one back. The Platform is handed an `ObjectWriter` with no `get` on it, so its inability to read a Customer's documents is a compile error rather than a bucket policy.

  **The Library moves the Middleware's half of that and not the Platform's** (ticket 39). A Library document is bytes an *Administrator* supplied and the platform reads on purpose — the opposite rule to an attachment's, in the same bucket under a `library/` prefix — so the Middleware is handed an `ObjectStore` that can put as well as get, and its credential carries write. The property this ADR is about is untouched: the asymmetry that matters was never `put` versus `get`, it was that **the prompt-injection surface has no way to read**, and it still has none.

## Ownership passes at the raise, not at the claim

The Agent leaves when the Handoff is **raised**, not when an Officer claims it. A Customer queueing for a person must not get bot replies while they wait; a queue is not a mode the Agent hangs around in.

The consequence is that an unstaffed queue is silence, and that is deliberate. Out of hours the Customer is told the Bank's real hours — read from a Dashboard setting, never a string we wrote.

**A stuck transfer is the exception, in two separate ways.** It does not wait for business hours: telling a Customer whose money has vanished that somebody will look on Monday is not an answer. And it **also** pages an operations address the Bank configures, *outside* the Inbox — the Handoff still goes into the Inbox, at the top of it, because an Officer has to work the conversation either way. Those are two facts and the code asks them as two predicates, because *when will somebody look at this* and *is somebody woken up* are not the same question and must not change together by accident.

## Considered Options

- **Silent-but-listening.** Rejected: same cost, no benefit, injection surface stays open.
- **Suggestion mode.** Rejected for v1: a real capability increase resting on a 68% classifier, pointed at a human predisposed to trust it. Nothing here forecloses it — it would need this ADR reopened, which is the point.
- **Ownership passes at the claim.** Rejected: it makes the queue a period in which a Customer is answered by a bot that has already told them a human is coming.
- **Auto-return to the Agent on idle.** Rejected outright: a Customer part-way through a sentence to a human suddenly getting an AI is the single worst moment to switch. A lapsed claim returns the conversation to the **queue** and never to the Agent.

## Consequences

**The conversation history has to be stored, and stored in the Middleware.** Until this slice nothing anywhere kept what a Customer said — the Platform answered a message and forgot it, which is fine while an AI is answering and useless the moment a human picks it up. It lives beside the Bindings rather than in the Platform for the reason all per-Customer data does ([ADR-0006](0006-secrets-and-security-records-live-outside-the-platform.md)), and it keeps `said`, `chose` and `event` apart (ticket 11) so an Officer can tell what a Customer typed from what they tapped.

**The Middleware composes and sends Customer-facing messages on a support path.** An Officer's reply is written by a human, stored by the Middleware and — on WhatsApp — pushed out by the Middleware over the Graph API, never handed to the Platform to repeat. That is the same reasoning that already keeps a transfer's outcome out of there ([ADR-0007](0007-flow-confirmations-terminate-at-the-middleware.md)).

**On in-app chat the Platform is still the courier, and that is correct.** The Widget talks to the Platform for all ordinary conversation, so the reply is fetched from the Platform, which reads it from the Middleware and passes it on unread by any model. This is *not* the sealed-surface case: a sealed surface exists for values that must never enter the transcript — a Transaction PIN, an account number — and an Officer's support message **is** the transcript. What ADR-0007 forbids on this Channel is a secret reaching the Platform, and nothing here is one.

**A Platform restart must not hand the conversation back.** The Platform caches conversation ids in memory, so a restarted process asks for one it has forgotten. Opening a conversation for a channel identity an Officer is already holding returns **that** conversation rather than minting a fresh one; otherwise the Handoff stays on the old conversation and the Agent starts answering over a human who is still typing.

**Officers need display names**, because the Customer is told who they are speaking to in both directions. Never silent, either way: swapping a human for an AI without saying so is a disclosure problem for a licensed institution, and it costs two sentences.
