#!/usr/bin/env node
import path from 'node:path';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { itemId, canonicalUrl, fileName } from '../lib/ids.mjs';
import { genVocab, checkVocab } from '../lib/vocab.mjs';
import { checkRefs, findEntity, loadConfig } from '../lib/entities.mjs';
import { checkIds, checkSegments, checkCapturedText } from '../lib/checks.mjs';
import { renameTerm } from '../lib/rename.mjs';

const argv = process.argv.slice(2);
const rootIdx = argv.indexOf('--root');
const root = path.resolve(rootIdx >= 0 ? argv.splice(rootIdx, 2)[1] : process.cwd());
const [cmd, ...args] = argv;

const STUBS = ['classify', 'fetch', 'capture', 'tag', 'apply-patch', 'index', 'export-notion', 'build-site'];

function report(name, errs) {
  if (errs.length) {
    console.error(`${name}: ${errs.length} problem(s)`);
    for (const e of errs) console.error(`  ${e}`);
    return 1;
  }
  console.log(`${name}: ok`);
  return 0;
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
    case 'gen-vocab': { const r = genVocab(root); console.log(`gen-vocab: ${r.terms} approved terms`); return 0; }
    case 'check-vocab': return report(cmd, checkVocab(root));
    case 'check-refs': return report(cmd, checkRefs(root));
    case 'check-ids': return report(cmd, checkIds(root));
    case 'check-segments': return report(cmd, checkSegments(root));
    case 'check-captured-text': return report(cmd, checkCapturedText(root));
    case 'find-entity': {
      const hits = findEntity(root, args.join(' '));
      for (const h of hits) console.log(`${h.dir}/${h.slug}\t${h.title}`);
      return hits.length ? 0 : 1;
    }
    case 'rename-term': console.log(`rename-term: ${renameTerm(root, args[0], args[1])} file(s) changed`); return 0;
    case 'validate': {
      let bad = 0;
      genVocab(root);
      for (const [n, f] of [['check-vocab', checkVocab], ['__manni', null], ['check-refs', checkRefs], ['check-ids', checkIds], ['check-segments', checkSegments], ['check-captured-text', checkCapturedText]]) {
        if (!f) { console.log('manni meta validate'); bad |= runManni(); } else bad |= report(n, f(root));
      }
      return bad ? 1 : 0;
    }
    default:
      if (STUBS.includes(cmd)) { console.error(`kb ${cmd}: not implemented yet (later phase)`); return 2; }
      console.error(`Usage: kb <command> [--root dir]\nCommands: id canonical slug gen-vocab check-vocab check-refs check-ids check-segments check-captured-text find-entity rename-term validate\nLater: ${STUBS.join(' ')}`);
      return cmd ? 2 : 0;
  }
}

process.exitCode = await main();
