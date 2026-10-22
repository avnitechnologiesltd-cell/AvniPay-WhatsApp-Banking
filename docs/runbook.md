# Runbook

What the Bank's operations team receives, and what they do with it. Written for
somebody with SSH to one VM and Docker on it, because that is the deployment
this platform is built to be — see
[ADR-0003](adr/0003-one-repo-three-deployables.md) and
ticket 23.

Everything here is the same on staging and on production. Where the two differ,
they differ by the contents of `.env` and by nothing else.

---

## What is running

One VM. One `docker-compose.yml`. Five containers:

| Container | What it is | Reachable from |
| --- | --- | --- |
| `middleware` | Every credential, every security record, the only route to BankOne | The public internet — WhatsApp Flows and Widgets post to it |
| `platform` | Channels, orchestration, the models. The prompt-injection surface | A Customer's handset, for the Widget |
| `dashboard` | The web application the Bank's staff sign in to | The Bank's staff, however the Bank exposes it |
| `postgres` | The only datastore | Nothing outside the VM |
| `minio` | Object storage for files Customers send. Replaceable by anything speaking S3 | Nothing outside the VM |

Two more services exist and are behind the `release` profile, so `docker compose
up` cannot reach them: `migrate` and `setup-administrator`. Both are below.

**Compose to Kubernetes is a migration; Kubernetes down to a VM is a rewrite.**
That asymmetry is why this is the shape it is. Growing out of it later is
ordinary work.

---

## First install

```sh
cp .env.example .env
chmod 600 .env
$EDITOR .env                                  # every key is required
```

Put the WhatsApp Flows private key on the VM at the path `.env` names —
`./secrets/` beside the Compose file is the default, and Compose mounts that
directory read-only. **`.env` holds paths, never key material.** A value that
looks like a PEM is refused at boot rather than tolerated.

```sh
docker compose build
docker compose run --rm migrate               # explicit, and not part of `up`
docker compose run --rm setup-administrator   # the first Administrator
docker compose up -d
```

Then check all three:

```sh
curl -fsS localhost:3001/health/ready         # middleware — is Postgres answering?
curl -fsS localhost:3002/health/ready         # platform
curl -fsS localhost:3003/api/health           # dashboard
```

`/health/ready` is the one to watch: it is readiness, and Postgres is the only
thing in it. `/health` beside it is liveness — the process is up and answering,
and it says nothing about the database. **Liveness is where `version` and
`environment` are**, so `curl -fsS localhost:3001/health` is the answer to "what
is actually running right now" during an incident.

### Why the two middle steps are separate

A deployment that migrates itself turns a bad deploy into a bad database, and
this database holds every Binding and every hashed Transaction PIN. A deployment
that creates an account on its own is reachable with a known password until
somebody notices. So both are things a person does, and neither happens on `up`.

`setup-administrator` declines if any account already exists — everybody after
the first is invited from the Dashboard. **Have an authenticator app open before
running it:** it enrols MFA in the same sitting, because an Administrator
without MFA cannot sign in. If the six-digit code does not verify it says so and
exits non-zero, leaving an account that has to be enrolled from the Dashboard or
dropped and made again.

A deployable started against an un-migrated database **refuses to serve and says
which migrations are missing.** It never migrates itself.

---

## The database logins

Three, and they are not interchangeable.

| Key | Login | May |
| --- | --- | --- |
| `DATABASE_URL` | The owner | Everything. Used by the migration step and by nothing else. |
| `MIDDLEWARE_DATABASE_URL` | `avni_middleware` | Read and write every table. Not change the schema. |
| `PLATFORM_DATABASE_URL` | `avni_platform` | Connect, and read `schema_migrations`. Nothing else at all. |

`docker compose run --rm migrate` creates the two roles, sets their passwords
from those URLs, and applies the grants — after the migrations, every time, so
that a table a release just created is granted on in the same breath.

**The Platform's login cannot read the Middleware's tables.** That is the point
of the split: the Platform is where Customer text meets a language model, and
[ADR-0006](adr/0006-secrets-and-security-records-live-outside-the-platform.md)
says "'The Platform is untrusted' has to be enforced, not merely intended". One
shared login would leave the Binding and the hashed Transaction PIN one `SELECT`
away from that surface. `tests/database-roles.test.ts` asks Postgres itself,
against the real schema, every table.

The migration step **refuses to run** if any two of the three name the same
role, so a deployment configured that way does not migrate and therefore does
not start.

`POSTGRES_USER` and `POSTGRES_PASSWORD` are what Compose creates the database
with; `DATABASE_URL` is how the migration step connects to it. They are two
statements of the same login and must agree.

**What that owning login has to be allowed to do**, if the Bank's DBA is
provisioning it rather than letting Compose create it: `CREATEROLE`, to make the
two roles; and **ownership of the database and of schema `public`**, because the
step revokes the default `PUBLIC` privileges from both. `CREATEROLE` alone is
not enough. The Compose `postgres` container's `POSTGRES_USER` is a superuser
and satisfies all of it without anyone doing anything.

**One side effect worth knowing before it surprises you.** The step also revokes
everything from `PUBLIC` — on the database, on the schema, and on every table —
because a privilege held by `PUBLIC` is a privilege held by the Platform, and
the paragraph above is only true if the Platform holds nothing it was not handed
deliberately. So a fourth login the Bank added by hand — a monitoring user, a
DBA's own account, a reporting tool — **loses access at the next release**
unless it was granted explicitly rather than relying on the default. Grant such
a login what it needs by name, and re-grant it after a release, or give it its
own read-only role and note it here.

---

## Releasing a new version

```sh
git fetch && git checkout <tag>
docker compose build
docker compose run --rm migrate
docker compose up -d
```

In that order. `migrate` before `up`, because the new image expects the new
schema and will refuse to serve without it.

`migrate` prints what it applied, or `nothing to apply`. It is safe to run when
there is nothing to do, and safe to run twice.

### The migration rules

- **Versioned.** `packages/db/migrations/NNNN-slug.sql`, four digits, and two
  files may not claim one number.
- **Forward-only.** There are no `.down.sql` files and the runner refuses a
  directory containing one.
- **Additive-first.** Add the column, backfill it, switch reads to it, drop the
  old one in a *later* release. This is what makes the rollback below true: a
  release that only adds is a release the previous image can still serve.
- **Never edited once applied.** Each file is checksummed and the runner refuses
  to run against a database where an applied migration's contents have changed.
  An edited migration is two different schemas wearing one version number.
- **Never at boot.** Only ever the explicit step above, run by whoever holds
  production access.

### When a migration fails halfway

It does not. Each migration runs in its own transaction and the runner stops at
the first failure, so the database carries every migration before the failed one
and none of the failed one. Fix the file, re-run the step; the ones already
applied are skipped.

If the release has already started and the failure is discovered late, roll back
as below and the partially-migrated database is still one the previous image can
serve, because migrations are additive.

---

## Rolling back

**Redeploy the previous image.** That is the whole procedure.

```sh
git checkout <previous tag>
docker compose build
docker compose up -d
```

**Do not run `migrate`.** There is nothing to undo and no reverse migration to
write. The next `migrate` will report that the database carries versions the
image does not ship — that message is expected after a rollback and is not an
error.

Reverse migrations are code that runs once, under pressure, having never been
tested. The way to make them safe is to not need them, which is what
additive-first buys.

---

## Rotating a credential

Edit `.env`, then restart. That is the mechanism for all of them.

```sh
$EDITOR .env
docker compose up -d                          # picks up the new values
```

Two need more than that:

- **A database role's password.** Change it in the URL, then
  `docker compose run --rm migrate` to push it to Postgres, then
  `docker compose up -d`. The migration step syncs the role's password from the
  URL every time it runs.
- **`CREDENTIAL_ENCRYPTION_KEY`.** See below. It is not a value to rotate
  casually.

---

## The credential encryption key

`CREDENTIAL_ENCRYPTION_KEY` seals everything the Middleware must be able to read
back: the in-app chat signing secrets, and the credential behind every
registered Connector.

**It does not live in Postgres.** A database dump that carries its own key is
not encrypted, it is obfuscated — and Connector credentials are the Bank's own
third-party secrets. It is an environment value so that a stolen dump and a
stolen key are two separate incidents.

32 bytes of base64, and refused at any other length:

```sh
openssl rand -base64 32
```

**Losing or changing it is not recoverable.** Nothing reads a sealed value back
except with this key, so there is nothing to migrate from. Every signing secret
would have to be re-issued, every Bank backend re-configured, and every
Connector credential entered again by hand. Back it up somewhere that is not the
same backup as the database.

---

## Logs, and what is not in them

Operational logs go to **stdout** as JSON lines:

```sh
docker compose logs -f middleware
```

That is all they are for. **Anything load-bearing is in the audit table
instead**, which the Dashboard reads: enrollment's failure cause, the Mandate
lifecycle, every Dashboard read, every Connector dispatch, every settings change.

This is deliberate and it is the answer to a problem this platform has by
construction — the platform runs on infrastructure we do not operate, so a file
on a box is unreachable exactly when it matters, and a table the Dashboard reads
is not. Enrollment is the case that decides it: its failure reasons are
*deliberately* indistinguishable to the Customer, so the record of which failure
occurred is the only way support or a fraud investigation can tell a wrong
account number from a wrong code.

**The platform never deletes an audit row.** `AUDIT_RETENTION_DAYS` records the
Bank's policy for the Bank's own archival tooling; nothing here acts on it. A
table that prunes its own evidence is not evidence.

---

## Backups

Postgres holds everything: Bindings, hashed Transaction PINs, Beneficiaries,
Mandates, the audit table, staff accounts, the Library, Connectors.

```sh
# The quotes matter: those two are expanded inside the container, not by your shell.
docker compose exec -T postgres sh -c 'pg_dump -U "$POSTGRES_USER" "$POSTGRES_DB"' \
  | gzip > "avni-$(date +%F).sql.gz"
```

Two things belong in a *different* place from that dump: `CREDENTIAL_ENCRYPTION_KEY`
and the Flows private key. A backup holding the dump and the key together
undoes the reason the key is not in the database.

The object store is backed up separately and holds Customers' attachments and
the Library's uploaded documents.

---

## The two environments

**Staging** on our infrastructure, against BankOne staging and the Avni WhatsApp
account. **Production** on the Bank's, against BankOne production and the Bank's
WhatsApp account.

They differ **only by `.env`**. No code path branches on which deployment it is
— `DEPLOYMENT_ENVIRONMENT` exists so a log line and a health body can say where
they came from, and `tests/configuration-not-constants.test.ts` refuses a source
file that compares it to anything. A staging deployment that behaved differently
because it knew it was staging would have stopped being a rehearsal of
production.

Nothing transfers between the two accounts. Every Flow id, phone number id, key
path, template name, bank code, institution code, product code and officer code
is different in production and every one of them is a key in `.env`.

### What staging cannot show you

Staging is **partly blind**, and these are the blind spots. Written down here
rather than discovered during a release:

- **Interbank name enquiry appears stubbed.** Probing BankOne staging on
  2026-08-20 returned the identical holder — `"JANE BOND DOE"` — for one
  fabricated account number at two different banks, with success both times.
  Real NIBSS name enquiry cannot do that. **The name on the Confirmation screen
  is the single most important anti-fraud element in the whole transfer path**
  — a Customer reads it and stops if it is wrong — and it cannot be exercised
  until production. Treat a correct-looking name in staging as no evidence at
  all.
- **Transaction history is unentitled.** `GetTransactions` answers
  `"AuthToken Not Configured for this institution"` on the Bank's staging token.
  What is testable in staging is therefore the Customer-facing "not available"
  outcome, and not the history itself.
- **No staging account is funded.** The staging account reports
  `WithdrawableBalance: "0.00"` against a ₦1,000,000 available balance, so a
  transfer fails on funds before it reaches anything else. **A completed
  transfer cannot be observed in staging** — the poll-and-answer path past
  dispatch is exercised against failure only, and whether BankOne deduplicates
  `RetrievalReference` stays untested, which is why the Middleware mints and
  dedupes its own.
- **An unentitled operation answers HTTP 200.** It is not only the stubs that
  are quiet — the failure shape is quiet too. A bad token is HTTP 400
  `Invalid Token`, but an operation the Bank's token may not call is a 200 with
  a message in the body. This is why `packages/fakes` reproduces it and why
  nothing in this codebase trusts a status code.

The consequence, stated plainly: **the first real interbank transfer, and the
first real name on a Confirmation screen, happen in production.** Plan the first
production release around watching one, with somebody present who can stop it.

---

## Who does what

Not our decision, and it wants naming before the first production release:

- Who holds production access and therefore runs `migrate`.
- Who is called at 3am when the Middleware is down. Its availability now bounds
  both the banking path and the support path.
- Who receives `alert-operations` — the address a stuck transfer pages. It is a
  Dashboard setting rather than a key here, because it is the Bank's to point
  wherever they actually staff.
