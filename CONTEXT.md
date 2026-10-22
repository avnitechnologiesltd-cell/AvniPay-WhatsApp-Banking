# Avni

A conversational banking and AI customer support platform built for a licensed microfinance bank. Avni is the vendor-built technology layer; the bank holds the licence and owns the regulatory perimeter.

## Language

### Parties

**Bank**:
The licensed microfinance bank this platform is built for. Owns the banking licence, the regulatory perimeter, and the BankOne tenancy.
_Avoid_: Client, customer, tenant

**Customer**:
A person who banks with the Bank and interacts with the platform through a channel.
_Avoid_: User, end user, client

**Support Officer**:
A human employed by the Bank who answers conversations the Support Agent hands off, and who looks up whatever a Customer is asking about. Sees a great deal and changes very little. **Has a display name**, because the Customer is told who they are speaking to — which means a Customer learns a staff member's first name, and that is a deliberate cost rather than an oversight.
_Avoid_: Agent, admin, operator — "agent" is reserved for the AI

**Administrator**:
A human employed by the Bank who configures the platform itself — fees, Connectors, Snippets, business hours, and who the Support Officers are. Every Administrator is also a Support Officer; there are only these two roles.
_Avoid_: Admin, superuser, owner — and never "operator", which suggests running the deployment rather than configuring the product

### Identity

**Binding**:
The record linking a channel identity to a single bank account. Created by enrollment, refreshed by renewal, and destroyed by revocation. One account per channel identity — a Binding reaches that account and no other, even where the same Customer holds several. **A WhatsApp conversation has one; in-app chat has none**, because the Bank's application states the account on every message and a Binding exists only to remember what a channel identity cannot say for itself. A WhatsApp conversation without a Binding is someone enrolling, not someone anonymous.
_Avoid_: Link, mapping, association, enrollment record — enrollment is the act, the Binding is what it leaves behind

### The two layers

**Banking Layer**:
Everything that reads or moves money. Contains no AI of any kind — every instruction reaching it is already structured and already authorised.
_Avoid_: Banking module, core layer

**Orchestration Layer**:
The layer that turns a Customer's natural language into a structured, validated banking instruction. May use an LLM, but only to resolve intent — it never executes a banking operation itself.
_Avoid_: Chatbot, banking bot, AI layer

**Intent**:
A structured representation of what a Customer asked for, produced by the Orchestration Layer. Carries the request and nothing else — no account, no Customer identifier, no authorisation. An Intent cannot move money.
_Avoid_: Command, request, action

**Mandate**:
An instruction the Customer has authorised. The Middleware builds it from an Intent once it has resolved the recipient and verified the Transaction PIN, filling in every field itself. The only thing the Banking Layer will execute.
_Avoid_: Confirmed intent, authorised intent, transaction — each blurs the line this pair exists to draw

### Money movement

**Beneficiary**:
A recipient a Customer has paid before, saved under a name the Customer chose. Searched by that name when a Customer says "send 5000 to Musa". The saved name is the Customer's own label, never proof of who holds the account — the confirmation screen shows the name from name enquiry instead. A Beneficiary also keeps the bank's own name for the account from the day it was saved, so that a later change can be noticed and said out loud.
_Avoid_: Payee, contact, recipient — a recipient is who one transfer pays; a Beneficiary is the saved record

**Label**:
The Customer's own word for a Beneficiary, given in an optional *"Save as"* field on the Confirmation screen and captured **inside the sealed surface** — never asked for in conversation, where the reply would be indistinguishable from a malformed Intent to the model reading it. Searched when a Customer says a name, shown as the title of a Disambiguation row, and **never offered as proof of who holds the account**. At most 24 characters, never all digits, never a bank's name. Duplicates are allowed; an absent one is ordinary, because the bank's own name for the account is searched too.
_Avoid_: Nickname, alias, name — the last is reserved for what a bank reports, which is the thing a label is deliberately not

**Disambiguation screen**:
The screen that asks a Customer which saved Beneficiary they meant, when more than one matches the name they used. Lists each match with the bank's own name for the account, and offers an account number instead. Precedes the confirmation screen; never replaces it.
_Avoid_: Picker, chooser, selection list

**Destination bank**:
The institution an account being paid is held at, named by its **NIBSS code**. Deliberately not *the Bank* — the Bank is one destination bank among the rest, and saying so is what lets a transfer be routed by comparing two codes rather than by asking which kind of transfer it is. The Middleware resolves it from the bank a Customer named, refuses one it cannot place, and shows the institution's own name on the Confirmation screen rather than the Customer's spelling of it.
_Avoid_: Receiving bank, beneficiary bank, other bank — the last is the one word this exists to make unnecessary

**NIBSS code**:
The Nigerian Inter-Bank Settlement System's identifier for a bank, and **the only thing that decides which endpoint moves a transfer**. The Bank's own is configuration; every other bank's comes from a directory the Middleware maintains, because BankOne exposes no bank list. Equal to the Bank's own is intra-bank, anything else is inter-bank, and there is no third answer — a bank that resolves to no code is refused before anything moves.
_Avoid_: Bank code, sort code, routing number — "bank code" is also BankOne's word for other things

**Confirmation screen**:
The screen a Customer sees before entering their Transaction PIN, showing what the Middleware is about to do — amount, destination, and the recipient's name as the recipient's own bank reports it now. The only defence against a well-formed instruction that is nonetheless wrong, so no path to a Mandate skips it.
_Avoid_: Review screen, summary screen

**Transaction PIN**:
A secret the Customer chooses and enters to authorise a Mandate. It reaches the Middleware only, never the Orchestration Layer.
_Avoid_: Password, passcode, OTP — an OTP is sent to the Customer, a Transaction PIN is chosen by them

### Support

**Support Agent**:
The single AI agent that answers Customer questions across all channels on the Bank's behalf, escalating to a Support Officer when it cannot answer.
_Avoid_: Bot, chatbot, assistant — "chatbot" refers to the banking conversation, not this

**Library**:
A body of Bank-provided reference material the Support Agent reads as context — policies, regulations, product documentation. Bank-wide and identical for every Customer, which is why a Customer's own conversation history is not one. Read as text; never called as an action, which is what separates it from a Connector. An Administrator uploads a **document**, reads the extracted text, and **publishes** it as a separate act; a document has **versions** and exactly one is live. The Agent may not state a Bank policy it cannot **cite** — document title, section and version date — so a question with nothing published behind it is a Handoff rather than an answer.
_Avoid_: Knowledge base, corpus, docs, conversation history — and note this is deliberately NOT the software sense of "library"

**Section**:
The grain the Library is stored, retrieved and cited at: the text under one of the Bank's own headings. **A heading is a boundary the Bank already drew**, which is what makes a citation checkable — a Support Officer can hold *"Funds Transfer Policy, Charges, 1 March 2026"* against the document on their desk, and can do nothing at all with *"chunk 14"*.
_Avoid_: Chunk, passage, snippet, excerpt — the first is the one this term exists to refuse

**Connector**:
An HTTP API that the Bank registers at runtime, which the Support Agent may call on a Customer's behalf. The Bank supplies the endpoint, the credentials, and a description of when to use it. The platform does not know what the API does, and does not know where it is hosted — it may or may not be BankOne. A Connector may read or write, and declares whether it is Gated. A Bank with no Connectors registered is an ordinary Bank, not an incomplete one.
_Avoid_: Tool, integration, plugin

**Gated**:
A check the Bank switches on for a Connector. A Gated Connector runs only after the Customer enters their Transaction PIN, every time it is called. The Middleware takes the PIN and dispatches the request; the Support Agent asks for neither and judges nothing.
_Avoid_: Verify User — the withdrawn model that asked three Bank-supplied security questions instead; protected, secured, verified

**Handoff**:
The transfer of a live conversation from the Support Agent to a Support Officer, preserving channel, conversation id and history. **A transfer of ownership, not a mode** — the Agent leaves completely and the Platform makes no model call about that conversation until the Officer resolves it ([ADR-0012](docs/adr/0012-a-handoff-transfers-ownership-and-the-model-stops-reading.md)). Ownership passes when it is *raised*, not when it is claimed, so a Customer waiting in the queue is not answered by a bot. The Customer is told by name in both directions.
_Avoid_: Escalation, transfer, routing — and "escalated mode", which is the thing this is not

**Trigger**:
One of the six named reasons a Handoff is raised, ordered by urgency: a `pending` transfer past the poll bound, the Customer asking for a human, a failed PIN on a Gated Connector, the Agent judging itself unable, a Channel that cannot fulfil the request, and repeated failure on the same Intent. A closed set, and **there is no sentiment trigger** — it was considered and dropped as a second model judgement whose failure mode is bad in both directions.
_Avoid_: Reason, cause, escalation type

**Inbox**:
The surface in the Dashboard where Support Officers see and answer handed-off conversations. One shared list, ordered by trigger urgency and then by arrival. A **claim** is exclusive so two Officers cannot answer at once, and expires on Officer inactivity — returning the conversation to the queue, never to the Agent.
_Avoid_: Queue, ticket list

**Attachment**:
A file a Customer sent. The platform records that one **exists** and stores the bytes in object storage the Platform writes without opening and only the Dashboard reads. The Orchestration Layer is never given a path to one, and an inbound message carrying one never reaches a model at all — caption included, because a document handed to the layer running the LLM is an injection vector with a file extension and the Customer chooses the filename too.
_Avoid_: Upload, media, document — the last is one kind of attachment and also an outbound verb

### Surfaces

**Channel**:
A medium through which a Customer reaches the platform: WhatsApp, or in-app chat inside the Bank's own mobile application. Both carry banking and support alike, and both arrive already identified — WhatsApp by its Binding, in-app chat by the Bank's app having signed the Customer in. There is no anonymous correspondent.
_Avoid_: Live chat, web chat — the chat surface lives inside the Bank's app, not on a public web page, and the difference decides who may use it; surface, endpoint, interface

**Snippet**:
The code the Bank copies from the Dashboard into their own mobile application to add in-app chat. It carries the Customer's identity, signed by the Bank's backend. Once pasted into a shipped application it cannot be recalled.
_Avoid_: SDK, embed code, widget script — the Snippet is what the Bank installs, the Widget is what a Customer sees

**Widget**:
The chat surface the Snippet's loader fetches from the Platform at runtime, and everything rendered inside it. That includes in-app chat's counterpart to a WhatsApp Flow — the Confirmation screen, the Disambiguation screen, the Transaction PIN — and **those sealed surfaces post to the Middleware and never through the Platform**, exactly as a Flow's contents do. Ordinary conversation goes to the Platform on both Channels; only the sealed part is different.
_Avoid_: Modal, dialog, form, component — the Widget is the whole surface, and the part of it that keeps a value out of the transcript is a sealed surface within it

**Said**:
Words a Customer composed themselves. The only thing the Orchestration Layer's model is ever shown, and therefore the platform's injection surface.
_Avoid_: Message, text, input — those cover what a Customer chose too, and the whole point is that they are different

**Chose**:
A Customer's answer given by touching a control the platform rendered, carrying back an identifier the platform itself minted. Routed by code, never by a model.
_Avoid_: Reply, selection, button press — the term is about where the value came from, not how it was pressed

**Dashboard**:
The single web application the Bank's staff use for both banking administration and support. There is exactly one.
_Avoid_: Admin panel, back office, console

**Middleware**:
The only component permitted to speak to BankOne. Translates between the platform's own vocabulary and BankOne's API.
_Avoid_: Adapter, gateway, proxy, integration layer

**BankOne**:
Appzone's cloud-hosted core banking platform, and the Bank's system of record for accounts and balances.
_Avoid_: Core, CBS, core banking
