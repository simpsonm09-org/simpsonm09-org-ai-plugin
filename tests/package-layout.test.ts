// What ships. The runtime is the set of files the OpenCode layer and the Claude Code plugin
// load. This test pins the published list, walks every relative import from the runtime
// entry points, and checks that each one resolves inside that list and never into tests/.
// It also checks that every runtime file is reached from an entry point. The Claude manifest
// and hooks file are checked in tests/claude-plugin.test.ts.

import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import {
  dirname,
  extname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const readJson = (name: string) =>
  JSON.parse(readFileSync(join(root, name), "utf8"));

const PUBLISHED = [
  "index.ts",
  "gate.mjs",
  "access.mjs",
  "package.json",
  "skills",
  "README.md",
  ".claude-plugin",
  ".github/plugin",
  "hooks",
  "bin",
  "lib",
];

// The files the runtime loads on its own: the OpenCode entry, the two hook scripts, the hook
// worker they start, and the launcher. Everything else in the runtime must be reached from one of these.
const ENTRIES = [
  "index.ts",
  "pi/index.ts",
  "hooks/pre-tool-use.mjs",
  "hooks/session-start.mjs",
  "hooks/worker.mjs",
  "bin/with-gh-token.mjs",
];

// The code files under a published path, as paths relative to the root.
function codeFiles(entry: string): string[] {
  const full = join(root, entry);
  if (!existsSync(full)) return [];
  if (!statSync(full).isDirectory()) return [entry];
  const out: string[] = [];
  for (const child of readdirSync(full)) {
    out.push(...codeFiles(join(entry, child).split(sep).join("/")));
  }
  return out;
}

// The code the runtime is made of: the published .ts and .mjs files, not manifests or docs.
function isCode(file: string): boolean {
  return [".ts", ".mjs", ".js"].includes(extname(file));
}

function runtimeFiles(): string[] {
  return [...new Set(PUBLISHED.flatMap(codeFiles))].filter(
    (file) => isCode(file) && !file.startsWith("skills/"),
  );
}

// The relative or package specifiers a file imports, static and dynamic.
function specifiers(source: string): string[] {
  const found: string[] = [];
  const pattern =
    /(?:import|export)\s[^'";]*?from\s*["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)|^\s*import\s*["']([^"']+)["']/gm;
  for (const match of source.matchAll(pattern))
    found.push(match[1] ?? match[2] ?? match[3]);
  return found;
}

function resolveImport(from: string, specifier: string): string | null {
  if (!specifier.startsWith(".")) return null;
  const target = resolve(dirname(join(root, from)), specifier);
  return relative(root, target).split(sep).join("/");
}

function insidePublished(path: string): boolean {
  return PUBLISHED.some(
    (entry) => path === entry || path.startsWith(`${entry}/`),
  );
}

test("the published list is exactly the runtime, in layer.json and package.json", () => {
  const layer = readJson("layer.json");
  const pkg = readJson("package.json");
  assert.deepEqual([...layer.files].sort(), [...PUBLISHED].sort());
  assert.deepEqual([...pkg.files].sort(), [...PUBLISHED].sort());
  for (const entry of PUBLISHED)
    assert.ok(existsSync(join(root, entry)), `${entry} is listed but missing`);
});

// The problem with one relative import from a runtime file, or null when it is fine.
function importProblem(file: string, specifier: string): string | null {
  const target = resolveImport(file, specifier);
  if (target === null) return null;
  if (isAbsolute(target) || target.startsWith(".."))
    return `${file} imports outside the repo: ${specifier}`;
  if (target.startsWith("tests/"))
    return `${file} imports from tests/: ${specifier}`;
  if (!insidePublished(target))
    return `${file} imports an unpublished file: ${specifier} -> ${target}`;
  if (!existsSync(join(root, target)))
    return `${file} imports a missing file: ${specifier}`;
  return null;
}

test("every relative import from a runtime file resolves inside the published list", () => {
  const problems: string[] = [];
  for (const file of runtimeFiles()) {
    const source = readFileSync(join(root, file), "utf8");
    for (const specifier of specifiers(source)) {
      const problem = importProblem(file, specifier);
      if (problem) problems.push(problem);
    }
  }
  assert.deepEqual(problems, []);
});

test("every package import is a Node builtin or a declared dependency", () => {
  const pkg = readJson("package.json");
  const declared = new Set(Object.keys(pkg.dependencies ?? {}));
  const problems: string[] = [];
  for (const file of runtimeFiles()) {
    for (const specifier of specifiers(
      readFileSync(join(root, file), "utf8"),
    )) {
      if (specifier.startsWith(".") || specifier.startsWith("node:")) continue;
      if (!declared.has(specifier))
        problems.push(`${file} imports undeclared ${specifier}`);
    }
  }
  assert.deepEqual(problems, []);
});

test("every runtime file is reached from an entry point", () => {
  const reached = new Set<string>();
  const queue = [...ENTRIES];
  while (queue.length > 0) {
    const file = queue.shift() as string;
    if (reached.has(file)) continue;
    reached.add(file);
    for (const specifier of specifiers(
      readFileSync(join(root, file), "utf8"),
    )) {
      const target = resolveImport(file, specifier);
      if (target && existsSync(join(root, target))) queue.push(target);
    }
  }
  const unused = runtimeFiles().filter((file) => !reached.has(file));
  assert.deepEqual(unused, [], "a runtime file nothing loads is dead code");
});
