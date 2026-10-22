-- Who the Bank's staff are, and how they hold a session.
--
-- These live in the **Middleware's** database rather than the Dashboard's,
-- because a staff password hash and a live session are security records, and
-- ADR-0006 puts every one of those outside the surface that faces the world.
-- The Dashboard authenticates *through* the Middleware, exactly as it reads the
-- audit log through it — so a compromised Dashboard does not hand over the
-- credential store for the whole Bank.
--
-- Additive-first: this migration only creates.

create table staff_accounts (
    id               uuid        primary key default gen_random_uuid(),

    -- Case-insensitively unique. Somebody signing in as `Ada@bank` when they
    -- registered `ada@bank` is a support ticket, and two accounts differing
    -- only by case is worse than one.
    email            text        not null,
    display_name     text        not null,

    -- **argon2id.** Never SHA-256, and never one shared salt — the prior art
    -- did both for the staff login while getting the Transaction PIN right in
    -- the same repository. The encoded form carries its own parameters and
    -- salt, so a later cost increase needs no migration.
    password_hash    text        not null,

    -- Two roles, nesting rather than partitioning: every Administrator is also
    -- a Support Officer. Stored as one value and widened by a capability check
    -- in code, so there is no way to hold "administrator but not officer".
    role             text        not null,

    -- TOTP. Required for Administrator before they can do anything; optional
    -- for a Support Officer in v1.
    mfa_secret       text,
    mfa_enrolled_at  timestamptz,

    created_at       timestamptz not null default now(),
    updated_at       timestamptz not null default now(),
    -- Disabled rather than deleted: an account that acted must stay resolvable
    -- from the audit rows naming it.
    disabled_at      timestamptz,

    constraint staff_accounts_role_is_known
        check (role in ('support_officer', 'administrator')),
    constraint staff_accounts_email_is_an_email
        check (email like '%_@_%'),
    -- An Administrator without MFA enrolled is a role that cannot be used, and
    -- the check below is what makes "MFA is required" true rather than intended.
    constraint staff_accounts_mfa_secret_accompanies_enrolment
        check ((mfa_secret is null) = (mfa_enrolled_at is null))
);

create unique index staff_accounts_one_per_email on staff_accounts (lower(email));

-- Server-side and revocable, so a compromised session is killed without a
-- redeploy. The prior art kept sessions in memory: unrevocable, and a restart
-- signed everybody out instead.
create table staff_sessions (
    id                uuid        primary key default gen_random_uuid(),

    -- The **hash** of the token, never the token. A database dump must not be
    -- a set of live sessions, which is the same reasoning as the password
    -- column above.
    token_hash        text        not null,

    staff_account_id  uuid        not null references staff_accounts (id),
    created_at        timestamptz not null default now(),
    last_seen_at      timestamptz not null default now(),
    expires_at        timestamptz not null,
    revoked_at        timestamptz,

    -- Recorded so a Support Officer can be shown where their sessions are and
    -- kill one they do not recognise.
    user_agent        text,
    ip_address        text
);

create unique index staff_sessions_by_token on staff_sessions (token_hash);

-- "Every session this person holds", for revoking all of them at once.
create index staff_sessions_by_account
    on staff_sessions (staff_account_id, id)
    where revoked_at is null;
