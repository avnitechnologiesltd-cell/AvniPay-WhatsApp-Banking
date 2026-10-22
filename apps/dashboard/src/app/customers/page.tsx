import Link from "next/link";
import { redirect } from "next/navigation";
import type { ReactNode } from "react";

import { searchCustomers, type CustomerMatch } from "../../customers";
import { currentSession } from "../../session";
import { readingAsOfficer } from "../guard";
import { StaffBar } from "../staff-bar";
import { button, card, field, heading, muted, notice, page, subheading } from "../ui";

/** Never cached — a search is an audited act. See the Customer page for why. */
export const dynamic = "force-dynamic";

/**
 * Finding a Customer.
 *
 * **There are two keys and no third.** An account number, or the number the
 * Customer is calling from — because BankOne resolves an account number to a
 * name and never the reverse, and the Bank's identity API is explicitly
 * forbidden from answering with a name at all. So there is no search by name,
 * and the honest thing is to say so rather than return nothing.
 *
 * The search itself is audited before it runs, which is why the query is a
 * `GET` in the URL and not a thing this page does quietly on the way past.
 */
const CustomersPage = async ({
  searchParams,
}: {
  searchParams: Promise<{ q?: string }>;
}): Promise<ReactNode> => {
  const session = await currentSession();
  if (!session) redirect("/sign-in");

  const query = ((await searchParams).q ?? "").trim();
  const result =
    query === "" ? undefined : await readingAsOfficer(() => searchCustomers(session, query));

  return (
    <main style={page}>
      <StaffBar account={session.account} />
      <h1 style={heading}>Customers</h1>
      <p style={muted}>
        Search by account number, or by the number the Customer is calling from.
      </p>

      <form method="GET">
        <label>
          Account number or phone number
          <input
            style={field}
            name="q"
            defaultValue={query}
            inputMode="numeric"
            autoFocus
            required
          />
        </label>
        <p style={muted}>
          <button style={button} type="submit">
            Search
          </button>
        </p>
      </form>

      {result === undefined ? null : result.outcome === "unreadable" ? (
        <p style={notice}>
          That is neither an account number nor a Nigerian mobile number. This surface cannot
          search by name — the Bank&rsquo;s systems resolve an account number to a name, never
          the other way round.
        </p>
      ) : (
        <>
          {result.bankSilent ? (
            <p style={notice}>
              The Bank&rsquo;s systems did not answer about that account number just now, so this
              is <strong>not</strong> the same as no such Customer. Try again shortly.
            </p>
          ) : null}

          <h2 style={subheading}>
            {result.matches.length === 0
              ? "Nobody found"
              : `${result.matches.length} match${result.matches.length === 1 ? "" : "es"}`}
          </h2>

          {result.matches.length === 0 && !result.bankSilent ? (
            <p style={muted}>No account or Binding matches that.</p>
          ) : (
            result.matches.map((match) => <Match key={match.accountNumber} match={match} />)
          )}
        </>
      )}
    </main>
  );
};

const Match = ({ match }: { match: CustomerMatch }): ReactNode => {
  const live = match.bindings.filter((binding) => binding.live);

  return (
    <div style={card}>
      <p style={{ margin: 0, fontWeight: 600 }}>
        <Link href={`/customers/${match.accountNumber}`}>
          {/* The bank's own name for the account. Absent where BankOne would
              not say, and an account with no name is shown as exactly that
              rather than as a name this page invented. */}
          {match.name ?? "Name unavailable"}
        </Link>
      </p>
      <p style={muted}>{match.accountNumber}</p>
      <p style={muted}>
        {live.length === 0
          ? "No WhatsApp number is linked to this account."
          : `WhatsApp ${live.map((binding) => binding.maskedIdentity).join(", ")}`}
      </p>
      <p style={muted}>
        Found by {match.matchedOn === "account_number" ? "account number" : "phone number"}.
      </p>
    </div>
  );
};

export default CustomersPage;
