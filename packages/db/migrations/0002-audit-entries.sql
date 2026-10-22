-- The single record the platform writes its security-relevant history to.
--
-- Written by the **Middleware** and read by the Dashboard. Not by the Dashboard
-- itself, so a compromised Dashboard cannot quietly stop recording itself — and
-- a table rather than a log file, because a table the Dashboard reads is
-- reachable from a deployment we do not operate and a file on a box is not.
-- (ADR-0002's "we cannot easily obtain logs" turned out to be answered here.)
--
-- Additive-first: this migration only creates.

create table audit_entries (
    -- Monotonic, so "what happened next" is answerable without trusting clocks.
    -- A timestamp alone cannot order two events inside the same millisecond,
    -- and reconstructing what authorised a debit is exactly that question.
    id              bigserial   primary key,
    recorded_at     timestamptz not null default now(),

    -- WHAT happened. Deliberately `text` and deliberately unconstrained: no
    -- enum, no check constraint, no lookup table. The row type is an OPEN set
    -- so that enrollment, Mandates, Connector dispatch and Dashboard reads can
    -- each add their own without a schema change.
    --
    -- The discipline lives in TypeScript, where `AuditAction` is a closed union
    -- every writer compiles against. Open where change is cheap, closed where
    -- mistakes are expensive.
    action          text        not null,

    -- WHO acted.
    actor_kind      text        not null,
    actor_id        text,

    -- WHICH Customer or account it concerned. The account number rather than a
    -- Customer identifier, because every operation the platform performs is
    -- keyed on the account and BankOne exposes no lookup that would produce
    -- the other thing.
    account_number  text,

    -- The correlating id, so one debit can be reconstructed across the
    -- conversation, the Mandate and BankOne's own record of it.
    conversation_id uuid,
    request_id      text,

    outcome         text        not null,

    -- Row-type-specific facts. Never a response body, never a credential,
    -- never a Transaction PIN — see the constraint below.
    detail          jsonb       not null default '{}'::jsonb,

    constraint audit_entries_action_is_named    check (length(action) between 1 and 100),
    constraint audit_entries_actor_kind_is_known
        check (actor_kind in ('customer', 'officer', 'administrator', 'platform', 'system')),
    constraint audit_entries_outcome_is_known
        check (outcome in ('succeeded', 'failed', 'refused', 'unavailable'))
);

-- "Everything that happened to this Customer", which is the insider-threat
-- question and the compliance question alike.
create index audit_entries_by_account
    on audit_entries (account_number, id desc)
    where account_number is not null;

-- "Everything in this conversation", for reconstructing one debit.
create index audit_entries_by_conversation
    on audit_entries (conversation_id, id desc)
    where conversation_id is not null;

create index audit_entries_by_recorded_at on audit_entries (recorded_at desc);

create index audit_entries_by_action on audit_entries (action, id desc);

comment on table audit_entries is
    'Append-only. The platform never deletes a row; retention and archival are '
    'the Bank''s, and AUDIT_RETENTION_DAYS records the policy rather than '
    'enacting it. There is no delete path in the code, and a test refuses one.';
