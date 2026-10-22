import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  REPO_ROOT,
  importsOf,
  packageNamed,
  sourceFilesOf,
  workspacePackages,
} from "./workspace";

/**
 * ADR-0003 ships channels, orchestration and support merged into one Platform
 * process, and pays for that by keeping the boundaries between them real. If
 * they erode into a ball of mud the option to split one out later is gone,
 * which was the entire justification for starting merged.
 *
 * So the boundary is a package boundary: a forbidden import is a dependency
 * that was never declared, and it fails to resolve rather than failing review.
 */
const PLATFORM_MODULES = [
  "@avni/platform-channels",
  "@avni/platform-orchestration",
  "@avni/platform-support",
] as const;

describe("the Platform's module boundaries", () => {
  it.each(PLATFORM_MODULES)("%s declares no dependency on a sibling module", (name) => {
    const pkg = packageNamed(name);
    const siblings = PLATFORM_MODULES.filter((other) => other !== name);

    expect(pkg.dependencies.filter((dep) => siblings.includes(dep as never))).toEqual([]);
  });

  it.each(PLATFORM_MODULES)("%s imports no sibling module in its source", (name) => {
    const pkg = packageNamed(name);
    const siblings = PLATFORM_MODULES.filter((other) => other !== name);

    const offences = sourceFilesOf(pkg).flatMap((file) =>
      importsOf(file)
        .filter((specifier) => siblings.some((sibling) => specifier.startsWith(sibling)))
        .map((specifier) => `${file.relativePath} imports ${specifier}`),
    );

    expect(offences).toEqual([]);
  });

  it("gives the Platform application the only view of all three", () => {
    const platform = packageNamed("@avni/platform");

    expect(PLATFORM_MODULES.every((name) => platform.dependencies.includes(name))).toBe(true);
  });

  it("keeps the Middleware out of the Platform's modules entirely", () => {
    const middleware = packageNamed("@avni/middleware");

    expect(middleware.dependencies.filter((dep) => dep.startsWith("@avni/platform"))).toEqual([]);
  });

  it("keeps the Platform out of the Middleware, which is where the credentials are", () => {
    // ADR-0006. The Platform is the prompt-injection surface; a shared package
    // between them would be a path from that surface into the credentials.
    for (const name of ["@avni/platform", ...PLATFORM_MODULES]) {
      expect(packageNamed(name).dependencies).not.toContain("@avni/middleware");
    }
  });

  it("declares every workspace package it imports", () => {
    const workspaceNames = new Set(workspacePackages().map((pkg) => pkg.name));

    const offences = workspacePackages().flatMap((pkg) =>
      sourceFilesOf(pkg).flatMap((file) =>
        importsOf(file)
          .filter((specifier) => workspaceNames.has(specifier))
          .filter((specifier) => !pkg.dependencies.includes(specifier))
          .map((specifier) => `${file.relativePath} imports undeclared ${specifier}`),
      ),
    );

    expect(offences).toEqual([]);
  });
});

/**
 * **Same bot logic, different rendering** — the one sentence that describes the
 * relationship between WhatsApp and in-app chat, kept true structurally rather
 * than by review.
 *
 * The behavioural half of this is in `tests/in-app-chat.test.ts`: the same
 * sentence gets the same words on both Channels. This is the half that keeps
 * being true as the composer grows. `wordsFor` is a closed switch over an
 * outcome and gains a branch with every slice, and the moment one of them reads
 * a Channel the two surfaces begin to drift.
 */
describe("the composer is not told which Channel it is on", () => {
  /**
   * Named rather than sliced between two landmarks in the file, so that
   * reordering methods cannot silently shrink what this covers.
   */
  const COMPOSER = [
    "public async answer(",
    "private async answerChose(",
    "private async answerSaid(",
    "private async offerSurface(",
    "private wordsFor(",
  ];

  it("names no Channel between receiving a message and the words it answers with", () => {
    const source = readFileSync(
      join(REPO_ROOT, "apps/platform/src/conversation.service.ts"),
      "utf8",
    );

    const offences = COMPOSER.flatMap((signature) => {
      const from = source.indexOf(signature);
      expect(from, `${signature} is no longer part of the composer`).toBeGreaterThan(-1);

      // To the next member at the same indentation, which is where one ends.
      const rest = source.slice(from);
      const end = rest.slice(1).search(/\n {2}(public|private) /);

      return [...(end === -1 ? rest : rest.slice(0, end)).matchAll(/^.*$/gm)]
        .map((match) => match[0].trim())
        // Substrings rather than whole words. `\b` does not fire inside a
        // camelCase identifier, so `inAppConversations` would have slipped
        // through a word-boundary match — which it did, until this test was
        // checked against a real violation instead of assumed to work.
        .filter((line) => /whatsapp|in_app_chat|inapp/i.test(line))
        // A comment may name a Channel; code may not.
        .filter((line) => !line.startsWith("*") && !line.startsWith("//"))
        .map((line) => `${signature} — ${line}`);
    });

    expect(offences).toEqual([]);
  });
});
