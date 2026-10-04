#!/usr/bin/env node
// Patch coverage gate. Fails when the lines a change adds or edits are not
// covered enough by the test suite. Reads an lcov report and a git diff, so it
// works for any language whose coverage tool emits lcov.
//
// usage:
//   node scripts/patch-coverage.mjs --lcov coverage/lcov.info --base origin/main [--threshold 80]
//
// The base ref is the merge base for a pull request. On a push with no pull
// request, pass HEAD~1. A change with no measured lines passes.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { EXIT } from "./lib/exit.mjs";

function parseArgs(argv) {
  const options = {
    lcov: "coverage/lcov.info",
    base: "origin/main",
    threshold: 80,
    help: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "-h" || arg === "--help") options.help = true;
    else if (arg === "--lcov") {
      options.lcov = argv[i + 1];
      i += 1;
    } else if (arg === "--base") {
      options.base = argv[i + 1];
      i += 1;
    } else if (arg === "--threshold") {
      options.threshold = Number(argv[i + 1]);
      i += 1;
    }
  }
  return options;
}

function parseLcov(text) {
  const files = new Map();
  let current = null;
  for (const line of text.split("\n")) {
    if (line.startsWith("SF:")) {
      current = line.slice(3).trim();
      files.set(current, new Map());
    } else if (line.startsWith("DA:") && current) {
      const [number, hits] = line.slice(3).split(",");
      files.get(current).set(Number(number), Number(hits));
    } else if (line === "end_of_record") {
      current = null;
    }
  }
  return files;
}

function changedLines(base) {
  let diff;
  try {
    diff = execFileSync("git", ["diff", "--unified=0", `${base}...HEAD`], {
      encoding: "utf8",
    });
  } catch {
    return new Map();
  }
  const result = new Map();
  let file = null;
  for (const line of diff.split("\n")) {
    if (line.startsWith("+++ b/")) {
      file = line.slice(6);
      result.set(file, new Set());
      continue;
    }
    const match = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (match && file) {
      const start = Number(match[1]);
      const count = match[2] === undefined ? 1 : Number(match[2]);
      for (let i = 0; i < count; i += 1) result.get(file).add(start + i);
    }
  }
  return result;
}

function matchReport(files, rel) {
  const suffix = "/" + rel;
  for (const [name, data] of files) {
    if (name === rel || name.endsWith(suffix)) return data;
  }
  return null;
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(
      "usage: node scripts/patch-coverage.mjs --lcov <path> --base <ref> [--threshold 80]\n",
    );
    process.exit(EXIT.OK);
  }
  if (!existsSync(options.lcov)) {
    process.stderr.write(
      `patch-coverage: no coverage report at ${options.lcov}\n`,
    );
    process.exit(EXIT.FAIL);
  }

  const files = parseLcov(readFileSync(options.lcov, "utf8"));
  const changed = changedLines(options.base);

  let measured = 0;
  let covered = 0;
  const gaps = [];
  for (const [rel, lines] of changed) {
    const report = matchReport(files, rel);
    if (!report) continue;
    const inReport = [...lines].filter((line) => report.has(line));
    if (inReport.length === 0) continue;
    const hit = inReport.filter((line) => report.get(line) > 0);
    measured += inReport.length;
    covered += hit.length;
    if (hit.length < inReport.length) {
      gaps.push(
        `  ${rel}: ${hit.length}/${inReport.length} changed lines covered`,
      );
    }
  }

  if (measured === 0) {
    process.stdout.write("patch-coverage: no measured changed lines, pass\n");
    process.exit(EXIT.OK);
  }
  const percent = (covered / measured) * 100;
  process.stdout.write(
    `patch-coverage: ${covered}/${measured} changed lines covered (${percent.toFixed(1)}%), threshold ${options.threshold}%\n`,
  );
  for (const gap of gaps) process.stdout.write(`${gap}\n`);
  process.exit(percent >= options.threshold ? EXIT.OK : EXIT.FAIL);
}

main();
