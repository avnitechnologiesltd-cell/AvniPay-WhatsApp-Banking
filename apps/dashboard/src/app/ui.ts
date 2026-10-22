import type { CSSProperties } from "react";

/**
 * The Dashboard's few styles, in one place.
 *
 * Deliberately small. This is an internal tool for a handful of people at one
 * bank, and the thing it has to get right is that a balance, a name and a
 * *"could not be read"* are all unmistakable at a glance — not that it has a
 * design system. A stylesheet would arrive with a build step and a class-naming
 * argument, for a surface with four screens on it.
 */

export const page: CSSProperties = {
  maxWidth: "56rem",
  margin: "0 auto",
  padding: "2rem 1.5rem 4rem",
};

export const heading: CSSProperties = { fontSize: "1.375rem", margin: "0 0 0.25rem" };

export const subheading: CSSProperties = {
  fontSize: "0.9375rem",
  fontWeight: 600,
  textTransform: "uppercase",
  letterSpacing: "0.06em",
  color: "#555",
  margin: "2rem 0 0.75rem",
};

export const muted: CSSProperties = { color: "#555", margin: "0.25rem 0" };

export const card: CSSProperties = {
  border: "1px solid #ddd",
  borderRadius: "0.5rem",
  padding: "1rem 1.25rem",
  margin: "0 0 0.75rem",
};

export const field: CSSProperties = {
  display: "block",
  width: "100%",
  padding: "0.5rem 0.625rem",
  border: "1px solid #bbb",
  borderRadius: "0.375rem",
  font: "inherit",
  marginTop: "0.25rem",
};

export const button: CSSProperties = {
  padding: "0.5rem 1rem",
  border: "1px solid #333",
  borderRadius: "0.375rem",
  background: "#333",
  color: "#fff",
  font: "inherit",
  cursor: "pointer",
};

/**
 * For the one write on this surface. A Binding revocation stops a Customer
 * reaching their account, so the control that does it does not look like the
 * controls that do not.
 */
export const dangerButton: CSSProperties = {
  ...button,
  background: "#fff",
  color: "#a11",
  borderColor: "#a11",
};

export const table: CSSProperties = {
  width: "100%",
  borderCollapse: "collapse",
  fontVariantNumeric: "tabular-nums",
};

export const cell: CSSProperties = {
  textAlign: "left",
  padding: "0.5rem 0.75rem 0.5rem 0",
  borderBottom: "1px solid #eee",
  verticalAlign: "top",
};

/**
 * Every *"we could not read this"* on the surface wears the same clothes, so an
 * Officer learns the shape once. An honest blank is a first-class answer here —
 * `not_available` is what the Bank's own token says about transaction history
 * today — and it must never be mistaken for an empty account.
 */
export const notice: CSSProperties = {
  ...card,
  background: "#fffaf0",
  borderColor: "#e0c58a",
  color: "#6b4e10",
};
