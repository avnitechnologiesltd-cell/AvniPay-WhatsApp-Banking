/**
 * BankOne's field names are inconsistent across endpoints, so the adapter reads
 * them tolerantly rather than betting on one spelling.
 *
 * The auth field alone is `authtoken` as a query parameter on WebAPI, `Token`
 * in the body on most Third Party endpoints, and `AuthenticationKey` on
 * intra-bank transfer — the same token *value* under three different *names*.
 * Success is spelled both `IsSuccessful` and `IsSuccessFul`.
 */

/** The first present value among `names`, matched case-insensitively. */
export const field = (body: unknown, ...names: readonly string[]): unknown => {
  if (typeof body !== "object" || body === null) return undefined;

  const lowered = new Map(
    Object.entries(body as Record<string, unknown>).map(
      ([key, value]) => [key.toLowerCase(), value] as const,
    ),
  );
  for (const name of names) {
    const value = lowered.get(name.toLowerCase());
    if (value !== undefined && value !== null) return value;
  }
  return undefined;
};

export const stringField = (body: unknown, ...names: readonly string[]): string | undefined => {
  const value = field(body, ...names);
  return typeof value === "string" ? value : typeof value === "number" ? String(value) : undefined;
};

/**
 * Whether a *call* succeeded, by the guide's general rule: `ResponseCode == "00"`
 * or a truthy success flag under either spelling.
 *
 * **Not for a Transaction Status Query.** There, `IsSuccessful: true` means the
 * query executed and has been observed beside `Status: "Failed"` (Appendix A.3).
 * That endpoint reads `ResponseCode`/`Status` only, and gets its own reader when
 * transfers arrive.
 */
export const isSuccessfulCall = (body: unknown): boolean => {
  if (stringField(body, "ResponseCode") === "00") return true;

  const flag = field(body, "IsSuccessful", "IsSuccessFul");
  return flag === true || flag === "true" || flag === "True";
};

/**
 * Whether the body carries a success signal **and that signal says no**.
 *
 * Deliberately not `!isSuccessfulCall(body)`, which is also true of a body
 * carrying no flag at all — and `GetTransactions` may answer as a bare array,
 * which has nowhere to put one. Reading that absence as failure would turn
 * every such response into an error; reading it as success would let
 * `{"IsSuccessful": false, "Transactions": []}` tell a Customer that nothing
 * happened on their account, which is a lie about their money rather than a
 * broken read.
 */
export const declaresFailure = (body: unknown): boolean =>
  field(body, "IsSuccessful", "IsSuccessFul", "ResponseCode") !== undefined &&
  !isSuccessfulCall(body);

/**
 * The message BankOne gave for a failure, if it gave one. Never shown to a
 * Customer — it goes to the operational log and the audit table.
 */
export const failureMessage = (body: unknown): string | undefined =>
  stringField(body, "ResponseMessage", "Message", "ResponseDescription");
