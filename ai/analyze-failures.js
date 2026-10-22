// AI failure triage: Newman JSON report -> Markdown summary.
//
// Always writes a plain results summary (no AI needed). When there are failures and
// ANTHROPIC_API_KEY is set, it also asks Claude to triage each failure: is it a bug in
// the API, a bug in the test, or an environment problem, and what should change.
//
// The output goes to reports/ai-analysis.md and, inside GitHub Actions, to the job
// summary page. This script never fails the build itself: the Newman step does that.
//
// Usage:
//   npm run ai:analyze                          # every Newman report in reports/
//   npm run ai:analyze -- --report reports/books-api.json
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { askClaude, describeError, hasCredentials, MODEL } from './lib/claude.js';

const { values: args } = parseArgs({
  options: {
    report: { type: 'string', multiple: true },
    'report-dir': { type: 'string', default: 'reports' },
    spec: { type: 'string', default: 'api/openapi.yaml' },
    out: { type: 'string', default: 'reports/ai-analysis.md' },
  },
});

// Response bodies are cut to this many characters before they go into the prompt.
// Error bodies from this API are tiny; the cap only protects against huge payloads.
const MAX_BODY_CHARS = 4000;

function findReports() {
  if (args.report?.length) return args.report;
  if (!fs.existsSync(args['report-dir'])) return [];
  return fs.readdirSync(args['report-dir'])
    .filter((f) => f.endsWith('.json'))
    .map((f) => path.join(args['report-dir'], f))
    .filter((f) => {
      try { return Boolean(JSON.parse(fs.readFileSync(f, 'utf8')).run?.stats); } catch { return false; }
    });
}

function decodeBody(stream) {
  if (!stream?.data) return '';
  const text = Buffer.from(stream.data).toString('utf8');
  return text.length > MAX_BODY_CHARS ? `${text.slice(0, MAX_BODY_CHARS)}\n[... ${text.length - MAX_BODY_CHARS} more characters cut]` : text;
}

function describeUrl(url) {
  if (!url) return '';
  const host = Array.isArray(url.host) ? url.host.join('.') : url.host;
  const query = (url.query ?? []).filter((q) => !q.disabled).map((q) => `${q.key}=${q.value}`).join('&');
  return `/${(url.path ?? []).join('/')}${query ? `?${query}` : ''}` + (host ? ` (host ${host}${url.port ? `:${url.port}` : ''})` : '');
}

function collectFailures(reportFile) {
  const report = JSON.parse(fs.readFileSync(reportFile, 'utf8'));
  const { run, collection } = report;
  const failures = run.failures.map((failure) => {
    const execution = run.executions.find((e) => e.cursor?.ref === failure.cursor?.ref);
    const testScript = execution?.item.event?.find((e) => e.listen === 'test')?.script.exec?.join('\n') ?? '';
    return {
      collection: collection?.info?.name ?? path.basename(reportFile),
      request: failure.source?.name ?? '(collection-level)',
      iteration: (failure.cursor?.iteration ?? 0) + 1,
      failedTest: failure.error.test ?? failure.at,
      error: `${failure.error.name}: ${failure.error.message}`,
      method: execution?.request.method ?? '',
      url: describeUrl(execution?.request.url),
      requestBody: execution?.request.body?.raw ?? '',
      responseStatus: execution?.response ? `${execution.response.code} ${execution.response.status}` : 'no response',
      responseBody: decodeBody(execution?.response?.stream),
      testScript,
    };
  });
  return { file: reportFile, name: collection?.info?.name ?? reportFile, stats: run.stats, failures };
}

const escapeCell = (s) => String(s).replace(/\|/g, '\\|').replace(/\n/g, ' ');

function resultsMarkdown(results) {
  const rows = results.map(({ name, stats }) => {
    const passed = stats.assertions.total - stats.assertions.failed;
    const icon = stats.assertions.failed === 0 && stats.testScripts.failed === 0 && stats.requests.failed === 0 ? '✅' : '❌';
    return `| ${icon} ${escapeCell(name)} | ${stats.requests.total} | ${passed}/${stats.assertions.total} | ${stats.testScripts.failed + stats.requests.failed} |`;
  });
  let md = `## API test results\n\n| Collection | Requests | Assertions passed | Script/request errors |\n|---|---|---|---|\n${rows.join('\n')}\n`;

  const failures = results.flatMap((r) => r.failures);
  if (failures.length) {
    md += `\n### Failures (${failures.length})\n\n| Request | Iteration | Failed test | Error | Response |\n|---|---|---|---|---|\n`;
    md += failures
      .map((f) => `| ${escapeCell(f.request)} | ${f.iteration} | ${escapeCell(f.failedTest)} | ${escapeCell(f.error)} | ${escapeCell(f.responseStatus)} |`)
      .join('\n');
    md += '\n';
  }
  return md;
}

const SYSTEM = `You are a senior QA engineer triaging failed API tests from a CI run.
Readers are developers who want to know quickly what broke and what to change. Be concrete and brief. Do not invent facts that are not in the evidence; when the evidence is not enough to decide, say what extra information would settle it.`;

function triagePrompt(failures, spec) {
  return `These Newman (Postman) tests failed in CI. For each failure decide the most likely cause:
- "API bug": the service does not follow its contract.
- "Test bug": the test expects something the contract does not promise, or the test script is wrong.
- "Environment": timeouts, connection errors, missing data or config.

The OpenAPI contract is the source of truth for what the API promises.

<openapi>
${spec}
</openapi>

<failures>
${JSON.stringify(failures, null, 2)}
</failures>

Reply in GitHub-flavoured Markdown with exactly these parts:
1. "### AI triage" heading, then a 1-3 sentence overview (group failures that share a root cause).
2. For each distinct root cause: a "#### " heading naming it, a line "**Verdict:** API bug | Test bug | Environment", a short explanation that cites the evidence (status, body, assertion), and a "**Suggested fix:**" with the specific change (code or test snippet when it helps).
Keep it under 400 words.`;
}

// ---------- Main ----------

const reportFiles = findReports();
if (reportFiles.length === 0) {
  console.error(`No Newman JSON reports found in ${args['report-dir']}/. Run the tests first (npm test).`);
  process.exit(0);
}

const results = reportFiles.map(collectFailures);
const failures = results.flatMap((r) => r.failures);
let markdown = resultsMarkdown(results);

if (failures.length === 0) {
  markdown += '\nAll assertions passed. No triage needed.\n';
} else if (!hasCredentials()) {
  markdown += '\n> AI triage skipped: `ANTHROPIC_API_KEY` is not set. Add it as a repository secret to get a root-cause analysis here.\n';
} else {
  console.log(`Asking ${MODEL} to triage ${failures.length} failure(s) ...`);
  try {
    const spec = fs.existsSync(args.spec) ? fs.readFileSync(args.spec, 'utf8') : '(no OpenAPI spec available)';
    const triage = await askClaude({ system: SYSTEM, prompt: triagePrompt(failures, spec), effort: 'medium', maxTokens: 16000 });
    markdown += `\n${triage.trim()}\n\n<sub>Triage generated by ${MODEL}. It is a starting point for investigation, not a verdict.</sub>\n`;
  } catch (err) {
    markdown += `\n> AI triage failed: ${describeError(err)}\n`;
  }
}

fs.mkdirSync(path.dirname(args.out), { recursive: true });
fs.writeFileSync(args.out, markdown);
if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${markdown}\n`);
console.log(markdown);
console.log(`Saved to ${args.out}`);
