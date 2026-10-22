import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { REPO_ROOT, allSourceFiles, testTreeFiles } from "./workspace";

/**
 * The platform never deletes an audit row.
 *
 * `AUDIT_RETENTION_DAYS` records the Bank's policy so their own archival
 * tooling has one place to read it from; nothing here acts on it. The moment
 * this codebase prunes its own evidence, the table stops being evidence — and
 * that change would arrive looking like housekeeping, which is why it is a test
 * rather than a note.
 */

const AUDIT_TABLE = "audit_entries";

/**
 * Comments removed, because the rule is about what the code *does*. Prose
 * explaining why there is no delete would otherwise be flagged as one, and the
 * fix for that would be to stop explaining it.
 */
const withoutComments = (source: string): string =>
  source
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:])\/\/.*$/gm, "$1")
    .replace(/^\s*--.*$/gm, "");

/** `delete from audit_entries`, `truncate audit_entries`, `drop table …`. */
const DESTRUCTIVE = new RegExp(
  String.raw`\b(delete\s+from|truncate(\s+table)?|drop\s+table(\s+if\s+exists)?)\s+["']?${AUDIT_TABLE}`,
  "i",
);

const migrationFiles = (): readonly { path: string; contents: string }[] => {
  const directory = join(REPO_ROOT, "packages/db/migrations");
  return readdirSync(directory)
    .filter((name) => name.endsWith(".sql"))
    .map((name) => ({
      path: `packages/db/migrations/${name}`,
      contents: readFileSync(join(directory, name), "utf8"),
    }));
};

describe("the audit log is append-only", () => {
  it("has no delete against it anywhere in the workspace", () => {
    const everything = [
      ...allSourceFiles().map((file) => ({ path: file.relativePath, contents: file.contents })),
      ...testTreeFiles().map((file) => ({ path: file.relativePath, contents: file.contents })),
      ...migrationFiles(),
    ];

    expect(
      everything
        .filter((file) => file.path !== "tests/audit-is-append-only.test.ts")
        .filter((file) => DESTRUCTIVE.test(withoutComments(file.contents)))
        .map((file) => `${file.path} destroys ${AUDIT_TABLE}`),
    ).toEqual([]);
  });

  it("exposes no method that would remove one", () => {
    // A `prune`, `purge` or `expire` on the repository is the shape this would
    // take, and it would look like housekeeping in review.
    const repository = allSourceFiles().find((file) =>
      file.relativePath.endsWith("audit/audit.repository.ts"),
    );

    expect(repository).toBeDefined();
    expect(withoutComments(repository?.contents ?? "")).not.toMatch(
      /\b(prune|purge|expire|deleteOld|cleanup)\s*\(/i,
    );
  });

  it("still sees a delete that is real code rather than prose", () => {
    // The comment-stripping above must not become a way to hide one.
    expect(
      DESTRUCTIVE.test(withoutComments(`const sql = "delete from ${AUDIT_TABLE}";`)),
    ).toBe(true);
    expect(
      DESTRUCTIVE.test(withoutComments(`// never delete from ${AUDIT_TABLE}`)),
    ).toBe(false);
  });

  it("finds the destructive pattern it claims to be looking for", () => {
    // A regex that silently matches nothing would make both rules vacuous.
    for (const statement of [
      `delete from ${AUDIT_TABLE} where id < 1`,
      `DELETE FROM ${AUDIT_TABLE}`,
      `truncate ${AUDIT_TABLE}`,
      `truncate table ${AUDIT_TABLE}`,
      `drop table if exists ${AUDIT_TABLE}`,
    ]) {
      expect(DESTRUCTIVE.test(statement)).toBe(true);
    }

    // And that it does not flag the writes and reads that must keep working.
    for (const statement of [
      `insert into ${AUDIT_TABLE} (action) values ($1)`,
      `select * from ${AUDIT_TABLE} order by id desc`,
      "delete from conversations where id = $1",
    ]) {
      expect(DESTRUCTIVE.test(statement)).toBe(false);
    }
  });

  it("keeps retention a recorded policy rather than an enacted one", () => {
    const config = allSourceFiles().find((file) =>
      file.relativePath.endsWith("packages/config/src/values.ts"),
    );

    expect(config?.contents).toContain("retentionDays");
    // Nothing outside configuration reads it, so nothing can act on it.
    const readers = allSourceFiles()
      .filter((file) => !file.relativePath.startsWith("packages/config/"))
      .filter((file) => /auditRetentionDays/.test(file.contents))
      .map((file) => file.relativePath);

    expect(readers).toEqual([]);
  });
});
