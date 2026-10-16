// The normalized shape of one observation, and the builders that produce it. The parser
// (lib/intent.mjs and its two domain modules) reads a command and returns one of these; the
// resolver (repo-standard scripts/agent-access.mjs) consumes the two projections in
// lib/intent.mjs (`toResolverIntent`, `observationDestination`), never this module.

// The observation kinds. `local` and `read` reach nothing this policy governs. `write` is a
// recognized governed write with a resolved destination and ref. `unsupported` is a form
// this observer does not model that carries a governed write signal. `ambiguous` is a
// modeled form whose destination or ref cannot be pinned to one answer.
export const OBSERVATION_KINDS = Object.freeze({
  local: "local",
  read: "read",
  write: "write",
  unsupported: "unsupported",
  ambiguous: "ambiguous",
});

/**
 * @typedef {{ host: string, owner: string, repo: string }} Destination
 * @typedef {{ kind: string, name: string, isDefault: boolean | null }} ObservedRef
 * @typedef {{ owner: string | null, repo: string | null, branch: string }} ObservedSide
 * @typedef {{
 *   kind: string,
 *   program: "git" | "gh" | "other",
 *   operation: string,
 *   capability: string | null,
 *   readOnly: boolean,
 *   resolved: boolean,
 *   destination: Destination | null,
 *   destinationSource: "explicit" | "remote" | "pushurl" | "url" | "git-default" | "cwd" | "none",
 *   refs: ObservedRef[],
 *   force: boolean,
 *   delete: boolean,
 *   base: ObservedSide | null,
 *   head: ObservedSide | null,
 *   environment: string[],
 *   reason: string,
 * }} Observation
 */

/**
 * @param {string} kind
 * @param {"git" | "gh" | "other"} program
 * @returns {Observation}
 */
export function baseObservation(kind, program) {
  return {
    kind,
    program,
    operation: "unknown",
    capability: null,
    readOnly: false,
    resolved: false,
    destination: null,
    destinationSource: "none",
    refs: [],
    force: false,
    delete: false,
    base: null,
    head: null,
    environment: [],
    reason: "",
  };
}

/**
 * @param {string} reason
 * @returns {Observation}
 */
export function localObservation(reason) {
  return {
    ...baseObservation("local", "other"),
    program: "other",
    operation: "none",
    readOnly: true,
    resolved: true,
    reason,
  };
}

/**
 * @param {"git" | "gh"} program
 * @param {string} reason
 * @returns {Observation}
 */
export function readObservation(program, reason) {
  return {
    ...baseObservation("read", program),
    operation: "read",
    readOnly: true,
    resolved: true,
    reason,
  };
}

/**
 * @param {string} reason
 * @returns {Observation}
 */
export function unsupported(reason) {
  return { ...baseObservation("unsupported", "other"), reason };
}

// Whether an observation carries a governed-write signal. `local` and `read` are read-only and
// reach nothing this policy governs; `write`, `ambiguous`, and `unsupported` are the shapes a
// caller must send to the resolver and deny when the destination or the environment cannot be
// trusted. One predicate, so every caller agrees on what a write is.
/**
 * @param {Observation} observation
 * @returns {boolean}
 */
export function isGovernedWrite(observation) {
  return observation.readOnly !== true;
}

/**
 * @param {{
 *   program: "git" | "gh",
 *   operation: string,
 *   capability: string,
 *   resolved: boolean,
 *   destination: Destination | null,
 *   destinationSource: Observation["destinationSource"],
 *   refs: ObservedRef[],
 *   force: boolean,
 *   delete: boolean,
 *   base?: ObservedSide | null,
 *   head?: ObservedSide | null,
 *   reason: string,
 * }} parts
 * @returns {Observation}
 */
export function writeObservation(parts) {
  return {
    ...baseObservation(parts.resolved ? "write" : "ambiguous", parts.program),
    operation: parts.operation,
    capability: parts.capability,
    resolved: parts.resolved,
    destination: parts.destination,
    destinationSource: parts.destinationSource,
    refs: parts.refs,
    force: parts.force,
    delete: parts.delete,
    base: parts.base ?? null,
    head: parts.head ?? null,
    reason: parts.reason,
  };
}
