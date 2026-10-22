# Migrations

Every change to the schema is a file here. There is no other way to change it,
and nothing applies these at boot.

## The rules

- **Named `NNNN-slug.sql`** — four digits, a hyphen, a lowercase slug. The
  number is the position in the sequence and two files may not claim one.
- **Forward-only.** There are no `.down.sql` files and the runner refuses a
  directory that contains one. Rollback is redeploying the previous image.
- **Additive-first.** Add the column, backfill it, switch reads to it, drop the
  old one in a later release. A release that only adds is a release the previous
  image can still serve, which is what makes the rollback above true.
- **Never edited once applied.** The runner checksums each file and refuses to
  run against a database where an applied migration's contents have changed —
  an edited migration is two different schemas wearing one version number.

## Running them

```sh
docker compose run --rm migrate     # against the Compose deployment
pnpm migrate                        # the same thing, outside Docker
```

Both read all three database URLs, not only `DATABASE_URL` — see the grants
below — and both refuse to start without them.

An explicit step in the release, performed by whoever holds production access.
A deployable started against a database this has not been run on refuses to
serve and says so.

## And then the grants

The same step applies the grant model, **after** the migrations and on every
run: it creates the `MIDDLEWARE_DATABASE_URL` and `PLATFORM_DATABASE_URL` roles,
syncs their passwords from those URLs, and hands the Middleware read and write
on every table while the Platform gets `CONNECT` and `SELECT` on
`schema_migrations` and nothing else.

Every run rather than once, because **a migration that creates a table is
exactly when the Middleware needs to reach it and the Platform needs not**. See
`../src/roles.ts`, and `docs/runbook.md` for the operator's view.

This directory ships with a schema per slice. Each slice adds the tables it
needs; nothing here has to remember to grant on them.
