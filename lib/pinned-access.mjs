import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const RESOLVER_PIN = Object.freeze({
  repository: "simpsonm09-org/simpsonm09-repo-standard",
  commit: "b108c6b339903e075fd757dfd5880a9325a18b5b",
  sourcePath: "scripts/agent-access.mjs",
  sha256: "d068dc5a7c8a86077fc8c5fc90d8096b3c1419f2a3a6feb7a1c68a71d1d9a442",
  apiVersion: 2,
  artifactPath: "runtime/agent-access.mjs",
});

const PIN_FILE = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  RESOLVER_PIN.artifactPath,
);
const METADATA_FILE = join(dirname(PIN_FILE), "agent-access.pin.json");

export function pinMetadata() {
  return {
    repository: RESOLVER_PIN.repository,
    commit: RESOLVER_PIN.commit,
    sourcePath: RESOLVER_PIN.sourcePath,
    sha256: RESOLVER_PIN.sha256,
    apiVersion: RESOLVER_PIN.apiVersion,
    artifactPath: RESOLVER_PIN.artifactPath,
  };
}

export function hasSupportedPinMetadata(metadata) {
  return (
    metadata !== null &&
    typeof metadata === "object" &&
    JSON.stringify(metadata) === JSON.stringify(pinMetadata())
  );
}

/**
 * @param {unknown} api
 * @returns {api is Record<string, unknown> & {
 *   loadCommittedCatalog: (dir: string) => unknown | null,
 *   loadCommittedOwnedForks: (dir: string) => unknown | null,
 *   resolveLevel: (catalog: unknown, repoName: string) => { level?: unknown, source?: string },
 *   resolveDestination: (input: Record<string, unknown>) => Record<string, unknown>,
 *   decideTarget: (target: unknown, intent: unknown) => { capability: string | null, allowed: boolean },
 * }}
 */
export function hasPinnedAccessApi(api) {
  return (
    api !== null &&
    typeof api === "object" &&
    typeof api.loadCommittedCatalog === "function" &&
    typeof api.loadCommittedOwnedForks === "function" &&
    typeof api.resolveLevel === "function" &&
    typeof api.resolveDestination === "function" &&
    typeof api.decideTarget === "function"
  );
}

/**
 * Hash the packaged bytes, adapt the unused filesystem bootstrap, then import
 * the resulting in-memory module so no mutable file is imported after checking.
 * @param {string} [artifactPath]
 * @returns {Promise<(Record<string, unknown> & {
 *   loadCommittedCatalog: (dir: string) => unknown | null,
 *   loadCommittedOwnedForks: (dir: string) => unknown | null,
 *   resolveLevel: (catalog: unknown, repoName: string) => { level?: unknown, source?: string },
 *   resolveDestination: (input: Record<string, unknown>) => Record<string, unknown>,
 *   decideTarget: (target: unknown, intent: unknown) => { capability: string | null, allowed: boolean },
 * }) | null>}
 */
export async function loadPinnedAccessApi(artifactPath = PIN_FILE) {
  try {
    const metadata = JSON.parse(await readFile(METADATA_FILE, "utf8"));
    if (!hasSupportedPinMetadata(metadata)) return null;
    const bytes = await readFile(artifactPath);
    const digest = createHash("sha256").update(bytes).digest("hex");
    if (digest !== RESOLVER_PIN.sha256) return null;

    const sourceText = bytes.toString("utf8");
    const sourceRoot =
      "const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');";
    if (sourceText.split(sourceRoot).length !== 2) return null;
    // The resolver's CLI default path is unused by this API. A data URL has no
    // filesystem location, so replace only that bootstrap value after verifying
    // the original packaged bytes. All decisions use the explicit catalog path.
    const moduleText = sourceText.replace(sourceRoot, "const ROOT = '';");
    const source = `data:text/javascript;base64,${Buffer.from(moduleText).toString("base64")}`;
    const api = await import(source);
    if (!hasPinnedAccessApi(api)) return null;
    return api;
  } catch {
    return null;
  }
}
