import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { REPO_ROOT, packageNamed, workspacePackages } from "./workspace";

/**
 * Adding a workspace package means touching four hand-kept lists — the root
 * `tsconfig.json` references, `tsconfig.test.json` paths, the Vitest aliases,
 * and the Dockerfile's copies. Forgetting one fails somewhere unrelated and
 * much later, which is exactly what happened twice while this was being built.
 *
 * So the lists check themselves against the packages actually on disk.
 */

const read = (relativePath: string): string =>
  readFileSync(join(REPO_ROOT, relativePath), "utf8");

/**
 * Packages another package can import — those with an entry point. The
 * Dashboard has none: it is an application Next builds, not a library, so
 * nothing aliases or references it.
 */
const importablePackages = () =>
  workspacePackages().filter((pkg) => {
    const manifest = JSON.parse(read(`${pkg.relativeDirectory}/package.json`)) as {
      main?: string;
    };
    return manifest.main?.startsWith("dist") ?? false;
  });

/**
 * Everything a deployable actually needs at runtime, walked from the two Node
 * applications. Derived rather than listed, so a package that stops being
 * shipped — or starts — is noticed here rather than in an image.
 */
const shippedPackages = (): readonly string[] => {
  const workspaceNames = new Set(workspacePackages().map((pkg) => pkg.name));
  const shipped = new Set<string>();

  const walk = (name: string): void => {
    if (shipped.has(name)) return;
    shipped.add(name);
    for (const dependency of packageNamed(name).runtimeDependencies) {
      if (workspaceNames.has(dependency)) walk(dependency);
    }
  };

  for (const app of ["@avni/middleware", "@avni/platform"]) walk(app);
  return [...shipped].filter((name) => !["@avni/middleware", "@avni/platform"].includes(name));
};

describe("the workspace's hand-kept lists", () => {
  it("aliases every workspace package in the Vitest config", () => {
    const config = read("vitest.config.ts");

    expect(
      importablePackages()
        .map((pkg) => pkg.name)
        .filter((name) => !config.includes(`"${name}":`)),
    ).toEqual([]);
  });

  it("maps every workspace package in the test tsconfig", () => {
    const paths = read("tsconfig.test.json");

    expect(
      importablePackages()
        .map((pkg) => pkg.name)
        .filter((name) => !paths.includes(`"${name}":`)),
    ).toEqual([]);
  });

  it("references every compiled package from the root tsconfig", () => {
    const root = read("tsconfig.json");

    expect(
      importablePackages()
        .map((pkg) => pkg.relativeDirectory)
        .filter((directory) => !root.includes(`"${directory}"`)),
    ).toEqual([]);
  });

  it("copies every workspace manifest into the Docker build", () => {
    // The install runs against the whole workspace, so every manifest has to be
    // there even for a package no image ships.
    const dockerfile = read("Dockerfile");

    expect(
      workspacePackages()
        .map((pkg) => `${pkg.relativeDirectory}/package.json`)
        .filter((path) => !dockerfile.includes(path)),
    ).toEqual([]);
  });

  it("ships the build output of every package a deployable depends on", () => {
    const dockerfile = read("Dockerfile");

    expect(
      shippedPackages()
        .map((name) => `${packageNamed(name).relativeDirectory}/dist`)
        .filter((path) => !dockerfile.includes(path)),
    ).toEqual([]);
  });

  it("runs the migration step from the Middleware's own image", () => {
    // A `migrate` service with an image of its own sits behind a Compose
    // profile, so `docker compose build` skips it — and the operator gets a
    // migrator built from an older tree, which applies nothing, reports
    // success, and leaves the deployables refusing to start against a schema
    // that was never created. Observed, not hypothesised.
    //
    // One tag for both makes that impossible rather than unlikely.
    const compose = read("docker-compose.yml");
    const section = (name: string): string => {
      const start = compose.indexOf(`  ${name}:`);
      const rest = compose.slice(start + 1);
      const end = rest.search(/\n {2}\w[\w-]*:\n/);
      return end === -1 ? rest : rest.slice(0, end);
    };

    const tag = /image: (\S+)/.exec(section("migrate"))?.[1];
    expect(tag).toBeDefined();
    expect(section("middleware")).toContain(`image: ${tag}`);
    expect(read("Dockerfile")).not.toContain("AS migrate");
  });

  it("keeps the fakes out of every image", () => {
    // The fakes stand in for BankOne, Groq and the WhatsApp Graph API. A
    // deployable that could import one is a deployable that could answer a
    // Customer from it.
    expect(shippedPackages()).not.toContain("@avni/fakes");
    expect(read("Dockerfile")).not.toContain("packages/fakes/dist");
  });
});
