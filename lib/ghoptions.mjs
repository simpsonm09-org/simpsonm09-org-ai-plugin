// The gh option tables: every option spelling this observer models, split by whether the
// option takes a value. One table per modeled command is what makes the value/flag
// distinction authoritative: `-r` is `--reviewer` (a value) for `pr create` and `--rebase`
// (a flag) for `pr merge`, and a value option's value can never be read as a flag. The tables
// are data only; the reader that consumes them is lib/ghargv.mjs and the selector that picks
// one is `optionSpecFor` in lib/ghcommand.mjs.

// The generic option spellings every gh command inherits. `-R`/`--repo` is a persistent flag,
// so it is accepted before or after the subcommand; the help and version flags print and exit.
export const GLOBAL_OPTIONS = optionSpec(
  ["-R", "--repo"],
  ["-h", "--help", "--version"],
);

// A gh option table, as the exact token spellings, split by whether the option takes a value.
/**
 * @param {string[]} values the option spellings that take a value
 * @param {string[]} flags the option spellings that take none
 * @returns {{ values: Set<string>, flags: Set<string> }}
 */
function optionSpec(values, flags) {
  return { values: new Set(values), flags: new Set(flags) };
}

const READ_OPTION_VALUES = [
  "--json",
  "-q",
  "--jq",
  "--template",
  "-R",
  "--repo",
  "-L",
  "--limit",
  "-s",
  "--state",
  "-S",
  "--search",
  "-B",
  "--base",
  "-H",
  "--head",
  "-l",
  "--label",
  "-a",
  "--assignee",
  "-A",
  "--author",
  "-c",
  "--comments",
];

export const COMMAND_OPTIONS = new Map([
  [
    "api",
    optionSpec(
      [
        "-X",
        "--method",
        "-f",
        "--raw-field",
        "-F",
        "--field",
        "--input",
        "-H",
        "--header",
        "-q",
        "--jq",
        "--template",
        "--cache",
        "--hostname",
        "--preview",
        "-R",
        "--repo",
      ],
      [
        "-i",
        "--include",
        "--paginate",
        "--slurp",
        "-s",
        "--silent",
        "--verbose",
        "-h",
        "--help",
      ],
    ),
  ],
  [
    "pr create",
    optionSpec(
      [
        "-t",
        "--title",
        "-b",
        "--body",
        "-F",
        "--body-file",
        "-B",
        "--base",
        "-H",
        "--head",
        "-r",
        "--reviewer",
        "-a",
        "--assignee",
        "-l",
        "--label",
        "-m",
        "--milestone",
        "-p",
        "--project",
        "-T",
        "--template",
        "--recover",
        "-R",
        "--repo",
      ],
      [
        "-d",
        "--draft",
        "-f",
        "--fill",
        "--fill-first",
        "--fill-verbose",
        "-w",
        "--web",
        "--maintainer-edit",
        "--no-maintainer-edit",
        "-h",
        "--help",
      ],
    ),
  ],
  [
    "pr merge",
    optionSpec(
      [
        "-b",
        "--body",
        "-t",
        "--subject",
        "-F",
        "--body-file",
        "--match-head-commit",
        "-R",
        "--repo",
      ],
      [
        "-m",
        "--merge",
        "-s",
        "--squash",
        "-r",
        "--rebase",
        "-d",
        "--delete-branch",
        "--auto",
        "--disable-auto",
        "--admin",
        "-h",
        "--help",
      ],
    ),
  ],
  [
    "release create",
    optionSpec(
      [
        "-n",
        "--notes",
        "-F",
        "--notes-file",
        "-t",
        "--title",
        "--target",
        "--notes-start-tag",
        "--discussion-category",
        "-R",
        "--repo",
      ],
      [
        "-d",
        "--draft",
        "-p",
        "--prerelease",
        "--generate-notes",
        "--latest",
        "--verify-tag",
        "--fail-on-no-commits",
        "-h",
        "--help",
      ],
    ),
  ],
  [
    "release edit",
    optionSpec(
      [
        "-n",
        "--notes",
        "-F",
        "--notes-file",
        "-t",
        "--title",
        "--tag",
        "--target",
        "-R",
        "--repo",
      ],
      ["-d", "--draft", "-p", "--prerelease", "--latest", "-h", "--help"],
    ),
  ],
  [
    "release delete",
    optionSpec(
      ["-R", "--repo"],
      ["-y", "--yes", "--cleanup-tag", "-h", "--help"],
    ),
  ],
  [
    "release upload",
    optionSpec(["-R", "--repo"], ["--clobber", "-h", "--help"]),
  ],
  [
    "workflow run",
    optionSpec(
      ["-f", "--raw-field", "--ref", "-R", "--repo"],
      ["-h", "--help"],
    ),
  ],
  [
    "secret set",
    optionSpec(
      [
        "-b",
        "--body",
        "-f",
        "--env-file",
        "-a",
        "--app",
        "-o",
        "--org",
        "-r",
        "--repos",
        "-v",
        "--visibility",
        "-e",
        "--env",
      ],
      ["-h", "--help"],
    ),
  ],
  [
    "secret delete",
    optionSpec(
      ["-a", "--app", "-o", "--org", "-r", "--repos", "-e", "--env"],
      ["-h", "--help"],
    ),
  ],
  [
    "repo create",
    optionSpec(
      [
        "-d",
        "--description",
        "--homepage",
        "-l",
        "--license",
        "--gitignore",
        "--template",
        "-t",
        "--team",
        "--source",
        "--remote",
      ],
      [
        "--public",
        "--private",
        "--internal",
        "--clone",
        "--disable-issues",
        "--disable-wiki",
        "--include-all-branches",
        "-y",
        "--confirm",
        "-h",
        "--help",
      ],
    ),
  ],
  [
    "repo edit",
    optionSpec(
      [
        "-d",
        "--description",
        "--homepage",
        "--add-topic",
        "--remove-topic",
        "--default-branch",
        "--visibility",
        "-R",
        "--repo",
      ],
      [
        "--enable-issues",
        "--disable-issues",
        "--enable-wiki",
        "--disable-wiki",
        "--enable-projects",
        "--disable-projects",
        "--enable-discussions",
        "--disable-discussions",
        "-h",
        "--help",
      ],
    ),
  ],
  [
    "repo delete",
    optionSpec(["-R", "--repo"], ["-y", "--yes", "-h", "--help"]),
  ],
  [
    "repo archive",
    optionSpec(["-R", "--repo"], ["-y", "--yes", "-h", "--help"]),
  ],
  [
    "repo rename",
    optionSpec(["-R", "--repo"], ["-y", "--yes", "-h", "--help"]),
  ],
  [
    "repo transfer",
    optionSpec(["-R", "--repo"], ["-y", "--yes", "-h", "--help"]),
  ],
]);

// The read verbs share one broad option table, so a real gh read with its usual flags keeps a
// trustworthy destination instead of falling out of the model.
export const READ_TABLE = new Map([
  [
    "pr",
    optionSpec(READ_OPTION_VALUES, [
      "-w",
      "--web",
      "-d",
      "--draft",
      "--help",
      "-h",
    ]),
  ],
  ["issue", optionSpec(READ_OPTION_VALUES, ["-w", "--web", "--help", "-h"])],
  ["run", optionSpec(READ_OPTION_VALUES, ["-w", "--web", "--help", "-h"])],
  ["repo", optionSpec(READ_OPTION_VALUES, ["-w", "--web", "--help", "-h"])],
  ["release", optionSpec(READ_OPTION_VALUES, ["-w", "--web", "--help", "-h"])],
  ["workflow", optionSpec(READ_OPTION_VALUES, ["-w", "--web", "--help", "-h"])],
  [
    "search",
    optionSpec(
      [
        ...READ_OPTION_VALUES,
        "--language",
        "--created",
        "--updated",
        "--merged",
        "--owner",
        "--topic",
        "--match",
      ],
      ["-w", "--web", "--draft", "--archived", "--help", "-h"],
    ),
  ],
]);
