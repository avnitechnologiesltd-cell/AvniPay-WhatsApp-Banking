/**
 * The Bank's identity API, stood up beside the Compose stack.
 *
 * **This is a stand-in for a service the Bank has not built yet**
 * (ticket 20).
 * Enrolment is the front door — an account number, a code to a contact already
 * on record, a Transaction PIN — and none of it can happen until `resolve`,
 * `send-otp` and `verify-otp` exist somewhere. This is somewhere, for as long as
 * that takes.
 *
 * It is the same fake the tests drive, from `packages/fakes`, so it behaves the
 * way the spec says rather than the way that would be convenient: it 404s an
 * account it does not hold, never returns a name or a contact detail, and
 * implements no lockout because attempt counting belongs to the platform.
 *
 * **It ships in no image.** It is run from the built `dist` on the host, which
 * is what keeps `tests/workspace-wiring.test.ts` — no fake in any deployable —
 * true while this exists.
 *
 *     node scripts/fake-bank-identity.mjs 2024000153 [more account numbers…]
 *
 * Every code it "sends" is printed here, because there is no SMS: this terminal
 * is the Customer's inbox.
 */

import { startFakeBankIdentity } from "../packages/fakes/dist/index.js";

const PORT = Number(process.env.FAKE_IDENTITY_PORT ?? 4010);
const API_KEY = process.env.BANK_IDENTITY_API_KEY ?? "dev-identity-key";
/** Fixed rather than random, so whoever is holding the handset can type it. */
const CODE = process.env.FAKE_IDENTITY_CODE ?? "123456";

// No account numbers needed. This fake holds whatever it is asked about, so
// you can type the account the Bank gave you straight into the Flow without
// telling this service about it first. Pass numbers anyway to seed them.
const accountNumbers = process.argv.slice(2);

const accounts = accountNumbers.map((accountNumber) => ({
  accountNumber,
  code: CODE,
  destinations: [
    { id: `${accountNumber}-phone`, kind: "phone", masked: "0803****901" },
    { id: `${accountNumber}-email`, kind: "email", masked: "a****@example.com" },
  ],
}));

const identity = await startFakeBankIdentity({
  apiKey: API_KEY,
  accounts,
  // Bound wide and on a fixed port, because the caller is the Middleware inside
  // a container and it arrives over the bridge rather than over loopback.
  listen: { host: "0.0.0.0", port: PORT },
  // A human is driving a real handset, and has not told this service which
  // account they hold. Never set in a test — see the option's note.
  code: CODE,
  admitAnyAccount: true,
});

const line = (text) => process.stdout.write(`${text}\n`);

line(`fake identity API listening on 0.0.0.0:${PORT}`);
line(`  accounts held : any account number you type` + (accountNumbers.length ? ` (seeded: ${accountNumbers.join(", ")})` : ""));
line(`  the code      : ${CODE}  ← type this when WhatsApp asks`);
line(`  api key       : ${API_KEY}`);
line("");
line("From a container, this is http://host.docker.internal:" + PORT);
line("Waiting. Every code sent and every notice appears below.");
line("");

// Poll the fake's own record rather than reaching inside it: this is the
// Customer's SMS inbox, printed as it fills.
let codes = 0;
let notices = 0;
let alerts = 0;
setInterval(() => {
  for (const sent of identity.codesSent.slice(codes)) {
    line(
      `[code]   account ${sent.accountNumber} → ${sent.destinationId}` +
        `  purpose=${sent.purpose || "(none)"}  CODE=${sent.code}`,
    );
  }
  codes = identity.codesSent.length;

  for (const notice of identity.noticesSent.slice(notices)) {
    line(`[notice] account ${notice.accountNumber} → ${notice.event}`);
  }
  notices = identity.noticesSent.length;

  for (const alert of identity.operationsAlerts.slice(alerts)) {
    line(`[ops]    ${alert.address} → ${alert.subject}`);
  }
  alerts = identity.operationsAlerts.length;
}, 500).unref?.();

process.on("SIGINT", () => {
  void identity.close().then(() => process.exit(0));
});
