import Link from "next/link";
import type { ReactNode } from "react";

import type { StaffAccount } from "../staff";
import { endSession } from "./actions";

/**
 * Who is signed in, and the way out.
 *
 * The **role is shown**, and it is not decoration: an Officer who cannot change
 * the tariff should be able to see why without first pressing the button that
 * refuses them. Everything on the Customers surface is held by both roles, so
 * this is the only place the difference is visible from here at all.
 */
export const StaffBar = ({ account }: { account: StaffAccount }): ReactNode => (
  <nav
    style={{
      display: "flex",
      gap: "0.75rem",
      alignItems: "baseline",
      justifyContent: "space-between",
      borderBottom: "1px solid #eee",
      paddingBottom: "0.75rem",
      marginBottom: "1.5rem",
      color: "#555",
      fontSize: "0.9375rem",
    }}
  >
    <span style={{ display: "flex", gap: "0.75rem" }}>
      <Link href="/customers">Customers</Link>
      {/* Both roles again, and for a sharper reason than the others: an Officer
          who has just been handed a conversation needs to be able to check what
          the Support Agent was permitted to say. Only an Administrator decides
          what that is. */}
      <Link href="/library">Library</Link>
      {/* Shown to both roles. A Support Officer reads the tariff, the hours and
          the alert address and writes none of them — and reading them is most of
          what the screen is for on the telephone. */}
      <Link href="/settings">Settings</Link>
    </span>

    <span style={{ display: "flex", gap: "0.75rem", alignItems: "baseline" }}>
      <span>
        {account.displayName} ·{" "}
        {account.role === "administrator" ? "Administrator" : "Support Officer"}
      </span>
      <form action={endSession}>
        <button
          type="submit"
          style={{
            font: "inherit",
            color: "inherit",
            background: "none",
            border: 0,
            padding: 0,
            cursor: "pointer",
            textDecoration: "underline",
          }}
        >
          Sign out
        </button>
      </form>
    </span>
  </nav>
);
