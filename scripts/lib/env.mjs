// Minimal .env loader — zero deps. Parses `KEY=value` lines into
// process.env; existing environment variables always win (so `DPLA_API_KEY=x
// npm run harvest` overrides a stale .env), and a missing file is a no-op
// (harvest must still run keyless). Not a general dotenv replacement: no
// quoting, no export handling, no multiline values.

import { readFileSync } from 'node:fs';

export function loadEnv(path = '.env') {
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return; // missing file: no-op
  }
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim();
    if (!key) continue;
    if (process.env[key] === undefined) process.env[key] = value;
  }
}
