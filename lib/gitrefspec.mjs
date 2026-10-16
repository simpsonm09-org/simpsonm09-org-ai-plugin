// The refspec half of the `git push` observation: which refs a push writes and the capability
// those refs need. The refs come from the command's refspecs, or, when it names none, from
// `remote.<r>.push`, then push.default, then the current branch. A name git cannot resolve
// stays `unknown`, which leaves the push unresolved and denied rather than guessed.

import {
  configValue,
  currentBranch,
  remotePushRefspecs,
  resolveRefName,
} from "./gitstate.mjs";

// The names a branch is treated as a default branch by when git records no default branch for
// the remote. They are only a fallback: when the remote-tracking HEAD is present, the
// comparison is against that branch, whatever it is called. Treating a conventionally named
// branch as the default can only deny a push, never allow one, so the fallback is the safe
// direction when a clone has no `refs/remotes/<remote>/HEAD` (the current classifier also
// special-cases these names).
const CONVENTIONAL_DEFAULTS = new Set(["main", "master"]);

// The refspecs git uses when the command names none: remote.<r>.push first, then push.default
// (matching is a multi-ref write, current and upstream name one branch), then the current
// branch.
/**
 * @param {((args: string[]) => string | null) | null} read
 * @param {string | null} remoteName
 * @returns {{ refs: (defaultName: string | null) => import("./observation.mjs").ObservedRef[], bulk: boolean, none: boolean, force: boolean }}
 */
export function implicitRefspecs(read, remoteName) {
  if (!read) return { refs: () => [], bulk: false, none: true, force: false };
  if (remoteName) {
    if (
      (configValue(read, `remote.${remoteName}.mirror`) ?? "").toLowerCase() ===
      "true"
    )
      return { refs: () => [], bulk: true, none: false, force: false };
    const configured = remotePushRefspecs(read, remoteName);
    if (configured.length > 0)
      return {
        refs: (defaultName) => refspecRefs(configured, read, { defaultName }),
        bulk: false,
        none: false,
        force: configured.some((spec) => spec.startsWith("+")),
      };
  }
  const pushDefault = (configValue(read, "push.default") ?? "").toLowerCase();
  if (pushDefault === "matching")
    return { refs: () => [], bulk: true, none: false, force: false };
  if (pushDefault === "nothing")
    return { refs: () => [], bulk: false, none: true, force: false };
  const branch = currentBranch(read);
  if (branch === null)
    return { refs: () => [], bulk: false, none: true, force: false };
  const target =
    pushDefault === "upstream" || pushDefault === "tracking"
      ? (configValue(read, `branch.${branch}.merge`) ?? `refs/heads/${branch}`)
      : `refs/heads/${branch}`;
  return {
    refs: (defaultName) => refspecRefs([target], read, { defaultName }),
    bulk: false,
    none: false,
    force: false,
  };
}

/**
 * @param {string[]} specs
 * @param {((args: string[]) => string | null) | null} read
 * @param {{ defaultName: string | null }} options
 * @returns {import("./observation.mjs").ObservedRef[]}
 */
export function refspecRefs(specs, read, options) {
  return specs.map((spec) => refOf(spec, read, options));
}

// One refspec as the ref it writes. The destination side of a `src:dst` form is the ref the
// remote writes; without a colon the source name is the ref. An empty source (`:dst`) is a
// deletion. An empty destination is not a refspec git accepts: git 2.55 refuses
// `git push origin feat/x:` with "fatal: invalid refspec" (verified with a local `--dry-run`
// against a new bare repository), so it is never normalized to the source name and never
// read as a deletion. It stays `unknown`, which leaves the push unresolved and denied. The
// lone `:` (empty source and destination) is git's documented matching form and is likewise
// left unresolved rather than guessed. A wildcard is a multi-ref write, which is never a
// single branch.
/**
 * @param {string} spec
 * @param {((args: string[]) => string | null) | null} read
 * @param {{ defaultName: string | null }} options
 * @returns {import("./observation.mjs").ObservedRef}
 */
function refOf(spec, read, options) {
  const text = spec.startsWith("+") ? spec.slice(1) : spec;
  const colon = text.indexOf(":");
  if (colon === -1) return refForTarget(text, read, options);
  const destination = text.slice(colon + 1);
  if (destination.length === 0)
    return { kind: "unknown", name: text, isDefault: null };
  return refForTarget(destination, read, options);
}

/**
 * @param {string} target
 * @param {((args: string[]) => string | null) | null} read
 * @param {{ defaultName: string | null }} options
 * @returns {import("./observation.mjs").ObservedRef}
 */
function refForTarget(target, read, options) {
  const ref = refKindFor(target, read);
  return {
    kind: ref.kind,
    name: ref.name,
    isDefault: defaultState(ref, options.defaultName),
  };
}

// Whether a ref is the default branch, as a tri-state. `true` is the resolved default branch
// (or a conventionally named branch when the remote records none), `false` is a resolved
// non-default branch, and `null` is a branch whose default branch could not be resolved. The
// resolver's own push rule requires exactly `false`, so `null` denies a governed branch push.
/**
 * @param {{ kind: string, name: string }} ref
 * @param {string | null} defaultName
 * @returns {boolean | null}
 */
function defaultState(ref, defaultName) {
  if (ref.kind !== "branch") return null;
  if (defaultName !== null) return ref.name === defaultName;
  return CONVENTIONAL_DEFAULTS.has(ref.name) ? true : null;
}

// The ref kind a name means, resolved from git where the name is bare.
/**
 * @param {string} target
 * @param {((args: string[]) => string | null) | null} read
 * @returns {{ kind: string, name: string }}
 */
function refKindFor(target, read) {
  if (target.includes("*")) return { kind: "other", name: target };
  if (target === "HEAD") return headRef(read, target);
  const qualified = classifyQualifiedRef(target);
  if (qualified) return qualified;
  if (!read) return { kind: "unknown", name: target };
  const resolved = resolveRefName(read, target);
  if (resolved.ambiguous || !resolved.ref)
    return { kind: "unknown", name: target };
  if (resolved.ref === "HEAD") return headRef(read, target);
  return classifyQualifiedRef(resolved.ref) ?? { kind: "other", name: target };
}

// The branch a symbolic HEAD names, or `unknown` when the branch cannot be read. The reported
// name is the one the refspec wrote, not the resolved branch, so a fork push keeps its text.
/**
 * @param {((args: string[]) => string | null) | null} read
 * @param {string} name
 * @returns {{ kind: string, name: string }}
 */
function headRef(read, name) {
  const branch = read ? currentBranch(read) : null;
  return branch ? { kind: "branch", name: branch } : { kind: "unknown", name };
}

// The kind of a fully qualified ref name, or null when the name is not one this observer reads
// as a tag, a branch, or some other ref.
/**
 * @param {string} ref
 * @returns {{ kind: string, name: string } | null}
 */
function classifyQualifiedRef(ref) {
  if (ref.startsWith("refs/tags/"))
    return { kind: "tag", name: ref.slice("refs/tags/".length) };
  if (ref.startsWith("refs/heads/"))
    return { kind: "branch", name: ref.slice("refs/heads/".length) };
  if (ref.startsWith("refs/")) return { kind: "other", name: ref };
  return null;
}

// The capability a push needs. A tag, a non-branch ref, an unknown ref, the default branch, a
// deletion, a force, and a bulk flag all need `pushMain`; otherwise every ref is a non-default
// branch and the push is `pushBranch`. A branch whose default state is unknown (`null`) is
// `pushBranch` for the organization — today's behavior — because the resolver's own push rule
// requires `isDefault === false` and so denies it for every other destination.
/**
 * @param {boolean} bulk
 * @param {import("./observation.mjs").ObservedRef[]} refs
 * @returns {string}
 */
export function pushCapability(bulk, refs) {
  if (bulk) return "pushMain";
  if (refs.length === 0) return "pushBranch";
  if (!refs.every((ref) => ref.kind === "branch" && ref.isDefault !== true))
    return "pushMain";
  return "pushBranch";
}
