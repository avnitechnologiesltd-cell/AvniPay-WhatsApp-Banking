/**
 * A 32-byte key for the tests that need one, in one place.
 *
 * The Middleware refuses anything that is not 32 bytes of base64, so every
 * suite that boots it has to supply one — and five copies of
 * `Buffer.alloc(32, 7)` scattered across the tree is five places to fix on the
 * day the cipher changes.
 *
 * Fixed rather than random, so a failure is reproducible. It is a fixture and
 * never reaches an image: `tests/workspace-wiring.test.ts` keeps this whole
 * package out of every deployable.
 */
export const TEST_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");
