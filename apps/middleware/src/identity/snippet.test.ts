import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  IDENTITY_PLACEHOLDER,
  LOADER_UNAVAILABLE_MESSAGE,
  loaderScript,
  signingInstructions,
  snippetFor,
} from "./snippet";
import { CONTRACT_VERSIONS, CURRENT_CONTRACT_VERSION } from "./signed-identity";

/**
 * The Snippet is the first code this platform ships that runs somewhere we do
 * not operate at all, and once it is inside a shipped mobile application it
 * cannot be recalled. These tests exist because a reviewer cannot be the thing
 * that stops it being edited.
 */

const BASE = "https://platform.bank.example";
const ENVELOPE = "v1.payload.signature";

// --- A tiny DOM, so the loader can actually be run -------------------------
//
// The loader is four lines of JavaScript that will execute inside somebody
// else's application, and the one behaviour this ticket asks of it — a plain
// message rather than an empty panel — is only observable by running it. A test
// that grepped the source for the message would pass on a loader that never
// reaches the line it is on.

interface FakeNode {
  tagName: string;
  textContent: string;
  parentNode: FakeNode | undefined;
  children: FakeNode[];
  appendChild: (child: FakeNode) => void;
  src?: string;
  async?: boolean;
  onerror?: () => void;
}

const node = (tagName: string): FakeNode => {
  const created: FakeNode = {
    tagName,
    textContent: "",
    parentNode: undefined,
    children: [],
    appendChild: (child) => {
      child.parentNode = created;
      created.children.push(child);
    },
  };
  return created;
};

interface RunResult {
  readonly mount: FakeNode;
  readonly script: FakeNode | undefined;
  readonly global: { version: string; base: string; identity: string; mount: FakeNode };
  readonly fireTimeout: () => void;
}

const runLoader = (source: string, options: { mounted?: boolean } = {}): RunResult => {
  const mount = node("div");
  const head = node("head");
  const timeouts: { fn: () => void; ms: number }[] = [];

  const document = {
    getElementById: (id: string) => (options.mounted === false ? null : id ? mount : null),
    createElement: node,
    head,
  };
  const window: Record<string, unknown> = {
    setTimeout: (fn: () => void, ms: number) => timeouts.push({ fn, ms }),
  };

  new Function("window", "document", source)(window, document);

  return {
    mount,
    script: head.children[0],
    global: window["AvniChat"] as RunResult["global"],
    fireTimeout: () => {
      for (const { fn } of timeouts) fn();
    },
  };
};

const sourceFor = (identity = ENVELOPE): string =>
  loaderScript(CURRENT_CONTRACT_VERSION, { platformBaseUrl: BASE, identity });

describe("the loader", () => {
  it("fetches the Widget from the Platform at runtime", () => {
    const { script } = runLoader(sourceFor());

    expect(script?.tagName).toBe("script");
    expect(script?.src).toBe(`${BASE}/widget/v1/widget.js`);
    expect(script?.async).toBe(true);
  });

  it("hands the Widget the signed identity and nothing else", () => {
    const { global } = runLoader(sourceFor());

    // The whole frozen contract: a version string and the envelope. Everything
    // else the Widget needs, it fetches.
    expect(global).toMatchObject({ version: "v1", base: BASE, identity: ENVELOPE });
    expect(Object.keys(global).sort()).toEqual(["base", "identity", "mount", "version"]);
  });

  it("shows a plain message when the Widget does not arrive", () => {
    const run = runLoader(sourceFor());
    run.script?.onerror?.();

    expect(run.mount.children[0]?.textContent).toBe(LOADER_UNAVAILABLE_MESSAGE);
  });

  it("shows the same message when the Widget never answers at all", () => {
    // The failure with no event. A hung network fires no `onerror`, and without
    // this the Customer is left looking at a blank rectangle inside their
    // bank's application — which is the one outcome the ticket rules out.
    const run = runLoader(sourceFor());
    run.fireTimeout();

    expect(run.mount.children[0]?.textContent).toBe(LOADER_UNAVAILABLE_MESSAGE);
  });

  it("does not overwrite a Widget that did arrive", () => {
    // The Widget replaces the loader's placeholder when it paints. A timeout
    // firing afterwards must not write "not available" over a working chat.
    const run = runLoader(sourceFor());
    run.mount.children.length = 0;
    const painted = node("div");
    run.mount.appendChild(painted);

    run.fireTimeout();
    run.script?.onerror?.();

    expect(run.mount.children).toEqual([painted]);
  });

  it("says nothing at all before it has failed", () => {
    const run = runLoader(sourceFor());

    expect(run.mount.children[0]?.textContent).not.toBe(LOADER_UNAVAILABLE_MESSAGE);
  });

  it("survives a Bank that forgot the mount element", () => {
    // Their application, their markup. A loader that throws takes whatever
    // else is on that screen down with it.
    expect(() => {
      const run = runLoader(sourceFor(), { mounted: false });
      run.script?.onerror?.();
      run.fireTimeout();
    }).not.toThrow();
  });

  it("cannot be escaped by the value substituted into it", () => {
    const { global } = runLoader(sourceFor(`";window.stolen=1;"`));

    expect(global.identity).toBe(`";window.stolen=1;"`);
  });
});

describe("the Snippet an Administrator copies", () => {
  it("carries the panel, the loader and a placeholder for the Bank's envelope", () => {
    const snippet = snippetFor(CURRENT_CONTRACT_VERSION, BASE);

    expect(snippet).toContain(`<div id="avni-chat"></div>`);
    expect(snippet).toContain(IDENTITY_PLACEHOLDER);
    expect(snippet).toContain(BASE);
    expect(runLoader(snippet.replace(/<\/?script>|<div[^>]*><\/div>/g, "")).script?.src).toBe(
      `${BASE}/widget/v1/widget.js`,
    );
  });

  it("puts the panel before the script, so a failure has somewhere to land", () => {
    const snippet = snippetFor(CURRENT_CONTRACT_VERSION, BASE);

    expect(snippet.indexOf("avni-chat")).toBeLessThan(snippet.indexOf("<script>"));
  });

  it("carries no signing secret", () => {
    // It is four lines inside somebody's mobile application. The secret is the
    // half of this that is not public, and it never appears here.
    expect(snippetFor(CURRENT_CONTRACT_VERSION, BASE)).not.toMatch(/secret/i);
  });

  it("tells the Bank's engineer how to sign, in the format the Middleware verifies", () => {
    const instructions = signingInstructions(CURRENT_CONTRACT_VERSION).join("\n");

    expect(instructions).toContain("HMAC-SHA256");
    expect(instructions).toContain(`"v1." + payload`);
    expect(instructions).toContain(IDENTITY_PLACEHOLDER);
  });
});

describe("the loader contract is versioned and never edited", () => {
  /**
   * The bytes of every published loader, pinned.
   *
   * **This test failing is not a test to fix.** A Snippet already pasted into a
   * shipped mobile application cannot be recalled, so a change to a loader is a
   * new entry in `CONTRACT_VERSIONS` and a new key here — served alongside the
   * old one, never in place of it (ADR-0011). If v1's hash no longer matches,
   * the change belongs in v2.
   */
  const PINNED: Record<string, string> = {
    v1: "d25dcfbc7021623443156fcfb1df8aad3fb633ee2688a3ee608c17dbd038edd2",
  };

  it.each(CONTRACT_VERSIONS)("%s is byte-for-byte what it was published as", (version) => {
    const source = loaderScript(version, {
      platformBaseUrl: "https://pinned.example",
      identity: "pinned-identity",
    });

    expect(createHash("sha256").update(source).digest("hex")).toBe(PINNED[version]);
  });

  it("pins every version it can serve", () => {
    expect(Object.keys(PINNED).sort()).toEqual([...CONTRACT_VERSIONS].sort());
  });
});
