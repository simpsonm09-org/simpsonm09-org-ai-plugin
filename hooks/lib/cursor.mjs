// Cursor's beforeShellExecution adapter. Cursor runs project hooks from the project root.
import { handlePreToolUse } from "./claude.mjs";

const ERROR_REASON =
  "the Cursor agent-access gate failed internally; the command is blocked";

function shellFor(input, platform = process.platform) {
  if (input.shell === "powershell" || input.shell === "bash")
    return input.shell;
  return platform === "win32" ? "powershell" : "bash";
}

export async function handleCursor(input, options = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw new Error("invalid Cursor hook payload");
  if (input.hook_event_name && input.hook_event_name !== "beforeShellExecution")
    return null;
  if (
    typeof input.command !== "string" ||
    typeof input.cwd !== "string" ||
    !input.cwd
  )
    throw new Error("the Cursor hook payload has no command or cwd");
  const shell = shellFor(input, options.platform);
  const answer = await handlePreToolUse(
    {
      tool_name: shell === "powershell" ? "PowerShell" : "Bash",
      tool_input: { command: input.command },
      cwd: input.cwd,
    },
    {
      workspaceRoot: options.workspaceRoot,
      env: options.env,
      toolShells: true,
    },
  );
  const hook = answer?.hookSpecificOutput;
  if (!hook) return { permission: "allow" };
  const output = { permission: hook.permissionDecision };
  if (hook.permissionDecisionReason)
    output.user_message = hook.permissionDecisionReason;
  if (hook.updatedInput?.command)
    output.updated_input = { command: hook.updatedInput.command };
  return output;
}

export function cursorFailure() {
  return { permission: "deny", user_message: ERROR_REASON };
}
