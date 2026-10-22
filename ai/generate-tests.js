// AI test generation: OpenAPI spec -> Claude test plan -> Postman collection.
//
// Claude decides WHAT to test and returns a structured test plan (JSON that matches
// PLAN_SCHEMA). This script decides HOW: it turns each planned case into a Postman
// request with ordinary pm.test() assertions. Keeping the two apart means the
// generated collection only contains code written here, and the plan is a small,
// reviewable file you can diff in a pull request.
//
// Usage:
//   npm run ai:generate                        # call Claude (needs ANTHROPIC_API_KEY)
//   npm run ai:generate -- --dry-run           # print the prompt, call nothing
//   npm run ai:generate:example                # build from the example plan, no API call
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { askClaude, describeError, hasCredentials, MODEL } from './lib/claude.js';

const { values: args } = parseArgs({
  options: {
    spec: { type: 'string', default: 'api/openapi.yaml' },
    out: { type: 'string', default: 'collections/generated/books-api.ai-generated.postman_collection.json' },
    'from-plan': { type: 'string' },
    'max-tests': { type: 'string', default: '30' },
    'dry-run': { type: 'boolean', default: false },
  },
});

const ASSERTION_KINDS = ['jsonPathExists', 'jsonPathEquals', 'jsonPathType', 'arrayMinLength', 'headerContains', 'bodyContains'];

const PLAN_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['summary', 'testCases'],
  properties: {
    summary: { type: 'string', description: 'Two or three sentences on the test strategy.' },
    testCases: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['name', 'folder', 'rationale', 'method', 'path', 'query', 'auth', 'body', 'expectedStatus', 'assertions'],
        properties: {
          name: { type: 'string', description: 'Short imperative test name, e.g. "Reject a negative price".' },
          folder: { type: 'string', description: 'Group name, e.g. "Books - Negative".' },
          rationale: { type: 'string', description: 'One sentence: the risk this test covers.' },
          method: { type: 'string', enum: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] },
          path: { type: 'string', description: 'Path starting with "/". May use {{bookId}}.' },
          query: { type: 'string', description: 'Query string without "?", or "".' },
          auth: { type: 'string', enum: ['token', 'none', 'invalid'] },
          body: { type: 'string', description: 'Raw request body (usually JSON text), or "" for none. May use {{uniqueIsbn}}.' },
          expectedStatus: { type: 'integer' },
          assertions: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['kind', 'target', 'expected'],
              properties: {
                kind: { type: 'string', enum: ASSERTION_KINDS },
                target: { type: 'string', description: 'Dot path into the JSON body (e.g. "data.0.id"), a header name, or "".' },
                expected: { type: 'string', description: 'Expected value as text. JSON literal for jsonPathEquals.' },
              },
            },
          },
        },
      },
    },
  },
};

const SYSTEM = `You are a senior API test engineer. You design focused, high-value API regression tests from an OpenAPI contract.
You return a test plan, not code. Another program turns the plan into a Postman collection that Newman runs in CI, so every case must be deterministic and runnable as described.`;

function buildPrompt(spec, maxTests) {
  return `Design an API test plan for the service described by this OpenAPI document.

<openapi>
${spec}
</openapi>

The runner prepares the following before your test cases run, in this order:
1. POST /test/reset puts the data back to the documented seed state (books with ids 1, 2 and 3 exist).
2. POST /auth/token logs in as admin/password123. Cases with auth "token" send that Bearer token; "invalid" sends a made-up token; "none" sends no Authorization header.
3. A fixture book is created and its id is stored in {{bookId}}.
Every request also gets a fresh, unused 13-digit ISBN in {{uniqueIsbn}}.

Cases run in the order you list them and share state, so a case that deletes {{bookId}} must come after every case that reads or updates it.

Assertion kinds you can use (the status code is always checked, so do not add an assertion for it):
- jsonPathExists: target is a dot path into the JSON body, e.g. "data.0.title".
- jsonPathEquals: target is a dot path; expected is a JSON literal, e.g. "\\"ok\\"", "1", "true".
- jsonPathType: target is a dot path; expected is one of string, number, boolean, array, object, null.
- arrayMinLength: target is a dot path to an array ("" for the body itself); expected is a whole number.
- headerContains: target is a header name; expected is a substring of its value.
- bodyContains: target is ""; expected is a substring of the raw response body.

Guidelines:
- Write at most ${maxTests} cases. Prefer fewer, sharper cases over many near-duplicates.
- Cover the happy path of every operation, authentication, input validation at the boundaries of each constraint, unknown resources, and error body shape.
- Only assert behaviour the contract states. If the contract is ambiguous, leave that case out rather than guessing.
- Use folder names such as "Health", "Auth", "Books - Read", "Books - Write", "Books - Negative".`;
}

// ---------- Plan -> Postman collection ----------

const ISBN_SCRIPT = [
  "// Fresh 13-digit ISBN for every request, so creates never collide.",
  "pm.variables.set('uniqueIsbn', '979' + String(Math.floor(Math.random() * 1e10)).padStart(10, '0'));",
];

const PATH_HELPER = "const valueAt = (obj, p) => (p ? p.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj) : obj);";

function assertionCode({ kind, target, expected }) {
  const t = JSON.stringify(target);
  const e = JSON.stringify(expected);
  switch (kind) {
    case 'jsonPathExists':
      return `pm.test(${JSON.stringify(`${target} is present`)}, () => pm.expect(valueAt(pm.response.json(), ${t})).to.not.be.undefined);`;
    case 'jsonPathEquals': {
      let literal;
      try { literal = JSON.stringify(JSON.parse(expected)); } catch { literal = e; }
      return `pm.test(${JSON.stringify(`${target} equals ${expected}`)}, () => pm.expect(valueAt(pm.response.json(), ${t})).to.eql(${literal}));`;
    }
    case 'jsonPathType':
      return expected === 'null'
        ? `pm.test(${JSON.stringify(`${target} is null`)}, () => pm.expect(valueAt(pm.response.json(), ${t})).to.be.null);`
        : `pm.test(${JSON.stringify(`${target} is a(n) ${expected}`)}, () => pm.expect(valueAt(pm.response.json(), ${t})).to.be.an(${e}));`;
    case 'arrayMinLength':
      return `pm.test(${JSON.stringify(`${target || 'body'} has at least ${expected} item(s)`)}, () => pm.expect(valueAt(pm.response.json(), ${t})).to.be.an('array').with.length.of.at.least(${Number(expected) || 0}));`;
    case 'headerContains':
      return `pm.test(${JSON.stringify(`${target} header contains "${expected}"`)}, () => pm.expect(pm.response.headers.get(${t}) || '').to.include(${e}));`;
    case 'bodyContains':
      return `pm.test(${JSON.stringify(`Body contains "${expected}"`)}, () => pm.expect(pm.response.text()).to.include(${e}));`;
    default:
      throw new Error(`Unknown assertion kind: ${kind}`);
  }
}

function toRequest(testCase) {
  const pathPart = testCase.path.startsWith('/') ? testCase.path : `/${testCase.path}`;
  const raw = `{{baseUrl}}${pathPart}${testCase.query ? `?${testCase.query}` : ''}`;
  const request = {
    method: testCase.method,
    header: [],
    url: {
      raw,
      host: ['{{baseUrl}}'],
      path: pathPart.split('/').filter(Boolean),
      ...(testCase.query
        ? { query: testCase.query.split('&').map((pair) => { const [key, ...rest] = pair.split('='); return { key, value: rest.join('=') }; }) }
        : {}),
    },
    description: testCase.rationale,
  };
  if (testCase.auth === 'none') request.auth = { type: 'noauth' };
  if (testCase.auth === 'invalid') request.auth = { type: 'bearer', bearer: [{ key: 'token', value: 'invalid-token-from-ai-plan', type: 'string' }] };
  if (testCase.body) {
    request.header.push({ key: 'Content-Type', value: 'application/json' });
    request.body = { mode: 'raw', raw: testCase.body, options: { raw: { language: 'json' } } };
  }

  const usesJson = testCase.assertions.some((a) => a.kind.startsWith('jsonPath') || a.kind === 'arrayMinLength');
  const exec = [
    `pm.test('Status code is ${testCase.expectedStatus}', () => pm.response.to.have.status(${testCase.expectedStatus}));`,
    ...(usesJson ? [PATH_HELPER] : []),
    ...testCase.assertions.map(assertionCode),
  ];
  return { name: testCase.name, event: [{ listen: 'test', script: { type: 'text/javascript', exec } }], request };
}

function setupFolder() {
  const json = (raw) => ({ mode: 'raw', raw, options: { raw: { language: 'json' } } });
  const jsonHeader = [{ key: 'Content-Type', value: 'application/json' }];
  const url = (p) => ({ raw: `{{baseUrl}}${p}`, host: ['{{baseUrl}}'], path: p.split('/').filter(Boolean) });
  const script = (exec) => [{ listen: 'test', script: { type: 'text/javascript', exec } }];
  return {
    name: 'Setup',
    description: 'Fixed preconditions added by the generator (not by the AI).',
    item: [
      {
        name: 'Reset test data',
        event: script(["pm.test('Reset returns 204', () => pm.response.to.have.status(204));"]),
        request: { method: 'POST', header: [], url: url('/test/reset'), auth: { type: 'noauth' } },
      },
      {
        name: 'Login',
        event: script([
          "pm.test('Login returns 201', () => pm.response.to.have.status(201));",
          "pm.collectionVariables.set('token', pm.response.json().token);",
        ]),
        request: { method: 'POST', header: jsonHeader, url: url('/auth/token'), auth: { type: 'noauth' }, body: json('{"username":"{{username}}","password":"{{password}}"}') },
      },
      {
        name: 'Create fixture book',
        event: script([
          "pm.test('Fixture created', () => pm.response.to.have.status(201));",
          "pm.collectionVariables.set('bookId', pm.response.json().id);",
        ]),
        request: { method: 'POST', header: jsonHeader, url: url('/books'), body: json('{"title":"Fixture Book","author":"Generator","isbn":"{{uniqueIsbn}}","price":9.99}') },
      },
    ],
  };
}

function buildCollection(plan, meta) {
  const folders = new Map();
  for (const testCase of plan.testCases) {
    if (!folders.has(testCase.folder)) folders.set(testCase.folder, []);
    folders.get(testCase.folder).push(toRequest(testCase));
  }
  return {
    info: {
      name: 'Bookstore API (AI-generated)',
      description: `${plan.summary}\n\nGenerated by ai/generate-tests.js from ${meta.spec} (${meta.source}). Review before you rely on it.`,
      schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json',
    },
    auth: { type: 'bearer', bearer: [{ key: 'token', value: '{{token}}', type: 'string' }] },
    event: [{ listen: 'prerequest', script: { type: 'text/javascript', exec: ISBN_SCRIPT } }],
    variable: [{ key: 'token', value: '' }, { key: 'bookId', value: '' }],
    item: [setupFolder(), ...[...folders].map(([name, item]) => ({ name, item }))],
  };
}

function validatePlan(plan) {
  if (!Array.isArray(plan?.testCases) || plan.testCases.length === 0) throw new Error('The plan has no test cases.');
  for (const [i, c] of plan.testCases.entries()) {
    for (const field of ['name', 'folder', 'method', 'path', 'expectedStatus', 'assertions']) {
      if (c[field] === undefined) throw new Error(`Test case ${i} is missing "${field}".`);
    }
    for (const a of c.assertions) {
      if (!ASSERTION_KINDS.includes(a.kind)) throw new Error(`Test case "${c.name}" uses unknown assertion kind "${a.kind}".`);
    }
  }
}

// ---------- Main ----------

const spec = fs.readFileSync(args.spec, 'utf8');
const prompt = buildPrompt(spec, Number(args['max-tests']));

if (args['dry-run']) {
  console.log(`--- system ---\n${SYSTEM}\n\n--- prompt ---\n${prompt}`);
  process.exit(0);
}

let plan;
let source;
if (args['from-plan']) {
  plan = JSON.parse(fs.readFileSync(args['from-plan'], 'utf8'));
  source = `plan file ${args['from-plan']}`;
} else {
  if (!hasCredentials()) {
    console.error('ANTHROPIC_API_KEY is not set. Set it, or run `npm run ai:generate:example` to build from the example plan.');
    process.exit(1);
  }
  console.log(`Asking ${MODEL} for a test plan based on ${args.spec} ...`);
  try {
    plan = await askClaude({ system: SYSTEM, prompt, schema: PLAN_SCHEMA, effort: 'high' });
  } catch (err) {
    console.error(`Test generation failed. ${describeError(err)}`);
    process.exit(1);
  }
  source = `Claude model ${MODEL}`;
}

validatePlan(plan);
const collection = buildCollection(plan, { spec: args.spec, source });

fs.mkdirSync(path.dirname(args.out), { recursive: true });
fs.writeFileSync(args.out, JSON.stringify(collection, null, 2) + '\n');
const planOut = args.out.replace(/\.postman_collection\.json$/, '.plan.json');
if (!args['from-plan']) fs.writeFileSync(planOut, JSON.stringify(plan, null, 2) + '\n');

console.log(`Wrote ${plan.testCases.length} test cases to ${args.out}`);
if (!args['from-plan']) console.log(`Saved the raw plan to ${planOut} for review.`);
console.log(`Run them with: npm run test:generated`);
