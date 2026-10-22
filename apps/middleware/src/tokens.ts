/**
 * Injection tokens, in a file of their own.
 *
 * They live here rather than beside the module that provides them so that a
 * controller or service can name a token without importing the composition
 * root that wires it — otherwise the module imports the controller and the
 * controller imports the module, and the cycle resolves to `undefined` at
 * exactly the moment Nest asks for it.
 *
 * The Platform keeps the same arrangement, for the same reason.
 */
export const MIDDLEWARE_CONFIG = Symbol("MIDDLEWARE_CONFIG");
export const BANKONE_ADAPTER = Symbol("BANKONE_ADAPTER");
export const BANK_IDENTITY_CLIENT = Symbol("BANK_IDENTITY_CLIENT");
export const FLOWS_PRIVATE_KEY = Symbol("FLOWS_PRIVATE_KEY");
/**
 * Read-only against the attachment bucket, and typed as `ObjectReader` so it
 * is: the Middleware serves a Customer's file to a signed-in Officer and writes
 * nothing. The Platform holds the other half of this pair and cannot read.
 */
export const ATTACHMENT_READER = Symbol("ATTACHMENT_READER");
/**
 * Read **and** write, and only for the Library.
 *
 * A Library document is bytes an Administrator supplied and the platform reads
 * on purpose — the exact opposite of an attachment's rule, in the same bucket
 * under a different prefix. The asymmetry that matters is untouched: the
 * Platform is still handed an `ObjectWriter` with no `get` on it, so *"the
 * prompt-injection surface cannot read a Customer's documents"* is still a
 * compile error rather than a bucket policy.
 */
export const LIBRARY_STORE = Symbol("LIBRARY_STORE");
/**
 * The one outbound HTTP client that calls an address somebody typed into a
 * form, and the only reason it is a token rather than a `new` in the service.
 *
 * A Connector endpoint is on the public internet **by policy** — the dispatcher
 * refuses loopback, private and link-local addresses on the resolved address at
 * connect time — and a test's fake Bank API is necessarily on loopback. So the
 * network is injected the way the clock is, and the policy has no seam at all:
 * nothing a caller can pass makes `127.0.0.1` acceptable.
 */
export const CONNECTOR_DISPATCHER = Symbol("CONNECTOR_DISPATCHER");
