// Static checks for every collection in collections/, run in CI before any test.
// Catches the mistakes that otherwise only show up as confusing Newman failures:
//   - the file is not valid JSON or not a v2.1 collection
//   - a request has no assertions
//   - a request hard-codes a host instead of using {{baseUrl}}
//   - a pre-request or test script has a JavaScript syntax error
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const V21 = 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json';

function findCollections(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return findCollections(full);
    return entry.name.endsWith('.postman_collection.json') ? [full] : [];
  });
}

function checkScripts(events = [], where, problems) {
  for (const event of events) {
    const source = [].concat(event.script?.exec ?? []).join('\n');
    try {
      // Wrapped in a function, as Postman does, so top-level `return` is allowed.
      new vm.Script(`(function () {\n${source}\n})`);
    } catch (err) {
      problems.push(`${where}: ${event.listen} script has a syntax error: ${err.message}`);
    }
  }
}

function walk(items, trail, problems, counts) {
  for (const item of items) {
    const where = [...trail, item.name].join(' / ');
    checkScripts(item.event, where, problems);
    if (item.item) {
      walk(item.item, [...trail, item.name], problems, counts);
      continue;
    }
    counts.requests++;
    const raw = typeof item.request?.url === 'string' ? item.request.url : item.request?.url?.raw ?? '';
    if (!raw.startsWith('{{baseUrl}}')) problems.push(`${where}: URL "${raw}" should start with {{baseUrl}}`);
    const tests = (item.event ?? []).filter((e) => e.listen === 'test').flatMap((e) => e.script?.exec ?? []).join('\n');
    if (!tests.includes('pm.test(')) problems.push(`${where}: request has no pm.test() assertions`);
  }
}

const files = findCollections('collections');
let failed = false;

for (const file of files) {
  const problems = [];
  const counts = { requests: 0 };
  let collection;
  try {
    collection = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    problems.push(`not valid JSON: ${err.message}`);
  }
  if (collection) {
    if (collection.info?.schema !== V21) problems.push(`info.schema should be ${V21}`);
    checkScripts(collection.event, '(collection)', problems);
    walk(collection.item ?? [], [], problems, counts);
  }

  if (problems.length) {
    failed = true;
    console.log(`✗ ${file}`);
    problems.forEach((p) => console.log(`    - ${p}`));
  } else {
    console.log(`✓ ${file} (${counts.requests} requests)`);
  }
}

if (files.length === 0) {
  console.log('No collections found.');
  failed = true;
}
process.exitCode = failed ? 1 : 0;
