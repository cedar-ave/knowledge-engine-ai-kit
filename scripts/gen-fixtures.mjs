// Writes three small saved sample pages (fictional) used by the article extraction tests.
import fs from 'node:fs';

const pages = [
  ['Gating Builds on Docs Drift', 'We compare the API spec against the reference pages on every pull request. A mismatch fails the build.'],
  ['Writing Release Notes People Read', 'Lead with what changed for the reader. Group by impact, not by team. Link to the upgrade guide.'],
  ['Owning Docs Reviews', 'Every docs page needs an owner. Reviews without owners stall, so assign a reviewer when the change opens.'],
];
fs.mkdirSync('test/fixtures', { recursive: true });
pages.forEach(([title, lead], i) => {
  const n = i + 1;
  const filler = 'This fictional page exists to test extraction. It has enough text for the reader algorithm to treat it as the main content of the page, including a second paragraph that continues the idea at some length so scoring succeeds.';
  const more = 'More fictional detail follows here, again long enough to count as real content for the extraction heuristics used by the library under test.';
  fs.writeFileSync(`test/fixtures/article${n}.html`,
    `<!doctype html><html><head><title>${title} | Sample Blog</title>\n<meta property="article:published_time" content="2026-0${n}-0${n}">\n</head><body><nav><a href="/">Home</a></nav><article><h1>${title}</h1><p>${lead}</p><p>${filler}</p><h2>Details</h2><p>${more}</p></article><footer>Footer links</footer></body></html>\n`);
});
