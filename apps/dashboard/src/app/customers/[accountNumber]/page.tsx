import Link from "next/link";
import { redirect } from "next/navigation";
import type { ReactNode } from "react";

import {
  readCustomer,
  readCustomerBeneficiaries,
  readCustomerTransactions,
  type AccountView,
  type BeneficiaryView,
  type BindingView,
  type CustomerTransactions,
  type TransactionPeriod,
} from "../../../customers";
import { PERIOD_WORDS, formatMovement, formatNaira, formatWhen } from "../../../format";
import { currentSession } from "../../../session";
import { readingAsOfficer } from "../../guard";
import { StaffBar } from "../../staff-bar";
import {
  card,
  cell,
  dangerButton,
  heading,
  muted,
  notice,
  page,
  subheading,
  table,
} from "../../ui";
import { revoke } from "./actions";

/**
 * **Never cached, never prerendered, and it is stated rather than inherited.**
 *
 * Reading a cookie already forces dynamic rendering, and Next does not cache
 * `fetch` by default any more — but both of those are framework defaults, and
 * this page is the one where a cached render would be a look at a Customer's
 * money that left no audit row. A default that changes in a minor version must
 * not be what stands between a Bank and its own record of who looked.
 */
export const dynamic = "force-dynamic";

/**
 * One Customer, and everything the platform can honestly say about them.
 *
 * This is the highest-privacy screen in the product, and **opening it is the
 * sensitive act** — three reads, none of which changes anything, each of which
 * writes an audit row naming the Officer and this account before it runs.
 *
 * It is also the answer to *"where did my money go"* without alt-tabbing into
 * BankOne, which is the whole reason banking administration stayed in scope.
 * What it deliberately does not have is a card freeze, a dispute or a limit
 * change: BankOne exposes none of the three to the first deployment's tenancy, and a
 * button that failed every time would be worse than no button.
 */
const CustomerPage = async ({
  params,
  searchParams,
}: {
  params: Promise<{ accountNumber: string }>;
  searchParams: Promise<{ period?: string }>;
}): Promise<ReactNode> => {
  const session = await currentSession();
  if (!session) redirect("/sign-in");

  const { accountNumber } = await params;
  const period = periodFrom((await searchParams).period);

  // In parallel, because they are three independent reads of the same Customer
  // and an Officer is on the telephone. Each writes its own row regardless.
  const [customer, transactions, beneficiaries] = await readingAsOfficer(() =>
    Promise.all([
      readCustomer(session, accountNumber),
      readCustomerTransactions(session, accountNumber, period),
      readCustomerBeneficiaries(session, accountNumber),
    ]),
  );

  return (
    <main style={page}>
      <StaffBar account={session.account} />

      <h1 style={heading}>{customer.name ?? "Name unavailable"}</h1>
      <p style={muted}>{customer.accountNumber}</p>

      <h2 style={subheading}>Accounts</h2>
      {customer.accounts.map((account) => (
        <Account key={account.accountNumber} account={account} />
      ))}
      <p style={muted}>
        {/* Said out loud rather than left for somebody to infer from a list of
            one. BankOne offers no way to ask which accounts a person holds, and
            a Binding reaches one account and no other. */}
        The Bank&rsquo;s systems answer per account, so this shows the account you searched for
        and cannot list any others the same Customer may hold.
      </p>

      <h2 style={subheading}>WhatsApp</h2>
      {customer.bindings.length === 0 ? (
        <p style={muted}>This account has never been linked to a WhatsApp number.</p>
      ) : (
        customer.bindings.map((binding) => (
          <Binding key={binding.id} binding={binding} accountNumber={customer.accountNumber} />
        ))
      )}

      <h2 style={subheading}>Transactions</h2>
      <Periods accountNumber={customer.accountNumber} chosen={period} />
      <History transactions={transactions} />

      <h2 style={subheading}>Beneficiaries</h2>
      <Beneficiaries beneficiaries={beneficiaries} />
    </main>
  );
};

const Account = ({ account }: { account: AccountView }): ReactNode => {
  if (account.balances.outcome !== "read") {
    return (
      <div style={notice}>
        <p style={{ margin: 0, fontWeight: 600 }}>{account.accountNumber}</p>
        <p style={{ margin: "0.25rem 0 0" }}>{BALANCE_WORDS[account.balances.outcome]}</p>
      </div>
    );
  }

  return (
    <div style={card}>
      <p style={{ margin: 0, fontWeight: 600 }}>
        {account.accountNumber}
        {account.accountType ? ` · ${account.accountType}` : ""}
      </p>
      <table style={{ ...table, marginTop: "0.5rem" }}>
        <tbody>
          <tr>
            <th style={cell}>Available</th>
            {/* A number, formatted here. BankOne sent `"1,000,000.00"` and the
                Middleware parsed it; no wire string reaches this screen. */}
            <td style={cell}>{formatNaira(account.balances.available)}</td>
          </tr>
          <tr>
            <th style={cell}>Ledger</th>
            <td style={cell}>{formatNaira(account.balances.ledger)}</td>
          </tr>
          <tr>
            <th style={cell}>Withdrawable</th>
            <td style={cell}>{formatNaira(account.balances.withdrawable)}</td>
          </tr>
        </tbody>
      </table>
    </div>
  );
};

/**
 * Three different silences, three different sentences.
 *
 * `not_available` is an entitlement the Bank has not switched on and is nobody's
 * outage — the sentence says so, because an Officer who reads it as a fault
 * raises a ticket against the wrong party. `not_found` is ordinary here, where
 * an Officer may type any ten digits; `failed` is the only one worth trying
 * again. Collapsing them into *"something went wrong"* would send an Officer
 * chasing whichever of the three they guessed at.
 */
const BALANCE_WORDS: Record<"not_available" | "not_found" | "failed", string> = {
  not_available:
    "The Bank's token does not carry this read. Nothing is wrong with the account — this is an entitlement to request.",
  not_found: "The Bank's systems do not hold this account number.",
  failed: "The Bank's systems could not be read just now. Try again shortly.",
};

const Binding = ({
  binding,
  accountNumber,
}: {
  binding: BindingView;
  accountNumber: string;
}): ReactNode => (
  <div style={card}>
    <p style={{ margin: 0, fontWeight: 600 }}>
      {/* Masked, always. An Officer who searched by account number would
          otherwise learn the Customer's mobile number as a side effect. */}
      {binding.maskedIdentity} · {binding.live ? "Linked" : "Revoked"}
    </p>
    <p style={muted}>Enrolled {formatWhen(binding.enrolledAt)}</p>
    {binding.renewedAt ? <p style={muted}>Renewed {formatWhen(binding.renewedAt)}</p> : null}
    <p style={muted}>Last heard from {formatWhen(binding.lastActivityAt)}</p>
    {binding.revokedAt ? <p style={muted}>Revoked {formatWhen(binding.revokedAt)}</p> : null}

    {binding.live ? (
      <details>
        {/* Behind a disclosure rather than a button in the flow of the page.
            This stops a Customer reaching their own account, and it is the only
            control on this surface that changes anything. */}
        <summary>Revoke this Binding</summary>
        <p style={muted}>
          This WhatsApp number stops reaching the account on the Customer&rsquo;s next message.
          They can enrol again from the handset. Their saved Beneficiaries are not affected.
        </p>
        <form action={revoke}>
          <input type="hidden" name="accountNumber" value={accountNumber} />
          <input type="hidden" name="bindingId" value={binding.id} />
          <button style={dangerButton} type="submit">
            Revoke
          </button>
        </form>
      </details>
    ) : null}
  </div>
);

const Periods = ({
  accountNumber,
  chosen,
}: {
  accountNumber: string;
  chosen: TransactionPeriod;
}): ReactNode => (
  <p style={{ ...muted, display: "flex", gap: "1rem", flexWrap: "wrap" }}>
    {(Object.keys(PERIOD_WORDS) as TransactionPeriod[]).map((period) => (
      <Link
        key={period}
        href={`/customers/${accountNumber}?period=${period}`}
        style={period === chosen ? { fontWeight: 600 } : {}}
      >
        {PERIOD_WORDS[period]}
      </Link>
    ))}
  </p>
);

const History = ({ transactions }: { transactions: CustomerTransactions }): ReactNode => {
  if (transactions.outcome === "not_available") {
    // **The honest state, and today's.** `GetTransactions` is not entitled on
    // the Bank's token, so this is what the screen says until it is. It is
    // deliberately not an empty table: an Officer shown a blank would tell a
    // Customer nothing had happened on their account.
    return (
      <p style={notice}>
        Transaction history is not available on the Bank&rsquo;s current entitlements. This is not
        an empty account — the Bank&rsquo;s token does not carry this read at all.
      </p>
    );
  }
  if (transactions.outcome !== "read") {
    return <p style={notice}>{BALANCE_WORDS[transactions.outcome]}</p>;
  }
  if (transactions.rows.length === 0) {
    return <p style={muted}>Nothing happened on this account in this period.</p>;
  }

  return (
    <table style={table}>
      <thead>
        <tr>
          <th style={cell}>When</th>
          <th style={cell}>Amount</th>
          <th style={cell}>Narration</th>
          <th style={cell}>Reference</th>
        </tr>
      </thead>
      <tbody>
        {transactions.rows.map((row, index) => (
          <tr key={row.reference ?? index}>
            <td style={cell}>{formatWhen(row.occurredAt)}</td>
            <td style={cell}>{formatMovement(row.amount, row.direction)}</td>
            {/* The Customer did not write this; whoever paid them did. It is
                text in a cell and nothing else — never markup, never a link. */}
            <td style={cell}>{row.narration ?? ""}</td>
            <td style={cell}>{row.reference ?? ""}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
};

/**
 * Who the Customer pays.
 *
 * Two names per row, and they are **different things**: the label is the
 * Customer's own word for somebody, and `nameAtSave` is what that person's bank
 * called the account on the day it was saved. Conflating them is how somebody
 * approves a fraudulent account wearing a familiar label, so this screen never
 * shows the label alone.
 */
const Beneficiaries = ({
  beneficiaries,
}: {
  beneficiaries: readonly BeneficiaryView[];
}): ReactNode => {
  if (beneficiaries.length === 0) {
    return <p style={muted}>This Customer has not paid anybody through the platform.</p>;
  }

  return (
    <table style={table}>
      <thead>
        <tr>
          <th style={cell}>Saved as</th>
          <th style={cell}>Bank&rsquo;s name at the time</th>
          <th style={cell}>Account</th>
          <th style={cell}>Last paid</th>
        </tr>
      </thead>
      <tbody>
        {beneficiaries.map((beneficiary) => (
          <tr key={beneficiary.id}>
            <td style={cell}>{beneficiary.label === "" ? "—" : beneficiary.label}</td>
            <td style={cell}>{beneficiary.nameAtSave}</td>
            <td style={cell}>
              {beneficiary.accountNumber} · {beneficiary.bankName}
            </td>
            <td style={cell}>{formatWhen(beneficiary.lastUsedAt)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
};

const periodFrom = (asked: string | undefined): TransactionPeriod =>
  (Object.keys(PERIOD_WORDS) as TransactionPeriod[]).find((period) => period === asked) ??
  "last_month";

export default CustomerPage;
