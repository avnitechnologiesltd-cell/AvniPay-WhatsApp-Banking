import { WIDGET_V1_SOURCE, WIDGET_V1_STYLES } from "./versions/v1";

/**
 * The **loader-to-server contract**, from the server's side.
 *
 * A Snippet already pasted into a shipped mobile application cannot be recalled
 * or force-upgraded, so this map only ever grows: a change to the contract is a
 * new key served alongside the old one, never an edit to an existing one
 * ([ADR-0011](../../../../docs/adr/0011-the-snippet-is-a-loader-not-the-widget.md)).
 * The Widget *behind* a version changes as often as we like — that is what the
 * loader exists for. The version is what the loader was told to ask for.
 *
 * The Middleware keeps its own list, because it is what mints a Snippet and the
 * two deployables share no code (ADR-0003). `tests/in-app-chat.test.ts` asserts
 * the two agree, which is the only place that can.
 */
const WIDGETS: Record<string, { readonly source: string; readonly styles: string }> = {
  v1: { source: WIDGET_V1_SOURCE, styles: WIDGET_V1_STYLES },
};

export const SERVED_CONTRACT_VERSIONS: readonly string[] = Object.keys(WIDGETS);

/**
 * The Widget for a contract version, or nothing.
 *
 * Styles are injected by the same file rather than fetched separately, so the
 * Bank pastes no stylesheet link and a Customer on a slow connection never sees
 * an unstyled panel.
 */
export const widgetFor = (version: string): string | undefined => {
  const widget = WIDGETS[version];
  if (!widget) return undefined;

  return [
    "(function(d){var s=d.createElement('style');",
    `s.textContent=${JSON.stringify(widget.styles)};`,
    "d.head.appendChild(s);})(document);",
    widget.source,
  ].join("\n");
};
