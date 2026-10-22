# What the Bank must supply

Everything the platform needs from the first deployment's Bank that it does not already have,
in one place. **We consume whatever they provide** — the shapes below are what
we need to exist, not a demand that they be built our way, except where a shape
is already specified and linked.

Three kinds of thing are on this list, and the difference decides who does the
work:

| Kind | Who builds it | How we reach it |
| --- | --- | --- |
| **A BankOne entitlement** | Nobody — it is switched on | The endpoint we already call starts working |
| **An API the Bank builds** | The Bank's development team | We integrate against their spec |
| **A Connector** | The Bank builds the API, then **registers it themselves** | No release from us at all |

**The third row is the important one.** A Connector is an HTTP API the Bank
registers from the Dashboard — endpoint, credential, description, declared
parameters, and one *Gated* checkbox that makes it take the Transaction PIN.
The Support Agent can then call it for a Customer. Nothing on our side changes.
**Utility bills, airtime and most of loans fit here**, which is why they are not
a release we have to schedule.

---

## 1. BankOne — switch on, or confirm

Probed against the first deployment's own token on `staging.mybankone.com`. An unentitled
operation answers **HTTP 200** with `"AuthToken Not Configured for this
institution"`; a bad token answers HTTP 400 with `Invalid Token`.

### Blocking

| # | What | Status | Blocks |
| --- | --- | --- | --- |
| 1.1 | Fund the staging account — **withdrawable**, not just available | `WithdrawableBalance: "0.00"` against ₦1,000,000 available | Every completed transfer |
| 1.2 | `GetTransactions` entitlement | **Not enabled** | Transaction history |
| 1.3 | **The sender's name from an account number** | No working endpoint found | **All inter-bank transfers** |

**On 1.3.** `Transfer/InterBankTransfer` requires a `Payer` field — the sender's
name, a customer of that Bank. `Transfer/NameEnquiry` resolves the *recipient* fine
with the destination bank's code (`033` for UBA works), but answers **"Invalid
Bank Code"** for `09XXXX` in every form. `GetAccountByAccountNumber/2` returns
balances with no name; versions 1, 3, 4 and 5 throw `NullReferenceException`.
The only documented endpoint carrying `CustomerName` needs a tracking reference
from account creation.

Either tell us which endpoint to call, **or** confirm that NameEnquiry with
`09XXXX` works in production and is failing only because staging's NIP directory
does not list the Bank. Either answer closes it.

### Confirm — not blocking, but unverified

| # | What | Why it matters |
| --- | --- | --- |
| 1.4 | Is interbank name enquiry **live or stubbed** on staging? | One made-up number returned `"JANE BOND DOE"` for two different banks. The recipient's real name is the main thing stopping money reaching the wrong person, and we would otherwise see it work first in production |
| 1.5 | Does BankOne deduplicate `RetrievalReference`? | We assume not and dedupe ourselves. Safe either way; worth knowing |
| 1.6 | **Transaction limits by KYC tier** — per transaction, per day | Undocumented and unobservable without moving money. Does BankOne enforce them, or must we? |
| 1.7 | Which code do account-number **check digits** compute over? | Real accounts validate under `030`, not under `09XXXX`. Ours is fitted to two examples — see [`nuban.md`](nuban.md) |
| 1.8 | Are **staging account numbers issued like production ones**? | If not, our local check is tuned to numbers that will never exist |
| 1.9 | `GetAccountStatement` and `SearchTransactionAdvanced` — do they come with `GetTransactions`, or separately? | Named as related, never verified |
| 1.10 | **Transaction Status Query** shape | Enabled but never exercised — we have only ever seen the failed case |

---

## 2. The identity API — the Bank builds it

**Nothing about enrolment works without this**, and it gates every other
journey: no Binding means no balance, no transfer, nothing. It is the single
most urgent item on this document.

BankOne cannot do it. No endpoint returns the phone or email on record for an
account, and nothing sends or checks a one-time code.

Five endpoints, fully specified in
[`bank-identity-api.md`](bank-identity-api.md):

| # | Endpoint | What it does |
| --- | --- | --- |
| 2.1 | `resolve` | Given an account number, say whether it exists and whether a contact is on record — **without returning the contact** |
| 2.2 | `send-otp` | Send a code to that contact, by whatever channel they already use |
| 2.3 | `verify-otp` | Say whether a code the Customer typed is the one sent |
| 2.4 | `notify` | Tell the contact on record that something happened to their account |
| 2.5 | `alert-operations` | Page the Bank's own operations desk about a stuck transfer — the only one not about a Customer |

**We deliberately do not ask for contact details.** Their service sends the
code; the platform never learns a phone number or an email. That keeps every
Customer's contact inside the Bank and an SMS vendor off the critical path. If
they push back wanting to hand the contacts over instead, that trade is the one
to defend.

Four open questions are in §7 of that spec. **One can still change the design:**
what happens for an account with *no* contact on record at all? Enrolment has
nowhere to send a code.

Running against a stand-in today — `scripts/fake-bank-identity.mjs`.

---

## 3. Capability the Bank registers as Connectors

Each is an HTTP API the Bank builds once and registers from the Dashboard.
**No release from us.** For each, they supply: endpoint, credential, a
description of when to use it, the parameters it takes, and whether it is Gated.

What we need from them per Connector is the same five things, so this list is
about which APIs to build rather than about integration work on our side.

### 3.1 Airtime

| Needs | Notes |
| --- | --- |
| Buy airtime | Amount, network, phone number. Whose number — the Customer's own, or any? |
| Buy data | Same, plus a bundle identifier |

**Gated**, almost certainly: it moves money, so it should take the Transaction
PIN on every execution.

There is a **Buy Airtime button on the WhatsApp menu today** and it says the
feature is coming. That button is the only thing waiting on this.

### 3.2 Utility bills

| Needs | Notes |
| --- | --- |
| List billers | Or a fixed set, if it does not change often |
| Validate a customer/meter number | The equivalent of name enquiry — **the Customer must see whose bill they are about to pay before paying it** |
| Pay a bill | Biller, customer/meter number, amount |
| Fetch a token or receipt | Prepaid electricity returns a token the Customer needs |

**Validation matters as much as it does for transfers.** A mistyped meter number
is money gone to a stranger, and the confirmation screen is the defence — so the
validate step is not optional.

**Gated.**

### 3.3 Loans

Read operations and a submission, rather than a decision:

| Needs | Notes |
| --- | --- |
| Am I eligible, and for how much? | If the Bank scores this, we show their answer and never compute one |
| Products and terms | Amounts, tenors, rates — so the Customer sees real figures |
| Apply | Amount, tenor, product, purpose. **Where does approval happen?** |
| Application status | So a Customer can ask "where is my loan" |
| My existing loans | Balance, next repayment, due date |
| Repay | Full or partial |

**Two questions before anything is built here:**

- **Is approval instant, or does a human decide?** If a human does, an
  application is a submission and a status to poll — a different product from
  one that answers immediately, and the conversation reads differently.
- **What must be disclosed at the point of applying?** Interest, fees, total
  repayable. This is a regulated disclosure and the wording is the Bank's, not
  ours.

**Gated** on apply and repay.

---

## 4. Already working — no ask

Confirmed against the first deployment's token, so that nobody re-requests them:

| Operation | Endpoint |
| --- | --- |
| Balance | `GetAccountByAccountNumber` |
| Name enquiry (recipient) | `Transfer/NameEnquiry` |
| Intra-bank transfer | `CoreTransactions/LocalFundsTransfer` |
| Inter-bank NIP transfer | `Transfer/InterBankTransfer` |
| Transaction status query | `CoreTransactions/TransactionStatusQuery` |
| Account creation | `CreateCustomerAndAccount` + `GetAccountByTransactionTrackingRef` |

---

## 5. What to send, and in what order

Three different audiences, so three conversations rather than one:

1. **The BankOne administrator** — §1. Switches and answers, no development.
   Draft: `asks/16`.
2. **The development team** — §2, and it is the one that gates everything.
   Draft: `asks/20`.
3. **The product owner** — §3. Which capabilities, in which order, and the two
   loan questions above.

**Worth saying to them plainly:** §3 needs no release from us at all. Once those
APIs exist, an Administrator registers each one from the Dashboard and the
Support Agent can use it the same day. §1 and §2 are the only things this
platform is actually waiting on.
