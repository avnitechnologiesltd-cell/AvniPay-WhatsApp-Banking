import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { readMigrations } from "./migrations";

const migrationDirectory = (files: Record<string, string>): string => {
  const directory = mkdtempSync(join(tmpdir(), "avni-migrations-"));
  for (const [name, contents] of Object.entries(files)) {
    writeFileSync(join(directory, name), contents, "utf8");
  }
  return directory;
};

describe("readMigrations", () => {
  it("orders migrations by version rather than by directory listing", () => {
    const directory = migrationDirectory({
      "0010-add-beneficiaries.sql": "select 10;",
      "0002-add-bindings.sql": "select 2;",
      "0001-initial.sql": "select 1;",
    });

    expect(readMigrations(directory).map((m) => m.version)).toEqual(["0001", "0002", "0010"]);
  });

  it("carries the name and the sql of each migration", () => {
    const directory = migrationDirectory({ "0001-initial.sql": "select 1;" });

    expect(readMigrations(directory)[0]).toMatchObject({
      version: "0001",
      name: "initial",
      filename: "0001-initial.sql",
      sql: "select 1;",
    });
  });

  it("checksums contents so an edited applied migration can be noticed", () => {
    const one = migrationDirectory({ "0001-initial.sql": "select 1;" });
    const same = migrationDirectory({ "0001-initial.sql": "select 1;" });
    const edited = migrationDirectory({ "0001-initial.sql": "select 2;" });

    expect(readMigrations(one)[0]?.checksum).toBe(readMigrations(same)[0]?.checksum);
    expect(readMigrations(one)[0]?.checksum).not.toBe(readMigrations(edited)[0]?.checksum);
  });

  it("refuses a filename that does not declare a version", () => {
    const directory = migrationDirectory({ "add-bindings.sql": "select 1;" });

    expect(() => readMigrations(directory)).toThrowError(/add-bindings\.sql/);
  });

  it("refuses two migrations claiming the same version", () => {
    const directory = migrationDirectory({
      "0001-initial.sql": "select 1;",
      "0001-also-initial.sql": "select 2;",
    });

    expect(() => readMigrations(directory)).toThrowError(/0001/);
  });

  it("refuses a reverse migration, because rollback is redeploying the previous image", () => {
    const directory = migrationDirectory({
      "0001-initial.sql": "select 1;",
      "0001-initial.down.sql": "drop table everything;",
    });

    expect(() => readMigrations(directory)).toThrowError(/forward-only/i);
  });

  it("ignores files that are not sql", () => {
    const directory = migrationDirectory({
      "0001-initial.sql": "select 1;",
      "README.md": "notes",
    });

    expect(readMigrations(directory)).toHaveLength(1);
  });

  it("reads the migration set this repository ships, whatever it currently holds", () => {
    const migrations = readMigrations();
    const versions = migrations.map((m) => m.version);

    expect(versions).toEqual([...versions].sort());
    expect(new Set(versions).size).toBe(versions.length);
  });
});
