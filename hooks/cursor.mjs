#!/usr/bin/env node
import { cursorFailure, handleCursor } from "./lib/cursor.mjs";

try {
  let text = "";
  for await (const chunk of process.stdin) text += chunk;
  const input = JSON.parse(text);
  process.stdout.write(`${JSON.stringify(await handleCursor(input))}\n`);
} catch {
  process.stdout.write(`${JSON.stringify(cursorFailure())}\n`);
}
