// Runs a Postman collection with Newman's Node API and writes HTML, JUnit and JSON reports.
//
// By default it boots the sample API in-process on a free port, so `npm test` needs
// nothing else running. Pass --no-server (or `npm run test:remote`) to test an API
// that is already running, using --base-url or the environment file's baseUrl.
import newman from 'newman';
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { createApp } from '../api/app.js';

const { values: args } = parseArgs({
  options: {
    collection: { type: 'string', default: 'collections/books-api.postman_collection.json' },
    environment: { type: 'string', default: 'environments/local.postman_environment.json' },
    data: { type: 'string' },
    folder: { type: 'string', multiple: true },
    'base-url': { type: 'string', default: process.env.BASE_URL },
    'no-server': { type: 'boolean', default: false },
    'report-dir': { type: 'string', default: 'reports' },
  },
});

const reportName = path.basename(args.collection).replace(/\.postman_collection\.json$/, '').replace(/\.json$/, '');
const reportDir = args['report-dir'];
fs.mkdirSync(reportDir, { recursive: true });

function startServer() {
  return new Promise((resolve) => {
    const server = createApp().listen(0, () => resolve(server));
  });
}

function runNewman(options) {
  return new Promise((resolve, reject) => {
    newman.run(options, (err, summary) => (err ? reject(err) : resolve(summary)));
  });
}

let server;
let baseUrl = args['base-url'];
if (!args['no-server']) {
  server = await startServer();
  baseUrl = `http://localhost:${server.address().port}`;
  console.log(`Started Bookstore API in-process at ${baseUrl}`);
}

try {
  const summary = await runNewman({
    collection: args.collection,
    environment: args.environment,
    iterationData: args.data,
    folder: args.folder,
    envVar: baseUrl ? [{ key: 'baseUrl', value: baseUrl }] : [],
    timeoutRequest: 10_000,
    reporters: ['cli', 'htmlextra', 'junit', 'json'],
    reporter: {
      htmlextra: {
        export: path.join(reportDir, `${reportName}.html`),
        title: `Newman report: ${reportName}`,
        browserTitle: 'Newman report',
        showEnvironmentData: true,
        skipSensitiveData: true,
      },
      junit: { export: path.join(reportDir, `${reportName}.junit.xml`) },
      json: { export: path.join(reportDir, `${reportName}.json`) },
    },
  });

  const { stats, failures } = summary.run;
  console.log(
    `\nAssertions: ${stats.assertions.total - stats.assertions.failed}/${stats.assertions.total} passed` +
      ` | Requests: ${stats.requests.total} | Failures: ${failures.length}`,
  );
  console.log(`Reports written to ${reportDir}/${reportName}.{html,junit.xml,json}`);
  if (failures.length > 0) process.exitCode = 1;
} catch (err) {
  console.error('Newman could not run the collection:', err.message);
  process.exitCode = 2;
} finally {
  server?.close();
}
