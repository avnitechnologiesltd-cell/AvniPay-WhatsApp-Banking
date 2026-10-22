import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

export const REPO_ROOT = resolve(__dirname, "..");

export interface WorkspacePackage {
  readonly name: string;
  readonly directory: string;
  readonly relativeDirectory: string;
  /** Everything declared, runtime and dev alike. */
  readonly dependencies: readonly string[];
  /** What ships. A devDependency is not in an image. */
  readonly runtimeDependencies: readonly string[];
}

const readPackage = (relativeDirectory: string): WorkspacePackage => {
  const directory = join(REPO_ROOT, relativeDirectory);
  const manifest = JSON.parse(readFileSync(join(directory, "package.json"), "utf8")) as {
    name: string;
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };
  return {
    name: manifest.name,
    directory,
    relativeDirectory,
    dependencies: [
      ...Object.keys(manifest.dependencies ?? {}),
      ...Object.keys(manifest.devDependencies ?? {}),
    ],
    runtimeDependencies: Object.keys(manifest.dependencies ?? {}),
  };
};

/** Every workspace package, read from disk rather than from a hardcoded list. */
export const workspacePackages = (): readonly WorkspacePackage[] =>
  ["apps", "packages"].flatMap((group) =>
    readdirSync(join(REPO_ROOT, group))
      .filter((entry) => statSync(join(REPO_ROOT, group, entry)).isDirectory())
      .map((entry) => readPackage(`${group}/${entry}`)),
  );

export const packageNamed = (name: string): WorkspacePackage => {
  const found = workspacePackages().find((pkg) => pkg.name === name);
  if (!found) throw new Error(`No workspace package named ${name}`);
  return found;
};

export interface SourceFile {
  readonly path: string;
  readonly relativePath: string;
  readonly contents: string;
}

const walk = (directory: string): string[] => {
  const entries = readdirSync(directory, { withFileTypes: true });
  return entries.flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return entry.name === "node_modules" ? [] : walk(path);
    return entry.isFile() && (path.endsWith(".ts") || path.endsWith(".tsx")) ? [path] : [];
  });
};

/** Every TypeScript source file under a package, tests excluded. */
export const sourceFilesOf = (pkg: WorkspacePackage): readonly SourceFile[] => {
  const source = join(pkg.directory, "src");
  let paths: string[];
  try {
    paths = walk(source);
  } catch {
    return [];
  }
  return paths
    .filter((path) => !path.endsWith(".test.ts") && !path.endsWith(".test.tsx"))
    .map((path) => ({
      path,
      relativePath: path.slice(REPO_ROOT.length + 1),
      contents: readFileSync(path, "utf8"),
    }));
};

export const allSourceFiles = (): readonly SourceFile[] =>
  workspacePackages().flatMap((pkg) => sourceFilesOf(pkg));

/** Module specifiers a file imports or requires. */
export const importsOf = (file: SourceFile): readonly string[] => {
  const specifiers: string[] = [];
  const patterns = [
    /\bfrom\s+["']([^"']+)["']/g,
    /\bimport\s+["']([^"']+)["']/g,
    /\brequire\(\s*["']([^"']+)["']\s*\)/g,
  ];
  for (const pattern of patterns) {
    for (const match of file.contents.matchAll(pattern)) {
      if (match[1]) specifiers.push(match[1]);
    }
  }
  return specifiers;
};

/** Every TypeScript file under `tests/`, this helper included. */
export const testTreeFiles = (): readonly SourceFile[] =>
  walk(join(REPO_ROOT, "tests")).map((path) => ({
    path,
    relativePath: path.slice(REPO_ROOT.length + 1),
    contents: readFileSync(path, "utf8"),
  }));
