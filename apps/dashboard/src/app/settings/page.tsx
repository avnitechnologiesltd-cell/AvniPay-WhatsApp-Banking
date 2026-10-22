import Link from "next/link";
import { redirect } from "next/navigation";
import type { ReactNode } from "react";

import { readAuditEntries, type AuditEntry } from "../../audit";
import { formatWhen } from "../../format";
import { currentSession } from "../../session";
import {
  WEEKDAYS,
  dayField,
  readSettings,
  readTariff,
  type BusinessHours,
  type Tariff,
  type TariffBand,
  type Weekday,
} from "../../settings";
import { BAND_ROWS, MAX_BAND_ROWS, VAT_FIELD, bandField } from "../../tariff-form";
import { readingAsOfficer } from "../guard";
import { StaffBar } from "../staff-bar";
import {
  button,
  card,
  cell,
  dangerButton,
  field,
  heading,
  muted,
  notice,
  page,
  subheading,
  table,
} from "../ui";
import { saveAlertAddress, saveBusinessHours, saveTariff, withdrawTariff } from "./actions";

/** Never cached. Reading the settings is an audited act, like everything here. */
export const dynamic = "force-dynamic";

/**
 * **The configuration a bank changes on its own schedule, without asking a
 * vendor.**
 *
 * The tariff is the reason this is a screen at all. Calling it configuration
 * made it deploy-time, and a bank changes its fees under its own regulator —
 * every change would have needed a release from us. It is also the first surface
 * where the two roles differ in a way a Support Officer will notice: they read
 * the tariff and cannot write it, because **a fee change alters what a Customer
 * is charged**.
 *
 * The forms are rendered for an Administrator only, and that is tidiness rather
 * than security: the Middleware checks every capability, records the attempt and
 * refuses. An Officer who posted one of these by hand would leave a refusal row
 * with their name on it and change nothing.
 */
const SettingsPage = async ({
  searchParams,
}: {
  searchParams: Promise<{ problem?: string; saved?: string }>;
}): Promise<ReactNode> => {
  const session = await currentSession();
  if (!session) redirect("/sign-in");

  const administrator = session.account.role === "administrator";
  const { problem, saved } = await searchParams;

  const [settings, tariff, changes] = await readingAsOfficer(() =>
    Promise.all([
      readSettings(session),
      readTariff(session),
      // The change record — **who, when, from what, to what**. Read from the
      // audit log rather than from a second table, because that is where it was
      // written and a copy would be a second thing to keep true.
      //
      // `outcome` is narrowed **server-side**, because the limit is applied
      // before anything this page could filter: twenty refused attempts — one
      // Support Officer poking at the endpoint would do it — would otherwise
      // push every real change off the list and leave the screen reporting that
      // the tariff had never been changed.
      readAuditEntries({
        token: session.token,
        action: "tariff.write",
        outcome: "succeeded",
        limit: 20,
      }),
    ]),
  );

  return (
    <main style={page}>
      <StaffBar account={session.account} />
      <h1 style={heading}>Settings</h1>
      <p style={muted}>
        {administrator
          ? "What the Bank configures about itself. Every change here is recorded."
          : "What the Bank configures about itself. Only an Administrator may change any of it."}
      </p>

      {/* Rendered as text, never as markup. It came back on the URL, so the one
          person who can put anything in it is the person reading it. */}
      {problem ? <p style={notice}>{problem}</p> : null}
      {saved && !problem ? <p style={muted}>Saved.</p> : null}

      <h2 style={subheading}>Transfer tariff</h2>
      <CurrentTariff tariff={tariff} />
      {administrator ? <TariffForm tariff={tariff} /> : null}
      <TariffChanges changes={changes} />

      <h2 style={subheading}>Business hours</h2>
      <p style={muted}>
        Read by the message a Customer gets when they ask for a human outside them. There is no
        default — until these are set, nobody is told when somebody will answer.
      </p>
      {administrator ? (
        <HoursForm hours={settings.businessHours} />
      ) : (
        <CurrentHours hours={settings.businessHours} />
      )}

      <h2 style={subheading}>Operations alert address</h2>
      <p style={muted}>
        Where a transfer that has not settled is reported. Nobody is paged if this is empty, and
        the alert is recorded as unavailable rather than sent somewhere we invented.
      </p>
      {administrator ? (
        <form action={saveAlertAddress}>
          <label>
            Email address
            <input
              style={field}
              name="operationsAlertAddress"
              type="email"
              defaultValue={settings.operationsAlertAddress}
            />
          </label>
          <p>
            <button style={button} type="submit">
              Save address
            </button>
          </p>
        </form>
      ) : (
        <p style={muted}>{settings.operationsAlertAddress || "No address is set."}</p>
      )}

      <h2 style={subheading}>Connectors</h2>
      <p style={muted}>
        <Link href="/settings/connectors">
          APIs of the Bank&rsquo;s the Support Agent may call for a Customer
        </Link>
        {administrator
          ? " — registering one grants the Agent a capability, so only an Administrator may."
          : " — read-only for a Support Officer."}
      </p>

      {administrator ? (
        <>
          <h2 style={subheading}>Officers</h2>
          <p style={muted}>
            <Link href="/settings/officers">Who may sign in, and what a Customer is told they
            are called</Link>
          </p>
        </>
      ) : null}
    </main>
  );
};

/**
 * What the Bank charges today, or the honest sentence.
 *
 * Shown to both roles, because a Support Officer answering *"what did that fee
 * cost me"* needs the figure as much as the Administrator who set it.
 */
const CurrentTariff = ({ tariff }: { tariff: Tariff | null }): ReactNode => {
  if (!tariff) {
    return (
      <p style={notice}>
        <strong>No tariff is entered.</strong> Every Confirmation screen tells the Customer that
        fees apply per their account tariff, and quotes no figure at all. That is deliberate — the
        platform has nowhere to get a fee from except the Bank&rsquo;s own hand, and a number it
        invented would be sitting on a licensed bank&rsquo;s screen.
      </p>
    );
  }

  return (
    <div style={card}>
      <Bands title="Intra-bank — within the Bank" bands={tariff.intraBank} />
      <Bands title="Inter-bank — to a bank with a different NIBSS code" bands={tariff.interBank} />
      <p style={muted}>
        {tariff.vatRate === 0
          ? "No VAT is charged on the fee."
          : `VAT of ${tariff.vatRate}% is charged on the fee, never on the amount sent.`}
      </p>
    </div>
  );
};

const Bands = ({ title, bands }: { title: string; bands: readonly TariffBand[] }): ReactNode => (
  <>
    <p style={{ margin: "0.5rem 0 0.25rem", fontWeight: 600 }}>{title}</p>
    <table style={table}>
      <tbody>
        {bands.map((band, index) => (
          <tr key={index}>
            <td style={cell}>
              {band.upTo === null ? "Above the band before" : `Up to ₦${band.upTo.toLocaleString("en-NG")}`}
            </td>
            <td style={cell}>{band.fee === 0 ? "No fee" : `₦${band.fee.toLocaleString("en-NG")}`}</td>
          </tr>
        ))}
      </tbody>
    </table>
  </>
);

/**
 * The form, with a fixed number of rows.
 *
 * An empty *up to* means **and above**, which is how the last band of every
 * published tariff is written. It is said on the screen rather than left to be
 * discovered, because the alternative reading — *up to nothing* — is one an
 * Administrator could plausibly hold while their fees came out wrong.
 */
const TariffForm = ({ tariff }: { tariff: Tariff | null }): ReactNode => {
  const longest = Math.max(tariff?.intraBank.length ?? 0, tariff?.interBank.length ?? 0);

  // **Said rather than truncated.** A tariff with more bands than the form can
  // carry would otherwise be silently shortened by an Administrator who opened
  // this to fix a typo — and the bands they never saw are the ones that price
  // the largest transfers.
  if (longest > MAX_BAND_ROWS) {
    return (
      <p style={notice}>
        This tariff has {longest} bands and this form carries {MAX_BAND_ROWS}. It is shown above
        and is being applied; editing it here would drop the bands that do not fit, so the form is
        not offered.
      </p>
    );
  }

  const rows = Math.max(BAND_ROWS, longest);

  return (
    <>
    <form action={saveTariff}>
      <BandInputs route="intraBank" title="Intra-bank" bands={tariff?.intraBank ?? []} rows={rows} />
      <BandInputs route="interBank" title="Inter-bank" bands={tariff?.interBank ?? []} rows={rows} />

      <label>
        VAT on the fee (%) — empty means none
        <input
          style={{ ...field, maxWidth: "8rem" }}
          name={VAT_FIELD}
          inputMode="decimal"
          defaultValue={tariff ? String(tariff.vatRate) : ""}
        />
      </label>

      <p style={muted}>
        Leave the last <em>up to</em> empty to mean <em>and above</em>. Every amount must fall in
        a band, or that transfer shows no figure at all.
      </p>
      <p>
        <button style={button} type="submit">
          Save tariff
        </button>
      </p>
    </form>

    {tariff ? (
      <form action={withdrawTariff}>
        <p style={muted}>
          Withdrawing puts every Confirmation screen back to saying fees apply per the account
          tariff, with no figure.
        </p>
        <p>
          <button style={dangerButton} type="submit">
            Withdraw the tariff
          </button>
        </p>
      </form>
    ) : null}
    </>
  );
};

const BandInputs = ({
  route,
  title,
  bands,
  rows,
}: {
  route: "intraBank" | "interBank";
  title: string;
  bands: readonly TariffBand[];
  /** Enough for what is stored, never fewer than {@link BAND_ROWS}. */
  rows: number;
}): ReactNode => (
  <fieldset style={{ ...card, border: "1px solid #ddd" }}>
    <legend style={{ fontWeight: 600 }}>{title}</legend>
    <table style={table}>
      <thead>
        <tr>
          <th style={cell}>Amounts up to (₦)</th>
          <th style={cell}>Fee (₦)</th>
        </tr>
      </thead>
      <tbody>
        {Array.from({ length: rows }, (_, row) => (
          <tr key={row}>
            <td style={cell}>
              <input
                style={field}
                name={bandField(route, row, "upTo")}
                inputMode="decimal"
                defaultValue={valueOf(bands[row]?.upTo)}
                placeholder={row === 0 ? "5000" : "and above"}
              />
            </td>
            <td style={cell}>
              <input
                style={field}
                name={bandField(route, row, "fee")}
                inputMode="decimal"
                defaultValue={valueOf(bands[row]?.fee)}
              />
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  </fieldset>
);

/** `0` is a figure the Bank entered; `null` and absent are both an empty box. */
const valueOf = (value: number | null | undefined): string =>
  value === null || value === undefined ? "" : String(value);

/**
 * **Who changed what Customers are charged, when, from what and to what.**
 *
 * The spec asked for this by name and it is the reason the tariff has its own
 * audit action rather than sharing the generic settings one — an answer that
 * needs filtering a settings action by a key buried in JSON is an answer nobody
 * reaches on the first try.
 */
const TariffChanges = ({ changes }: { changes: readonly AuditEntry[] }): ReactNode => {
  if (changes.length === 0) {
    return <p style={muted}>The tariff has never been changed on this deployment.</p>;
  }

  return (
    <>
      <p style={{ ...subheading, margin: "1.5rem 0 0.5rem" }}>Changes</p>
      <table style={table}>
        <thead>
          <tr>
            <th style={cell}>When</th>
            <th style={cell}>Who</th>
            <th style={cell}>From</th>
            <th style={cell}>To</th>
          </tr>
        </thead>
        <tbody>
          {changes.map((entry) => (
            <tr key={entry.id}>
              <td style={cell}>{formatWhen(entry.recordedAt)}</td>
              {/* The name as it was at the time, recorded with the row. An id
                  would need the Officer list to read, which a Support Officer
                  may not see — and a name that has since changed would misreport
                  who made the change. */}
              <td style={cell}>{String(entry.detail["by"] ?? entry.actorId ?? "")}</td>
              <td style={cell}>{summarise(entry.detail["from"])}</td>
              <td style={cell}>{summarise(entry.detail["to"])}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
};

/** A tariff in one line, so a change is readable without expanding anything. */
const summarise = (value: unknown): string => {
  if (value === null || value === undefined) return "No tariff";

  const tariff = value as Partial<Tariff>;
  const route = (bands: readonly TariffBand[] | undefined): string =>
    (bands ?? []).map((band) => `${band.upTo === null ? "above" : band.upTo}: ${band.fee}`).join(", ");

  return `intra-bank ${route(tariff.intraBank)}; inter-bank ${route(tariff.interBank)}; VAT ${tariff.vatRate ?? 0}%`;
};

const CurrentHours = ({ hours }: { hours: BusinessHours | null }): ReactNode => {
  if (!hours) return <p style={notice}>No business hours are set.</p>;

  return (
    <table style={table}>
      <tbody>
        {WEEKDAYS.map((day) => (
          <tr key={day}>
            <td style={cell}>{dayName(day)}</td>
            <td style={cell}>
              {hours.days[day] ? `${hours.days[day]?.opens} to ${hours.days[day]?.closes}` : "Closed"}
            </td>
          </tr>
        ))}
        <tr>
          <td style={cell}>Time zone</td>
          <td style={cell}>{hours.timeZone}</td>
        </tr>
      </tbody>
    </table>
  );
};

const HoursForm = ({ hours }: { hours: BusinessHours | null }): ReactNode => (
  <form action={saveBusinessHours}>
    <table style={table}>
      <thead>
        <tr>
          <th style={cell}>Day</th>
          <th style={cell}>Opens</th>
          <th style={cell}>Closes</th>
        </tr>
      </thead>
      <tbody>
        {WEEKDAYS.map((day) => (
          <tr key={day}>
            <td style={cell}>{dayName(day)}</td>
            <td style={cell}>
              <input
                style={field}
                name={dayField(day, "opens")}
                placeholder="08:00"
                defaultValue={hours?.days[day]?.opens ?? ""}
              />
            </td>
            <td style={cell}>
              <input
                style={field}
                name={dayField(day, "closes")}
                placeholder="18:00"
                defaultValue={hours?.days[day]?.closes ?? ""}
              />
            </td>
          </tr>
        ))}
      </tbody>
    </table>

    <label>
      Time zone
      <input
        style={field}
        name="timeZone"
        placeholder="Africa/Lagos"
        defaultValue={hours?.timeZone ?? "Africa/Lagos"}
      />
    </label>

    <p style={muted}>
      Leave both times empty on a day the Bank is shut. Times are 24-hour, as <code>HH:mm</code>.
    </p>
    <p>
      <button style={button} type="submit">
        Save hours
      </button>
    </p>
  </form>
);

const dayName = (day: Weekday): string => day.charAt(0).toUpperCase() + day.slice(1);

export default SettingsPage;
