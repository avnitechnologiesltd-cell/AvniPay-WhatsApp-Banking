# The account-number check digit

**A NUBAN is the account number.** The bank code is the code the CBN assigns —
The first deployment's is `09XXXX`, and it is the same code that routes a transfer. There is
no second "NUBAN bank code"; the config key is named `NUBAN_BANK_CODE` and that
name is misleading. See "The naming" below.

The platform computes a check digit locally so a mistyped digit is caught on the
first enrolment screen, before any call leaves the platform. **A valid check
digit does not mean the account exists** — that is the Bank's to say.

## What actually validates the first deployment's accounts

Real staging accounts at that Bank carry a valid check digit under **`030`**
with the 2010 weight vector — twelve weights of `3 7 3` over a three-digit code
plus nine serial digits. None validates under the Bank's six-digit code, under
`090`, or under any six-digit form of that code with the 2020 fifteen-weight
rule. That was checked directly, not assumed.

So `030` is **fitted rather than looked up**: it is the value that makes real
account numbers validate. It is recorded here as an observation, not as a claim
about what the first deployment's CBN code is.

## The naming, which is wrong

`NUBAN_BANK_CODE` reads as though NUBANs have their own bank code. They do not.
What the key actually holds is *the value this check digit computes over*, which
for this deployment is not the Bank's code. Renaming it is worth doing; it was
left alone here because renaming a configuration key is a deployment change and
this file is the honest description in the meantime.

## Why not the 2020 revision

The CBN's 2020 revision brought Other Financial Institutions into NUBAN with a
six-digit code and fifteen weights, and a microfinance bank is an OFI — so that
rule looks like it should apply. **It does not validate the first deployment's real account
numbers**, under any candidate code. The 2010 rule does.

This was changed to the 2020 rule and changed back. The lesson is recorded
rather than the reasoning repeated: the account numbers are the evidence, and a
standard that does not validate them is the wrong standard for these accounts,
whatever its date.

## What is worth asking the Bank

- **Which code do their account numbers' check digits compute over?** `030` fits
  and nobody here can say why.
- **Are staging account numbers issued the same way production ones are?** If
  not, this check is fitted to numbers that will not exist in production.

Until both are answered, the check is a typo-catcher tuned to two examples. It
is cheap and it is honest about being local — but if it ever rejects a real
Customer, **turn it off rather than tune it**: the Bank's own API is the
authority on whether an account exists, and a local check that refuses real
accounts is worse than no local check at all.
