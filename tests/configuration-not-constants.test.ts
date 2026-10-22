import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  REPO_ROOT,
  allSourceFiles,
  packageNamed,
  sourceFilesOf,
  testTreeFiles,
} from "./workspace";

/**
 * The Bank's WhatsApp account and BankOne tenancy are not the development ones,
 * and staging and production must differ only by configuration. Every Flow id,
 * phone number id, key path, external base URL, bank code, institution code,
 * product code and officer code is therefore read from the environment — and
 * the way to keep that true is to make a literal fail a test rather than a
 * review.
 */

const CONFIG_PACKAGE = "packages/config/src/index.ts";

/**
 * The fakes stand in for BankOne, Groq and the WhatsApp Graph API, and they
 * ship in no image (`tests/workspace-wiring.test.ts` holds that). They are
 * fixtures that happen to live in a package, so the literal rules below exempt
 * them for the same reason they exempt `*.test.ts`: a fake WhatsApp payload is
 * *supposed* to carry an invented phone number id.
 */
const isFixture = (relativePath: string): boolean =>
  relativePath.startsWith("packages/fakes/");

/**
 * Scope, stated rather than implied: the literal checks below cover production
 * source — `apps/*` and `packages/*`, tests excluded. Test files are fixtures
 * and are *supposed* to contain invented Flow ids and account numbers, so
 * running these over them would only teach us to weaken them.
 *
 * The `process.env` rule is the one that covers the test tree too, because a
 * test reaching for the environment is how a production seam gets added by
 * accident.
 */
describe("nothing that differs between deployments is a constant", () => {
  it("reads process.env in exactly one place in production source", () => {
    const readers = allSourceFiles()
      .filter((file) => /\bprocess\.env\b/.test(file.contents))
      .map((file) => file.relativePath);

    expect(readers).toEqual([CONFIG_PACKAGE]);
  });

  it("lets the test tree read only the one variable that points it at Postgres", () => {
    const offences = testTreeFiles()
      .flatMap((file) =>
        [...file.contents.matchAll(/process\.env\[?["']?([A-Z][A-Z0-9_]*)/g)].map(
          (match) => ({ file: file.relativePath, key: match[1] as string }),
        ),
      )
      .filter(({ key }) => key !== "TEST_DATABASE_URL")
      .map(({ file, key }) => `${file} reads ${key}`);

    expect(offences).toEqual([]);
  });

  it("holds no external base URL as a literal in production source", () => {
    const hosts = [
      "graph.facebook.com",
      "mybankone.com",
      "bankone",
      "api.groq.com",
      "thirdpartyapiservice",
    ];

    const offences = allSourceFiles()
      .filter((file) => file.relativePath !== CONFIG_PACKAGE && !isFixture(file.relativePath))
      .flatMap((file) =>
        hosts
          .filter((host) => file.contents.toLowerCase().includes(`//${host}`))
          .map((host) => `${file.relativePath} contains ${host}`),
      );

    expect(offences).toEqual([]);
  });

  it("holds no Flow id, phone number id or institution code as a literal in production source", () => {
    // Nine or more consecutive digits: a Flow id, a WhatsApp phone number id, a
    // NUBAN. Ports, timeouts and HTTP status codes are all shorter than this.
    const offences = allSourceFiles()
      .filter((file) => file.relativePath !== CONFIG_PACKAGE && !isFixture(file.relativePath))
      .flatMap((file) =>
        [...file.contents.matchAll(/["'](\d{9,})["']/g)].map(
          (match) => `${file.relativePath} contains the literal ${match[1]}`,
        ),
      );

    expect(offences).toEqual([]);
  });

  it("names every key it requires in .env.example", () => {
    const example = readFileSync(join(REPO_ROOT, ".env.example"), "utf8");
    const documented = new Set(
      example
        .split("\n")
        .map((line) => /^([A-Z][A-Z0-9_]*)=/.exec(line.trim())?.[1])
        .filter((key): key is string => key !== undefined),
    );

    const required = sourceFilesOf(packageNamed("@avni/config")).flatMap((file) =>
      [...file.contents.matchAll(/^\s{2}([A-Z][A-Z0-9_]*):/gm)].map((match) => match[1] as string),
    );

    expect(required.length).toBeGreaterThan(0);
    expect([...new Set(required)].filter((key) => !documented.has(key))).toEqual([]);
  });
});

/**
 * Staging and production differ only by `.env`. That is what makes staging
 * worth having: a deployment that behaves differently because it knows it is
 * staging has stopped being a rehearsal of production and become a fourth thing
 * nobody tested.
 *
 * `DEPLOYMENT_ENVIRONMENT` exists so a log line and a health body can say where
 * they came from. The moment anything *branches* on it, the value stops being a
 * label and becomes a feature flag with no owner — so the branch is what these
 * refuse, rather than the value.
 */
describe("no code path branches on which deployment this is", () => {
  /** Where the three names are allowed to appear: the schema that defines them. */
  const ENVIRONMENT_ENUM = "packages/config/src/values.ts";

  /**
   * And this file, which has to be able to write down what it forbids. Exempted
   * by name rather than by a cleverer pattern, because a rule that cannot quote
   * the thing it refuses is a rule nobody can read.
   */
  const THIS_FILE = "tests/configuration-not-constants.test.ts";

  it("writes the name of an environment nowhere but the enum that declares it", () => {
    const offences = allSourceFiles()
      .filter((file) => file.relativePath !== ENVIRONMENT_ENUM)
      .flatMap((file) =>
        [...file.contents.matchAll(/["'](development|staging|production)["']/g)].map(
          (match) => `${file.relativePath} names the ${match[1] as string} environment`,
        ),
      );

    expect(offences).toEqual([]);
  });

  it("compares the environment to nothing, in production source or in tests", () => {
    // Both trees, because a test that asserts staging-only behaviour is a test
    // asserting the branch this exists to prevent.
    //
    // Read either way round — `environment === x` and `x === environment` are
    // the same branch — and covering the ways a comparison hides from an
    // equality operator: a switch on it, a membership test, a prefix check.
    // No `g` flag: `.test` on a global regex advances `lastIndex` and would
    // start the next file part-way in, silently missing matches.
    const comparisons = [
      /\benvironment\s*[=!]==?/i,
      /[=!]==?\s*\w*\.?environment\b/i,
      /\bswitch\s*\(\s*[\w.]*environment\b/i,
      /\benvironment\s*\.\s*(startsWith|endsWith|includes|match)\b/i,
      /\.\s*includes\s*\(\s*[\w.]*environment\b/i,
    ];

    const offences = [...allSourceFiles(), ...testTreeFiles()]
      .filter((file) => file.relativePath !== THIS_FILE)
      .flatMap((file) =>
        comparisons
          .filter((pattern) => pattern.test(file.contents))
          .map((pattern) => `${file.relativePath} compares the environment (${pattern.source})`),
      );

    expect(offences).toEqual([]);
  });

  it("reads NODE_ENV nowhere at all", () => {
    // The collision that made DEPLOYMENT_ENVIRONMENT a separate key: Next forces
    // NODE_ENV to `production` inside a container, so it cannot also be the name
    // of which deployment this is.
    const offences = [...allSourceFiles(), ...testTreeFiles()]
      .filter((file) => /process\.env\s*(?:\.\s*NODE_ENV|\[\s*["']NODE_ENV)/.test(file.contents))
      .map((file) => file.relativePath);

    expect(offences).toEqual([]);
  });
});
