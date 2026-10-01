import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Plugin } from "@opencode/plugin";

const here = dirname(fileURLToPath(import.meta.url));

interface SkillSeed {
  id: string;
  name: string;
  description: string;
  path: string;
  content: string;
}

export function splitFrontmatter(raw: string): {
  fields: Record<string, string>;
  body: string;
} {
  const text = raw.replace(/\r\n/g, "\n");
  if (!text.startsWith("---\n")) return { fields: {}, body: text };

  const end = text.indexOf("\n---", 4);
  if (end === -1) return { fields: {}, body: text };

  const header = text.slice(4, end);
  const body = text.slice(end + 4).replace(/^\n/, "");
  const fields: Record<string, string> = {};

  for (const line of header.split("\n")) {
    const match = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    if (!match) continue;
    let value = match[2].trim();
    const quoted =
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"));
    if (quoted && value.length >= 2) value = value.slice(1, -1);
    fields[match[1]] = value;
  }

  return { fields, body };
}

export function loadSkills(root: string): SkillSeed[] {
  if (!existsSync(root)) return [];

  const seeds: SkillSeed[] = [];
  for (const entry of readdirSync(root)) {
    const directory = join(root, entry);
    if (!statSync(directory).isDirectory()) continue;

    const file = join(directory, "SKILL.md");
    if (!existsSync(file)) continue;

    const { fields, body } = splitFrontmatter(readFileSync(file, "utf8"));
    seeds.push({
      id: entry,
      name: fields.name ?? entry,
      description: fields.description ?? "",
      path: file,
      content: body,
    });
  }
  return seeds;
}

export default Plugin.define({
  id: "org-opencode",
  async setup(ctx) {
    const skills = loadSkills(join(here, "skills"));
    if (skills.length === 0) return;

    await ctx.skill.transform((editor) => {
      for (const skill of skills) {
        if (editor.get(skill.id)) editor.remove(skill.id);
        editor.add({
          id: skill.id,
          name: skill.name,
          description: skill.description,
          path: skill.path,
          content: skill.content,
        });
      }
    });
  },
});
