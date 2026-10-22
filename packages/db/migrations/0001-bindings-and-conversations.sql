-- The Middleware's first two tables.
--
-- Both live in the Middleware's database and neither is reachable from the
-- Platform, which is the prompt-injection surface (ADR-0006). The Platform may
-- cache a Binding in memory for the life of a conversation; it may never
-- persist one.
--
-- Additive-first: this migration only creates. Rolling back is redeploying the
-- previous image, which simply does not read these tables.

-- A Binding links one channel identity to one account. Created by enrollment,
-- refreshed by renewal, destroyed by revocation.
--
-- It holds no name, no contact details and no CustomerID — BankOne exposes no
-- lookup that would produce one, and every spine operation is keyed on the
-- account number.
create table bindings (
    id                uuid        primary key default gen_random_uuid(),
    channel_identity  text        not null,
    account_number    text        not null,
    enrolled_at       timestamptz not null default now(),
    renewed_at        timestamptz,
    revoked_at        timestamptz,

    constraint bindings_account_number_is_a_nuban check (account_number ~ '^[0-9]{10}$')
);

-- One account per channel identity, one channel identity per account — enforced
-- by the database rather than by the code that writes it, because "enrolling a
-- second number revokes the first" is a money-correctness rule and an
-- approximate reimplementation in application code is what tests would then be
-- asserting against.
--
-- Partial, so a revoked Binding does not block a Customer re-enrolling.
create unique index bindings_one_live_per_channel_identity
    on bindings (channel_identity)
    where revoked_at is null;

create unique index bindings_one_live_per_account
    on bindings (account_number)
    where revoked_at is null;

-- The Middleware issues the conversation id; the Platform quotes it and never
-- mints one. This is the single mechanism that stops the component running the
-- LLM from naming its own security context.
create table conversations (
    id                uuid        primary key default gen_random_uuid(),
    channel           text        not null,
    channel_identity  text        not null,
    binding_id        uuid        references bindings (id),
    opened_at         timestamptz not null default now(),
    last_seen_at      timestamptz not null default now(),

    constraint conversations_channel_is_known check (channel in ('whatsapp', 'in_app_chat'))
);

create index conversations_by_channel_identity
    on conversations (channel, channel_identity);
