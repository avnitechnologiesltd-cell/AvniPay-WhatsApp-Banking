/**
 * Injection tokens, in a file of their own.
 *
 * They live here rather than beside the module that provides them so that a
 * service can name a token without importing the composition root that wires
 * it — otherwise the module imports the service and the service imports the
 * module, and the cycle resolves to `undefined` at exactly the moment Nest
 * asks for it.
 */
export const PLATFORM_CONFIG = Symbol("PLATFORM_CONFIG");
export const INTENT_RESOLVER = Symbol("INTENT_RESOLVER");
/** The Support Agent. A separate model call from the resolver, and a larger model. */
export const SUPPORT_AGENT = Symbol("SUPPORT_AGENT");
export const WHATSAPP_SENDER = Symbol("WHATSAPP_SENDER");
export const WHATSAPP_MEDIA = Symbol("WHATSAPP_MEDIA");
/**
 * **`ObjectWriter`, and the type is the point.** This deployable moves a
 * Customer's file into object storage without opening it, and the interface it
 * is handed has no `get` — so "the Platform cannot read an attachment back" is
 * something the compiler enforces rather than something a reviewer notices.
 */
export const ATTACHMENT_WRITER = Symbol("ATTACHMENT_WRITER");
