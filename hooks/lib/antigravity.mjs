// Antigravity's PreToolUse adapter for the run_command shell tool.
import { handlePreToolUse } from "./claude.mjs";

const FAILURE = {
  decision: "deny",
  reason:
    "the Antigravity agent-access gate failed internally; the command is blocked",
};

function shellFor(args, platform = process.platform) {
  if (args.Shell === "powershell" || args.Shell === "bash") return args.Shell;
  return platform === "win32" ? "powershell" : "bash";
}

export async function handleAntigravity(input, options = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw new Error("invalid Antigravity hook payload");
  if (input.hook_event_name && input.hook_event_name !== "PreToolUse")
    return null;
  const name = input.toolCall?.name;
  if (typeof name !== "string")
    throw new Error("the Antigravity payload has no tool name");
  if (name !== "run_command") return null;
  const args = input.toolCall.args;
  if (
    !args ||
    typeof args !== "object" ||
    typeof args.CommandLine !== "string" ||
    typeof args.Cwd !== "string" ||
    !args.Cwd
  )
    throw new Error(
      "the Antigravity run_command payload has no command or cwd",
    );
  const shell = shellFor(args, options.platform);
  const answer = await handlePreToolUse(
    {
      tool_name: shell === "powershell" ? "PowerShell" : "Bash",
      tool_input: { command: args.CommandLine },
      cwd: args.Cwd,
    },
    {
      workspaceRoot: options.workspaceRoot,
      env: options.env,
      toolShells: true,
    },
  );
  const hook = answer?.hookSpecificOutput;
  if (!hook) return { decision: "allow" };
  if (hook.permissionDecision === "deny")
    return { decision: "deny", reason: hook.permissionDecisionReason };
  if (hook.permissionDecision === "ask")
    return {
      decision: "ask",
      reason: hook.permissionDecisionReason,
      ...(hook.updatedInput?.command
        ? { overwrite: { CommandLine: hook.updatedInput.command } }
        : {}),
    };
  if (hook.updatedInput?.command)
    return {
      decision: "allow",
      overwrite: { CommandLine: hook.updatedInput.command },
    };
  return { decision: "allow" };
}

export function antigravityFailure() {
  return { ...FAILURE };
}
