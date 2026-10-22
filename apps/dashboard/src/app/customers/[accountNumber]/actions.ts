"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";

import { revokeBinding } from "../../../customers";
import { currentSession } from "../../../session";

/**
 * The one write on the Customers surface.
 *
 * A **Binding revocation is a security event**, not an edit: the Customer's
 * WhatsApp stops reaching the account on their next message. Their saved
 * recipients survive it, because the Beneficiary store is keyed on the account
 * rather than on the Binding — a Customer who changes handsets does not lose
 * everybody they have ever paid.
 *
 * The account number travels with the Binding id and the Middleware checks the
 * pair, so a Binding belonging to somebody else is refused rather than revoked
 * under the wrong Customer's name in the audit table.
 */
export const revoke = async (form: FormData): Promise<void> => {
  const session = await currentSession();
  if (!session) redirect("/sign-in");

  const accountNumber = String(form.get("accountNumber") ?? "");
  await revokeBinding(session, accountNumber, String(form.get("bindingId") ?? ""));

  revalidatePath(`/customers/${accountNumber}`);
};
