// Phase 9: recall@k of golden `must` items for each retrieval mode, time per query,
// and the sample-questions self-test (smoke test only).
import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { loadCatalog, openRetriever } from './search.mjs';
import { asList } from './entities.mjs';
import { mdHeader } from './generated.mjs';

export function loadGolden(root) {
  return YAML.parse(fs.readFileSync(path.join(root, 'evals', 'golden-questions.yaml'), 'utf8'));
}

const median = (xs) => { const s = [...xs].sort((a, b) => a - b); return s.length ? (s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : 0; };
const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

/** Run the golden questions (and optionally the self-test) for each mode. Returns a JSON-able result. */
export async function runEval(root, { modes = ['fast', 'query'], k = 10, selfTest = false, selfTestMode = 'fast', index, log = () => {} } = {}) {
  const golden = loadGolden(root);
  const catalog = loadCatalog(root);
  const ids = new Set(catalog.map((c) => c.id));
  const title = new Map(catalog.map((c) => [c.id, c.title]));
  const missing = [...new Set(golden.questions.flatMap((q) => asList(q.must)).filter((id) => !ids.has(id)))];
  const r = await openRetriever(root, { index });
  const out = { k, items: catalog.length, tagged: catalog.filter((c) => c['sample-questions']).length, missing, modes: {} };
  try {
    for (const mode of modes) {
      // Warm-up query loads the models once; its time is reported separately.
      const warm = await r.retrieve(mode, golden.questions[0].question, k);
      const rows = [];
      for (const q of golden.questions) {
        const must = asList(q.must).filter((id) => ids.has(id));
        if (!must.length) continue;
        const { ids: top, ms } = await r.retrieve(mode, q.question, k);
        const hit = must.filter((id) => top.includes(id));
        rows.push({ id: q.id, question: q.question, gap: !!q.gap, must: must.length, hits: hit.length, recall: hit.length / must.length, ms, missed: must.filter((id) => !top.includes(id)), top });
        log(`${mode} ${q.id} recall ${hit.length}/${must.length} ${(ms / 1000).toFixed(1)} s`);
      }
      out.modes[mode] = { recall: mean(rows.map((x) => x.recall)), msMean: mean(rows.map((x) => x.ms)), msMedian: median(rows.map((x) => x.ms)), warmupMs: warm.ms, questions: rows };
    }
    if (selfTest) {
      let n = 0; let ok = 0; const fails = [];
      for (const c of catalog) {
        for (const sq of asList(c['sample-questions'])) {
          n++;
          const { ids: top } = await r.retrieve(selfTestMode, sq, 5);
          if (top.includes(c.id)) ok++; else fails.push({ id: c.id, question: sq });
        }
      }
      out.selfTest = { mode: selfTestMode, questions: n, top5: n ? ok / n : 0, fails };
      log(`self-test ${ok}/${n}`);
    }
  } finally { await r.close(); }
  out.title = Object.fromEntries([...title].filter(([id]) => Object.values(out.modes).some((m) => m.questions.some((q) => q.missed.includes(id)))));
  return out;
}

export function renderReport(res, { label = '' } = {}) {
  const pct = (x) => `${(x * 100).toFixed(0)}%`;
  const sec = (ms) => `${(ms / 1000).toFixed(1)} s`;
  const modes = Object.keys(res.modes);
  const L = [`# Eval report${label ? `: ${label}` : ''}`, '',
    `${res.items} items indexed (${res.tagged} tagged). recall@${res.k} over golden \`must\` items, macro-averaged across questions.`, ''];
  if (res.missing.length) L.push(`Left out (no item file): ${res.missing.map((m) => `\`${m}\``).join(', ')}`, '');
  L.push('| Mode | recall@' + res.k + ' | mean time/query | median | model load (first query) |', '|---|---|---|---|---|');
  for (const m of modes) { const x = res.modes[m]; L.push(`| ${m} | ${pct(x.recall)} | ${sec(x.msMean)} | ${sec(x.msMedian)} | ${sec(x.warmupMs)} |`); }
  if (modes.length > 1) {
    const [a, b] = modes.map((m) => res.modes[m]);
    const faster = a.msMean <= b.msMean ? modes[0] : modes[1];
    const slower = faster === modes[0] ? modes[1] : modes[0];
    const gain = res.modes[slower].recall - res.modes[faster].recall;
    L.push('', `Recommendation: **${gain >= 0.05 ? slower : faster}**. ${slower} is ${pct(Math.abs(gain))} ${gain >= 0 ? 'better' : 'worse'} on recall and ${(res.modes[slower].msMean / Math.max(res.modes[faster].msMean, 1)).toFixed(1)}× slower; the plan keeps the faster mode unless the slower one clearly improves recall (threshold used: 5 points).`);
  }
  L.push('', '## Per question', '', `| Q | ${modes.map((m) => `${m} recall`).join(' | ')} | Question |`, `|---|${modes.map(() => '---').join('|')}|---|`);
  for (const q of res.modes[modes[0]].questions) {
    L.push(`| ${q.id}${q.gap ? ' (gap)' : ''} | ${modes.map((m) => { const x = res.modes[m].questions.find((y) => y.id === q.id); return `${x.hits}/${x.must}`; }).join(' | ')} | ${q.question} |`);
  }
  L.push('', '## Misses', '');
  for (const m of modes) {
    L.push(`### ${m}`, '');
    for (const q of res.modes[m].questions.filter((x) => x.missed.length)) {
      L.push(`- **${q.id}** ${q.question}`);
      for (const id of q.missed) L.push(`  - \`${id}\` ${res.title[id] ?? ''}`);
    }
    L.push('');
  }
  if (res.selfTest) {
    const s = res.selfTest;
    L.push('## Sample-questions self-test (smoke test only)', '', `${s.mode} mode: ${pct(s.top5)} of ${s.questions} sample questions return their own item in the top 5. The same model wrote the questions and the tags, so this proves little.`, '');
    for (const f of s.fails.slice(0, 30)) L.push(`- \`${f.id}\`: ${f.question}`);
    if (s.fails.length > 30) L.push(`- … ${s.fails.length - 30} more`);
  }
  return mdHeader('kb eval') + L.join('\n') + '\n';
}
