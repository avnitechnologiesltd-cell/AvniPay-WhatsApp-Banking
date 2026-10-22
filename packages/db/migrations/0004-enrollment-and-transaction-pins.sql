-- The front door: what an enrollment attempt is while it is running, what it
-- leaves behind, and the secret a Customer chooses at the end of it.
--
-- All three live in the **Middleware's** database. The Platform is the
-- prompt-injection surface and holds none of it (ADR-0006) — least of all the
-- Transaction PIN, which authorises every transfer and every Gated Connector.
--
-- Additive-first: this migration creates three tables and adds one column.

-- When the Customer last spoke to us **of their own accord**.
--
-- Separate from `conversations.last_seen_at` because a Binding outlives any one
-- conversation, and because this is the value the 90-day dormancy expiry reads.
-- Only a Customer-initiated message moves it: if a notification *we* sent
-- refreshed a Binding, the mechanism would keep alive precisely the Bindings it
-- exists to kill on a recycled number.
alter table bindings
    add column last_activity_at timestamptz not null default now();

-- An enrollment in flight.
--
-- It holds no contact detail of any kind. The masked labels and the opaque
-- destination handles the Bank returns are rendered into one screen and thrown
-- away; a Customer who goes back gets a fresh `resolve`. The platform never
-- learns a phone number or an email, and that stays true of what it stores as
-- well as what it logs.
create table enrollments (
    id                uuid        primary key default gen_random_uuid(),

    -- The Flow's token, hashed. The Customer's handset quotes it back on every
    -- screen, so it is a bearer credential and is stored the way the staff
    -- session tokens are: a dump must not be a set of resumable enrollments.
    token_hash        text        not null,

    channel_identity  text        not null,

    -- Which of the three walks this is. All three take a code to the contact
    -- already on record; they differ in what they identify from and what they
    -- leave behind.
    purpose           text        not null,

    -- Null until the Customer has typed one that passes the NUBAN check, and
    -- filled in from the Binding for a renewal or a PIN reset.
    account_number    text,

    -- Whether the Bank answered 200. **Never surfaced, in any form** — an
    -- account the Bank 404s still gets a destination screen, a code screen and
    -- the identical failure wording as a wrong code, and this column is the only
    -- place in the system the two are distinguishable.
    account_exists    boolean     not null default false,

    -- The handle the Customer picked, opaque and the Bank's to interpret.
    --
    -- The code's own expiry is deliberately **not** here. The Bank generates the
    -- code, delivers it and owns its lifetime; a second copy of that deadline
    -- would be a clock of ours to disagree with theirs, and the answer the
    -- Customer sees comes from `verify-otp` either way.
    destination_id    text,

    binding_id        uuid        references bindings (id),

    phase             text        not null,
    started_at        timestamptz not null default now(),
    completed_at      timestamptz,

    constraint enrollments_purpose_is_known
        check (purpose in ('enrollment', 'renewal', 'pin_reset')),
    constraint enrollments_phase_is_known
        check (phase in ('identifying', 'choosing_destination', 'awaiting_code',
                         'setting_pin', 'complete')),
    constraint enrollments_account_number_is_a_nuban
        check (account_number is null or account_number ~ '^[0-9]{10}$')
);

create unique index enrollments_by_token on enrollments (token_hash);

-- "What is this number in the middle of", for resuming and for the audit trail.
create index enrollments_by_channel_identity
    on enrollments (channel_identity, started_at desc);

-- Three attempts, then an hour, **on the WhatsApp number**.
--
-- A table of its own rather than a column on `enrollments`, and that is the
-- whole point: a counter scoped to one attempt resets when the Customer opens
-- the Flow again, which is the mistake ticket 10 named for the Transaction PIN
-- — *"otherwise starting a fresh transfer resets it and guessing four digits is
-- free"*. Here it would make the silent enumeration walk free instead.
--
-- The Bank implements no lockout. This is the platform's, because it is scoped
-- to the channel identity rather than to the Customer, and because it is
-- load-bearing for enumeration resistance.
create table enrollment_lockouts (
    channel_identity  text        primary key,
    failed_attempts   integer     not null default 0,
    locked_until      timestamptz,
    updated_at        timestamptz not null default now()
);

-- The Transaction PIN.
--
-- Keyed on the **account**, not on the Binding and not on the channel identity.
-- Two consequences, both wanted: it survives a phone change, and the lockout
-- counter below is therefore counted against the Customer rather than against
-- any single transfer or Gated Connector call (ADR-0009 — one secret, one
-- budget).
create table transaction_pins (
    account_number    text        primary key,

    -- **argon2id.** A 4-digit PIN is 10,000 possibilities; under a fast hash a
    -- database dump yields every Customer's PIN in seconds. The lockout is the
    -- real defence and this is the backstop, so the constraint below makes
    -- "never a fast hash" a property of the schema rather than of the care taken
    -- by whoever writes the next caller.
    pin_hash          text        not null,

    set_at            timestamptz not null default now(),
    updated_at        timestamptz not null default now(),

    failed_attempts   integer     not null default 0,
    locked_until      timestamptz,

    constraint transaction_pins_account_is_a_nuban
        check (account_number ~ '^[0-9]{10}$'),
    constraint transaction_pins_hash_is_argon2id
        check (pin_hash like '$argon2id$%')
);
