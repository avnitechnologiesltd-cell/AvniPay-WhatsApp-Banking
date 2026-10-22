-- The **Mandate** — an instruction the Customer has authorised, and the only
-- thing the Banking Layer will execute (ADR-0008).
--
-- Every column here is written by the **Middleware**. Nothing on this row comes
-- from the handset except, once, the Transaction PIN that authorises it — which
-- is not stored at all. That is the whole design: an Intent says what the
-- Customer asked for, this says what the Bank will do, and a tampered payload
-- can change neither, because every value is read back from here.
--
-- Additive-first: this migration only creates.

create table mandates (
    id                     uuid        primary key default gen_random_uuid(),

    -- The Flow token, hashed. The handset quotes it back on every screen of the
    -- authorisation surface, so it is a bearer credential and is stored the way
    -- the enrollment and staff session tokens are: a database dump must not be
    -- a set of authorisable transfers.
    --
    -- **This is the only thing that names the Mandate.** Nothing in the payload
    -- identifies the transfer, which is what makes a tampered `amount` or
    -- `account_number` a value with nowhere to go.
    token_hash             text        not null,

    -- Which conversation asked for it, for the audit trail and for telling the
    -- Customer the outcome on the Channel they are already on.
    conversation_id        uuid        not null references conversations (id),

    -- From the Binding, never from the Intent. The Intent names no account and
    -- the Platform could not name one if it tried (ADR-0006).
    source_account         text        not null,

    destination_account    text        not null,

    -- Where the money is going, and which endpoint carried it.
    --
    -- **Routing is a Middleware decision, never an Intent variant** — splitting
    -- intra- and inter-bank upstream would push a BankOne implementation detail
    -- into the LLM's job. What the Middleware decides *from* is the bank the
    -- Customer named, because that is what an Intent carries and v1 maintains no
    -- NIBSS bank-code list; the code below is the one the transfer was actually
    -- sent under, resolved here and stored so an audit can see it.
    destination_bank_code  text        not null,
    destination_bank       text        not null,

    -- **From name enquiry, never from a Beneficiary's saved label.** A label is
    -- text the Customer typed once; someone who saved "Musa" against a
    -- fraudster's account would otherwise see "Musa" on the Confirmation screen
    -- and approve it.
    destination_name       text        not null,

    -- Naira, and never kobo. `numeric` rather than a float, because money that
    -- is off by a rounding error is money that is wrong.
    amount                 numeric(18,2) not null,

    -- Minted here, at most 12 characters because BankOne's `RetrievalReference`
    -- caps there, and unique because **nothing documents BankOne deduplicating
    -- on it** (Appendix A.5). The same value is reused for the status query.
    reference              text        not null,

    created_at             timestamptz not null default now(),

    -- Single-use, enforced by claiming this column rather than by reading it
    -- first and writing it after. Two taps on the same PIN screen race, and the
    -- loser of that race must not be a second debit.
    authorised_at          timestamptz,

    -- Claimed the same way, and for the sharper version of the same rule: a
    -- dispatch that timed out may still have moved money, so a retry asks the
    -- status query about this reference rather than sending the transfer again.
    dispatched_at          timestamptz,

    settled_at             timestamptz,

    -- Null until BankOne has been asked. `pending` is first-class and is not a
    -- failure: it means the platform does not know, which is a different and
    -- truer thing to tell a Customer than either of the other two.
    outcome                text,

    constraint mandates_amount_is_positive
        check (amount > 0),
    constraint mandates_accounts_are_nubans
        check (source_account ~ '^[0-9]{10}$' and destination_account ~ '^[0-9]{10}$'),
    constraint mandates_reference_fits_bankone
        check (char_length(reference) between 1 and 12),
    constraint mandates_outcome_is_known
        check (outcome is null or outcome in ('succeeded', 'failed', 'pending')),
    -- Nothing is dispatched that was not authorised. The types say so in the
    -- application; the schema says so where a future caller cannot argue.
    constraint mandates_dispatch_follows_authorisation
        check (dispatched_at is null or authorised_at is not null)
);

create unique index mandates_by_token on mandates (token_hash);

-- The deduplication itself. BankOne guarantees no idempotency, so a reference
-- that could be minted twice would be a debit that could happen twice.
create unique index mandates_by_reference on mandates (reference);

create index mandates_by_conversation on mandates (conversation_id, created_at desc);
