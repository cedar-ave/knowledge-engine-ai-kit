// Fails if any file under samples/ contains a real Slack or LinkedIn feed URL (0.3: no real content in the public kit).
import fs from 'node:fs';
import path from 'node:path';

const BAD = /slack\.com|linkedin\.com\/feed/i;
const hits = [];
const walk = (d) => {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p);
    else if (BAD.test(fs.readFileSync(p, 'utf8'))) hits.push(p);
  }
};
walk('samples');
if (hits.length) {
  console.error(`Leak check failed. Real Slack/LinkedIn URLs found in:\n${hits.map((h) => `  ${h}`).join('\n')}`);
  process.exit(1);
}
console.log('leak check: ok');
