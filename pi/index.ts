// The Pi coding agent extension. Pi loads it from the package's "pi" manifest (package.json) and
// calls the default export with its extension API. The entry registers one handler, for
// tool_call. The gate is hooks/lib/pi.mjs, which decides with the shared gate (gate.mjs).
//
// The API is described by the local types below rather than imported from Pi, so this file adds
// no package dependency. Only the members the gate uses are described.

import { gateToolCall } from "../hooks/lib/pi.mjs";

// The tool_call event: the tool's name, and its arguments. A bash call carries command in input.
export interface ToolCallEvent {
  toolName: string;
  input: { command?: unknown; [key: string]: unknown };
}

// The context Pi passes with the event. ui.confirm asks the person, when the session has a UI.
export interface ToolCallContext {
  cwd?: string;
  hasUI?: boolean;
  ui?: { confirm?: (title: string, message: string) => Promise<boolean> };
}

// A block stops the call and shows its reason. Nothing returned lets the call run.
export type ToolCallResult = { block: true; reason: string } | undefined;

export interface ExtensionAPI {
  on(
    event: "tool_call",
    handler: (
      event: ToolCallEvent,
      ctx: ToolCallContext,
    ) => Promise<ToolCallResult>,
  ): unknown;
}

export interface GateOptions {
  workspaceRoot?: string;
}

// Register the gate on an extension API. Pi calls the default export, which uses the workspace
// this plugin is installed in. A test passes options.workspaceRoot to point the gate at a fixture.
export function install(pi: ExtensionAPI, options: GateOptions = {}): void {
  pi.on("tool_call", (event, ctx) => gateToolCall(event, ctx, options));
}

export default function agentAccessGate(pi: ExtensionAPI): void {
  install(pi);
}
