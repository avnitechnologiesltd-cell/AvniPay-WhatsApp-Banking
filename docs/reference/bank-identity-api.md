# Bank Identity API — specification for the Bank

**Status:** specification, to be built by the Bank. Not yet implemented.
**Consumer:** the Middleware, and only the Middleware ([ADR-0002](../adr/0002-middleware-is-the-sole-path-to-bankone.md), [ADR-0006](../adr/0006-secrets-and-security-records-live-outside-the-platform.md)).
**Written by:** ticket 09 — Design the enrollment Flow.

---

## 1. Why this exists

Enrollment binds a Customer's WhatsApp number to their identity in the core banking
system. The design settled during charting is: the Customer supplies an account
number, a one-time code goes to a phone number or email **already on record**, and
on success the WhatsApp number is bound to that Customer.

Building the enrollment prototype established that BankOne cannot support this:

| What enrollment needs | BankOne endpoint that provides it |
|---|---|
| The contact on record for an account — phone or email | **None.** `NameEnquiry` returns name, BVN and KYC. `GetAccountByAccountNumber` returns balances. Neither returns contact details. |
| Deliver a one-time code to that contact | **None.** |
| Check the code | **None.** |

See [`bankone-api.md`](bankone-api.md) sections 5, 6 and 11.

**One thing this spec deliberately does not ask for.** An earlier draft also asked the Bank
for a `CustomerID`, because the Binding was to the Customer. **The Binding is now to a single
account**, and every operation the platform performs is keyed on the account number — balance,
name enquiry, both transfer types and history all take an account number and none takes a
`CustomerID`. So the Bank is not asked to invent or guarantee any identifier. The account
number the Customer already knows is the only key in play.

So the Bank builds these endpoints. They may be backed by BankOne, by the Bank's
own customer database, or by anything else — the platform does not care, and
deliberately does not ask.

> **Three became four on 2026-08-21.** `resolve`, `send-otp` and `verify-otp`
> are unchanged. [§4.4](#44-tell-the-contact-on-record-that-something-happened)
> adds `notify`, which the auto-revoke rule always needed and this spec never
> provided: the platform must be able to tell the contact on record that a
> Binding was revoked by an enrollment elsewhere, and it cannot, because it does
> not hold the contact. It is a two-field request with no message body.

## 2. The one design decision to read before the endpoints

**The Bank's service sends the code. The platform never learns the contact.**

The obvious alternative — the Bank returns the phone number and email, and the
platform sends the code itself — was rejected for two reasons:

1. **It would introduce an SMS and email delivery vendor** that nothing on the
   project has costed, contracted or security-reviewed, on the critical path of
   the front door. The Bank already sends OTPs and transaction alerts today.
2. **It would put every Customer's contact details inside the platform.**
   [ADR-0006](../adr/0006-secrets-and-security-records-live-outside-the-platform.md)
   exists to keep exactly this kind of data out. The Binding holds an account
   number and three dates and nothing else, by design.

The consequence is that the platform works entirely in **opaque destination
handles** and **masked labels**. It shows the Customer "••• ••• 6655", the
Customer picks it, and the platform asks the Bank to send to handle `d1`. At no
point does the platform hold `08037776655`.

## 3. Transport and auth

- HTTPS only, reachable from the Middleware's network only.
- Auth: a bearer token or mutual TLS, the Bank's choice. Whatever it is, it is
  Middleware-side configuration and never appears in the Platform.
- All request and response bodies are JSON. All timestamps ISO-8601 UTC.
- Every request carries `X-Request-Id` (a UUID the Middleware generates) for
  correlation in both parties' logs.

## 4. Endpoints

### 4.1 Resolve an account number

```
POST /identity/resolve
{ "accountNumber": "2024000153" }
```

**200 — resolved**

```json
{
  "destinations": [
    { "id": "d1", "kind": "phone", "masked": "••• ••• 6655" },
    { "id": "d2", "kind": "email", "masked": "c•••@g•••.com" }
  ]
}
```

**404 — no such account, or the account is not in a state that permits enrollment**

```json
{ "error": "not_found" }
```

Rules:

- **The response carries no customer identifier**, by design — see §1. A `200`
  means "this account exists and can be enrolled"; the account number the caller
  supplied is the only key.
- **`destinations[].id` must be opaque and must not be a stable public identifier**
  of the contact. Scoped to this resolve call is ideal; scoped to the Customer is
  acceptable. It must not be the phone number, an index into a public list, or
  anything that leaks the contact if guessed.
- **`masked` is display text and the Bank chooses the masking.** The platform
  renders it verbatim. Recommended: phone as `••• ••• ` + last 4; email as first
  character + `•••@` + first character of domain + `•••.` + TLD. Showing more —
  a leading `0803`, a full domain — hands the network operator or mail provider
  of an account that may not be the requester's to anyone who asks.
- **Return `404` honestly.** Do not invent a plausible-looking response for an
  unknown account. The platform handles enumeration resistance itself (§6); a
  half-implementation on both sides is worse than a clean one on either.
- **Never return the account holder's name.** Account number in, real name out,
  with no verification, is a free enumeration oracle — and it is what the previous
  implementation did.

### 4.2 Send a one-time code

```
POST /identity/send-otp
{ "accountNumber": "2024000153", "destinationId": "d1", "purpose": "enrollment" }
```

`purpose` is `"enrollment"`, `"renewal"` or `"pin_reset"` and exists so the Bank
can word the message appropriately. A renewal message always reaches someone who
has not used the service in three months, so it lands cold — see §5.

> **`pin_reset` added 2026-08-21, while building ticket 29.**
> A forgotten Transaction PIN resets over this same path rather than through a
> Support Officer or a new mechanism, so the Bank needs to be able to say *"this
> code is to set a new Transaction PIN"* rather than *"to link WhatsApp
> banking"*. It is a third word in an existing field, not a fourth endpoint. A
> Bank that ignores it and sends the enrollment wording is wrong but not broken.

**202 — accepted**

```json
{ "sent": true, "expiresAt": "2026-08-20T14:32:00Z" }
```

**4xx** on an unknown `accountNumber`/`destinationId` pair.

Rules:

- **The Bank generates the code, delivers it, and owns its expiry.** Target expiry
  is **10 minutes**. Not 5: Nigerian SMS delivery is routinely slower than that,
  and a code that expires before it arrives produces support calls, not security.
- The response must **not** contain the code, and must not echo the contact.
- The Bank may rate-limit sends per Customer. The platform also rate-limits, per
  WhatsApp number (§6) — the two are complementary, not redundant.

### 4.3 Verify a one-time code

```
POST /identity/verify-otp
{ "accountNumber": "2024000153", "destinationId": "d1", "code": "482913" }
```

**200**

```json
{ "verified": true }
```

```json
{ "verified": false, "reason": "incorrect" }
```

`reason` is one of `incorrect`, `expired`, `not_sent`. It is for the Middleware's
logs and is **never surfaced to the Customer** — see §6.

Rules:

- The Bank verifies the code it issued. **The Bank does not implement lockout.**
  Attempt counting and lockout are the platform's, because they are scoped to the
  WhatsApp number rather than to the Customer, and because they are load-bearing
  for enumeration resistance.
- A code must be **single-use**: a successful verification invalidates it.

### 4.4 Tell the contact on record that something happened

> **Added 2026-08-21, while building ticket 29.**
> This spec was written with three endpoints and the count was wrong: ticket 09
> settled auto-revoke-on-new-enrollment and settled that **notification is the
> mitigation** for its one real cost, and there was no way for the platform to
> notify a contact it is designed never to learn. So this is a fourth endpoint
> the Bank builds, and it is the smallest of the four.

```
POST /identity/notify
{ "accountNumber": "2024000153", "event": "binding_revoked_by_new_enrollment" }
```

**202 — accepted**

```json
{ "sent": true }
```

Rules:

- **The Bank decides where it goes** — the same contacts `resolve` would have
  offered, or all of them. The platform holds no address and passes none.
- `event` is a closed vocabulary and today has exactly one value. It exists so
  the Bank can write copy per event rather than receive a message body from us;
  **the platform never sends message text**, here or anywhere.
- Best-effort. A failure here must not fail the enrollment that triggered it: a
  Customer whose phone was stolen has to be able to enroll on a new number even
  if the notification service is down, and a revocation the Bank could not
  announce is still a revocation the audit table records.

**Why this matters more than its size suggests.** Enrolling an account on a new
number revokes the old Binding, which closes the stolen-phone window from ninety
days to minutes. The cost is that a SIM-swap attacker who can receive the
Customer's code enrols on their own number and locks the real Customer out as a
side effect. A Handoff would not have prevented that — the attacker passed the
same code an Officer would have relied on. What this endpoint buys is that the
takeover is **announced to the one address the attacker does not hold**, which
turns a silent loss of access into something the Customer can report.

### 4.5 Page the Bank's own operations desk

> **Added 2026-08-23, while building ticket 36.**
> A fifth endpoint, and the only one on this API that is **not about a
> Customer**. It exists because ticket 10
> settled that a transfer still `pending` past the inline poll bound becomes a
> Handoff — and a transfer stuck overnight means a Customer's money has left
> their account and nobody is looking at it until morning.

```
POST /identity/alert-operations
{
  "address": "operations@bank.example",
  "subject": "A transfer is unresolved and needs a Support Officer",
  "body": "Account: 2024000153\nConversation: …\nHandoff: …\nDetail: …"
}
```

**202 — accepted**

```json
{ "sent": true }
```

Rules:

- **It goes to the Bank, never to a Customer.** So it needs no approved WhatsApp
  template and draws on no messaging tier — the two constraints that shape
  everything else the platform sends.
- **The address comes from us**, which is the one place this endpoint differs
  from every other on this API. The Bank sets it in the Dashboard, so the
  platform holds it; the *sending* is still the Bank's, because they run a
  notification service and the platform runs no mail transport.
- **The body carries an account number, a conversation id and a reference, and
  nothing a Customer wrote.** This leaves the platform and lands in a mailbox we
  do not control.
- Best-effort, like `notify`. What did and did not go out is in the audit table —
  and an address the Bank has never configured is recorded as `unavailable` and
  logged as an error rather than passing silently, because a stuck transfer that
  nobody is told about is the failure this whole path exists to prevent.

**Whether the Bank staffs that address is the Bank's decision.** The platform's
obligation is to make sure the alert is never sitting silently in a queue at 3am.

## 5. Message wording (renewal in particular)

A Binding expires after **90 days with no Customer-initiated contact**
(ticket 03).
So a renewal code *always* arrives at someone who has not touched the service in
three months. It has no conversational context around it, and it looks exactly
like a phishing message.

The Bank owns this copy. It should name the Bank, say plainly that the code is
to keep WhatsApp banking active, and state that the Bank will never ask for the
code by phone or message. This is the Bank's anti-phishing language to write,
not the vendor's.

## 6. What the platform does on its side

Recorded here so the Bank's implementers can see where the boundary falls, and so
nobody builds it twice.

- **Enumeration resistance.** For an account number the Bank returns `404` for,
  the platform still shows a destination screen and a code screen, and still fails
  with the same wording as a wrong code. The decoy destinations are derived
  deterministically from the account number — random decoys are themselves an
  oracle, since two probes of the same number would differ.
- **One failure message.** Wrong account number, wrong code, expired code and
  never-sent code are indistinguishable to the Customer. Only the Middleware's
  logs tell them apart.
- **NUBAN check digit, validated locally.** A malformed account number is rejected
  in the Flow with a clear message and never reaches this API. This is what makes
  enumeration resistance survivable for a Customer who mistypes one digit —
  without it, a typo costs them the full silent walk to lockout.
- **Attempts and lockout.** 3 attempts, then a 1-hour lockout on that WhatsApp
  number.
- **The Binding.** `{ channelIdentity, accountNumber, enrolledAt, renewedAt,
  revokedAt }`, in the Middleware's database. Nothing else — no name, no customer
  identifier, no contact details. One account per channel identity.

## 7. Open questions for the Bank

1. Which contacts count as "on record" — every contact the Bank holds, or only
   ones the Customer has confirmed? An unverified contact captured at onboarding
   is a weaker root of trust than the design assumes.
2. What happens for an account with **no** contact on record at all? Enrollment
   has nowhere to send a code, and the answer is probably a branch Handoff.
3. Is there an existing OTP service inside the Bank this should wrap rather than
   duplicate?
4. Delivery-failure visibility: if the SMS bounces, does `send-otp` still return
   `202`? The platform cannot distinguish "not delivered" from "Customer ignored
   it", and after 3 attempts the Customer is locked out of a failure that was not
   theirs.
