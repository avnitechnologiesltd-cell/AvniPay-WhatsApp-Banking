-- The **Library**: Bank reference material the Support Agent reads as context,
-- and the one thing that makes a cited answer possible.
--
-- Three tables, in the **Middleware's** database. That placement is worth
-- stating because the Library is not per-Customer data and ADR-0006 is
-- therefore not what decides it. Two other things do: an Administrator's upload
-- is an audited act by a named member of staff, and the audit log and the staff
-- accounts are both here — and the Dashboard talks to nothing else. The
-- Platform reads these rows over the same HTTP boundary it reads everything
-- else through, and holds no copy.
--
-- **No second copy exists anywhere.** No embedding index, no cache of extracted
-- text, no separate search store — because every extra copy is a place a
-- withdrawn policy survives, and a Support Agent quoting a withdrawn policy is a
-- compliance problem for the Bank. Retrieval reads the same rows the Dashboard
-- writes, and Postgres' own full-text index is derived from them rather than
-- being a copy of them.
--
-- Additive-first: this migration only creates.

-- --- What the Bank published ------------------------------------------------

-- One document, across every version of it. The title is what a citation names
-- first, so it is the document's rather than the version's — a Customer told
-- *"Funds Transfer Policy, section 4"* should hear the same title next quarter.
create table library_documents (
    id          uuid        primary key default gen_random_uuid(),
    title       text        not null,
    created_at  timestamptz not null default now(),
    created_by  uuid        references staff_accounts (id),

    constraint library_documents_title_is_named check (length(title) between 1 and 200)
);

-- One version of one document, and **exactly one of them is live**.
--
-- `version_date` is the Bank's own date for the policy, typed by the
-- Administrator, and deliberately not the upload timestamp. A citation names it,
-- and *"the day somebody happened to drag the file in"* is not a fact about the
-- Bank's policy. It is a `date` rather than a `timestamptz` for the same reason:
-- a policy is effective on a day, not at a moment in a time zone.
create table library_versions (
    id                 uuid        primary key default gen_random_uuid(),
    document_id        uuid        not null references library_documents (id),

    version_date       date        not null,

    -- **Where the original file went**, in the same object storage a Customer's
    -- attachment goes to. The rule is deliberately the opposite one: the
    -- Platform moves an attachment *without opening it*, and a Library document
    -- is read on purpose. The difference is who supplied it — a Customer, or an
    -- Administrator.
    --
    -- Nothing retrieves from here. The original is kept so the Bank can show
    -- what was actually uploaded; the text the Agent reads is in the sections
    -- below.
    source_key         text        not null,
    source_media_type  text        not null,
    source_name        text        not null default '',

    -- `draft` has never been retrievable and never will be. `live` is the one
    -- version retrieval reads. `withdrawn` was taken down by an Administrator;
    -- `superseded` was replaced by a newer version. Both are unquotable and the
    -- Bank can tell them apart, which is the whole reason there are two words —
    -- *we retired this policy* and *we reissued it* are different answers to a
    -- regulator.
    status             text        not null default 'draft',

    uploaded_at        timestamptz not null default now(),
    uploaded_by        uuid        references staff_accounts (id),
    -- **Publishing is a separate, explicit step**, which is exactly what these
    -- two columns being nullable says. A row arrives with them empty.
    published_at       timestamptz,
    published_by       uuid        references staff_accounts (id),
    retired_at         timestamptz,
    retired_by         uuid        references staff_accounts (id),

    constraint library_versions_status_is_known
        check (status in ('draft', 'live', 'withdrawn', 'superseded')),
    constraint library_versions_a_publication_is_whole
        check ((published_at is null) = (published_by is null)),
    -- A superseding version is published by the person publishing its
    -- replacement, so a retirement always has a name against it.
    constraint library_versions_a_retirement_is_whole
        check ((retired_at is null) = (retired_by is null)),
    -- **A draft has never been published.** The strongest form of "a draft is
    -- never retrievable" this file can hold: there is no state in which a row
    -- reads `draft` and carries a publication date.
    constraint library_versions_a_draft_was_never_published
        check (status <> 'draft' or published_at is null),
    constraint library_versions_a_live_version_was_published
        check (status <> 'live' or published_at is not null),
    constraint library_versions_a_live_version_is_not_retired
        check (status <> 'live' or retired_at is null),
    constraint library_versions_a_retired_version_says_when
        check (status in ('draft', 'live') or retired_at is not null)
);

-- **Exactly one live version per document**, held by the database rather than by
-- the code that writes it. Two live versions of one policy is the Agent quoting
-- whichever row the planner reached first, and no amount of care in a service
-- method is worth as much as this index.
create unique index library_versions_one_live_per_document
    on library_versions (document_id)
    where status = 'live';

create index library_versions_by_document on library_versions (document_id, uploaded_at desc);

-- --- What the Agent actually reads ------------------------------------------

-- **The grain is the section**, not the document and not an arbitrary chunk.
--
-- A heading is a boundary the Bank already drew, which is what makes a citation
-- mean something: *"Funds Transfer Policy, Charges, 1 March 2026"* is checkable
-- by the Officer a Customer complains to, and *"chunk 14"* is not.
--
-- This is also the only copy of the extracted text. The version row above does
-- not keep a second one, which means the preview an Administrator approves
-- before publishing is rendered from these rows — so a document that extracted
-- as interleaved nonsense *and* a document that split into one enormous section
-- are both visible in the same glance, rather than only the first.
create table library_sections (
    id              uuid    primary key default gen_random_uuid(),
    version_id      uuid    not null references library_versions (id) on delete cascade,

    -- Reading order, so a preview is the document rather than a bag of parts.
    ordinal         int     not null,

    -- The heading the section sits under, or '' where the document opened with
    -- text before its first one. A citation names it.
    heading         text    not null default '',
    body            text    not null,

    -- **Sized once, at ingestion.** The retrieval budget is checked on every
    -- turn of every conversation, and counting characters across a growing
    -- corpus at query time is work that only ever has one answer per row.
    token_estimate  int     not null,

    -- **Postgres full-text search, and nothing else.** No embeddings, no
    -- pgvector, no chunking pipeline, no second datastore for the Bank's team
    -- to run, back up and patch (ticket 13). An embedding pipeline fails by
    -- returning plausible-but-wrong neighbours *silently*; lexical search fails
    -- visibly, by finding nothing — and finding nothing is the case this design
    -- handles best, because it is what makes the Agent say it cannot confirm.
    --
    -- Generated rather than maintained by a trigger, so there is no state in
    -- which the index disagrees with the text it indexes. `english` is fixed
    -- because a generated column must be immutable, and the corpus is a
    -- Nigerian bank's policy set, dense with exact terms a Customer uses
    -- verbatim — NIP, NUBAN, BVN, KYC tier, COT. That is what this is good at.
    search          tsvector generated always as (
        setweight(to_tsvector('english', coalesce(heading, '')), 'A') ||
        setweight(to_tsvector('english', coalesce(body, '')), 'B')
    ) stored,

    constraint library_sections_body_is_text check (length(body) > 0),
    constraint library_sections_is_sized check (token_estimate > 0),
    constraint library_sections_ordinal_is_a_position check (ordinal >= 0),

    unique (version_id, ordinal)
);

create index library_sections_search on library_sections using gin (search);

comment on table library_sections is
    'The only copy of a Library document''s extracted text. Retrieval reads '
    'these rows joined to a live version, so unpublishing a document makes it '
    'unquotable in the very next turn with nothing to re-index and no cache to '
    'invalidate.';
