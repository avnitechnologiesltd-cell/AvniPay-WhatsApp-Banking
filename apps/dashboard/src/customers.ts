import { ask, MiddlewareRefused, type Session } from "./middleware-client";

/**
 * The Dashboard's Customers surface, read **through the Middleware**.
 *
 * **Every function here needs a session token, and every one of them leaves a
 * row.** That is not incidental to this module; it is the module's reason for
 * going through the Middleware at all. Two of these reads change nothing and are
 * the most sensitive things on the surface: who a Customer pays, and everything
 * they have ever done with their money.
 *
 * The request itself, and the shape of a refusal, are in `middleware-client.ts` — see
 * there for why the Dashboard never reaches Postgres.
 */

export { MiddlewareRefused, type Session };

export type TransactionPeriod = "today" | "last_week" | "last_month" | "last_three_months";

/** One handset's link to an account, as an Officer is shown it. */
export interface BindingView {
  readonly id: string;
  /** `••• ••• 5678`. The Middleware masks it; the whole number is never sent. */
  readonly maskedIdentity: string;
  readonly enrolledAt: string;
  readonly renewedAt: string | null;
  readonly revokedAt: string | null;
  readonly lastActivityAt: string;
  readonly live: boolean;
}

export type Balances =
  | {
      readonly outcome: "read";
      /** Naira, as numbers. A BankOne string never reaches this module. */
      readonly available: number;
      readonly ledger: number;
      readonly withdrawable: number;
    }
  | { readonly outcome: "not_available" }
  | { readonly outcome: "not_found" }
  | { readonly outcome: "failed" };

export interface AccountView {
  readonly accountNumber: string;
  readonly accountType: string | undefined;
  readonly balances: Balances;
}

export interface CustomerView {
  readonly accountNumber: string;
  readonly name: string | undefined;
  readonly accounts: readonly AccountView[];
  readonly bindings: readonly BindingView[];
}

export interface CustomerMatch {
  readonly accountNumber: string;
  readonly name: string | undefined;
  readonly matchedOn: "account_number" | "channel_identity";
  readonly bindings: readonly BindingView[];
}

export type CustomerSearchResult =
  | { readonly outcome: "unreadable" }
  | {
      readonly outcome: "searched";
      readonly matches: readonly CustomerMatch[];
      readonly bankSilent: boolean;
    };

export interface TransactionView {
  readonly amount: number;
  readonly direction: "credit" | "debit";
  readonly occurredAt: string | undefined;
  readonly narration: string | undefined;
  readonly reference: string | undefined;
}

export type CustomerTransactions =
  | {
      readonly outcome: "read";
      readonly period: TransactionPeriod;
      readonly rows: readonly TransactionView[];
    }
  | { readonly outcome: "not_available" }
  | { readonly outcome: "not_found" }
  | { readonly outcome: "failed" };

export interface BeneficiaryView {
  readonly id: string;
  readonly label: string;
  readonly nameAtSave: string;
  readonly bankName: string;
  readonly bankCode: string;
  readonly accountNumber: string;
  readonly createdAt: string;
  readonly lastUsedAt: string;
}

export const searchCustomers = (
  session: Session,
  query: string,
): Promise<CustomerSearchResult> =>
  ask(session, `/dashboard/customers?q=${encodeURIComponent(query)}`, "the Customer search");

export const readCustomer = (session: Session, accountNumber: string): Promise<CustomerView> =>
  ask(session, `/dashboard/customers/${encodeURIComponent(accountNumber)}`, "a Customer read");

export const readCustomerTransactions = (
  session: Session,
  accountNumber: string,
  period: TransactionPeriod,
): Promise<CustomerTransactions> =>
  ask(
    session,
    `/dashboard/customers/${encodeURIComponent(accountNumber)}/transactions?period=${period}`,
    "a transaction history read",
  );

export const readCustomerBeneficiaries = async (
  session: Session,
  accountNumber: string,
): Promise<readonly BeneficiaryView[]> => {
  const body = await ask<{ beneficiaries?: readonly BeneficiaryView[] }>(
    session,
    `/dashboard/customers/${encodeURIComponent(accountNumber)}/beneficiaries`,
    "a Beneficiary read",
  );
  return body.beneficiaries ?? [];
};

/**
 * The one write on this surface, and it is a security event.
 *
 * Whether the Binding was live a moment ago is not this function's to report:
 * the Middleware answers the same way for a Binding it destroyed and one that
 * was already gone, because the Customer's access has stopped either way.
 */
export const revokeBinding = async (
  session: Session,
  accountNumber: string,
  bindingId: string,
): Promise<void> => {
  await ask(
    session,
    `/dashboard/customers/${encodeURIComponent(accountNumber)}/bindings/${encodeURIComponent(bindingId)}/revoke`,
    "a Binding revocation",
    { method: "POST" },
  );
};
