/**
 * What can be recorded, as a closed union.
 *
 * The database column is deliberately open — plain `text`, no enum, no check —
 * so a later slice adds a row type without a schema change. The discipline
 * lives here instead: **open where change is cheap, closed where mistakes are
 * expensive.** A typo in an action name is not a runtime error, it is a row
 * nobody will ever find again, so the compiler catches it rather than the Bank.
 *
 * Adding one is one line here plus its `detail` shape below. No migration.
 */
export const AUDIT_ACTIONS = {
  // --- The Binding, whose whole lifecycle is a security event ---------------
  "binding.created": "A channel identity was bound to an account",
  "binding.renewed": "A dormant Binding was renewed by a code to the contact on record",
  "binding.revoked": "A Binding was destroyed",

  // --- Enrollment ----------------------------------------------------------
  //
  // The Customer sees **one** failure message for a wrong account number, a
  // wrong code, an expired code and a code that was never sent, because telling
  // them apart is an enumeration oracle. These rows are therefore the only place
  // in the system where the four are distinguishable, which makes them load
  // -bearing rather than decorative: without them nobody — not a Support
  // Officer, not an investigator — can ever answer *why did this fail*.
  "enrollment.started": "A Customer opened the enrollment, renewal or PIN reset Flow",
  "enrollment.account_submitted": "An account number was offered for enrollment",
  "enrollment.code_sent": "The Bank was asked to send a one-time code",
  "enrollment.code_checked": "A one-time code was checked",
  "enrollment.locked_out": "A channel identity was locked out of enrollment",
  "enrollment.completed": "An enrollment, renewal or PIN reset finished",

  // --- The Transaction PIN -------------------------------------------------
  "pin.set": "A Customer set or replaced their Transaction PIN",
  "pin.checked": "A Transaction PIN was checked",
  "pin.locked_out": "A Customer was locked out after three wrong PINs",

  // --- Telling a Customer something happened to their access ---------------
  "customer.notified": "A Customer was told about a change to their Binding",

  // --- Reading money -------------------------------------------------------
  "banking.balance_read": "An account's balance was read",
  "banking.transactions_read": "An account's transaction history was read",
  "banking.name_enquiry": "An account number was resolved to the name its own bank holds",

  // --- Moving money --------------------------------------------------------
  //
  // The Bank's compliance function must be able to reconstruct what authorised
  // any given debit, and these rows are that answer: what was proposed, that the
  // Customer authorised it with their PIN, what was sent to BankOne, and what
  // BankOne finally said. The reference ties them all to BankOne's own record of
  // the transfer.
  //
  // Only the last three say **Mandate**, and the vocabulary is doing work: a
  // Mandate is an instruction the Customer has authorised, so the row written
  // before the PIN names a *proposal* instead.
  "transfer.proposed": "A transfer was resolved and shown to the Customer for authorisation",
  "transfer.refused": "An authorisation was refused before any money moved",
  "mandate.authorised": "A Customer authorised a Mandate with their Transaction PIN",
  "mandate.dispatched": "A Mandate was sent to BankOne",
  "mandate.settled": "What BankOne finally said about a Mandate",

  // --- Saved recipients ----------------------------------------------------
  //
  // `resolved` is the row that matters, and it is here because this is the one
  // step in the platform where a Customer's *words* become somebody's account
  // number by inference rather than by instruction. It records what was said,
  // how many records answered to it and which one the Customer settled on, so
  // that "I sent money to the wrong Musa" is a question with an answer.
  "beneficiary.resolved": "A name a Customer said was matched against their Beneficiaries",
  "beneficiary.saved": "A Beneficiary was created or updated by an authorised transfer",
  "beneficiary.forgotten": "A Beneficiary was removed",

  // --- Handing a conversation to a human -----------------------------------
  //
  // The whole arc, because the Handoff is where a Customer stops talking to a
  // machine and starts talking to a named member of the Bank's staff. Who took
  // it, what they said back to whom, and when they let go of it are exactly the
  // questions a complaint about a support conversation starts from — and none
  // of them can be reconstructed afterwards from the conversation alone.
  "handoff.triggered": "A conversation needs a Support Officer",
  "handoff.claimed": "A Support Officer took a conversation out of the Inbox",
  "handoff.replied": "A Support Officer answered a Customer",
  "handoff.resolved": "A Support Officer closed a conversation and gave it back to the Agent",
  // Trigger 1 alone, and it goes to the **Bank** rather than to a Customer: a
  // transfer nobody can account for must never be sitting silently in a queue.
  "handoff.operations_alerted": "The Bank's operations desk was paged about an unresolved transfer",
  "inbox.read": "Somebody read the Inbox, or one conversation in it",

  // --- A Customer's own documents ------------------------------------------
  //
  // Written by the Platform without opening the file, read only by the
  // Dashboard. Both halves are recorded because *who looked at a Customer's
  // documents* is the insider-threat question, and the file itself lives
  // somewhere the audit table cannot describe.
  "attachment.stored": "A file a Customer sent was written to object storage",
  "attachment.read": "Somebody opened a file a Customer sent",

  // --- The Library ---------------------------------------------------------
  //
  // **Model-facing text the Bank wrote**, which is why every one of these rows
  // has a named Administrator against it. A published section is something the
  // Support Agent may quote to a Customer as the Bank's own policy, so *who put
  // this in front of Customers, and when* is a question with the same weight as
  // *who changed the fee*.
  //
  // `library.retrieved` is the other half and is written on the Agent's path
  // rather than a human's: it records **which sections a model was given for one
  // turn**, by title, section and version date, and never their text. The
  // Agent's reply shows what it cited; only this shows what it was offered, and
  // the difference is the whole question when a Customer says they were told
  // something the policy does not say.
  "library.uploaded": "An Administrator uploaded a document to the Library",
  "library.published": "An Administrator published a Library document to the Support Agent",
  "library.withdrawn": "An Administrator took a Library document out of the Support Agent's reach",
  "library.discarded": "An Administrator threw away an unpublished Library draft",
  "library.read": "Somebody read the Library",
  "library.retrieved": "The Support Agent was given Library material for one turn",

  // --- Connectors ----------------------------------------------------------
  //
  // **Registering one grants the Support Agent a capability**, which is why
  // every row here has a named Administrator against it and why the registry
  // rows sit beside the Library's rather than beside the settings.
  //
  // The two call rows are told apart because they answer different questions.
  // `called` is *what the Agent asked for and whether it was allowed* — it is
  // where a refused argument is recorded, which is how the Bank sees what its
  // Support Agent is getting wrong at a measured ~68% tool-calling rate.
  // `dispatched` is *what left the building*: who, which Connector, which
  // Customer, whether Gated fired, and the response **status only, never the
  // body**. A response body is the Bank's data and this table is the one place
  // they look during an investigation.
  //
  // The actor on `dispatched` says which kind of act it was: `customer` where a
  // Gated Connector was authorised with a Transaction PIN, `platform` where the
  // Agent asked and the Binding alone carried it.
  "connector.registered": "An Administrator registered a Connector",
  "connector.changed": "An Administrator changed a registered Connector",
  "connector.retired": "An Administrator took a Connector out of the Support Agent's reach",
  "connector.read": "Somebody read the registered Connectors",
  "connector.called": "The Support Agent asked for a Connector",
  // The Customer's own half, and it is kept apart from `called` for the same
  // reason `transfer.refused` is kept apart from `transfer.proposed`: this row
  // is written when somebody presents a **spent, expired or retired** Gated
  // authorisation at the sealed surface, which is a different event with a
  // different actor from the Agent asking for one in the first place.
  "connector.refused": "A Gated authorisation was refused before the Connector ran",
  "connector.dispatched": "A Connector was called on a Customer's behalf",

  // --- What the Bank configures --------------------------------------------
  //
  // Every one of these rows carries **from what, to what** in its detail. Ticket
  // 22 asked for that shape once rather than per screen, and the tariff is the
  // reason it was worth asking: a fee change alters what a Customer is charged,
  // and *"what was it before"* is the first question about one.
  "settings.read": "Somebody read the platform settings",
  "settings.write": "An Administrator changed a platform setting",
  // Kept apart from `settings.*` because the Bank's compliance function will
  // ask *"who changed what our Customers are charged"*, and an answer that
  // requires filtering a generic settings action by a key buried in JSON is an
  // answer nobody gets to on the first try.
  "tariff.read": "Somebody read the Bank's transfer tariff",
  "tariff.write": "An Administrator changed what Customers are charged to transfer",

  // --- The sealed channel (ADR-0007) ---------------------------------------
  "flow.exchanged": "A Flow posted its contents to the Middleware",
  "flow.refused": "A Flow payload was refused before it was opened",
  // Written by **both doors**, and named for the surface rather than for the
  // Flow because one of the two Channels has none. It is kept separate from
  // `flow.refused` because the two refuse different things: that one is a
  // signature or a keypair, this one is a token presented at the door
  // belonging to the other Channel. `detail.surface` says which door.
  "surface.refused": "A sealed surface exchange was refused at the wrong door",

  // --- The Bank's staff ----------------------------------------------------
  "staff.sign_in": "Somebody tried to sign in to the Dashboard",
  "staff.signed_out": "A session was ended deliberately",
  "staff.account_created": "A staff account was created",
  // Told apart because they are different events with different weight. An
  // *offer* hands a TOTP secret to somebody who has proved only a password, on
  // an unauthenticated route — so it is written whether or not anybody ever
  // comes back to confirm it, and it is the row an investigation into a
  // swapped authenticator would start from.
  "staff.mfa_offered": "A TOTP secret was offered to somebody who proved the password",
  "staff.mfa_enrolled": "A staff account enrolled in MFA",
  "staff.sessions_revoked": "Every session for an account was killed",
  "staff.me_read": "A signed-in member of staff read their own account",

  // --- In-app chat ---------------------------------------------------------
  //
  // Generating a Snippet issues the secret the Bank's backend signs a
  // Customer's identity with, which makes it a high-privilege act alongside
  // Connector registration rather than a settings change. Reading the Snippet
  // is recorded too — it carries no secret, and *who asked the platform for the
  // integration details* is still worth knowing.
  "snippet.issued": "An Administrator generated a Snippet and its signing secret",
  "snippet.read": "Somebody read the Snippet the Bank pastes into their application",
  "snippet.secret_revoked": "An in-app chat signing secret was retired",

  // --- The Dashboard, where looking is the sensitive act -------------------
  //
  // The four `customer.*` rows are the Customers surface, and they are here
  // rather than folded into `banking.*` because they answer a different
  // question. `banking.balance_read` says *what the platform asked BankOne and
  // what BankOne said*; these say **who went looking, and at which Customer** —
  // which is the only question an insider-threat investigation starts from, and
  // the one no other row can answer, because a look that BankOne never heard
  // about leaves no `banking.*` row at all.
  //
  // Every one of them is written for a view that **changes nothing**. That is
  // the point: on this surface reading is the sensitive act.
  "customer.searched": "A Support Officer looked for a Customer",
  "customer.read": "A Support Officer opened a Customer's accounts and balances",
  "customer.transactions_read": "A Support Officer read a Customer's transaction history",
  "customer.beneficiaries_read": "A Support Officer read who a Customer pays",
  "audit.read": "Somebody read the audit log",
  "officers.read": "Somebody read the list of staff accounts",
  "officers.write": "Somebody created or changed a staff account",
  // Told apart from `officers.write` because they are different acts with
  // different consequences. A display name change is what a Customer is told on
  // a Handoff; a password reset means somebody other than the account's owner
  // chose the credential it now has, and every session it held was killed.
  "officers.password_reset": "An Administrator set a new password for a staff account",

  // --- Everything the Platform asked for, whether or not it was granted ----
  "conversation.opened": "The Platform opened a conversation",
  "intent.submitted": "The Platform submitted an Intent",
} as const;

export type AuditAction = keyof typeof AUDIT_ACTIONS;

/**
 * Who acted. `platform` is the Platform acting on a Customer's behalf, and is
 * distinct from `customer` because the two are not the same claim: one is a
 * request from the injection surface, the other is a Customer we identified.
 */
export type ActorKind = "customer" | "officer" | "administrator" | "platform" | "system";

/** How it ended. Four, because *refused* and *unavailable* are not failures. */
export type AuditOutcome = "succeeded" | "failed" | "refused" | "unavailable";

export interface Actor {
  readonly kind: ActorKind;
  /** An Officer's id. Absent for a Customer, who is named by the account. */
  readonly id?: string;
}

/**
 * One thing that happened.
 *
 * Six fields are the contract this table was asked for — who, when, what,
 * which Customer or account, the outcome, and a correlating id. `detail`
 * carries whatever else a row type needs.
 */
export interface AuditRecord {
  readonly action: AuditAction;
  readonly actor: Actor;
  readonly outcome: AuditOutcome;
  readonly accountNumber?: string;
  readonly conversationId?: string;
  readonly requestId?: string;
  readonly detail?: Readonly<Record<string, unknown>>;
}

/** A row as it comes back out. */
export interface AuditEntry {
  readonly id: string;
  readonly recordedAt: Date;
  readonly action: string;
  readonly actorKind: ActorKind;
  readonly actorId: string | null;
  readonly accountNumber: string | null;
  readonly conversationId: string | null;
  readonly requestId: string | null;
  readonly outcome: AuditOutcome;
  readonly detail: Readonly<Record<string, unknown>>;
}

/**
 * Keys that must never reach `detail`, checked at the writer rather than
 * trusted to callers.
 *
 * The audit table is the one place the Bank will look during an investigation,
 * which makes it the worst possible place to accumulate secrets. Ticket 18
 * settled the specific case — a Connector dispatch records the response
 * **status only, never the body** — and this generalises it.
 */
export const FORBIDDEN_DETAIL_KEYS = [
  "pin",
  "transactionpin",
  "password",
  "otp",
  "token",
  "secret",
  "credential",
  "credentials",
  "apikey",
  "authorization",
  "body",
  "responsebody",
] as const;
