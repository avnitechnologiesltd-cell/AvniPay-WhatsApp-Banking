-- **Enrolling a second factor from the Dashboard**, for an account that has a
-- password and cannot sign in without one.
--
-- The gap this closes is structural rather than cosmetic. MFA is required for an
-- Administrator, the setup step makes exactly one account and declines once any
-- exists, and everybody after that is invited from the Officer accounts screen —
-- so before this there was no way for a second Administrator to ever sign in.
-- The setup step's own failure message already told an operator to "enrol it
-- from the Dashboard".
--
-- Additive: one nullable column and one check.

-- The secret somebody has been shown and has **not yet proved they can read**.
--
-- Deliberately not `mfa_secret`. Migration 0003 constrains that column and
-- `mfa_enrolled_at` to be null or set together, which is what makes "MFA is
-- required" a fact about the schema rather than an intention in code — a secret
-- sitting in it without an enrolment date would be exactly the half-state that
-- check exists to forbid. So a secret in flight gets a column of its own, and
-- the enrolled pair stays coupled.
alter table staff_accounts
    add column mfa_pending_secret text;

-- **A pending secret and an enrolment cannot coexist**, which is the security
-- property of the whole route written where code cannot argue with it.
--
-- Enrolling takes the password and nothing else, and that is correct for an
-- account whose only factor is the password: somebody holding it can already do
-- everything the account can. It would be badly wrong for an account that
-- already has a second factor, where a leaked password would be enough to swap
-- the authenticator out from under its owner. The service refuses that case; this
-- says so at the column, so a future caller cannot reintroduce it.
alter table staff_accounts
    add constraint staff_accounts_no_pending_secret_once_enrolled
        check (mfa_pending_secret is null or mfa_enrolled_at is null);

comment on column staff_accounts.mfa_pending_secret is
    'A TOTP secret offered to somebody who has proved the password but has not '
    'yet returned a code from it. Never a credential on its own: an account is '
    'enrolled only when mfa_secret and mfa_enrolled_at are both set.';
