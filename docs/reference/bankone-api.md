# BankOne Core Banking API — Integration Guide (bank-agnostic)

BankOne (by AppZone / Qore) is a **multi-tenant core banking platform** used by
many Nigerian microfinance banks. The **API contract is the same across every
bank on the platform** — only the credentials, codes, and which operations a bank
has enabled differ. This guide documents that shared contract so you can
integrate **any** BankOne bank: collect the per-bank config in Section 2, then
call the endpoints in Sections 4–11 with those values plugged in.

> How to read this doc:
> - `{LIKE_THIS}` = a **per-bank value** you obtain from the bank (Section 2).
> - "Contract confidence" = how sure we are the request/response shape is correct.
>   The shapes here were confirmed against a live BankOne instance, so they are
>   reliable BankOne contracts — but **whether a given bank has enabled a given
>   operation is per-bank** (Section 3).
> - Nothing in this file is specific to one bank's data except the clearly
>   labelled *examples*.

---

## 1. Platform shape: two services, one token value

BankOne splits operations across **two services on the same host**. They use the
**same token value** but authenticate differently — and even name the auth field
differently between endpoints.

| Service | Base URL pattern | Auth mechanism | Operations |
|---|---|---|---|
| **WebAPI** | `{BASE_WEBAPI}` = `https://{HOST}/BankOneWebAPI` | `authtoken` **query parameter** | Balance, account opening, account lookup, transaction history |
| **Third Party API** | `{BASE_THIRDPARTY}` = `https://{HOST}/thirdpartyapiservice/apiservice` | auth field **inside the JSON body** | Name enquiry, intra-bank transfer, inter-bank (NIP) transfer, transaction status query |

`{HOST}` examples:
- Staging (shared across banks): `staging.mybankone.com`
- Production: `api.mybankone.com` (confirm per bank — some deployments differ)

WebAPI paths end with a version segment `/{VERSION}` (use `2`).

### Auth field name per endpoint (important)

| Endpoint | Where the token goes | Field name |
|---|---|---|
| WebAPI (all) | query string | `authtoken` |
| `Transfer/NameEnquiry` | JSON body | `Token` |
| `Transfer/InterBankTransfer` | JSON body | `Token` |
| `CoreTransactions/LocalFundsTransfer` | JSON body | **`AuthenticationKey`** |
| `CoreTransactions/TransactionStatusQuery` | JSON body | `Token` (confirm) |

> **Gotcha:** `LocalFundsTransfer` rejects `Token` and requires
> `AuthenticationKey`. Same token *value*, different field *name*.

---

## 2. Per-bank configuration (collect this for every bank)

These are the values that change from bank to bank. Gather them during onboarding
and store them per tenant (e.g. per merchant row / per env). **None of these are
hardcodable if you want to support more than one bank.**

| Config key | What it is | How to get it | Example (a staging bank) |
|---|---|---|---|
| `{HOST}` | API host | From the bank / BankOne | `staging.mybankone.com` |
| `{AUTH_TOKEN}` | The bank's API key. Same value for WebAPI `authtoken` and the Third Party body auth field | Issued by the bank's BankOne admin | *(secret)* |
| `{INSTITUTION_CODE}` | The bank's BankOne institution code | From the bank | `0221` |
| `{BANK_CODE}` | The bank's own **NIBSS** bank code (used for same-bank name enquiry + local/interbank routing) | From the bank / NIBSS | `090110` |
| `{VERSION}` | WebAPI path version | Constant | `2` |
| `{PRODUCT_CODE}` | The savings/current **product** a new account opens under. Each bank defines its own products | From the bank (there is **no** list-products endpoint on the WebAPI we found — the bank supplies the list) | e.g. `100` = "SAVINGS ACCOUNT" |
| `{ACCOUNT_OFFICER_CODE}` | An **existing** staff/officer code the new account is assigned to. Per bank, per environment | From the bank | e.g. `001` |

> **Design your integration so all of the above are configuration, not code.**
> Store them keyed by bank/tenant. The endpoints below only reference the
> `{PLACEHOLDERS}`.

---

## 3. Per-bank ENTITLEMENTS (which operations a bank has enabled)

The API contract is universal, but **each bank chooses which operations its token
may call.** An operation you have not been granted returns, on the WebAPI:

```json
{ "IsSuccessful": false, "Message": "AuthToken Not Configured for this institution" }
```
(HTTP 400). This is **not** a bug or a wrong request — it means *that operation is
not enabled for that bank's token yet.* Ask the bank's BankOne admin to authorise it.

Entitlements that commonly vary per bank — **check these during onboarding for
each new bank**:

| Capability | Endpoint | Notes |
|---|---|---|
| Name enquiry | `Transfer/NameEnquiry` | Needs the Third Party (transfer) service enabled |
| Balance | `GetAccountByAccountNumber` | Usually available |
| Intra-bank transfer | `CoreTransactions/LocalFundsTransfer` | Needs Third Party service |
| Inter-bank / NIP transfer | `Transfer/InterBankTransfer` | Separate NIP entitlement; not every bank has it |
| Transaction history | `GetTransactions` | Often **not** enabled by default — request it explicitly |
| Account opening | `CreateCustomerAndAccount` | Usually available |

> Build the integration to **degrade gracefully**: if an operation returns
> "AuthToken Not Configured", surface a clear "not enabled for this bank" state
> rather than crashing, and keep going for the operations that are enabled.

---

## 4. Global conventions

- **Money units:**
  - WebAPI balances are **naira decimal strings**, e.g. `"1500.00"`. Parse as
    float; do **not** divide by 100.
  - Third Party transfer `Amount` is **naira** (e.g. `10` = ₦10), **not** kobo.
- **Success detection:** `ResponseCode == "00"` **OR** a truthy `IsSuccessful` /
  `IsSuccessFul` flag. (Casing of "IsSuccessFul" varies by endpoint.)
- **Pending:** codes such as `"01"`, `"09"`, `"25"`, `"91"` mean not-yet-final →
  resolve via Transaction Status Query (Section 9).
- **`RetrievalReference` max length is 12 characters.** Longer → rejected with
  `"... Retrieval Reference. Max Length 12"`. Generate a ≤12-char reference and
  reuse the same value for the later TSQ lookup.
- **Read responses tolerantly.** Field casing/naming is inconsistent across
  endpoints; match case-insensitively with fallbacks rather than one fixed spelling.

---

## 5. Name Enquiry

Resolve an account number to the holder's name. Works for same-bank and other-bank
accounts (pass the relevant bank code). Used to confirm a recipient before a
transfer and to link a customer's existing account.

- **Service:** Third Party API
- **`POST {BASE_THIRDPARTY}/Transfer/NameEnquiry`**
- **Auth:** `Token` in body

### Request

| Field | Type | Required | Notes |
|---|---|---|---|
| `Token` | string | yes | `{AUTH_TOKEN}` |
| `AccountNumber` | string | yes | 10-digit NUBAN to resolve |
| `BankCode` | string | yes | NIBSS code of the account's bank. Same-bank → `{BANK_CODE}`. Other bank → that bank's code. Missing → `"BankCode not sent"` |

```json
{ "Token": "{AUTH_TOKEN}", "AccountNumber": "2024000153", "BankCode": "{BANK_CODE}" }
```

### Response

| Field | Type | Notes |
|---|---|---|
| `Name` | string | Holder name (empty/null on failure) |
| `BVN` | string/null | May be null |
| `KYC` | string/null | May be null |
| `IsSuccessful` | bool | **Success flag** |
| `SessionID` | string | NIBSS session id (may be empty) |
| `ResponseMessage` | string | `"Successful"`, `"Invalid Bank Code"`, `"BankCode not sent"`, … |
| `DefaultGateWay` | string | e.g. `"ISW"` |
| `InstitutionCode` | string/null | Often null |

```json
{ "Name": "JANE BOND DOE", "IsSuccessful": true, "ResponseMessage": "Successful", "DefaultGateWay": "ISW" }
```

- **Success:** `IsSuccessful == true` and non-empty `Name`.
- **Contract confidence:** High — confirmed against a live BankOne instance.

---

## 6. Balance Enquiry

Get an account's balances. Use `GetAccountByAccountNumber` (widely enabled).

- **Service:** WebAPI
- **`GET {BASE_WEBAPI}/api/Account/GetAccountByAccountNumber/{VERSION}`**
- **Auth:** `authtoken` query parameter

### Request (query parameters)

| Param | Type | Required | Notes |
|---|---|---|---|
| `authtoken` | string | yes | `{AUTH_TOKEN}` |
| `accountNumber` | string | yes | 10-digit NUBAN |
| `institutionCode` | string | yes | `{INSTITUTION_CODE}` |

```
GET {BASE_WEBAPI}/api/Account/GetAccountByAccountNumber/2?authtoken={AUTH_TOKEN}&accountNumber=2024000153&institutionCode={INSTITUTION_CODE}
```

### Response (naira decimal strings)

| Field | Type | Notes |
|---|---|---|
| `AvailableBalance` | string | Naira, e.g. `"0.00"` |
| `LedgerBalance` | string | Naira book balance |
| `WithdrawableBalance` | string | Naira spendable balance |
| `AccountType` | string | e.g. `"Savings/Current Account"` |

```json
{ "AvailableBalance": "0.00", "LedgerBalance": "0.00", "WithdrawableBalance": "0.00", "AccountType": "Savings/Current Account" }
```

- **Not found:** HTTP `404` with a plain-text message.
- **Money:** naira — do not divide by 100.
- **Contract confidence:** High — confirmed live.

---

## 7. Intra-Bank (Local) Transfer

Move money between two accounts within the **same** bank.

- **Service:** Third Party API
- **`POST {BASE_THIRDPARTY}/CoreTransactions/LocalFundsTransfer`**
- **Auth:** **`AuthenticationKey`** in body (not `Token`)

### Request

| Field | Type | Required | Notes |
|---|---|---|---|
| `AuthenticationKey` | string | yes | `{AUTH_TOKEN}`. **Field name is `AuthenticationKey`** |
| `Amount` | number | yes | **Naira** |
| `FromAccountNumber` | string | yes | Sender NUBAN |
| `ToAccountNumber` | string | yes | Recipient NUBAN (same bank) |
| `RetrievalReference` | string | yes | Your unique reference, **≤ 12 chars**. Reuse for TSQ |
| `Narration` | string | no | Description |

```json
{
  "AuthenticationKey": "{AUTH_TOKEN}",
  "Amount": 10,
  "FromAccountNumber": "2024000153",
  "ToAccountNumber": "2024000373",
  "RetrievalReference": "ref123456789",
  "Narration": "Transfer"
}
```

### Response

| Field | Type | Notes |
|---|---|---|
| `IsSuccessful` | bool | Success flag |
| `ResponseMessage` | string | e.g. `"Approved by Financial Institution"` |
| `ResponseCode` | string | `"00"` = success; `"12"` = validation error |
| `Reference` | string | BankOne's own reference |

```json
{ "IsSuccessful": true, "ResponseMessage": "Approved by Financial Institution", "ResponseCode": "00", "Reference": "A2009110171" }
```

- **Success:** `ResponseCode == "00"` or `IsSuccessful == true`.
- **Contract confidence:** High — confirmed live (returned `"00" / Approved`).
- **Gotchas:** `AuthenticationKey` (not `Token`); `RetrievalReference` ≤ 12 chars;
  `Amount` in naira. Balance enforcement depends on the environment.

---

## 8. Inter-Bank (NIP) Transfer

Send from an account at this bank to an account at **another** Nigerian bank via
NIBSS Instant Payment. Requires the bank's NIP entitlement (Section 3).

- **Service:** Third Party API
- **`POST {BASE_THIRDPARTY}/Transfer/InterBankTransfer`**
- **Auth:** `Token` in body

### Request

| Field | Type | Required | Notes |
|---|---|---|---|
| `Token` | string | yes | `{AUTH_TOKEN}` |
| `Amount` | number | yes | **Naira** |
| `PayerAccountNumber` | string | yes | Sender NUBAN at this bank |
| `Payer` | string | yes | Sender name / description |
| `ReceiverBankCode` | string | yes | Destination bank's NIBSS code. Missing → `"Receiverbankcode not sent"` |
| `ReceiverAccountNumber` | string | yes | Recipient NUBAN at the other bank |
| `ReceiverName` | string | yes | Recipient name (from an interbank Name Enquiry) |
| `ReceiverAccountType` | string | yes | e.g. `"10"` (savings) |
| `ReceiverKYC` | string | yes | e.g. `"1"` |
| `ReceiverBVN` | string | no | If available |
| `ReceiverPhoneNumber` | string | no | If available |
| `TransactionReference` | string | yes | Your unique transaction reference |
| `RetrievalReference` | string | yes | Your retrieval reference (**≤ 12 chars**) |
| `Narration` | string | no | Description |

```json
{
  "Token": "{AUTH_TOKEN}",
  "Amount": 10,
  "PayerAccountNumber": "2024000153",
  "Payer": "JANE BOND DOE",
  "ReceiverBankCode": "058",
  "ReceiverAccountNumber": "0123456789",
  "ReceiverName": "JOHN DOE",
  "ReceiverAccountType": "10",
  "ReceiverKYC": "1",
  "ReceiverBVN": "",
  "ReceiverPhoneNumber": "",
  "TransactionReference": "txn123456789",
  "RetrievalReference": "ref123456789",
  "Narration": "Transfer"
}
```

### Response

| Field | Type | Notes |
|---|---|---|
| `Status` | string/int | `"Failed"` / numeric on validation error |
| `StatusDescription` | string | Human-readable |
| `ReferenceID` | int | BankOne internal id |
| `UniqueIdentifier` | string/null | |
| `IsSuccessFul` | bool | **Note the casing** |
| `ResponseMessage` | string | |
| `ResponseCode` | string | `"00"` success; `"96"` failed; `"12"` validation |
| `Reference` | string | Your reference echoed |
| `SessionID` | string/null | NIBSS session id |
| `RequestStatus` | bool | |
| `ResponseDescription` | string | |
| `ResponseStatus` | string | |

```json
{ "Status": "Failed", "IsSuccessFul": false, "ResponseCode": "96", "ResponseMessage": "Sender account name is not valid", "Reference": "txn123456789" }
```

- **Success:** `ResponseCode == "00"` or `IsSuccessFul == true`.
- **Contract confidence:** Medium — request shape confirmed (all fields accepted,
  reaches a business response). A clean success additionally requires: the bank's
  NIP entitlement enabled, and a **properly provisioned/funded sender account**.
  A `"96" "Sender account name is not valid"` indicates a sender/setup problem in
  that environment, not a request-shape problem.
- **Prerequisite:** run an **interbank Name Enquiry** (Section 5, with the
  destination `ReceiverBankCode`) first to obtain a valid `ReceiverName`.

---

## 9. Transaction Status Query (TSQ)

**TSQ = "Transaction Status Query."** Use it to find the *final* status of a
transfer that returned a **pending** response code, or to reconcile later. You
poll TSQ (e.g. every few seconds) until it reports success or failed.

- **Service:** Third Party API
- **`POST {BASE_THIRDPARTY}/CoreTransactions/TransactionStatusQuery`**
- **Auth:** `Token` in body (confirm)

### Request (best-known shape — confirm per bank)

| Field | Type | Required | Notes |
|---|---|---|---|
| `Token` | string | yes | `{AUTH_TOKEN}` |
| `TransactionReference` | string | yes | The reference used on the original transfer |
| `RetrievalReference` | string | maybe | The same ≤12-char retrieval reference |

```json
{ "Token": "{AUTH_TOKEN}", "TransactionReference": "txn123456789", "RetrievalReference": "ref123456789" }
```

### Response

Expected to mirror the transfer response: `ResponseCode` / `IsSuccessful` /
`Status`, plus a reference. Map to success / pending / failed using the same rules
as transfers (Section 4).

- **Contract confidence:** Low — **request/response not yet exercised.** Treat the
  shape as provisional and confirm against a bank whose transfers return pending.
- **When you need it:** only when a transfer returns a pending code. Purely
  synchronous "00" transfers don't require TSQ.

---

## 10. Account Opening (two-step)

Open a new customer + account. **Two calls:** create (returns only a success flag,
no account number), then fetch the new number by the tracking reference.

### 10a. Create Customer & Account

- **Service:** WebAPI
- **`POST {BASE_WEBAPI}/api/Account/CreateCustomerAndAccount/{VERSION}`**
- **Auth:** `authtoken` query parameter

#### Request

| Field | Type | Required | Notes |
|---|---|---|---|
| `TransactionTrackingRef` | string | **yes** | Your unique ref; also used to fetch the new number. Missing → `"TransactionTrackingRef is required."` |
| `AccountOpeningTrackingRef` | string | yes | Same value as `TransactionTrackingRef` is fine |
| `FirstName` | string | yes | |
| `LastName` | string | yes | |
| `OtherNames` | string | no | |
| `PhoneNo` | string | yes | |
| `Email` | string | no | |
| `BVN` | string | no | Empty may be accepted (bank-dependent) |
| `Gender` | string | **yes** | **Must be the word `"Male"` or `"Female"`.** `"M"`/`"F"`/numbers read as null → `"Gender can not be null"` / `"Invalid Gender"` |
| `DateOfBirth` | string | no | e.g. `"1990-05-01"` |
| `PlaceOfBirth` | string | no | |
| `Address` | string | no | |
| `NextOfKinName` | string | no | |
| `NextOfKinPhoneNo` | string | no | |
| `HasSufficientInfoOnAccountInfo` | bool | no | Send `true` |
| `NotificationPreference` | int | no | `0` |
| `InstitutionCode` | string | yes | `{INSTITUTION_CODE}` |
| `ProductCode` | string | **yes** | `{PRODUCT_CODE}` — must be a **real** product for this bank. Invalid → `"Invalid product code..."` |
| `AccountOfficerCode` | string | **yes** | `{ACCOUNT_OFFICER_CODE}` — must be an **existing** officer for this bank/env. Invalid → `"No Account Officer exists with accountofficercode [xxx]"` |

```json
{
  "TransactionTrackingRef": "open-0001",
  "AccountOpeningTrackingRef": "open-0001",
  "FirstName": "Chidi",
  "LastName": "Demo",
  "PhoneNo": "08037776655",
  "Email": "c@d.io",
  "BVN": "",
  "Gender": "Male",
  "DateOfBirth": "1990-05-01",
  "Address": "Abuja",
  "HasSufficientInfoOnAccountInfo": true,
  "NotificationPreference": 0,
  "InstitutionCode": "{INSTITUTION_CODE}",
  "ProductCode": "{PRODUCT_CODE}",
  "AccountOfficerCode": "{ACCOUNT_OFFICER_CODE}"
}
```

#### Response

| Field | Type | Notes |
|---|---|---|
| `IsSuccessful` | bool | **Success flag** |
| `Message` | string | e.g. `"Individual Customer and account Created successfully."` |
| `TransactionTrackingRef` | string | Echo (use in 10b) |
| `CustomerIDInString` | string/null | Often null here |
| `Page` | null | |

```json
{ "IsSuccessful": true, "Message": "Individual Customer and account Created successfully.", "TransactionTrackingRef": "open-0001" }
```

> **Gotcha:** the create response does **NOT** contain the new account number.
> Call 10b with the same `TransactionTrackingRef` to retrieve it.

### 10b. Get Account By Transaction Tracking Ref

- **Service:** WebAPI
- **`GET {BASE_WEBAPI}/api/Account/GetAccountByTransactionTrackingRef/{VERSION}`**
- **Auth:** `authtoken` query parameter

#### Request (query parameters)

| Param | Type | Required | Notes |
|---|---|---|---|
| `authtoken` | string | yes | `{AUTH_TOKEN}` |
| `transactionTrackingRef` | string | yes | The ref from 10a |
| `institutionCode` | string | yes | `{INSTITUTION_CODE}` |

#### Response (full account object)

| Field | Type | Notes |
|---|---|---|
| `AccountNumber` / `NUBAN` | string | **The new account number** |
| `AccountStatus` | string | e.g. `"Active"` |
| `AccountType` | string | e.g. `"SavingsOrCurrent"` |
| `AvailableBalance` / `WithdrawableBalance` | string | Naira |
| `CustomerID` | string | |
| `CustomerName` | string | |
| `DateCreated` | string | |
| `AccountTier`, `PNDStatus`, `AccessLevel`, `Branch`, … | various | May be null |

```json
{ "AccountNumber": "2024000263", "NUBAN": "2024000263", "AccountStatus": "Active", "AccountType": "SavingsOrCurrent", "AvailableBalance": "0.00", "CustomerID": "089012", "CustomerName": "Chidi Demo", "AccountTier": "1", "PNDStatus": false }
```

- **Success:** 10a `IsSuccessful == true`; 10b non-empty `AccountNumber`/`NUBAN`.
- **Contract confidence:** High — confirmed live end to end. New accounts open at
  ₦0.00.
- **Gotchas:** Gender must be `"Male"`/`"Female"`; `ProductCode` and
  `AccountOfficerCode` must be valid for that bank/environment; the account number
  comes from 10b, not 10a.
- **Other create endpoints seen but not used:** `Account/OnboardCustomer`
  (returned `"Invalid Request"` for our payload) and
  `CustomerAndAccountCreation/CreateCustomerAndAccount` (returned `404`). Prefer
  `CreateCustomerAndAccount`.

---

## 11. Transaction History

BankOne exposes account transaction history on the WebAPI. Whether a given bank's
token is authorised for it **varies per bank** (Section 3) — request the
entitlement during onboarding.

- **Service:** WebAPI
- **`GET {BASE_WEBAPI}/api/Account/GetTransactions/{VERSION}`**
- **Auth:** `authtoken` query parameter

### Request (query parameters — confirm per bank)

| Param | Type | Required | Notes |
|---|---|---|---|
| `authtoken` | string | yes | `{AUTH_TOKEN}` |
| `accountNumber` | string | yes | 10-digit NUBAN |
| `institutionCode` | string | yes | `{INSTITUTION_CODE}` |
| date-range params | string | maybe | BankOne docs mention a date range for this and related endpoints (`GetTransactions`, `GetDailyAccountStatement`, `SearchTransactionAdvanced`). Confirm exact param names against a bank that has it enabled |

### Response (expected shape — confirm)

A list (or `{ "Transactions": [ ... ] }`) of rows. Per row, expect approximately:

| Field (approx) | Notes |
|---|---|
| amount | e.g. `Amount` / `TransactionAmount` |
| credit/debit marker | e.g. `RecordType` / `Type` / `DrCr` |
| date | e.g. `TransactionDate` / `PostingDate` |
| narration | e.g. `Narration` / `Description` |
| reference | e.g. `ReferenceID` / `TransactionReference` |

- **Contract confidence:** Low — **response shape not yet verified** because the
  bank we tested had not enabled it (returned "AuthToken Not Configured for this
  institution"). Implement defensively and confirm the exact fields against a bank
  that has history enabled.
- **Related WebAPI endpoints (same auth model, unverified):**
  `GetDailyAccountStatement`, `GetAccountStatement`, `SearchTransactionAdvanced`.

---

## 12. Reference

### 12.1 Response codes (universal)

| Code | Meaning |
|---|---|
| `00` | Success / Approved |
| `01`, `09`, `25`, `91` | Pending / in progress → query TSQ |
| `12` | Validation error (missing/invalid field) |
| `96` | Failed (business rule) |

Also treat truthy `IsSuccessful` / `IsSuccessFul` as success.

### 12.2 Product codes and officer codes are PER BANK

There is no list-products or list-officers endpoint on the WebAPI we found. **Each
bank supplies its own product codes and account officer codes.** Store them per
bank. Do not hardcode one bank's values.

*Example only* (one staging bank's products — every bank's list differs): `100`
SAVINGS ACCOUNT, `101` EASY SAVINGS, `102` KIDDIES SAVINGS, `200` CURRENT
INDIVIDUAL, `203` SALARY CURRENT, … Ask each bank for its own list.

*Example only:* on that bank's staging, account officer `001` (Head Office)
existed; most other codes did not. Officer codes are environment-specific — always
use a code that exists in the environment you are calling.

### 12.3 Bank code

`{BANK_CODE}` is the bank's own NIBSS code, used for same-bank name enquiry and to
decide local vs. interbank routing. For interbank, `ReceiverBankCode` is the
destination bank's NIBSS code. Maintain a NIBSS bank-code list, or confirm whether
the bank's Third Party service exposes a bank-list endpoint.

---

## 13. Recommended call sequences

**Link an existing customer's account**
1. `Transfer/NameEnquiry` (`AccountNumber` + `{BANK_CODE}`) → confirm `Name`.

**Check balance**
1. `GetAccountByAccountNumber` (`accountNumber` + `{INSTITUTION_CODE}`) → `AvailableBalance`.

**Open a new account**
1. `CreateCustomerAndAccount` (`Gender`="Male"/"Female", `{PRODUCT_CODE}`, `{ACCOUNT_OFFICER_CODE}`, `TransactionTrackingRef`) → `IsSuccessful`.
2. `GetAccountByTransactionTrackingRef` (same ref) → new `AccountNumber`.

**Send money — same bank**
1. `Transfer/NameEnquiry` on the recipient → confirm name.
2. `CoreTransactions/LocalFundsTransfer` (`AuthenticationKey`, `Amount` naira, `RetrievalReference` ≤12) → `ResponseCode "00"`.
3. If pending → `TransactionStatusQuery` until final.

**Send money — other bank (NIP)**
1. `Transfer/NameEnquiry` on the recipient (with their `ReceiverBankCode`) → `ReceiverName`.
2. `Transfer/InterBankTransfer` (`Token`, `ReceiverBankCode`, `ReceiverName`, …) → `ResponseCode "00"`.
3. If pending → `TransactionStatusQuery` until final.

---

## 14. Onboarding checklist for a NEW bank

For each new BankOne bank you integrate, collect and verify:

- [ ] `{HOST}` (staging + production base URLs)
- [ ] `{AUTH_TOKEN}` (API key)
- [ ] `{INSTITUTION_CODE}`
- [ ] `{BANK_CODE}` (NIBSS)
- [ ] `{PRODUCT_CODE}` list (and which product new accounts should use)
- [ ] `{ACCOUNT_OFFICER_CODE}`(s) valid in the target environment
- [ ] One or two funded test accounts
- [ ] Confirm which **entitlements** are enabled (Section 3): name enquiry,
      balance, local transfer, interbank/NIP, transaction history, account opening.
      For any that return "AuthToken Not Configured", request the bank enable them.

---

## 15. Capability confidence at a glance

| Operation | Endpoint | Contract confidence | Per-bank entitlement to confirm |
|---|---|---|---|
| Name enquiry | `Transfer/NameEnquiry` | High | Third Party service enabled |
| Balance | `GetAccountByAccountNumber` | High | Usually on |
| Intra-bank transfer | `CoreTransactions/LocalFundsTransfer` | High | Third Party service enabled |
| Account create | `CreateCustomerAndAccount` + `GetAccountByTransactionTrackingRef` | High | Usually on; needs valid product + officer codes |
| Interbank transfer | `Transfer/InterBankTransfer` | Medium (shape confirmed; clean success needs provisioned sender + NIP) | NIP entitlement |
| TSQ | `CoreTransactions/TransactionStatusQuery` | Low (not exercised) | Third Party service |
| Transaction history | `GetTransactions` | Low (shape unverified) | Often **off** by default — request it |

_Contract shapes confirmed against a live BankOne staging instance, 2026-07-21.
Per-bank credentials, codes, and entitlements always vary — treat them as config._

---

# Appendix A — findings from the first deployment (added by Avni, 2026-08-20)

Everything above is the vendored bank-agnostic guide. This appendix records what
was observed probing **the first deployment's own token** against `staging.mybankone.com`.

## A.1 Entitlements

| Operation | the first deployment's Bank staging |
|---|---|
| Balance — `GetAccountByAccountNumber` | Enabled |
| Name enquiry — `Transfer/NameEnquiry` | Enabled (but stubbed — see A.4) |
| Intra-bank — `CoreTransactions/LocalFundsTransfer` | Enabled |
| Inter-bank NIP — `Transfer/InterBankTransfer` | **Enabled** |
| Transaction Status Query | Enabled |
| Transaction history — `GetTransactions` | **NOT enabled** |
| `GetDailyAccountStatement` | **HTTP 404** — absent from this deployment |

Distinguishing failures: a bad token returns `Invalid Token` at **HTTP 400**; an
unentitled operation returns **HTTP 200** with
`"AuthToken Not Configured for this institution"`.

## A.2 ⚠ Balances contain thousands separators

Section 4 says balances are naira decimal strings like `"1500.00"` and to parse
as float. **At values ≥ 1000 a comma appears**, which every documented example
misses:

```json
{"AvailableBalance":"1,000,000.00","LedgerBalance":"1,000,000.00","WithdrawableBalance":"0.00"}
```

`parseFloat("1,000,000.00")` returns **`1`** in JavaScript/TypeScript. A customer
with ₦1,000,000 would be shown ₦1, and every limit and threshold check downstream
would be wrong — silently, and only above ₦1,000, so small-value testing never
catches it.

**Rule: strip separators before parsing, and never pass a raw BankOne balance
string upward out of the Middleware.**

## A.3 ⚠ `IsSuccessful` on a TSQ response is not the transaction's outcome

```json
{"IsSuccessful":true,"ResponseMessage":"Failed","ResponseCode":"06","Status":"Failed"}
```

`IsSuccessful: true` means *the query executed*, not *the transfer succeeded*.
Section 4's general rule — treat truthy `IsSuccessful` as success — is **wrong for
this endpoint**, the one whose entire job is establishing whether money moved.

**Rule: read TSQ outcome from `ResponseCode`/`Status` only.**

Note `ResponseCode "06"`, absent from the Section 12.1 table. That table is not
exhaustive — **treat any unrecognised code as failure**, never as success.

## A.4 Staging name enquiry appears stubbed

The same fabricated account number returned the identical holder,
`"JANE BOND DOE"`, with `IsSuccessful: true`, for both the first deployment's own bank code and
GTBank's `058`. Real NIBSS name enquiry cannot resolve an arbitrary number at an
arbitrary bank.

So **interbank name enquiry is unverified**, despite Section 15 rating it High —
that rating rests on this same staging behaviour. Since `InterBankTransfer`
requires a `ReceiverName` sourced this way, beneficiary confirmation cannot be
validated before production or a properly wired staging tenancy.

## A.5 Still unverified

- **Whether `RetrievalReference` is deduplicated.** Untestable: the staging
  account has `WithdrawableBalance: "0.00"`, so transfers fail on funds before any
  duplicate check. **Until proven otherwise, assume no deduplication and make the
  Middleware responsible for it.**
- **`GetTransactions` response shape** — still unknown, pending the entitlement.
  In particular, **whether a row carries a credit/debit marker at all**. The
  Middleware reads a marker where there is one and falls back to the sign of the
  amount where there is none, which means a response with neither is
  indistinguishable from an account that only ever received money. Confirming
  which needs the entitlement *and* a funded account with real history.
- **TSQ shape in the *pending* case** — only the failed case has been observed.
- **Transaction limits by KYC tier** — not observable by probing.

## A.6 ⚠ §2's example `{BANK_CODE}` is a real bank's code, and it was copied

The parameter table in §2 gives `090110` as the example for `{BANK_CODE}`.
**`090110` is VFD Microfinance Bank.** The first deployment's Bank is `09XXXX` — per the bank list
the Bank themselves supplied, and **confirmed by the Bank**.

That example reached a live `.env`, and it is worth being precise about why
nothing caught it. `{BANK_CODE}` is sent as `BankCode` on same-bank name enquiry
and is what decides local-versus-interbank routing, so a wrong one means every
same-bank enquiry asks a *different institution* who holds an account — and
staging cannot show that, because staging's name enquiry is stubbed (A.4) and
answers `JANE BOND DOE` for anything. It is invisible in the only environment
available to test it in.

The second effect is worse and only appears once interbank routing exists: a
transfer a Customer meant for VFD resolves to the Bank's own code, and is
therefore sent down `LocalFundsTransfer` — reaching whoever holds that account
number at *this* bank.

**Rule: take `{BANK_CODE}` from the bank's own list, never from an example.** The
Middleware now checks its configured code against that list at boot and refuses
to start when the code belongs to a differently-named institution.
