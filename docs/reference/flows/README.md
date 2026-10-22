# The published Flows

Two, and only two. Both are **published on the Bank's own WhatsApp Business
Account**, in endpoint mode, and both exchange data with the Middleware at
`POST /flows/whatsapp` — never with the Platform
([ADR-0007](../../adr/0007-flow-confirmations-terminate-at-the-middleware.md)).

| File | Configuration key | Screens |
| --- | --- | --- |
| [`enrollment.flow.json`](enrollment.flow.json) | `WA_ENROLLMENT_FLOW_ID` | `IDENTIFY` → `CHOOSE_DESTINATION` → `CODE` → `SET_PIN` → `DONE` |
| [`send-money.flow.json`](send-money.flow.json) | `WA_SEND_MONEY_FLOW_ID` | `RECIPIENT` → `CONFIRM` → `DONE` |

Each also carries `LOCKED` and `UNAVAILABLE` as terminal screens. The Middleware
routes on the screen id, so these names are a contract rather than a label.

## Republished, never reused

**Do not import a Flow from the prior art.** The published prior-art Flow echoes
the amount and the account number back from the screen the server rendered, and
Flows encrypt with a key the *client* generates — so a handset that changes those
values on the way back has decided where money goes. That is a ₦900,000 debit
against a ₦5,000 confirmation, with a correct PIN and an honest screen.

The rule these two are built to, from
[ADR-0008](../../adr/0008-an-intent-becomes-a-mandate-when-authorised.md):

> The payload may carry **what the Customer newly supplies**. It must never
> carry back a value the server rendered.

So `CONFIRM` sends the PIN, its confirmation, and an optional label — three
things the Customer just typed. The amount, the account number and the
recipient's name are rendered from the stored Mandate and read back from there.
Echoing a tampered value is pointless rather than refused, which is the stronger
of the two.

## Publishing them

For each Flow, in the WhatsApp Manager:

1. Create a Flow, choose **Endpoint** mode, and paste the JSON.
2. Set the endpoint URI to `<MIDDLEWARE_PUBLIC_BASE_URL>/flows/whatsapp`.
   Both Flows use the same one.
3. Upload the **public** key — `secrets/whatsapp-flow-public.pem`. The private
   half stays on the VM and is referenced by path in `.env`.
4. Publish, and put the id into `.env`.

The endpoint is on the **Middleware** (port 3001), not the Platform (3002) which
takes the messages webhook. They need two tunnels, or one with path routing.

## Versions

`"version": "7.3"` and `"data_api_version": "3.0"`.

They are two different things and only the first is the schema. **Flow JSON
versions expire** — Meta moves each one Active → Frozen → Expired, and an
expired one stops working for Flows already published, not just for new ones.
`3.1` was the version this repository first carried and it is expired; publishing
it returns *"Given Flow JSON version is not supported"*. Check the
[changelog](https://developers.facebook.com/docs/whatsapp/flows/changelogs#currently-supported-versions)
before a publish rather than after one, because this is the one thing here that
rots on Meta's clock rather than on ours.

`data_api_version` is the endpoint contract — the shape of the request the
Middleware answers at `/flows/whatsapp`. It is unrelated to the schema version
and does not move with it.

## Two things to watch on the first publish

Both are recorded in the source and neither can be settled without a real
published Flow. They are here so that whoever publishes first knows what they
are looking at.

**1. `CONFIRM` is rendered by two different surfaces.** A transfer sends
`amount`, `destination_name`, `destination_account`, `destination_bank`,
`source_account` and `fee_note`. A **Gated** Connector sends `action` and
`details` instead — the same two-step surface with everything about money
removed ([ADR-0009](../../adr/0009-a-gated-connector-takes-the-transaction-pin.md)).
The screen declares the union of both and hides what is absent, so each surface
renders only its own fields.

**2. `visible` is bound to a string on several components.** `"visible":
"${data.error_message}"` is asking Meta to treat a non-empty string as true.
That is not obviously in the schema, which wants a boolean — so if the validator
rejects it, the fix is a boolean companion field per conditional block
(`has_error`, `is_creating_pin`, `name_did_change`) sent by the Middleware,
rather than dropping the conditionals and rendering blank lines.

**3. Some keys are sent only when they apply.** `pin_action` and `pin_note`
appear only when the Customer has no PIN yet; `name_changed` only when the
account's name has changed since it was saved; `error_message` only after a
refusal. Whether Meta tolerates an undeclared-but-absent key against a screen's
declared data model is the open question `transfers.service.ts` records at the
point it omits them. If the first publish rejects a `data_exchange` response for
a missing key, that is this — and the fix is to send every key always, with an
empty string for absent, rather than to change what the screens mean.
