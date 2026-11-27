// @effect-diagnostics nodeBuiltinImport:off - inspects package exports and source imports on disk.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import { describe, expect, it } from "vite-plus/test";

const packageRoot = NodePath.resolve(
  NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)),
  "..",
);

interface PackageJson {
  readonly exports: Record<string, string | { readonly default: string; readonly types?: string }>;
  readonly dependencies?: Record<string, string>;
  readonly peerDependencies?: Record<string, string>;
}

const IMPORT_STATEMENT_RE = /(?:^|\n)\s*(?:import|export)\b[^;]*?from\s+["']([^"']+)["']/g;
const DYNAMIC_IMPORT_RE = /import\(\s*["']([^"']+)["']\s*\)/g;

function resolveLocalModule(fromFile: string, specifier: string): string | null {
  if (!specifier.startsWith(".")) return null;
  const base = NodePath.resolve(NodePath.dirname(fromFile), specifier);
  for (const candidate of [base, `${base}.ts`, `${base}.tsx`, NodePath.join(base, "index.ts")]) {
    if (NodeFS.existsSync(candidate) && NodeFS.statSync(candidate).isFile()) {
      return candidate;
    }
  }
  return null;
}

function parseRuntimeImportSpecifiers(filePath: string): ReadonlyArray<string> {
  const source = NodeFS.readFileSync(filePath, "utf8");
  const specifiers: string[] = [];
  for (const match of source.matchAll(IMPORT_STATEMENT_RE)) {
    const statement = match[0].trimStart();
    if (statement.startsWith("import type ") || statement.startsWith("export type ")) continue;
    specifiers.push(match[1]!);
  }
  for (const match of source.matchAll(DYNAMIC_IMPORT_RE)) {
    specifiers.push(match[1]!);
  }
  return specifiers;
}

function collectTransitiveExternalImports(entryFile: string): ReadonlySet<string> {
  const visited = new Set<string>();
  const externals = new Set<string>();
  const stack = [entryFile];
  while (stack.length > 0) {
    const current = stack.pop()!;
    if (visited.has(current)) continue;
    visited.add(current);
    for (const specifier of parseRuntimeImportSpecifiers(current)) {
      const local = resolveLocalModule(current, specifier);
      if (local !== null) stack.push(local);
      else externals.add(specifier);
    }
  }
  return externals;
}

describe("@zerocode/client-runtime dependency boundaries", () => {
  const pkg = JSON.parse(
    NodeFS.readFileSync(NodePath.join(packageRoot, "package.json"), "utf8"),
  ) as PackageJson;

  it("keeps client-runtime free of React dependencies", () => {
    const deps = Object.keys({ ...pkg.dependencies, ...pkg.peerDependencies });
    expect(deps.filter((dep) => /^react(?:$|-)/.test(dep))).toEqual([]);
  });

  it("isolates three to ./device/* and jszip to ./zip/* with zero core subpath leaks", () => {
    const threeSubpaths: string[] = [];
    const jszipSubpaths: string[] = [];
    const reactSubpaths: string[] = [];

    for (const [subpath, target] of Object.entries(pkg.exports)) {
      const relativeEntry = typeof target === "string" ? target : target.default;
      const entryFile = NodePath.resolve(packageRoot, relativeEntry);
      expect(NodeFS.existsSync(entryFile), `missing export target for ${subpath}`).toBe(true);

      const externals = collectTransitiveExternalImports(entryFile);
      for (const external of externals) {
        if (external === "three" || external.startsWith("three/")) {
          threeSubpaths.push(subpath);
          break;
        }
      }
      for (const external of externals) {
        if (external === "jszip" || external.startsWith("jszip/")) {
          jszipSubpaths.push(subpath);
          break;
        }
      }
      for (const external of externals) {
        if (external === "react" || external.startsWith("react/") || external === "react-native") {
          reactSubpaths.push(subpath);
          break;
        }
      }
    }

    expect(reactSubpaths).toEqual([]);
    expect(threeSubpaths.filter((subpath) => !subpath.startsWith("./device/"))).toEqual([]);
    expect(jszipSubpaths.filter((subpath) => !subpath.startsWith("./zip/"))).toEqual([]);
    expect(threeSubpaths.sort()).toEqual(["./device/duo-viewer", "./device/phone-viewer"]);
    expect(jszipSubpaths.sort()).toEqual(["./zip/bounded-zip"]);
  });
});
