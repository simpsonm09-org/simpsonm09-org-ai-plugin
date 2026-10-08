import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Plugin } from "@opencode/plugin";
import {
  defaultScripts,
  gitRemoteUrl,
  levelFor,
  loadAccessApi,
  loadTokenApi,
  resolveAccess,
  tokenFor,
} from "./access.mjs";
import { contextLine, gateShellEdit } from "./gate.mjs";
import { fleetLookup } from "./lib/fleet.mjs";

// This file is an adapter. The rules are in gate.mjs; the decision for a command is
// gateShellEdit there, and the Claude Code hook applies the same decision.

const here = dirname(fileURLToPath(import.meta.url));

// The plugin lives at <workspace>/.opencode/plugins/<name>, so the workspace root is
// three levels up. It is the trusted workspace for the fleet lookup: a working directory
// counts as a fleet repository only under this workspace. A caller may point it elsewhere
// with options.workspaceRoot, as the tests do with a fixture.
const defaultWorkspaceRoot = resolve(here, "..", "..", "..");

function workspaceRootFor(options: unknown): string {
  const configured = (options as { workspaceRoot?: unknown } | undefined)
    ?.workspaceRoot;
  return typeof configured === "string" && configured.length > 0
    ? resolve(configured)
    : defaultWorkspaceRoot;
}

interface Scripts {
  access: string;
  token: string;
}

// The resolver and broker default to the repo-standard clone in the workspace. A caller
// may point them elsewhere with options.scripts, which keeps the gate testable in a
// checkout that has no workspace around it.
function scriptsFor(options: unknown, workspaceRoot: string): Scripts {
  const configured = (options as { scripts?: Partial<Scripts> } | undefined)
    ?.scripts;
  const defaults = defaultScripts(workspaceRoot);
  return {
    access: configured?.access ?? defaults.access,
    token: configured?.token ?? defaults.token,
  };
}

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
  id: "simpsonm09-org-ai-plugin",
  async setup(ctx) {
    const workspaceRoot = workspaceRootFor(ctx.options);
    const scripts = scriptsFor(ctx.options, workspaceRoot);

    // Load the resolver and broker modules once. The gate calls their exports in-process,
    // so no interpreter is involved.
    const accessApi = await loadAccessApi(scripts.access);
    const tokenApi = await loadTokenApi(scripts.token);

    const skills = loadSkills(join(here, "skills"));
    if (skills.length > 0) {
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
    }

    await ctx.shell.hook("create.before", async (input) => {
      // A directory git cannot resolve is not a pass: the gate applies its unknown-answer rule.
      const found = fleetLookup(input.cwd, workspaceRoot);
      if (!found.repo && !found.unresolved) return;
      input.env ??= {};
      await gateShellEdit(input, input.env, {
        cwd: input.cwd,
        lookup: () => found,
        resolve: (name, command, remoteUrl) =>
          resolveAccess(accessApi, scripts.access, name, command, remoteUrl),
        remoteUrl: gitRemoteUrl,
        tokenFor: (name) => tokenFor(tokenApi, scripts.token, name),
      });
    });

    await ctx.session.hook("context", (event) => {
      const repo = fleetLookup(ctx.location.directory, workspaceRoot).repo;
      if (!repo) return;
      event.system.push({
        type: "text",
        text: contextLine(repo, levelFor(accessApi, repo)),
      });
    });
  },
});
