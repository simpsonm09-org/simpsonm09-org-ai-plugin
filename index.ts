import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Plugin } from "@opencode/plugin";
import {
  type CliResult,
  contextLine,
  fallbackLevel,
  gateShellEdit,
  repoFromCwd,
  tokenUsable,
} from "./gate.mjs";

const here = dirname(fileURLToPath(import.meta.url));

// The plugin lives at <workspace>/.opencode/plugins/<name>, so the workspace
// root is three levels up.
const workspaceRoot = resolve(here, "..", "..", "..");
const REPO_STANDARD = join(
  workspaceRoot,
  "projects",
  "repos",
  "simpsonm09-repo-standard",
);
const OWNER = "simpsonm09-org";

interface Scripts {
  access: string;
  token: string;
}

// The resolver and broker default to the repo-standard clone in the workspace.
// A caller may point them elsewhere with options.scripts, which keeps the gate
// testable in a checkout that has no workspace around it.
function scriptsFor(options: unknown): Scripts {
  const configured = (options as { scripts?: Partial<Scripts> } | undefined)
    ?.scripts;
  return {
    access:
      configured?.access ?? join(REPO_STANDARD, "scripts", "agent-access.mjs"),
    token:
      configured?.token ?? join(REPO_STANDARD, "scripts", "agent-token.mjs"),
  };
}

// Run the frozen resolver interface. It classifies the command to a capability
// and exits 0 when the level grants it, 1 when it does not, 2 when the catalog
// is unreadable. A missing script is an unknown answer, not a crash: the gate
// fails closed on a write and leaves a read alone. The JSON on stdout carries
// the level for the context line.
function resolveAccess(
  script: string,
  repo: string,
  command: string,
): CliResult {
  if (!existsSync(script)) return { code: 2, stdout: "" };
  try {
    const stdout = execFileSync(
      process.execPath,
      [script, repo, "--command", command, "--json"],
      { encoding: "utf8" },
    );
    return { code: 0, stdout: stdout ?? "" };
  } catch (error) {
    const failure = error as {
      status?: number | null;
      stdout?: string | Buffer;
    };
    if (typeof failure?.status === "number")
      return { code: failure.status, stdout: String(failure.stdout ?? "") };
    return { code: 2, stdout: "" };
  }
}

// Read the resolved level for the context line. The command decision above is
// the authority; the level is informational.
function resolveLevel(script: string, repo: string): string {
  if (!existsSync(script)) return fallbackLevel();
  try {
    const stdout = execFileSync(process.execPath, [script, repo, "--json"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    const parsed = JSON.parse(stdout ?? "") as { level?: unknown };
    return typeof parsed.level === "string" ? parsed.level : fallbackLevel();
  } catch {
    return fallbackLevel();
  }
}

interface TokenCache {
  token: string;
  expires_at: string;
}

let tokenCache: TokenCache | null = null;

// Mint an installation token for one repository and cache it until it nears
// expiry. The token never leaves the process environment; it is never logged.
async function tokenFor(script: string, repo: string): Promise<string | null> {
  if (tokenUsable(tokenCache, Date.now()))
    return (tokenCache as TokenCache).token;
  if (!existsSync(script)) return null;
  try {
    const stdout = execFileSync(
      process.execPath,
      [script, `${OWNER}/${repo}`, "--json"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    );
    const parsed = JSON.parse(stdout ?? "") as Partial<TokenCache>;
    if (!parsed.token || !parsed.expires_at) return null;
    tokenCache = { token: parsed.token, expires_at: parsed.expires_at };
    return parsed.token;
  } catch {
    return null;
  }
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
  id: "simpsonm09-org-opencode",
  async setup(ctx) {
    const scripts = scriptsFor(ctx.options);

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
      const repo = repoFromCwd(input.cwd, workspaceRoot);
      if (!repo) return;
      input.env ??= {};
      await gateShellEdit(input, input.env, {
        cwd: input.cwd,
        workspaceRoot,
        resolve: (name, command) =>
          resolveAccess(scripts.access, name, command),
        tokenFor: (name) => tokenFor(scripts.token, name),
      });
    });

    await ctx.session.hook("context", (event) => {
      const repo = repoFromCwd(ctx.location.directory, workspaceRoot);
      if (!repo) return;
      event.system.push({
        type: "text",
        text: contextLine(repo, resolveLevel(scripts.access, repo)),
      });
    });
  },
});
