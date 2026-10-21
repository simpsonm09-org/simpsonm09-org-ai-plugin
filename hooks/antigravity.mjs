#!/usr/bin/env node
import { antigravityFailure, handleAntigravity } from "./lib/antigravity.mjs";

try {
  let text = "";
  for await (const chunk of process.stdin) text += chunk;
  const input = JSON.parse(text);
  const result = await handleAntigravity(input);
  if (result) process.stdout.write(`${JSON.stringify(result)}\n`);
} catch {
  process.stdout.write(`${JSON.stringify(antigravityFailure())}\n`);
}
