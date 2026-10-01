import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadSkills, splitFrontmatter } from "../index.ts";

test("splitFrontmatter reads the fields and strips quotes", () => {
  const raw = '---\nname: demo\ndescription: "quoted text"\n---\nBody line';
  const { fields, body } = splitFrontmatter(raw);

  assert.equal(fields.name, "demo");
  assert.equal(fields.description, "quoted text");
  assert.equal(body, "Body line");
});

test("splitFrontmatter normalizes CRLF line endings", () => {
  const { fields, body } = splitFrontmatter("---\r\nname: demo\r\n---\r\nBody");

  assert.equal(fields.name, "demo");
  assert.equal(body, "Body");
});

test("splitFrontmatter returns the whole document when there is no frontmatter", () => {
  const raw = "# Heading\n\nNo frontmatter here.";
  const { fields, body } = splitFrontmatter(raw);

  assert.deepEqual(fields, {});
  assert.equal(body, raw);
});

test("loadSkills reads one seed per skill and ignores directories without a SKILL.md", () => {
  const root = mkdtempSync(join(tmpdir(), "org-skills-"));
  try {
    mkdirSync(join(root, "alpha"));
    writeFileSync(
      join(root, "alpha", "SKILL.md"),
      "---\nname: alpha\ndescription: first\n---\nAlpha body",
    );
    mkdirSync(join(root, "beta"));
    writeFileSync(
      join(root, "beta", "SKILL.md"),
      "---\ndescription: second\n---\nBeta body",
    );
    mkdirSync(join(root, "empty"));

    const seeds = loadSkills(root).sort((a, b) => a.id.localeCompare(b.id));

    assert.deepEqual(
      seeds.map((seed) => seed.id),
      ["alpha", "beta"],
    );
    assert.equal(seeds[0].name, "alpha");
    assert.equal(seeds[0].description, "first");
    assert.equal(seeds[0].content, "Alpha body");
    assert.equal(seeds[1].name, "beta");
    assert.equal(seeds[1].description, "second");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("loadSkills returns nothing when the skills directory is absent", () => {
  assert.deepEqual(loadSkills(join(tmpdir(), "org-skills-absent-xyz")), []);
});
