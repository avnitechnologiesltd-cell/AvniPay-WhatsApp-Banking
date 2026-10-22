import { describe, expect, it } from "vitest";

import { allSourceFiles } from "./workspace";

/**
 * Nest can resolve a constructor parameter from its *type*, using the metadata
 * `emitDecoratorMetadata` writes. `tsc` emits that metadata and the esbuild
 * transform the test runner uses does not — so a type-only injection resolves
 * in a built image and throws under test.
 *
 * That difference runs in the worst possible direction: the tests are what we
 * trust, and they would be exercising a wiring the image does not have. So
 * every injected parameter names its token, and this keeps it that way.
 */

/** `constructor(` … `) {}` on a decorated class. */
const CONSTRUCTOR = /public constructor\(([\s\S]*?)\)\s*\{/g;

/** One parameter of an injectable constructor. */
const PARAMETER = /(?:^|,)\s*((?:@[\w.]+\([^)]*\)\s*)*)(private|public|protected|readonly)[^,]*/g;

describe("dependency injection", () => {
  it("names a token on every injected constructor parameter", () => {
    const offences: string[] = [];

    for (const file of allSourceFiles()) {
      if (!/@(Injectable|Controller)\(/.test(file.contents)) continue;

      for (const match of file.contents.matchAll(CONSTRUCTOR)) {
        const parameters = match[1] ?? "";
        for (const parameter of parameters.matchAll(PARAMETER)) {
          const decorators = parameter[1] ?? "";
          if (!decorators.includes("@Inject")) {
            offences.push(`${file.relativePath}: ${parameter[0]?.trim().slice(0, 60)}`);
          }
        }
      }
    }

    expect(offences).toEqual([]);
  });

  it("finds the constructors it claims to be checking", () => {
    // A regex that silently matches nothing would make the rule above vacuous.
    const checked = allSourceFiles()
      .filter((file) => /@(Injectable|Controller)\(/.test(file.contents))
      .flatMap((file) => [...file.contents.matchAll(CONSTRUCTOR)]);

    expect(checked.length).toBeGreaterThan(0);
  });
});
