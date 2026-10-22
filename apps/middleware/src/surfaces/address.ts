/**
 * Where a **Widget** posts a sealed surface.
 *
 * One function, in its own file, because two deployables have to agree about it
 * and neither may import the other: the Middleware *serves* this route and the
 * Widget *calls* it, and what carries the address between them is a field on the
 * outcome the Platform couriers. This is the Middleware's half — the route and
 * the URL are built from the same string, so a rename moves both.
 *
 * It is the **Middleware's own public address**, and that is the entire point.
 * The Platform serves the Widget and then hands it somewhere else to send the
 * Transaction PIN ([ADR-0007](../../../../docs/adr/0007-flow-confirmations-terminate-at-the-middleware.md)).
 */

/** The route, as the controller mounts it. */
export const WIDGET_SURFACE_PATH = "widget/surface";

/** The route, as a handset dials it. */
export const widgetSurfaceUrl = (publicBaseUrl: string): string =>
  `${publicBaseUrl.replace(/\/+$/, "")}/${WIDGET_SURFACE_PATH}`;
