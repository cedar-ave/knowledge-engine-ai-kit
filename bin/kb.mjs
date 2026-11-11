#!/usr/bin/env node
import path from 'node:path';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { itemId, canonicalUrl, fileName } from '../lib/ids.mjs';
import { genVocab, checkVocab, termUsage, vocabWarnings, refValue } from '../lib/vocab.mjs';
import { checkRefs, findEntity, loadConfig } from '../lib/entities.mjs';
import { checkIds, checkSegments, checkCapturedText } from '../lib/checks.mjs';
import { renameTerm } from '../lib/rename.mjs';
import { digest } from '../lib/digest.mjs';
import { classify, pickType } from '../lib/classify.mjs';
import { importNotion, loadOverrides } from '../lib/notion.mjs';
import { findDuplicates, renderDuplicates } from '../lib/dupes.mjs';
import { runFetch, fetchReport } from '../lib/fetch.mjs';

const argv = process.argv.slice(2);
const rootIdx = argv.indexOf('--root');
const root = path.resolve(rootIdx >= 0 ? argv.splice(rootIdx, 2)[1] : process.cwd());
const [cmd, ...args] = argv;

const STUBS = ['capture', 'tag', 'apply-patch', 'index', 'build-site'];

function report(name, errs) {
  if (errs.length) {
    console.error(`${name}: ${errs.length} problem(s)`);
    for (const e of errs) console.error(`  ${e}`);
    return 1;
  }
  console.log(`${name}: ok`);
  return 0;
}

function warn(name, warnings) {
  for (const w of warnings) console.warn(`${name}: warning: ${w}`);
}

function manniBin() {
  for (const req of [createRequire(path.join(root, 'package.json')), createRequire(import.meta.url)]) {
    try {
      const pkg = req.resolve('@hawkeyexl/manni/package.json');
      return path.join(path.dirname(pkg), JSON.parse(fs.readFileSync(pkg, 'utf8')).bin.manni);
    } catch { /* try next */ }
  }
  throw new Error('@hawkeyexl/manni is not installed');
}

function runManni() {
  const r = spawnSync(process.execPath, [manniBin(), 'meta', 'validate', '--quiet', '--allow-empty'], { cwd: root, stdio: 'inherit' });
  return r.status ?? 1;
}

async function main() {
  switch (cmd) {
    case 'id': {
      const cfg = loadConfig(root);
      const teams = Object.fromEntries((cfg['slack-workspaces'] ?? []).map((w) => [w['team-id'], w.subdomain]));
      console.log(itemId(args[0], { slackTeams: teams }));
      return 0;
    }
    case 'canonical': console.log(canonicalUrl(args[0])); return 0;
    case 'slug': console.log(fileName(args[0], args.slice(1).join(' '))); return 0;
    case 'gen-vocab': { const r = genVocab(root); console.log(`gen-vocab: ${r.terms} terms (${r.approved} approved, ${r.candidate} candidate)`); return 0; }
    case 'check-vocab': { const code = report(cmd, checkVocab(root)); warn(cmd, vocabWarnings(root)); return code; }
    case 'term-usage': {
      // Candidates with item counts (literary warrant); --all lists every term.
      const rows = termUsage(root).filter((u) => args.includes('--all') || u.term.status === 'candidate')
        .sort((a, b) => b.items.length - a.items.length || a.term.scheme.localeCompare(b.term.scheme) || refValue(a.term).localeCompare(refValue(b.term)));
      for (const u of rows) console.log(`${u.items.length}	${u.term.status}	${u.term.scheme}	${refValue(u.term)}`);
      return 0;
    }
    case 'check-refs': return report(cmd, checkRefs(root));
    case 'check-ids': return report(cmd, checkIds(root));
    case 'check-segments': return report(cmd, checkSegments(root));
    case 'check-captured-text': return report(cmd, checkCapturedText(root));
    case 'find-entity': {
      const hits = findEntity(root, args.join(' '));
      for (const h of hits) console.log(`${h.dir}/${h.slug}\t${h.title}`);
      return hits.length ? 0 : 1;
    }
    case 'classify': {
      const c = classify(args[0]);
      console.log(JSON.stringify({ ...c, pick: pickType(args[0], c).type }));
      return 0;
    }
    case 'import-notion': {
      const exportDir = path.resolve(root, args.find((a) => !a.startsWith('--')) ?? 'migration/notion-export');
      const ov = path.join(root, 'migration', 'import-overrides.yaml');
      const r = await importNotion(root, { exportDir, overrides: loadOverrides(ov), force: args.includes('--force') });
      console.log(`import-notion: ${r.rows} rows → ${Object.values(r.byType).reduce((a, b) => a + b, 0)} items, ${r.toolPages} tool pages; entities ${JSON.stringify(r.entCount)}
See migration/import-report.md`);
      return 0;
    }
    case 'entity-duplicates': {
      const pairs = findDuplicates(root);
      const out = path.join(root, args[0] ?? 'migration/entity-duplicates.md');
      fs.mkdirSync(path.dirname(out), { recursive: true });
      fs.writeFileSync(out, renderDuplicates(pairs, new Date().toLocaleDateString('en-CA', { timeZone: loadConfig(root).timezone ?? 'UTC' })));
      console.log(`entity-duplicates: ${pairs.length} candidate pair(s) → ${path.relative(root, out)}`);
      return 0;
    }
    case 'digest': {
      const out = path.join(root, args[0] ?? 'migration/content-digest.md');
      const r = digest(root);
      fs.mkdirSync(path.dirname(out), { recursive: true });
      fs.writeFileSync(out, r.text);
      console.log(`digest: ${r.count} items → ${path.relative(root, out)}`);
      return 0;
    }
    case 'fetch':
    case 'fetch-bookmark': {
      // Resumable: state lives in the item files and migration/bookmark-inputs/; log in migration/fetch-log.jsonl.
      const opt = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : undefined; };
      const only = cmd === 'fetch-bookmark' ? ['bookmark'] : opt('--only')?.split(',');
      const r = await runFetch(root, { only, limit: Number(opt('--limit') ?? Infinity), retryFailed: args.includes('--retry-failed'), recheck: args.includes('--recheck-paywall') });
      const rep = fetchReport(root);
      const out = path.join(root, 'migration', 'fetch-report.md');
      fs.writeFileSync(out, rep.text);
      console.log(`${cmd}: ${r.planned} item(s) ${JSON.stringify(r.counts)}; ${rep.failed} extraction-failed, ${rep.missing} missing capture → ${path.relative(root, out)}`);
      return rep.missing ? 1 : 0;
    }
    case 'rename-term': console.log(`rename-term: ${renameTerm(root, args[0], args[1])} file(s) changed`); return 0;
    case 'validate': {
      let bad = 0;
      genVocab(root);
      for (const [n, f] of [['check-vocab', checkVocab], ['__manni', null], ['check-refs', checkRefs], ['check-ids', checkIds], ['check-segments', checkSegments], ['check-captured-text', checkCapturedText]]) {
        if (!f) { console.log('manni meta validate'); bad |= runManni(); } else bad |= report(n, f(root));
        if (n === 'check-vocab') warn(n, vocabWarnings(root));
      }
      return bad ? 1 : 0;
    }
    default:
      if (STUBS.includes(cmd)) { console.error(`kb ${cmd}: not implemented yet (later phase)`); return 2; }
      console.error(`Usage: kb <command> [--root dir]\nCommands: id canonical slug classify import-notion fetch fetch-bookmark entity-duplicates digest gen-vocab check-vocab term-usage check-refs check-ids check-segments check-captured-text find-entity rename-term validate\nLater: ${STUBS.join(' ')}`);
      return cmd ? 2 : 0;
  }
}

process.exitCode = await main();
