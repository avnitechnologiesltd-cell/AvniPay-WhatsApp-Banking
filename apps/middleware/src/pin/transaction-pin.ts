/**
 * The **Transaction PIN** — the secret a Customer chooses and enters to
 * authorise a **Mandate**, and, since
 * [ADR-0009](../../../../docs/adr/0009-a-gated-connector-takes-the-transaction-pin.md),
 * every **Gated** Connector call as well.
 *
 * BankOne has no PIN — the word appears nowhere in its API reference — so the
 * platform mints and holds its own. That is a credential the Bank does not
 * control, which is a decision reaching well past the Flow it was made in, and
 * it is why everything about how this one is stored is written down rather than
 * assumed.
 *
 * This file holds the rules about what a PIN *is*. Storage, attempts and lockout
 * are next door.
 */

/**
 * Four digits, which is what a Nigerian bank customer expects and what every
 * other PIN they hold is.
 *
 * It is also only 10,000 possibilities, and the two consequences of that are
 * both handled elsewhere and neither is optional: the lockout is the real
 * defence, and argon2id is the backstop for a database dump.
 */
export const PIN_LENGTH = 4;

/**
 * Three attempts, then an hour — and the counter is on the **Customer**, not on
 * the Mandate or the Connector call.
 *
 * Counting per transfer would let an attacker start a fresh one after every
 * third guess, which makes guessing four digits free. Gated Connector attempts
 * draw on this same budget for the same reason: separate counters would give six
 * guesses where the design intends three. It is one secret, so it gets one
 * budget, and the cost — a Customer who fumbles a support action cannot transfer
 * for an hour — is accepted rather than worked around.
 */
export const PIN_ATTEMPTS = 3;
export const PIN_LOCKOUT_MS = 60 * 60 * 1000;

const DIGITS = new RegExp(`^\\d{${PIN_LENGTH}}$`);

/**
 * Why a proposed PIN is not acceptable, or nothing.
 *
 * Length and digits only. Rejecting `0000` and `1234` is a defensible policy and
 * deliberately not made here: it shrinks an already small space, it belongs to
 * the Bank rather than to the vendor, and it is the kind of rule that is cheap
 * to add and expensive to remove once Customers have chosen around it.
 */
export const pinProblem = (pin: string): string | undefined =>
  DIGITS.test(pin) ? undefined : `Your PIN must be ${PIN_LENGTH} digits.`;

/**
 * What a Customer reads when the two fields do not agree.
 *
 * It lives here rather than beside either surface that sets a PIN, because
 * there are now two of them — enrollment's last screen on WhatsApp, and the
 * Confirmation screen in the Widget for a Customer who never enrolled — and one
 * sentence written twice is two sentences waiting to disagree.
 */
export const PINS_DIFFER = "Those two PINs are not the same.";

/**
 * The invitation to choose one, shown where a PIN is being **created** rather
 * than entered.
 *
 * Said plainly that it will be needed again, because a Customer typing four
 * digits in the middle of sending money will otherwise read it as a step in
 * this transfer rather than as a credential they now hold.
 */
export const CHOOSE_A_PIN =
  `Choose a ${PIN_LENGTH}-digit Transaction PIN. You will use it every time you send money.`;
