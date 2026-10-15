#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { pinMetadata, RESOLVER_PIN } from "../lib/pinned-access.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const standard = resolve(root, "..", "simpsonm09-repo-standard");
const artifact = join(root, RESOLVER_PIN.artifactPath);
const metadataFile = join(root, "runtime", "agent-access.pin.json");
const args = process.argv.slice(2);
const check = args.includes("--check");
const repoArg = args.indexOf("--repo");
const sourceRepo = repoArg >= 0 ? resolve(args[repoArg + 1] ?? "") : standard;

function fail(message) {
  process.stderr.write(`refresh-gate-resolver: ${message}\n`);
  process.exitCode = 1;
}

if (
  args.some(
    (arg, index) =>
      !["--check", "--repo"].includes(arg) && args[index - 1] !== "--repo",
  ) ||
  args.filter((arg) => arg === "--check").length > 1 ||
  (repoArg >= 0 && (!args[repoArg + 1] || args.indexOf("--repo", repoArg + 1) >= 0))
) {
  fail("usage: node scripts/refresh-gate-resolver.mjs [--check] [--repo <clone-path>]");
} else if (!/^[0-9a-f]{40}$/.test(RESOLVER_PIN.commit)) {
  fail("the pinned commit must be a full lowercase SHA");
} else {
  try {
    const actualCommit = execFileSync(
      "git",
      ["-C", sourceRepo, "rev-parse", `${RESOLVER_PIN.commit}^{commit}`],
      { encoding: "utf8", windowsHide: true },
    ).trim();
    if (actualCommit !== RESOLVER_PIN.commit)
      throw new Error("the source object did not resolve to the pinned full commit");

    const bytes = execFileSync(
      "git",
      ["-C", sourceRepo, "show", `${RESOLVER_PIN.commit}:${RESOLVER_PIN.sourcePath}`],
      { encoding: null, windowsHide: true, maxBuffer: 8 * 1024 * 1024 },
    );
    const digest = createHash("sha256").update(bytes).digest("hex");
    if (digest !== RESOLVER_PIN.sha256)
      throw new Error(`source digest mismatch: ${digest}`);

    const metadata = `${JSON.stringify(pinMetadata(), null, 2)}\n`;
    if (check) {
      if (!readFileSync(artifact).equals(bytes))
        throw new Error("packaged resolver differs from the pinned source object");
      if (readFileSync(metadataFile, "utf8") !== metadata)
        throw new Error("pin metadata differs from the pinned resolver constants");
      process.stdout.write(`gate resolver pin ok: ${RESOLVER_PIN.commit} ${digest}\n`);
    } else {
      mkdirSync(dirname(artifact), { recursive: true });
      writeFileSync(artifact, bytes);
      writeFileSync(metadataFile, metadata);
      process.stdout.write(`refreshed gate resolver: ${RESOLVER_PIN.commit} ${digest}\n`);
    }
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
}
