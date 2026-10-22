-- The **Beneficiary** store, and the walk that stands in front of it.
--
-- A Beneficiary is a recipient a Customer has paid before, saved under a name
-- the Customer chose. It exists so that *"send 5000 to Musa"* can be answered at
-- all — and everything about the shape below follows from one sentence:
-- **resolving one decides what is offered, never what is sent**. There is no
-- column here that a transfer reads instead of a name enquiry.
--
-- Additive-first: this migration creates two tables and adds two nullable
-- columns, so the previous image still serves this schema.

-- Where a Customer's saved recipients live.
--
-- **In the Middleware's database** (ADR-0006), because it is per-Customer data
-- and the Orchestration Layer must never read it. BankOne has no Beneficiary
-- concept at all — the word appears once in the whole reference, about a field
-- on an inter-bank transfer — so there is nothing to read from the Bank and
-- nothing to sync with.
create table beneficiaries (
    id                     uuid        primary key default gen_random_uuid(),

    -- **Keyed on the account, not the Binding.** A Binding is revoked whenever a
    -- Customer enrolls a new WhatsApp number, and losing every saved recipient
    -- on a phone change punishes the honest case to defend a rare one. The rare
    -- one — a SIM-swap attacker's planted record surviving the real Customer's
    -- recovery — is real, recorded on ticket 33, and not closed here.
    owner_account          text        not null,

    account_number         text        not null,

    -- The destination bank as a NIBSS code, resolved before the row was written
    -- and stored so that a later transfer to this record routes on the same
    -- comparison every other transfer routes on.
    bank_code              text        not null,
    bank_name              text        not null,

    -- **The bank's own name for the account on the day it was saved.**
    --
    -- Two jobs, and both matter. It is searched alongside the label, which
    -- catches the common case of a Customer saying a surname nobody ever typed
    -- into a "Save as" field. And it is compared against what name enquiry
    -- returns *now*, so that an account which has changed hands can be noticed
    -- and said out loud before the PIN.
    name_at_save           text        not null,

    -- **The Customer's own word for somebody, and never proof of who holds the
    -- account.** The Confirmation screen shows the name enquiry result instead.
    --
    -- Empty is the ordinary case: the "Save as" field is optional, and a record
    -- with no label is still findable through `name_at_save`. Duplicate labels
    -- are allowed — forcing a rename at save time asks the Customer to solve a
    -- problem they do not have yet, and the Disambiguation screen already exists
    -- for the day they do.
    label                  text        not null default '',

    -- **Which authorised transfer brought this row into existence.**
    --
    -- This is what makes "removed if the transfer is later confirmed failed"
    -- safe to perform. A transfer that fails deletes only the record it
    -- *created*; a second payment to somebody already saved leaves their record
    -- alone, because that record was not this transfer's to remove.
    created_by_mandate_id  uuid        references mandates (id) on delete set null,

    created_at             timestamptz not null default now(),

    -- Most-recently-used decides the order of the Disambiguation screen, and
    -- therefore which rows a cap drops.
    last_used_at           timestamptz not null default now(),

    constraint beneficiaries_account_is_a_nuban
        check (owner_account ~ '^[0-9]{10}$' and account_number ~ '^[0-9]{10}$'),
    -- Where WhatsApp truncates a list row title. A longer label would be
    -- silently cut at the exact moment a Customer is choosing between two
    -- similar records, which is the one moment the screen exists for.
    constraint beneficiaries_label_fits_a_row
        check (char_length(label) <= 24)
);

-- One record per account a Customer pays, at the bank they pay it at. Paying
-- somebody a second time updates their record rather than adding another, so a
-- Customer's own list does not fill with the same person.
create unique index beneficiaries_by_account
    on beneficiaries (owner_account, bank_code, account_number);

-- How resolution reads the store: one Customer's records, newest use first.
create index beneficiaries_by_owner on beneficiaries (owner_account, last_used_at desc);

-- A transfer that has been asked for and has no destination yet.
--
-- **The Confirmation screen cannot be reached until something is a destination**
-- — the Customer named a person, and one of *none*, *one* or *several* saved
-- records answers to that name. Only the middle case can go straight to a
-- Mandate. The other two need a screen first, and this row is what that screen
-- is rendered from: the token the handset holds names this, and the Mandate is
-- written underneath it once a destination exists.
--
-- The amount lives here rather than in the payload for the same reason it lives
-- on the Mandate: the handset owns the plaintext it sends, and a value the
-- server rendered must never come back from it.
create table transfer_walks (
    id                     uuid        primary key default gen_random_uuid(),

    -- The Flow token, hashed, exactly as `mandates.token_hash` is. It is a
    -- bearer credential living on a handset, and a database dump must not be a
    -- set of openable surfaces.
    token_hash             text        not null,

    conversation_id        uuid        not null references conversations (id),

    -- From the Binding, never from the Intent. Also the key the store is read
    -- under, so a tapped row that belongs to somebody else resolves to nothing.
    source_account         text        not null,

    -- **What the Customer said**, kept so that a `BACK` re-renders the same
    -- list rather than a different one. It is a string a model extracted and it
    -- is never shown to a Customer as though the platform had understood it.
    said_name              text        not null,

    -- `transfer` proposes; `forget` deletes the tapped record and moves no
    -- money. One screen serves both, which is what makes *"forget Musa"* handle
    -- two Musas correctly without a second surface.
    purpose                text        not null,

    -- Naira. Null on a `forget` walk, which has no amount to carry.
    amount                 numeric(18,2),

    -- The proposal this walk has resolved to, once it has one. Null until the
    -- Customer has chosen a recipient or typed an account number.
    mandate_id             uuid        references mandates (id) on delete set null,

    created_at             timestamptz not null default now(),

    constraint transfer_walks_purpose_is_known
        check (purpose in ('transfer', 'forget')),
    constraint transfer_walks_account_is_a_nuban
        check (source_account ~ '^[0-9]{10}$'),
    -- A transfer walk carries an amount and a forget walk does not. Neither is
    -- a shape the other should be able to wear.
    constraint transfer_walks_amount_matches_purpose
        check ((purpose = 'transfer') = (amount is not null)),
    constraint transfer_walks_amount_is_positive
        check (amount is null or amount > 0)
);

create unique index transfer_walks_by_token on transfer_walks (token_hash);

-- What the Customer's own store contributed to this transfer.
--
-- Both are null on a transfer to a typed account number, which is every
-- Customer's first one.
alter table mandates add column beneficiary_id uuid references beneficiaries (id) on delete set null;

-- **The bank's name for this account on the day it was saved**, copied onto the
-- proposal so the comparison is made against the value the Customer approved
-- rather than against a record that may have moved since.
--
-- When it differs from what name enquiry returns now, both names are said before
-- the PIN: *"This account is now CHIDI EZE. It was M. O. OKONKWO when you saved
-- it."* A changed name is the clearest available signal that an account has
-- changed hands, and it is free on every transfer. Refusing outright was
-- rejected — banks rename accounts for boring reasons — and showing only the
-- live name throws the signal away.
alter table mandates add column saved_name text;
