import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

/** A single forward-only step, named by the file that carries it. */
export interface Migration {
  readonly version: string;
  readonly name: string;
  readonly filename: string;
  readonly sql: string;
  readonly checksum: string;
}

/** `0001-initial.sql` — four digits, a hyphen, a slug. */
const FILENAME = /^(\d{4})-([a-z0-9-]+)\.sql$/;

/**
 * Migrations live beside the package rather than under a configured path, so
 * the set that ships in an image is the set the image was built from and there
 * is no way to point a release at somebody else's schema.
 */
export const DEFAULT_MIGRATIONS_DIRECTORY = resolve(__dirname, "..", "migrations");

export const checksumOf = (sql: string): string =>
  createHash("sha256").update(sql, "utf8").digest("hex");

/**
 * Reads the migration set, in order. Throws on anything ambiguous — an
 * unversioned filename, two files claiming one version, or a reverse migration.
 * Rollback is redeploying the previous image ([ADR ticket 23]); a `.down.sql`
 * in the tree is somebody quietly reintroducing untested recovery code.
 */
export const readMigrations = (
  directory: string = DEFAULT_MIGRATIONS_DIRECTORY,
): readonly Migration[] => {
  const filenames = readdirSync(directory).filter((name) => name.endsWith(".sql"));

  const reverse = filenames.filter((name) => name.endsWith(".down.sql"));
  if (reverse.length > 0) {
    throw new Error(
      `Migrations are forward-only, but ${directory} contains reverse migrations: ${reverse.join(", ")}. ` +
        "Roll back by redeploying the previous image.",
    );
  }

  const migrations: Migration[] = [];
  const seen = new Map<string, string>();

  for (const filename of filenames.sort()) {
    const match = FILENAME.exec(filename);
    if (!match) {
      throw new Error(
        `Migration ${filename} is not named <NNNN>-<slug>.sql, so its position in the sequence is undefined.`,
      );
    }

    const [, version = "", name = ""] = match;
    const alreadySeen = seen.get(version);
    if (alreadySeen !== undefined) {
      throw new Error(
        `Two migrations claim version ${version}: ${alreadySeen} and ${filename}.`,
      );
    }
    seen.set(version, filename);

    const sql = readFileSync(join(directory, filename), "utf8");
    migrations.push({ version, name, filename, sql, checksum: checksumOf(sql) });
  }

  return migrations;
};
