import { Inject, Injectable } from "@nestjs/common";
import { z } from "zod";

import type { Pool } from "@avni/db";
import { DATABASE_POOL } from "@avni/service";

import { businessHoursSchema, type BusinessHours } from "./business-hours";
import { tariffSchema, type Tariff } from "./tariff";

/**
 * What the Bank configures about itself, on its own schedule.
 *
 * **All of it is configuration the Bank edits rather than environment
 * variables.** Opening hours change without a redeploy, the operations alert
 * address is the Bank's to point wherever they actually staff, and the tariff is
 * the Bank's fee schedule — set under its own regulator and never by a vendor's
 * release. Ticket 28 settled that a Support Officer may *read* these and only an
 * Administrator may write one, and they are exactly why that distinction was
 * worth a role: the hours decide what a Customer is told, the address decides
 * who is woken at 3am, and the tariff decides what a Customer is charged.
 */

/**
 * Where a stuck transfer is reported. An email address the Bank names.
 *
 * Empty is a real value and means *nobody is configured*, which is not the same
 * as a default: an address we invented would send a Customer's missing money to
 * a mailbox nobody reads, and silently. Unset is loud instead — the alert is
 * recorded as `unavailable` and logged as an error, so the gap is visible in the
 * one table the Bank looks at.
 */
const operationsAlertAddress = z.string().trim().max(320).email().or(z.literal(""));

const SETTINGS = {
  business_hours: businessHoursSchema,
  operations_alert_address: operationsAlertAddress,
} as const;

export type SettingKey = keyof typeof SETTINGS;

export const SETTING_KEYS = Object.keys(SETTINGS) as readonly SettingKey[];

/**
 * The tariff lives in the same table and **not** on the endpoint above.
 *
 * It is the one setting with its own capability: ticket 22's role table gives a
 * Support Officer read on the tariff and `tariff.write` to an Administrator
 * alone, separately from `settings.write`. Folding it into the generic
 * key/value route would have made that capability dead code and recorded a fee
 * change under the same action name as an address change — and *"who changed
 * what Customers are charged"* is the query the Bank's compliance function will
 * run.
 */
const TARIFF_KEY = "transfer_tariff";

/** Every setting, as the Dashboard reads them and the platform acts on them. */
export interface PlatformSettings {
  /**
   * `null` until the Bank sets them, and `null` rather than absent because this
   * crosses a JSON boundary — an omitted key and a key the Bank has not filled
   * in would arrive at the Dashboard as the same thing.
   */
  readonly businessHours: BusinessHours | null;
  readonly operationsAlertAddress: string;
}

/**
 * What a Bank that has configured nothing gets.
 *
 * **There is no default business-hours value**, and that is deliberate. A
 * platform that invented *"Mon–Fri, 8am–6pm"* would tell a Customer the Bank's
 * hours were something nobody at the Bank had ever said — which is the prior
 * art's mistake with an extra step. Unset means the Handoff never claims to know
 * when somebody will answer, and never queues anybody against hours it made up.
 */
const UNSET: PlatformSettings = { businessHours: null, operationsAlertAddress: "" };

interface SettingRow {
  key: string;
  value: unknown;
}

export type SettingRefusal = { readonly outcome: "refused"; readonly problem: string };

/**
 * A setting that changed, in the four parts a change record is made of: **who,
 * when, from what, to what.**
 *
 * Who and when belong to the audit row this becomes; from and to belong here,
 * because they are the only two the caller cannot work out for itself. Ticket 22
 * asked for this shape once rather than per screen, and the tariff is why —
 * a fee change alters what a Customer is charged.
 */
export interface SettingWritten<T> {
  readonly outcome: "written";
  /** `null` where there was nothing before, or where what was there no longer parses. */
  readonly from: T | null;
  readonly to: T;
}

@Injectable()
export class SettingsRepository {
  public constructor(@Inject(DATABASE_POOL) private readonly pool: Pool) {}

  /**
   * Every setting, with anything unset or unreadable falling back to {@link UNSET}.
   *
   * A stored value that no longer parses — because the schema tightened under a
   * row written by an older image — reads as unset rather than throwing. The
   * alternative is a Handoff that cannot be raised because somebody's opening
   * hours are malformed, and a Customer waiting on a human is the wrong person
   * to pay for that.
   */
  public async all(): Promise<PlatformSettings> {
    const { rows } = await this.pool.query<SettingRow>(
      "select key, value from platform_settings",
    );

    const read = <K extends SettingKey>(key: K): z.infer<(typeof SETTINGS)[K]> | undefined => {
      const row = rows.find((one) => one.key === key);
      if (!row) return undefined;
      const parsed = SETTINGS[key].safeParse(row.value);
      return parsed.success ? (parsed.data as z.infer<(typeof SETTINGS)[K]>) : undefined;
    };

    return {
      businessHours: read("business_hours") ?? UNSET.businessHours,
      operationsAlertAddress: read("operations_alert_address") ?? UNSET.operationsAlertAddress,
    };
  }

  /**
   * The Bank's fee schedule, or `null` where it has entered none.
   *
   * Read on the way to every Confirmation screen, and **unreadable reads as
   * unset** for the same reason the hours do: a tariff row written by an older
   * image must not be able to stop a Customer sending money. What they see
   * instead is the honest sentence, which is always available.
   */
  public async tariff(): Promise<Tariff | null> {
    const { rows } = await this.pool.query<SettingRow>(
      "select key, value from platform_settings where key = $1",
      [TARIFF_KEY],
    );
    if (!rows[0]) return null;

    const parsed = tariffSchema.safeParse(rows[0].value);
    return parsed.success ? parsed.data : null;
  }

  /**
   * Writes one setting, validating it here rather than at the column.
   *
   * The table is a key/value store on purpose — a column per setting is a
   * migration every time the Dashboard grows a field — so the closed set lives
   * in TypeScript, exactly as the audit table's action names do.
   */
  public async write(
    key: SettingKey,
    value: unknown,
    by: string,
  ): Promise<SettingWritten<unknown> | SettingRefusal> {
    // The map's values are two different schemas, so the union is widened here
    // rather than at every call site. `write` answers in `unknown` for the same
    // reason its `value` parameter takes one: what a valid business-hours object
    // is belongs beside the code that acts on it, and the controller above is
    // passing a change record through rather than reading it.
    return this.put(SETTINGS[key] as z.ZodType<unknown>, key, value, by);
  }

  /** The tariff, on its own capability. See {@link TARIFF_KEY}. */
  public async writeTariff(
    value: unknown,
    by: string,
  ): Promise<SettingWritten<Tariff | null> | SettingRefusal> {
    return this.put(tariffSchema, TARIFF_KEY, value, by);
  }

  /**
   * Validate, write, and answer with **what it was and what it now is**.
   *
   * One statement rather than a read followed by a write. The `previous` CTE
   * sees the snapshot the statement began with, so the old value comes back from
   * the same command that replaced it — which means two Administrators saving at
   * once produce two change records that chain, rather than two that both claim
   * to have replaced the same figure.
   */
  private async put<T>(
    schema: z.ZodType<T>,
    key: string,
    value: unknown,
    by: string,
  ): Promise<SettingWritten<T> | SettingRefusal> {
    const parsed = schema.safeParse(value);
    if (!parsed.success) {
      return {
        outcome: "refused",
        problem: parsed.error.issues
          .map((issue) => [issue.path.join("."), issue.message].filter(Boolean).join(" "))
          .join("; "),
      };
    }

    const { rows } = await this.pool.query<{ previous: unknown }>(
      `with previous as (select value from platform_settings where key = $1)
       insert into platform_settings (key, value, updated_by)
       values ($1, $2::jsonb, $3)
       on conflict (key) do update
         set value = excluded.value, updated_by = excluded.updated_by, updated_at = now()
       returning (select value from previous) as previous`,
      [key, JSON.stringify(parsed.data), by],
    );

    // A `from` that no longer parses is reported as unset rather than as the
    // raw row: the change record is read by a person asking what the figure used
    // to be, and a shape they cannot read is not an answer to that.
    const before = schema.safeParse(rows[0]?.previous ?? null);

    return { outcome: "written", from: before.success ? before.data : null, to: parsed.data };
  }
}
