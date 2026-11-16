#!/usr/bin/env node
import path from 'node:path';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { itemId, canonicalUrl, fileName } from '../lib/ids.mjs';
import { genVocab, checkVocab, termUsage, vocabWarnings, refValue, newCandidateLines } from '../lib/vocab.mjs';
import { checkRefs, findEntity, loadConfig } from '../lib/entities.mjs';
import { checkIds, checkSegments, checkCapturedText, checkLeftovers } from '../lib/checks.mjs';
import { runTag } from '../lib/tag.mjs';
import { buildCatalog, runIndex, missingQmdEnv, MODE_NAMES } from '../lib/search.mjs';
import { runEval, renderReport } from '../lib/eval.mjs';
import { renameTerm } from '../lib/rename.mjs';
import { digest } from '../lib/digest.mjs';
import { classify, pickType } from '../lib/classify.mjs';
import { importNotion, loadOverrides } from '../lib/notion.mjs';
import { findDuplicates, renderDuplicates } from '../lib/dupes.mjs';
import { splitFindings, taggedItems } from '../lib/migration.mjs';
import { mdHeader, regen } from '../lib/generated.mjs';
import { runFetch, fetchReport } from '../lib/fetch.mjs';
import { findItem, parseLinks, addBatch, ingestBrowser, lineFor, finishAdd } from '../lib/add.mjs';
import { research, parseResearchArgs } from '../lib/research.mjs';
import { checkLinks, renderLinks } from '../lib/links.mjs';
import { toolsMissingLinks, fillToolLinks } from '../lib/toollinks.mjs';
import { serve } from '../lib/mcp.mjs';

const argv = process.argv.slice(2);
const rootIdx = argv.indexOf('--root');
const root = path.resolve(rootIdx >= 0 ? argv.splice(rootIdx, 2)[1] : process.cwd());
const [cmd, ...args] = argv;

// qmd commands: re-run with kb.config.yaml qmd-env in the starting environment (see missingQmdEnv).
if (['index', 'eval', 'research', 'mcp'].includes(cmd)) {
  const env = missingQmdEnv(root);
  if (Object.keys(env).length) {
    const r = spawnSync(process.execPath, [...process.execArgv, ...process.argv.slice(1)], { stdio: 'inherit', env: { ...process.env, ...env } });
    process.exit(r.status ?? 1);
  }
}

const STUBS = ['capture', 'apply-patch', 'build-site'];

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
  if (!loadConfig(root).migration) {
    const r = spawnSync(process.execPath, [manniBin(), 'meta', 'validate', '--quiet', '--allow-empty'], { cwd: root, stdio: 'inherit' });
    return r.status ?? 1;
  }
  // Migration mode (§0.9): tag-field errors on untagged items become warnings; everything else still fails.
  const r = spawnSync(process.execPath, [manniBin(), 'meta', 'validate', '--allow-empty', '-f', 'json'], { cwd: root, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  let out;
  try { out = JSON.parse(r.stdout); } catch { process.stderr.write(r.stdout + r.stderr); return 1; }
  const { errors, warnings } = splitFindings(out.results, taggedItems(root));
  const files = new Set(warnings.map((w) => w.file));
  if (warnings.length) console.warn(`manni: warning: migration mode: ${warnings.length} tag-field finding(s) on ${files.size} untagged item(s) (Phase 6 fills them)`);
  for (const e of errors) console.error(`  ${e.file}:${e.line ?? 1}: ${e.message}  [${e.schema}]`);
  console.log(errors.length ? `manni: ${errors.length} error(s)` : `manni: ok (${out.summary.files} files)`);
  return errors.length ? 1 : 0;
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
      // --new-only [--since <rev>] (kb-add): only candidates created or brought to two items since <rev> (default HEAD~1, plus uncommitted changes).
      if (args.includes('--new-only')) {
        const i = args.indexOf('--since');
        const since = i >= 0 ? args[i + 1] : 'HEAD~1';
        const git = (a) => spawnSync('git', a, { cwd: root, encoding: 'utf8' });
        const diff = git(['diff', '--name-status', '--no-renames', since, '--', 'concepts', 'items']);
        if (diff.status !== 0) { console.error(`term-usage: git diff against ${since} failed: ${diff.stderr.trim()}`); return 1; }
        const untracked = git(['ls-files', '--others', '--exclude-standard', '--', 'concepts', 'items']).stdout.split('\n').filter(Boolean);
        const rows = diff.stdout.split('\n').filter(Boolean).map((l) => l.split('\t'));
        const added = new Set([...rows.filter(([s]) => s === 'A').map(([, f]) => f), ...untracked].filter((f) => f.startsWith('concepts/')));
        const changed = new Set([...rows.filter(([s]) => s !== 'D').map(([, f]) => f), ...untracked].filter((f) => f.startsWith('items/')));
        for (const l of newCandidateLines(termUsage(root), { added, changed })) console.log(l);
        return 0;
      }
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
      fs.writeFileSync(out, mdHeader('kb entity-duplicates') + renderDuplicates(pairs));
      console.log(`entity-duplicates: ${pairs.length} candidate pair(s) → ${path.relative(root, out)}`);
      return 0;
    }
    case 'digest': {
      const out = path.join(root, args[0] ?? 'migration/content-digest.md');
      const r = digest(root);
      fs.mkdirSync(path.dirname(out), { recursive: true });
      fs.writeFileSync(out, mdHeader('kb digest') + r.text);
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
      fs.writeFileSync(out, mdHeader('kb fetch') + rep.text);
      console.log(`${cmd}: ${r.planned} item(s) ${JSON.stringify(r.counts)}; ${rep.failed} extraction-failed, ${rep.missing} missing capture → ${path.relative(root, out)}`);
      return rep.missing ? 1 : 0;
    }
    case 'regen': {
      // §0.9: regenerate deterministic generated files; --check fails if any committed one would change.
      const check = args.includes('--check');
      const changed = regen(root, { check });
      if (check) return report('regen --check', changed.map((f) => `${f}: out of date (run kb regen and commit)`));
      console.log(`regen: ${changed.length} file(s) updated${changed.length ? `: ${changed.join(', ')}` : ''}`);
      return 0;
    }
    case 'tag': {
      // Phase 6: one headless Sonnet call per item; resumable (items with a provenance record are skipped unless --redo).
      const opt = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : undefined; };
      const files = opt('--files')?.split(',').filter(Boolean);
      const r = await runTag(root, { batch: Number(opt('--batch') ?? 15), redo: args.includes('--redo'), files, parallel: Number(opt('--parallel') ?? 1),
        onItem: (x) => console.log(`${x.status}	${x.file}${x.review?.length ? `	${x.review.join('; ')}` : ''}${x.errors ? `	${x.errors.slice(0, 3).join(' | ')}` : ''}`) });
      const changed = regen(root);
      const n = (s) => r.results.filter((x) => x.status === s).length;
      const cost = r.results.reduce((a, x) => a + (x.cost ?? 0), 0);
      console.log(`tag: ${r.planned} item(s): ${n('ok')} ok, ${n('review')} queued for review, ${n('failed')} failed; ${r.remaining} untagged left; ~US$${cost.toFixed(2)} at list price (subscription)${changed.length ? `; regenerated ${changed.join(', ')}` : ''}`);
      return n('failed') ? 1 : 0;
    }
    case 'build-catalog': console.log(`build-catalog: ${buildCatalog(root)} items → catalog.jsonl`); return 0;
    case 'index': {
      // Phase 7: catalog + qmd collections/contexts + update + embed. --index <name> picks a qmd named index.
      const opt = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : undefined; };
      await runIndex(root, { index: opt('--index'), embed: !args.includes('--no-embed'), log: (m) => console.log(`index: ${m}`) });
      return 0;
    }
    case 'eval': {
      // Phase 9: recall@k of golden must items per retrieval mode; writes evals/report.md (or --out).
      // --explain adds, for questions scoring 0, matched terms and each missed item's facets and list ranks.
      const opt = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : undefined; };
      const modes = (opt('--modes') ?? MODE_NAMES.join(',')).split(',');
      const res = await runEval(root, { modes, k: Number(opt('--k') ?? 10), selfTest: args.includes('--self-test'), explain: args.includes('--explain'), index: opt('--index'), log: args.includes('--verbose') ? console.log : () => {} });
      const out = path.resolve(root, opt('--out') ?? 'evals/report.md');
      fs.mkdirSync(path.dirname(out), { recursive: true });
      fs.writeFileSync(out, renderReport(res, { label: opt('--label') ?? '' }));
      if (opt('--json')) fs.writeFileSync(path.resolve(root, opt('--json')), JSON.stringify(res, null, 1));
      for (const [m, x] of Object.entries(res.modes)) console.log(`eval: ${m}: recall@${res.k} ${(x.recall * 100).toFixed(0)}%, ${(x.msMean / 1000).toFixed(1)} s/query (model load ${(x.warmupMs / 1000).toFixed(1)} s)`);
      if (res.selfTest) console.log(`eval: self-test ${(res.selfTest.top5 * 100).toFixed(0)}% top-5 of ${res.selfTest.questions}`);
      if (res.missing.length) console.log(`eval: left out (no item file): ${res.missing.join(', ')}`);
      console.log(`eval: report → ${path.relative(root, out)}`);
      return 0;
    }
    case 'tools-missing-links': {
      // Tool files without a resource (items listing the tool, file).
      const rows = toolsMissingLinks(root);
      for (const r of rows) console.log(`${r.items}\t${r.slug}\t${r.title}\t${r.file}`);
      console.error(`tools-missing-links: ${rows.length} tool file(s) without a resource`);
      return 0;
    }
    case 'fill-tool-links': {
      // Link every "Tools mentioned" line whose tool file has a resource.
      const r = fillToolLinks(root);
      console.log(`fill-tool-links: ${r.lines} line(s) linked in ${r.files} item(s)`);
      return 0;
    }
    case 'cursor-skills': {
      // Cursor loads Agent Skills from .cursor/skills/ (not from Claude plugins): copy the kit's skills there (git-ignored; run on install).
      const src = fileURLToPath(new URL('../skills', import.meta.url));
      const dest = path.join(root, '.cursor', 'skills');
      const names = fs.readdirSync(src).filter((n) => fs.existsSync(path.join(src, n, 'SKILL.md')));
      for (const n of names) { fs.rmSync(path.join(dest, n), { recursive: true, force: true }); fs.cpSync(path.join(src, n), path.join(dest, n), { recursive: true }); }
      console.log(`cursor-skills: ${names.join(', ')} → ${path.relative(root, dest)}`);
      return 0;
    }
    case 'check-links': {
      // kb-maintain, on demand: dead or moved item resources → evals/dead-links.md.
      const r = await checkLinks(root, { log: args.includes('--verbose') ? console.log : () => {} });
      const out = path.join(root, 'evals', 'dead-links.md');
      fs.mkdirSync(path.dirname(out), { recursive: true });
      fs.writeFileSync(out, mdHeader('kb check-links') + renderLinks(root, r));
      console.log(`check-links: ${r.checked} checked, ${r.dead.length} dead, ${r.moved.length} moved → ${path.relative(root, out)}`);
      return 0;
    }
    case 'find': {
      // kb-add step 1: the existing item for an id or URL (exit 1 when none).
      const r = findItem(root, args[0]);
      console.log(r.file ? `${r.id}	${r.file}	${r.type}	${r.title}` : `${r.id}	not found`);
      return r.file ? 0 : 1;
    }
    case 'add':
    case 'add-batch': {
      // Phase 10 kb-add: web and YouTube links, each tagged in its own headless call; then validate, commit, index.
      const links = parseLinks(args.filter((a) => !['--no-commit', '--no-index'].includes(a)));
      if (!links.length) { console.error('Usage: kb add-batch <url> [--note "…"] [--bookmark] [--type t] [--best] [--shared-in id] …'); return 2; }
      const r = await addBatch(root, links, { commit: !args.includes('--no-commit'), index: !args.includes('--no-index') });
      const cost = r.results.reduce((a, x) => a + (x.cost ?? 0), 0);
      console.log(`add-batch: ${r.results.filter((x) => x.status === 'added').length}/${links.length} added; validate ${r.validate ?? '-'}, commit ${r.commit ?? '-'}, index ${r.index ?? '-'}; ~US$${cost.toFixed(2)} at list price (subscription)`);
      return r.validate === 'failed' || r.results.some((x) => x.status === 'error') ? 1 : 0;
    }
    case 'ingest-browser': {
      // Slack/LinkedIn: a browser download in migration/inbox/ → verbatim item (--refresh appends new replies).
      const opt = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : undefined; };
      const r = await ingestBrowser(root, path.resolve(root, args[0]), { note: opt('--note'), refresh: args.includes('--refresh') });
      console.log(r.status === 'added' || r.status === 'exists' ? lineFor({ url: '', ...r }) : `${r.status}: ${r.file}${r.appended ? ` (+${r.appended} message(s))` : ''}`);
      for (const n of r.notes ?? []) if (r.status !== 'added') console.log(`  ${n}`);
      if (r.links?.length) console.log(`Shared links (ask which to save):\n${r.links.map((u) => `  ${u}`).join('\n')}`);
      if (['added', 'refreshed'].includes(r.status) && !args.includes('--no-finish')) {
        const f = finishAdd(root, [r], { commit: !args.includes('--no-commit'), index: !args.includes('--no-index') });
        console.log(`ingest-browser: validate ${f.validate}, commit ${f.commit ?? '-'}, index ${f.index ?? '-'}`);
        return f.validate === 'ok' ? 0 : 1;
      }
      return 0;
    }
    case 'research': {
      // Phase 10 kb-research: fast mode (catalog weight 1.5) + facet filters → JSON for the skill.
      const { question, opts } = parseResearchArgs(args);
      if (!question) { console.error('Usage: kb research "<question>" [--k 12] [--knowledge-types a,b] [--type t] [--tools s] [--genre g] [--event e] [--example-of x] [--doc-types d] [--org-contexts o] [--organizations o] [--lifecycle-stages l] [--first-hand] [--best] [--sort published|best] [--strict]'); return 2; }
      console.log(JSON.stringify(await research(root, question, opts), null, 1));
      return 0;
    }
    case 'mcp': {
      // Phase 10 Claude desktop: stdio MCP server with kb_research and kb_get.
      const { version } = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
      await serve(root, { version });
      return 0;
    }
    case 'rename-term': console.log(`rename-term: ${renameTerm(root, args[0], args[1])} file(s) changed`); return 0;
    case 'validate': {
      let bad = 0;
      genVocab(root);
      for (const [n, f] of [['check-vocab', checkVocab], ['__manni', null], ['check-refs', checkRefs], ['check-ids', checkIds], ['check-segments', checkSegments], ['check-captured-text', checkCapturedText], ['check-leftovers', checkLeftovers]]) {
        if (!f) { console.log('manni meta validate'); bad |= runManni(); } else bad |= report(n, f(root));
        if (n === 'check-vocab') warn(n, vocabWarnings(root));
      }
      return bad ? 1 : 0;
    }
    default:
      if (STUBS.includes(cmd)) { console.error(`kb ${cmd}: not implemented yet (later phase)`); return 2; }
      console.error(`Usage: kb <command> [--root dir]\nCommands: id canonical slug classify find add-batch ingest-browser research mcp check-links cursor-skills tools-missing-links fill-tool-links import-notion fetch fetch-bookmark tag build-catalog index eval regen entity-duplicates digest gen-vocab check-vocab term-usage check-refs check-ids check-segments check-captured-text find-entity rename-term validate\nLater: ${STUBS.join(' ')}`);
      return cmd ? 2 : 0;
  }
}

process.exitCode = await main();
