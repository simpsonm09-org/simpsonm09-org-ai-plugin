import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Plugin } from "@opencode/plugin";
import {
  type CliResult,
  contextLine,
  fallbackLevel,
  gateShellEdit,
  nodeRunner,
  remoteUrlFor,
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

// The resolver module (scripts/agent-access.mjs) exports the decision it makes
// for its own CLI, so the gate calls the functions in-process instead of
// spawning. Importing avoids the interpreter trap: the plugin runs inside the
// OpenCode binary, where process.execPath is the OpenCode CLI, not Node. Only
// the exports the gate needs are typed here.
interface AccessApi {
  loadCatalog: (path?: string) => unknown;
  loadCommittedCatalog?: (dir?: string) => unknown | null;
  resolveLevel: (catalog: unknown, repoName: string) => { level?: unknown };
  decide: (
    level: string,
    command: string,
    remoteUrl?: string | null,
  ) => { capability: string | null; allowed: boolean };
}

interface TokenApi {
  mintForRepo: (
    owner: string,
    repo: string,
  ) => Promise<{ token: string; expires_at: string }>;
}

// Import a configured script and return it only when it exports the interface
// the gate calls. A missing file, a syntax error, or a script without the API
// is a genuine unknown, which the caller treats conservatively.
async function importModule<T>(script: string): Promise<T | null> {
  if (!existsSync(script)) return null;
  try {
    return (await import(pathToFileURL(script).href)) as T;
  } catch {
    return null;
  }
}

function isAccessApi(value: unknown): value is AccessApi {
  const api = value as Partial<AccessApi> | null;
  return (
    typeof api?.loadCatalog === "function" &&
    typeof api.resolveLevel === "function" &&
    typeof api.decide === "function"
  );
}

// Load the committed catalog the way the resolver CLI does, then classify the
// command. This mirrors agent-access.mjs main(): prefer the committed catalog,
// fall back to the working-tree catalog, and exit 2 when neither loads. The
// remote URL scopes a git push, so a push to a non-organization remote is out
// of scope and allowed; an unknown URL stays governed.
function accessFromApi(
  api: AccessApi,
  repo: string,
  command: string,
  remoteUrl: string | null,
): CliResult {
  const catalog = api.loadCommittedCatalog?.() ?? api.loadCatalog();
  const resolved = api.resolveLevel(catalog, repo);
  const level =
    typeof resolved.level === "string" ? resolved.level : fallbackLevel();
  const decision = api.decide(level, command, remoteUrl);
  return {
    code: decision.allowed ? 0 : 1,
    stdout: JSON.stringify({
      level,
      capability: decision.capability,
      allowed: decision.allowed,
    }),
  };
}

// The last resort when the script exports no API: run it as a CLI. Run it with
// a Node runtime, never the OpenCode binary, so the spawn cannot open OpenCode.
// The remote URL is passed only when it is known, so the CLI keeps its default
// governed behavior when git cannot resolve it.
function accessFromCli(
  script: string,
  repo: string,
  command: string,
  remoteUrl: string | null,
): CliResult {
  const args = [script, repo, "--command", command, "--json"];
  if (remoteUrl) args.push("--remote-url", remoteUrl);
  try {
    const stdout = execFileSync(nodeRunner(process.execPath), args, {
      encoding: "utf8",
    });
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

// Resolve access for one command. The in-process module is the preferred path;
// a script that only ships a CLI is spawned with a Node runtime. A module that
// loads but then throws is an unknown answer, not a crash.
function resolveAccess(
  api: AccessApi | null,
  script: string,
  repo: string,
  command: string,
  remoteUrl: string | null,
): CliResult {
  if (api) {
    try {
      return accessFromApi(api, repo, command, remoteUrl);
    } catch {
      return { code: 2, stdout: "" };
    }
  }
  if (!existsSync(script)) return { code: 2, stdout: "" };
  return accessFromCli(script, repo, command, remoteUrl);
}

// Read the resolved level for the context line. The command decision above is
// the authority; the level is informational.
function levelFor(api: AccessApi | null, repo: string): string {
  if (!api) return fallbackLevel();
  try {
    const catalog = api.loadCommittedCatalog?.() ?? api.loadCatalog();
    const resolved = api.resolveLevel(catalog, repo);
    return typeof resolved.level === "string"
      ? resolved.level
      : fallbackLevel();
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
async function tokenFor(
  api: TokenApi | null,
  script: string,
  repo: string,
): Promise<string | null> {
  if (tokenUsable(tokenCache, Date.now()))
    return (tokenCache as TokenCache).token;
  const minted = api
    ? await mintInProcess(api, repo)
    : await mintFromCli(script, repo);
  if (!minted) return null;
  tokenCache = minted;
  return minted.token;
}

async function mintInProcess(
  api: TokenApi,
  repo: string,
): Promise<TokenCache | null> {
  try {
    const minted = await api.mintForRepo(OWNER, repo);
    if (!minted?.token || !minted.expires_at) return null;
    return { token: minted.token, expires_at: minted.expires_at };
  } catch {
    return null;
  }
}

// A broker that only ships a CLI is spawned with a Node runtime, matching the
// resolver fallback. The CLI prints one JSON object on stdout.
async function mintFromCli(
  script: string,
  repo: string,
): Promise<TokenCache | null> {
  if (!existsSync(script)) return null;
  try {
    const stdout = execFileSync(
      nodeRunner(process.execPath),
      [script, `${OWNER}/${repo}`, "--json"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    );
    const parsed = JSON.parse(stdout ?? "") as Partial<TokenCache>;
    if (!parsed.token || !parsed.expires_at) return null;
    return { token: parsed.token, expires_at: parsed.expires_at };
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

    // Load the resolver and broker modules once. The gate calls their exports
    // in-process, so no child process and no interpreter are involved.
    const access = await importModule<AccessApi>(scripts.access);
    const accessApi = isAccessApi(access) ? access : null;
    const broker = await importModule<TokenApi>(scripts.token);
    const tokenApi =
      broker && typeof broker.mintForRepo === "function" ? broker : null;

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
        resolve: (name, command, remoteUrl) =>
          resolveAccess(accessApi, scripts.access, name, command, remoteUrl),
        remoteUrl: (remote, cwd) =>
          remoteUrlFor(remote, cwd, (args) =>
            execFileSync("git", args, {
              encoding: "utf8",
              stdio: ["ignore", "pipe", "ignore"],
            }),
          ),
        tokenFor: (name) => tokenFor(tokenApi, scripts.token, name),
      });
    });

    await ctx.session.hook("context", (event) => {
      const repo = repoFromCwd(ctx.location.directory, workspaceRoot);
      if (!repo) return;
      event.system.push({
        type: "text",
        text: contextLine(repo, levelFor(accessApi, repo)),
      });
    });
  },
});
