-- **Handoff**: the transfer of a live conversation from the Support Agent to a
-- Support Officer, and the **Inbox** the Officer works it from.
--
-- Three tables, and the first of them is the one that makes the rest possible.
-- Until now nothing anywhere stored what a Customer said: the Platform answered
-- a message and forgot it, which is fine while an AI is answering and useless
-- the moment a human has to pick the conversation up. An Officer who has to
-- re-ask a Customer everything makes the Handoff worse than no Agent at all.
--
-- All three live in the **Middleware's** database (ADR-0006). Conversation
-- history is per-Customer data, an Officer's claim is a concurrency control the
-- Platform must not be able to forge, and the settings below decide who gets
-- paged at 3am. None of that belongs in the prompt-injection surface.
--
-- Additive-first: this migration only creates.

-- --- The history an Officer is handed ---------------------------------------

-- Every message in a conversation, **with `said`, `chose` and `event` kept
-- apart** (ticket 11).
--
-- A flat transcript would be cheaper and would lose the one distinction an
-- Officer will actually be called about. Somebody paid the wrong person: did
-- they *type* a name, or did they *tap* a row the platform rendered? Those are
-- different failures with different owners, and a column is what tells them
-- apart six weeks later.
create table conversation_messages (
    -- Monotonic, for the same reason the audit table's id is: two messages in
    -- one millisecond still have an order, and "what did they say next" is the
    -- question this table exists to answer.
    id                bigserial   primary key,

    -- **The conversation id is preserved across a Handoff, never minted fresh**
    -- (ticket 03). The foreign key is what makes that structural rather than a
    -- convention — there is no second id for this table to hang off.
    conversation_id   uuid        not null references conversations (id),

    -- Which way it went. An Officer reading the Inbox needs both halves; the
    -- Agent's replies are as much a part of "what has already been tried" as
    -- the Customer's questions.
    direction         text        not null,

    -- The three inbound shapes, kept as they arrived. An outbound message is
    -- always `said` — the platform composes words, and a control it rendered is
    -- carried in `body` as the question it asked.
    kind              text        not null,

    -- What was said, or the id that was chosen, or a short description of the
    -- event. **Never an attachment's contents** — see `attachment_key`.
    body              text        not null default '',

    -- Who produced it. `agent` is the Support Agent, `officer` a named human,
    -- `system` the platform speaking for itself (the arrival and resolve
    -- notices). Kept distinct from `direction` because an Officer's reply and
    -- the Agent's reply are both outbound and a Customer is told which is which.
    author            text        not null,
    author_staff_id   uuid        references staff_accounts (id),

    -- **Where the file is, and nothing about what is in it.**
    --
    -- The Platform downloads the bytes from WhatsApp's media API and writes them
    -- to object storage without opening them; the Orchestration Layer learns
    -- only that a file exists (ticket 11). A document handed to the layer
    -- running the LLM is an injection vector with a file extension, and the
    -- Customer chooses the filename too — which is why the filename below is
    -- rendered to an Officer and is never part of the key.
    attachment_key    text,
    attachment_type   text,
    attachment_name   text,

    -- **Whether the Agent understood the turn this reply answers.**
    --
    -- Null on everything except an Agent reply, where it is the difference
    -- between an answer and *"I did not understand that"*. Two jobs: the Inbox
    -- shows an Officer which turns went nowhere, and three consecutive falses
    -- are Handoff trigger 6 — the Customer rephrasing the same request and
    -- getting nowhere.
    --
    -- Counted from this column rather than from a tally in the Platform's
    -- memory, because the Platform is restarted and replicated and a counter
    -- there would reset under the Customer mid-rephrase.
    agent_understood  boolean,

    -- **Held, because WhatsApp's window shut.** An Officer's reply written more
    -- than 24 hours after the Customer's last message cannot be delivered as
    -- itself; the approved template reopens the conversation and this row waits
    -- until the Customer replies (ticket 11). In-app chat has no window and
    -- nothing here is ever held on it.
    held              boolean     not null default false,

    recorded_at       timestamptz not null default now(),

    constraint conversation_messages_direction_is_known
        check (direction in ('inbound', 'outbound')),
    constraint conversation_messages_kind_is_known
        check (kind in ('said', 'chose', 'event')),
    constraint conversation_messages_author_is_known
        check (author in ('customer', 'agent', 'officer', 'system')),
    -- An Officer's message names the Officer. Nothing else may, so a row cannot
    -- claim a human wrote what the Agent wrote.
    constraint conversation_messages_only_an_officer_is_named
        check ((author_staff_id is null) or (author = 'officer')),
    -- A key without a type is a file nobody can serve; a type without a key is a
    -- claim about a file that does not exist.
    constraint conversation_messages_attachment_is_whole
        check ((attachment_key is null) = (attachment_type is null)),
    -- Only what the platform has not yet delivered may be held, and only
    -- outbound is ever delivered.
    constraint conversation_messages_only_outbound_is_held
        check (not held or direction = 'outbound'),
    -- Only the Agent can have failed to understand something.
    constraint conversation_messages_only_the_agent_understands
        check (agent_understood is null or author = 'agent')
);

-- "The whole conversation, oldest first" — which is the Inbox's only read.
create index conversation_messages_by_conversation
    on conversation_messages (conversation_id, id);

-- "What is still waiting to go out on this conversation", for the moment a
-- Customer replies and the window reopens.
create index conversation_messages_held
    on conversation_messages (conversation_id, id)
    where held;

-- --- The Inbox ---------------------------------------------------------------

-- One Handoff: a conversation whose ownership has passed from the Support Agent
-- to a human, and has not come back.
--
-- **Ownership passes when the Handoff is raised, not when it is claimed.** The
-- Agent leaves completely — not silent-but-listening, not suggesting replies —
-- so while a row here is open the Platform makes no model call about this
-- conversation at all. The injection surface closes at exactly the moment a
-- human is being asked to trust what they are reading.
create table handoffs (
    id                     uuid        primary key default gen_random_uuid(),

    -- Preserved, never minted. Audit, the Mandate's own clock and the Officer
    -- seeing one conversation rather than two all depend on it.
    conversation_id        uuid        not null references conversations (id),

    -- Which of the six fired. Ordered by urgency in code; `pending_transfer` is
    -- the top of the queue always, because money has already left the
    -- Customer's account and the platform cannot say where it went.
    --
    -- **There is no sentiment trigger.** It was on the ticket and it does not
    -- survive: a second model judgement, stacked on one already measured at
    -- ~68%, whose failure mode is bad in both directions.
    trigger                text        not null,

    -- What the Agent had tried, in its own words, so an Officer starts from
    -- something rather than from a wall of transcript.
    summary                text        not null default '',

    raised_at              timestamptz not null default now(),

    -- **Exclusive.** Two Officers cannot answer at once, and the claim is taken
    -- by a conditional update rather than by a read-then-write in application
    -- code — the same reason one-live-Binding-per-account is a unique index.
    claimed_by             uuid        references staff_accounts (id),
    claimed_at             timestamptz,

    -- **A claim expires on Officer inactivity** and the conversation returns to
    -- the queue. Otherwise a conversation is held hostage by somebody who went
    -- home with it open, which is the failure that actually happens. Expiry is
    -- computed from this column at read and claim time rather than swept by a
    -- job: a background task that has not run yet is a lock that has not
    -- expired yet, and the Customer is the one waiting.
    officer_last_active_at timestamptz,

    -- The Officer resolves. There is no mid-conversation handback and no idle
    -- auto-return — a Customer part-way through a sentence to a human suddenly
    -- getting a bot is the single worst moment to switch.
    resolved_at            timestamptz,
    resolved_by            uuid        references staff_accounts (id),

    constraint handoffs_trigger_is_known
        check (trigger in (
            'pending_transfer',
            'customer_asked',
            'gated_pin_failed',
            'agent_unable',
            'channel_cannot_fulfil',
            'repeated_failure'
        )),
    constraint handoffs_a_claim_is_whole
        check ((claimed_by is null) = (claimed_at is null)),
    constraint handoffs_a_claim_has_activity
        check ((claimed_by is null) = (officer_last_active_at is null)),
    constraint handoffs_a_resolution_is_whole
        check ((resolved_at is null) = (resolved_by is null))
);

-- **One open Handoff per conversation.** A second trigger firing while an
-- Officer already owns the conversation must not put it in the Inbox twice, and
-- a Customer who says "get me a human" three times must not summon three.
create unique index handoffs_one_open_per_conversation
    on handoffs (conversation_id)
    where resolved_at is null;

-- The Inbox's own read: everything unresolved, urgent first.
create index handoffs_open on handoffs (raised_at) where resolved_at is null;

-- --- What the Bank configures about all this ---------------------------------

-- The settings this ticket produces, and only those: the Bank's real business
-- hours, and the operations address an unresolved transfer alerts at 3am.
--
-- A key/value table rather than a column per setting, because the alternative
-- is a migration every time the Dashboard grows a field — and these are
-- configuration the Bank edits, not schema. The **values are validated in
-- TypeScript** on the way in, which is the same "open where change is cheap,
-- closed where mistakes are expensive" line the audit table draws.
--
-- Read by a Support Officer, written only by an Administrator. Business hours
-- decide what a Customer is told out of hours and the alert address decides who
-- is woken up, so neither is a thing everybody who can answer a chat may edit.
create table platform_settings (
    key          text        primary key,
    value        jsonb       not null,
    updated_at   timestamptz not null default now(),
    updated_by   uuid        references staff_accounts (id),

    constraint platform_settings_key_is_named check (length(key) between 1 and 60)
);

comment on table platform_settings is
    'Bank-editable configuration. Deliberately not environment variables: the '
    'Bank changes their opening hours without a redeploy, and the operations '
    'alert address is theirs to point wherever they staff.';
