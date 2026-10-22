# Contributing

Thanks for helping make this a better learning resource.

## Getting started

```bash
npm install
npm run lint
npm test
npm run test:data
npm run test:generated
```

All four should pass before you open a pull request. CI runs the same commands.

## Guidelines

- **Collections** are plain Postman v2.1 JSON. Edit them in Postman (export as v2.1) or by hand. Every request URL starts with `{{baseUrl}}` and every request has at least one `pm.test()`; `npm run lint` checks both.
- **Test names** say what is expected, for example "Create with an invalid ISBN", not "Test 7".
- **Keep tests independent of order where you can.** When a test needs earlier state (a token, an id), save it with `pm.collectionVariables.set` and say so in the folder description.
- **API changes** go together with an update to `api/openapi.yaml`, since the AI generator reads it.
- **No secrets** in collections, environments or code. Use GitHub secrets and `--env-var` in CI.
- If you add a learning topic, add a row to the "What you will learn" table in the README.

## Reporting issues

Please include the command you ran, your Node version (`node -v`) and the relevant part of the Newman output or `reports/*.html`.
