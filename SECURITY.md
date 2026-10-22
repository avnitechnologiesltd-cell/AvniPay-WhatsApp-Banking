# Security policy

Avni handles bank credentials, Transaction PINs and customers' money. Please
report vulnerabilities privately.

## Reporting

Use GitHub's **private vulnerability reporting** on this repository
(Security → Report a vulnerability). Do not open a public issue.

Include what is affected, how to reproduce it, and the impact you expect. You
will get an acknowledgement within a few days and we will agree a disclosure
date with you once a fix is ready.

## Scope

In scope: the code in this repository. Out of scope: a specific bank's
deployment, BankOne itself, and Meta's WhatsApp platform — report those to their
owners.

## For operators

If you deploy Avni, read the configuration comments in `.env.example` and the
runbook in `docs/runbook.md`. In particular, set `WHATSAPP_APP_SECRET` so the
Flows endpoint verifies Meta's signature, never store `CREDENTIAL_ENCRYPTION_KEY` in
Postgres or alongside its backups, and give the three database logins different
passwords.
