// Regenerates schema/*.schema.json. Run: node scripts/gen-schemas.mjs
import fs from 'node:fs';

const D = 'https://json-schema.org/draft/2020-12/schema';
const str = { type: 'string', minLength: 1 };
const strList = (min = 0, max) => ({ type: 'array', items: str, uniqueItems: true, ...(min ? { minItems: min } : {}), ...(max ? { maxItems: max } : {}) });
const date = { type: 'string', pattern: '^\\d{4}(-\\d{2}(-\\d{2})?)?$', description: 'W3CDTF: YYYY, YYYY-MM or YYYY-MM-DD' };
const SOURCES = ['blog', 'newsletter', 'podcast', 'channel', 'docs-site', 'portfolio', 'website', 'repo', 'book', 'course'];
const PIECES = ['article', 'episode', 'video', 'talk', 'slide-deck', 'docs-page', 'linkedin-post', 'linkedin-article', 'slack-thread'];
const ENTITY_TYPES = ['tool', 'person', 'organization', 'event', 'series'];

const segment = {
  type: 'object',
  required: ['slug', 'title', 'knowledge-type'],
  properties: {
    slug: str,
    title: str,
    start: { type: 'string', pattern: '^\\d{2}:\\d{2}:\\d{2}$' },
    'knowledge-type': str,
    genre: str,
    concepts: strList(),
    organizations: strList(),
    tools: strList(),
    'first-hand': { type: 'boolean' },
  },
};

const item = {
  $schema: D,
  $id: 'kb:item:1.0.0',
  title: 'Knowledge base item frontmatter',
  description: 'Field shapes only. Allowed values for controlled fields come from the generated schema/vocab.enum.json.',
  type: 'object',
  required: ['id', 'type', 'title', 'description', 'resource', 'captured-on', 'concepts', 'knowledge-types', 'sample-questions', 'capture'],
  properties: {
    id: { type: 'string', pattern: '^(yt|li|slack|web):.+' },
    type: { enum: [...SOURCES, ...PIECES] },
    title: str,
    'title-devised': { type: 'boolean' },
    description: str,
    resource: { type: 'string', format: 'uri' },
    authors: strList(),
    hosts: strList(),
    guests: strList(),
    organizations: strList(),
    publisher: str,
    event: str,
    'slack-workspace': str,
    'slack-channel': { type: 'string', pattern: '^#' },
    published: date,
    'captured-on': date,
    'length-min': { type: 'number', minimum: 0 },
    concepts: strList(1, 6),
    genre: strList(),
    'knowledge-types': strList(1),
    'example-of': strList(1, 5),
    'lifecycle-stages': strList(),
    'org-contexts': strList(),
    'doc-types': strList(),
    tools: strList(0, 8),
    'first-hand': { type: 'boolean' },
    best: { type: 'boolean' },
    note: str,
    'sample-questions': { type: 'array', minItems: 1, maxItems: 5, items: str },
    segments: { type: 'array', minItems: 1, items: segment },
    series: strList(),
    'related-pages': strList(),
    'shared-in': strList(),
    'captured-text-sha256': { type: 'string', pattern: '^[0-9a-f]{64}$' },
    capture: { enum: ['verbatim', 'full-text', 'partial', 'summary-only', 'extraction-failed', 'bookmark'] },
    'part-of': str,
    'last-reviewed': { type: 'string', pattern: "^[0-9]{4}(-(0[1-9]|1[0-2])(-(0[1-9]|[12][0-9]|3[01])(T([01][0-9]|2[0-3]):[0-5][0-9](:[0-5][0-9](\\.[0-9]+)?)?(Z|[+-]([01][0-9]|2[0-3]):[0-5][0-9]))?)?)?$", description: 'Same key and pattern as manni:stewardship:1.2.0 last-reviewed. Date a human last reviewed the metadata.' },
    'notion-url': { type: 'string', format: 'uri' },
  },
  allOf: [
    { if: { properties: { 'knowledge-types': { contains: { const: 'example' } } }, required: ['knowledge-types'] }, then: { required: ['example-of'] } },
    {
      if: { properties: { capture: { const: 'bookmark' } }, required: ['capture'] },
      then: {
        properties: { 'sample-questions': { maxItems: 3 }, type: { enum: SOURCES } },
        not: { anyOf: [{ required: ['segments'] }, { required: ['captured-text-sha256'] }] },
      },
      else: { properties: { 'sample-questions': { minItems: 3 }, type: { enum: PIECES }, 'lifecycle-stages': { minItems: 1 } }, required: ['lifecycle-stages'] },
    },
    { if: { properties: { type: { const: 'slack-thread' } }, required: ['type'] }, then: { required: ['slack-workspace', 'slack-channel'] } },
  ],
  additionalProperties: true,
};

const term = {
  $schema: D,
  $id: 'kb:term:1.0.0',
  title: 'Vocabulary term frontmatter (SKOS)',
  type: 'object',
  required: ['type', 'id', 'in-scheme', 'status', 'title', 'description', 'label'],
  properties: {
    type: { const: 'term' },
    id: str,
    'in-scheme': { enum: ['topics', 'docs-artifacts', 'frameworks', 'genres', 'knowledge-types', 'lifecycle-stages', 'doc-types', 'org-contexts'] },
    status: { enum: ['candidate', 'approved', 'deprecated'] },
    title: str,
    description: str,
    label: str,
    notation: str,
    see: str,
    'scope-note': str,
    'alt-labels': strList(),
    'hidden-labels': strList(),
    broader: strList(),
    narrower: strList(),
    'related-terms': strList(),
  },
  additionalProperties: true,
};

const entity = {
  $schema: D,
  $id: 'kb:entity:1.0.0',
  title: 'Entity file frontmatter',
  type: 'object',
  required: ['type', 'title', 'description'],
  properties: {
    type: { enum: ENTITY_TYPES },
    title: str,
    description: str,
    resource: { type: 'string', format: 'uri' },
    'alt-labels': strList(),
    'same-as': { type: 'array', items: { type: 'string', format: 'uri' } },
    'start-date': date,
    location: str,
    online: { type: 'boolean' },
    'part-of': str,
  },
  allOf: [
    {
      if: { properties: { type: { const: 'event' } }, required: ['type'] },
      then: { required: ['start-date'] },
    },
  ],
  additionalProperties: true,
};

const nul = (t) => ({ anyOf: [t, { type: 'null' }] });

// Phase 6 contract (prompts/tag-item.md): one model call per item returns every judgment, including the type.
// Flat keys; a script applies them. Controlled values are checked against the vocabulary by the script.
const tagSegment = {
  type: 'object',
  additionalProperties: false,
  required: ['title', 'knowledge-type'],
  oneOf: [{ required: ['insert-before'] }, { required: ['heading'] }],
  properties: {
    'insert-before': { type: 'string', minLength: 4 },
    heading: str,
    title: str,
    start: segment.properties.start,
    'knowledge-type': str,
    genre: nul(str),
    concepts: strList(),
    organizations: strList(),
    tools: strList(),
    'first-hand': nul({ type: 'boolean' }),
  },
};

const tag = {
  $schema: D,
  $id: 'kb:tag-output:2.0.0',
  title: 'Model output contract for tagging one item (a patch, never a whole file)',
  type: 'object',
  additionalProperties: false,
  required: ['type', 'description', 'concepts', 'knowledge-types', 'lifecycle-stages', 'sample-questions', 'confidence'],
  properties: {
    type: { enum: [...SOURCES, ...PIECES] },
    title: nul(str),
    'title-devised': nul({ type: 'boolean' }),
    description: str,
    concepts: strList(1, 6),
    genre: strList(),
    'knowledge-types': strList(1),
    'example-of': strList(0, 5),
    'lifecycle-stages': strList(),
    'org-contexts': strList(),
    'doc-types': strList(),
    organizations: strList(),
    tools: strList(0, 8),
    authors: strList(),
    hosts: strList(),
    guests: strList(),
    'first-hand': nul({ type: 'boolean' }),
    published: nul(date),
    'sample-questions': { type: 'array', minItems: 1, maxItems: 5, items: str },
    segments: { type: 'array', items: tagSegment },
    summary: nul(str),
    'key-takeaways': nul({ type: 'array', items: str }),
    'tools-mentioned': nul({ type: 'array', items: str }),
    'new-entities': {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['kind', 'slug', 'title', 'description'],
        properties: {
          kind: { enum: ['tool', 'person', 'organization'] },
          slug: { type: 'string', pattern: '^[a-z0-9]+(-[a-z0-9]+)*$' },
          title: str,
          description: str,
          resource: nul({ type: 'string', format: 'uri' }),
          'alt-labels': strList(),
        },
      },
    },
    'candidate-terms': {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['scheme', 'label', 'description'],
        properties: { scheme: { enum: ['topics', 'docs-artifacts', 'frameworks'] }, label: str, description: str, 'scope-note': nul(str), broader: strList() },
      },
    },
    confidence: { type: 'object', additionalProperties: { type: 'number', minimum: 0, maximum: 1 } },
    notes: { type: 'string' },
  },
};


fs.mkdirSync('schema', { recursive: true });
for (const [n, s] of Object.entries({ 'kb-item': item, 'kb-term': term, 'kb-entity': entity, 'tag-output': tag })) {
  const out = { $comment: 'GENERATED by scripts/gen-schemas.mjs — do not edit', ...s };
  fs.writeFileSync(`schema/${n}.schema.json`, JSON.stringify(out, null, 2) + '\n');
}
