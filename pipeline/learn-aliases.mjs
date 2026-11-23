#!/usr/bin/env node
// Collect the GitHub account behind each commit email that GitHub knows about, from the data
// alltime.mjs saved, so analyze2.py can credit commits made with a non-GitHub email.
// Emails are written hashed (sha256 of the lowercased email), the same way aliases_hashed.json is.
//
// Usage: node pipeline/learn-aliases.mjs <alltime cache dir> <output json>
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const [cache, out] = process.argv.slice(2);
if (!cache || !out) {
  console.error('usage: node learn-aliases.mjs <cache dir> <output.json>');
  process.exit(2);
}
const dir = join(cache, 'api');
const learned = {};
if (existsSync(dir)) {
  for (const f of readdirSync(dir).filter((f) => f.endsWith('.json'))) {
    const store = JSON.parse(readFileSync(join(dir, f), 'utf8'));
    for (const c of Object.values(store.commits || {})) {
      const email = String(c.ae || '').trim().toLowerCase();
      if (!email || !c.a || email.endsWith('@users.noreply.github.com')) continue;
      learned[createHash('sha256').update(email).digest('hex')] = c.a;
    }
  }
}
writeFileSync(out, JSON.stringify(learned, null, 0));
console.log(`${Object.keys(learned).length} commit emails tied to GitHub accounts`);
