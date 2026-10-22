-- The second **Channel**: in-app chat inside the Bank's own mobile application.
--
-- Two things, and the smaller one is the more interesting. There is **no
-- Binding table here and no column added to the one that exists** — a Binding
-- exists only because WhatsApp arrives carrying a phone number that means
-- nothing to us, so the link to an account has to be stored. The Bank's
-- application states the account on every session, signed by their own backend,
-- so there is nothing to remember (ADR-0010).
--
-- That deletes work rather than adding it: no enrollment on this Channel, no
-- OTP, no dormancy, no renewal, no revocation. And it is what keeps opening the
-- Bank's app from revoking a Customer's WhatsApp access, which
-- one-live-Binding-per-account would have done on every launch.
--
-- Additive-first: one new table and one nullable column, so the previous image
-- still serves this schema.

-- The secrets the Bank's backend signs an in-app identity with.
--
-- Issued from the Dashboard by an Administrator, alongside the Snippet they
-- paste. The Snippet itself is public — it is four lines inside somebody's
-- mobile application — and this is the half that is not.
create table snippet_secrets (
    id                 uuid        primary key default gen_random_uuid(),

    -- **The secret, encrypted, and never a hash of it.** Everything else this
    -- platform stores of a secret is argon2id and one-way, because nothing is
    -- meant to recover a password or a Transaction PIN. Verifying an HMAC needs
    -- the secret itself, so this one is the exception — sealed with AES-256-GCM
    -- under a key held in the environment and **never in this database beside
    -- the ciphertext**, because a dump that carries its own key is obfuscation.
    sealed_secret      text        not null,

    -- Which loader-to-server contract version the Snippet issued alongside it
    -- was pinned to. A Snippet already inside a shipped mobile application
    -- cannot be recalled, so a change to that contract is served alongside the
    -- old version rather than edited (ADR-0011), and this is how a later reader
    -- can tell what is still out there.
    contract_version   text        not null,

    -- What an Administrator called it, so the Bank can tell two apart during a
    -- rotation. Never the secret, and never anything a Customer supplied.
    label              text        not null default '',

    -- Who issued it. Disabled rather than deleted staff stay resolvable, which
    -- is the same reason the audit rows naming them do.
    issued_by          uuid        references staff_accounts (id),
    issued_at          timestamptz not null default now(),

    -- **Several may be live at once**, which is what gives the Bank a rotation
    -- window: issuing a second secret does not break the one their backend is
    -- still signing with. Retiring the first is a separate deliberate act.
    revoked_at         timestamptz,

    constraint snippet_secrets_label_is_short check (char_length(label) <= 60)
);

-- How verification reads them: every live one, newest first.
create index snippet_secrets_live on snippet_secrets (issued_at desc) where revoked_at is null;

-- The account an in-app conversation was opened against.
--
-- **Written only from a verified envelope**, at the moment the conversation is
-- opened, and never from anything a handset asserts afterwards. It is the
-- in-app equivalent of the Binding's `account_number` — the difference being
-- that a Binding outlives the conversation and this does not, which is exactly
-- the difference between a Channel that has to remember who somebody is and one
-- that is told.
alter table conversations add column account_number text;

-- WhatsApp resolves its account through the Binding and must never grow a
-- second path to one. Making that a database rule rather than a habit is what
-- stops a later slice quietly stamping an account onto a WhatsApp conversation
-- and bypassing revocation, dormancy and the one-live-Binding rule with it.
alter table conversations add constraint conversations_account_is_in_app_only
    check (account_number is null or channel = 'in_app_chat');

alter table conversations add constraint conversations_account_is_a_nuban
    check (account_number is null or account_number ~ '^[0-9]{10}$');
