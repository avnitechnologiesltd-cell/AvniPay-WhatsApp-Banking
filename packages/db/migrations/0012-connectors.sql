-- **Connectors**: the way the Bank adds capability without a release from us.
--
-- An Administrator registers an HTTP API — an endpoint, a credential, a
-- description and one **Gated** checkbox — and the Support Agent may call it on
-- a Customer's behalf. The platform never learns what the API does or where it
-- is hosted (ADR-0005), which is why the two things that matter here are what a
-- row may *not* hold and what may not be read back out of one.
--
-- **In the Middleware's database, and nowhere else.** A Connector credential is
-- a Bank credential, and ADR-0006 keeps every one of those out of the
-- deployable that reads Customer text into an LLM. v1 ships with **zero**
-- Connectors registered; the registry ships anyway.
--
-- Additive-first: this migration only creates.

-- --- What the Bank registered -----------------------------------------------

create table connectors (
    id                uuid        primary key default gen_random_uuid(),

    -- **What the Support Agent's tool is called.** Bank-written, and shown to
    -- the model, so it is constrained to the shape a tool name may take rather
    -- than left as free text — a name with a newline in it is a name that can
    -- write a second instruction into the tool list.
    name              text        not null,

    -- **Untrusted model-facing text**, and the field this whole table treats
    -- most carefully. It steers when the Agent calls the Connector, so a
    -- careless one causes wrong calls and a hostile one is prompt injection
    -- with an API behind it. Bank staff may write it, no Customer may, and
    -- nothing in the platform ever treats it as an instruction.
    description       text        not null,

    -- Where the call goes. Checked at registration **and again at dispatch**,
    -- on the resolved address rather than on this string — a hostname is turned
    -- into an IP at call time and whoever owns the name chooses what comes back.
    -- This column is the implicit allowlist: nothing unregistered can be called.
    endpoint          text        not null,

    -- The one checkbox. `true` takes the Customer's Transaction PIN on **every**
    -- execution, through the same sealed surface a transfer uses and against the
    -- same lockout counter (ADR-0009). Defaulted on, so leaving it off is a
    -- deliberate act rather than an oversight.
    gated             boolean     not null default true,

    -- **Field naming, not a schema language.** Each entry is a name, a type, a
    -- required flag and a one-line description, and the Middleware refuses an
    -- argument that does not match rather than coercing it. jsonb because the
    -- list is the Bank's and changes without a migration.
    parameters        jsonb       not null default '[]'::jsonb,

    -- **Write-only.** The header name is readable — the Bank has to be able to
    -- see how their API is being addressed — and the value is not, by anyone,
    -- including the Administrator who typed it and including the Dashboard.
    -- Changing a credential means entering a new one.
    --
    -- Sealed with AES-256-GCM under a key from the environment. The key is
    -- **never in this database**: a dump that carries its own key is
    -- obfuscation with the word encryption written on it.
    credential_header text        not null,
    credential_sealed text        not null,
    credential_set_at timestamptz not null default now(),

    -- `active` is callable. `retired` is not, and is kept rather than deleted
    -- because the audit rows about dispatches through it name this id, and a
    -- foreign key that dangles is a history nobody can read back.
    status            text        not null default 'active',

    registered_at     timestamptz not null default now(),
    registered_by     uuid        references staff_accounts (id),
    updated_at        timestamptz not null default now(),
    updated_by        uuid        references staff_accounts (id),
    retired_at        timestamptz,
    retired_by        uuid        references staff_accounts (id),

    constraint connectors_name_is_a_tool_name check (name ~ '^[a-z][a-z0-9_]{1,39}$'),
    constraint connectors_description_is_written check (length(description) between 1 and 500),
    constraint connectors_endpoint_is_https check (endpoint like 'https://%'),
    constraint connectors_credential_header_is_named
        check (credential_header ~ '^[A-Za-z][A-Za-z0-9-]{0,63}$'),
    constraint connectors_status_is_known check (status in ('active', 'retired')),
    constraint connectors_a_retirement_is_whole check ((retired_at is null) = (retired_by is null)),
    constraint connectors_an_active_one_is_not_retired
        check (status <> 'active' or retired_at is null)
);

-- **One live Connector per name**, held by the database rather than by the code
-- that writes it. The name is what the Support Agent calls, and two Connectors
-- answering to one name is the model reaching whichever row the planner found
-- first. A retired one keeps its name, so a name can be reused after retirement
-- and the history still reads.
create unique index connectors_one_active_per_name
    on connectors (name)
    where status = 'active';

create index connectors_by_status on connectors (status, registered_at desc);

comment on column connectors.credential_sealed is
    'Write-only. There is no route in the platform that reads this back — not '
    'the Dashboard, not the Administrator who entered it. Changing a credential '
    'means entering a new one.';

-- --- A Gated call, waiting for a Transaction PIN -----------------------------

-- One dispatch that has been asked for and **not yet authorised**.
--
-- This is not a verification record, and the distinction is the whole of
-- ADR-0009: nothing here says *this Customer has verified*. It is the request
-- itself — which Connector, whose account, which arguments — held for exactly
-- as long as it takes the Customer to enter their PIN into a sealed surface, and
-- spent the moment they do. There is no expiry to extend, no conversation-long
-- window, and no state a second call could inherit.
--
-- The arguments are stored **because they must not come back through the
-- handset**. A sealed surface's payload may carry what the Customer newly
-- supplies and never a value the server rendered, so what is dispatched is read
-- from this row rather than from what the phone sends up.
create table connector_requests (
    id              uuid        primary key default gen_random_uuid(),

    -- The token is a bearer credential handed to a handset, so only its hash is
    -- stored — the same rule the transfer walk's token is under.
    token_hash      text        not null unique,

    connector_id    uuid        not null references connectors (id),
    conversation_id uuid        not null references conversations (id),

    -- **Injected by the Middleware, never supplied by the model.** The Support
    -- Agent can get *what* wrong and can never get *who* wrong, which is what
    -- makes a ~68% tool-calling rate survivable rather than an account-takeover
    -- rate.
    account_number  text        not null,

    arguments       jsonb       not null default '{}'::jsonb,

    created_at      timestamptz not null,
    -- Single-use, claimed rather than checked: two taps on one screen race here
    -- and the loser must not be a second call against the Bank's API.
    dispatched_at   timestamptz,

    constraint connector_requests_account_is_a_nuban check (account_number ~ '^[0-9]{10}$')
);

create index connector_requests_by_conversation
    on connector_requests (conversation_id, created_at desc);

comment on table connector_requests is
    'A Gated dispatch between the Support Agent asking for it and the Customer '
    'authorising it with their Transaction PIN. Not a verification record: '
    'Gated holds no state, and this row is the request rather than a claim '
    'about who the Customer is.';
