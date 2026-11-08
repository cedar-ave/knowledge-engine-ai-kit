// Fails if samples/ or test/ contain a Slack workspace or LinkedIn activity ID that is not on the fictional allowlist (0.3).
import fs from 'node:fs';
import path from 'node:path';

const SLACK_WORKSPACES = new Set(['example-workspace']);
const LINKEDIN_IDS = new Set(['7000000000000000001', '7000000000000000002']);

const checks = [
  // https://<workspace>.slack.com/...
  [/\b([a-z0-9-]+)\.slack\.com/gi, (m) => SLACK_WORKSPACES.has(m[1].toLowerCase()), 'Slack workspace'],
  // slack:<workspace>:<channel>:<ts> item IDs
  [/\bslack:([a-z0-9-]+):/gi, (m) => SLACK_WORKSPACES.has(m[1].toLowerCase()), 'Slack workspace (item id)'],
  // LinkedIn activity / share / ugcPost IDs, and li:<id> item IDs
  [/(?:activity[:-]|share[:-]|ugcPost[:-]|\bli:)(\d{19})/g, (m) => LINKEDIN_IDS.has(m[1]), 'LinkedIn ID'],
];

const problems = [];
const walk = (d) => {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) { if (e.name !== 'node_modules') walk(p); continue; }
    const text = fs.readFileSync(p, 'utf8');
    for (const [re, ok, label] of checks) {
      for (const m of text.matchAll(re)) if (!ok(m)) problems.push(`${p}: ${label} "${m[1]}" is not on the allowlist`);
    }
  }
};
for (const dir of ['samples', 'test']) if (fs.existsSync(dir)) walk(dir);

if (problems.length) {
  console.error(`Leak check failed:\n${[...new Set(problems)].map((p) => `  ${p}`).join('\n')}`);
  process.exit(1);
}
console.log('leak check: ok');
