import type { ContractVersion } from "./signed-identity";

/**
 * The **Snippet** — what an Administrator copies out of the Dashboard and the
 * Bank pastes into their mobile application, once, forever.
 *
 * It is a **loader, not the Widget**
 * ([ADR-0011](../../../../docs/adr/0011-the-snippet-is-a-loader-not-the-widget.md)).
 * Once this is inside an application on a Customer's handset it cannot be
 * recalled or force-upgraded — some Customers will not update for years, and we
 * serve whatever is out there for as long as they do not. So it contains as
 * close to nothing as possible: it fetches the real Widget from the Platform at
 * runtime and hands it the signed identity. The Confirmation screen, PIN entry,
 * the wording, a security fix — all of it lives on our side and reaches every
 * Customer at once.
 *
 * **What is frozen is only the contract between the loader and the server**: a
 * version string, the signed identity envelope, and the two names below that
 * the Widget reads itself out of. That turns *"we can never change the Widget"*
 * into *"we can never change four lines"*.
 *
 * A change to it is a **new version served alongside the old one, never an edit
 * to this one**. `snippet.test.ts` pins each version's bytes so that editing one
 * fails a test rather than a Customer's handset.
 */

/** Where the Bank puts the panel, and what the Widget reads itself out of. */
const MOUNT_ID = "avni-chat";
const GLOBAL = "AvniChat";

/**
 * How long the loader waits before it says so.
 *
 * The failure this exists for is not a script that 404s — `onerror` catches
 * that — but a network that hangs, where nothing ever fires and the Customer is
 * left looking at a blank rectangle inside their bank's application. Ten
 * seconds is long enough that a slow Nigerian mobile connection is not called a
 * failure, and short enough that nobody is still waiting.
 */
const LOADER_TIMEOUT_MS = 10_000;

/** What a Customer reads if the Widget does not arrive. Plain, never an error. */
export const LOADER_UNAVAILABLE_MESSAGE =
  "Chat is not available right now. Please try again shortly.";

const LOADER_LOADING_MESSAGE = "Loading chat…";

/**
 * Where the Bank's backend writes the envelope it signed for the Customer who
 * is already logged in to their application.
 */
export const IDENTITY_PLACEHOLDER = "SIGNED_IDENTITY_FROM_YOUR_BACKEND";

/**
 * The loader, per contract version.
 *
 * Written as one frozen string rather than assembled, because assembling it
 * would make it possible to change it by accident — and this is the one
 * interface on the map with no deprecation path.
 */
const LOADERS: Record<ContractVersion, (options: LoaderOptions) => string> = {
  v1: ({ platformBaseUrl, identity }) =>
    `(function (w, d) {
  var v = "v1", b = ${quote(platformBaseUrl)}, m = d.getElementById(${quote(MOUNT_ID)});
  var p = d.createElement("p"); p.textContent = ${quote(LOADER_LOADING_MESSAGE)}; if (m) m.appendChild(p);
  var fail = function () { if (m && p.parentNode === m) p.textContent = ${quote(LOADER_UNAVAILABLE_MESSAGE)}; };
  w.${GLOBAL} = { version: v, base: b, identity: ${quote(identity)}, mount: m };
  var s = d.createElement("script"); s.src = b + "/widget/" + v + "/widget.js"; s.async = true;
  s.onerror = fail; w.setTimeout(fail, ${LOADER_TIMEOUT_MS}); d.head.appendChild(s);
})(window, document);`,
};

export interface LoaderOptions {
  /** Where a handset reaches the Platform. Configuration, never a constant. */
  readonly platformBaseUrl: string;
  /** The envelope, or the placeholder the Bank substitutes at runtime. */
  readonly identity: string;
}

/** The loader's JavaScript alone, which is what the frozen contract actually is. */
export const loaderScript = (version: ContractVersion, options: LoaderOptions): string =>
  LOADERS[version](options);

/**
 * The Snippet as an Administrator copies it: the mount point, the loader, and a
 * placeholder where the Bank's backend writes the envelope.
 *
 * The panel comes first so that the failure message has somewhere to land even
 * if the Platform is unreachable — a loader whose mount point is created by the
 * script it failed to fetch has no failure state at all.
 */
export const snippetFor = (version: ContractVersion, platformBaseUrl: string): string =>
  [
    `<div id="${MOUNT_ID}"></div>`,
    "<script>",
    loaderScript(version, { platformBaseUrl, identity: IDENTITY_PLACEHOLDER }),
    "</script>",
  ].join("\n");

/**
 * What the Bank's backend has to do, in the words their engineer needs.
 *
 * ADR-0010 estimates five lines on their side, and this is the description that
 * makes that true. It ships beside the Snippet because a signing format nobody
 * can implement from the Dashboard is a support call, and because the Bank's
 * engineers are the only readers of it who matter.
 */
export const signingInstructions = (version: ContractVersion): readonly string[] => [
  `Sign the identity on your server, never on the handset. The Snippet's ${IDENTITY_PLACEHOLDER}`,
  "is replaced at runtime with the envelope below, built for whichever Customer is signed in.",
  "",
  `  payload   = base64url({"account":"<10-digit NUBAN>","exp":<unix seconds>})`,
  `  signature = base64url(HMAC-SHA256(<your signing secret>, "${version}." + payload))`,
  `  envelope  = "${version}." + payload + "." + signature`,
  "",
  "Keep the expiry short — minutes, not days — and keep the signing secret on your server.",
  "Anything unsigned, edited or expired is refused, and the account number is never trusted",
  "as a plain value.",
];

/** Quotes a value for embedding in the loader, with no way out of the string. */
const quote = (value: string): string => JSON.stringify(value);
