# Changelog

## 1.2.0

### Added
- **Shards and parallel jobs.**
  - `neuron-reporter merge <files|dirs>` and `mergeRuns()` merge the run JSON of several jobs into one report and one history record.
  - New `StepReporter#writeJSON()`.
  - Under `--shard`, the Playwright reporter writes `shards/shard-N-of-M.json` and leaves history to the merge.
  - The GitHub Action supports `command: merge`.
- **Safe concurrent history writes.**
  - A lock folder serialises writers, and a crashed writer's stale lock is taken over.
  - Each write replaces the file atomically (temp file plus rename, with retries on Windows).
  - Runs are kept in start-time order.
- **Secret redaction, on by default.**
  - Covers bearer/basic credentials, JWTs, URL credentials, key/value secrets (including JSON), cloud and SaaS token formats, private keys, and the values of secret-looking env vars.
  - Applies to the HTML, the history file and shard JSON.
  - Options: `redact: { values, patterns, env, replacement }` or `redact: false`; on the CLI, `--redact REGEX` and `--no-redact`.
- **Stable step identity and "did not run".**
  - Each step is keyed by its path, or by an `id` (`step(..., { id })`, `group(..., fn, { id })`, the Playwright test id, JUnit `classname::name`). Repeated names get ` #2`.
  - Each run records the outcome of every step, so steps that didn't run are no longer counted as passes, flips skip them, and the Trends strip shows them as outlined squares.
  - Steps that passed on a retry show amber in the strip.
- GitHub Action input `extra-args`.

### Fixed (found by testing against real Playwright 1.65, TypeScript 5.9 and the Action script)
- **ESM imports:** `import { render, mergeRuns, createRedactor, … } from 'neuron-reporter'` failed at runtime. Node couldn't see those names as exports. `render` was already affected in 1.0.
- **Playwright reporter:**
  - Browser, context and page setup inside fixtures and hooks no longer shows up as steps of every test. A failing hook still shows.
  - `test.fail()` tests no longer put their intended failures into the failure list, triage or history.
  - The console summary no longer counts skipped tests as passed.
  - An `{ type: 'id' }` annotation keeps a test's history across renames. Playwright's own test id changes when the title does.
- **Failure triage:** the `Expected: … / Received: …` format of Playwright, Jest and Vitest is now classified as a value mismatch, `element(s) not found` as element not found, and "Test timeout of N ms exceeded" under a new **Test timed out** cause.
- **History keys:** steps inside a test case with an `id` are keyed under that id, so they keep their history when the case is renamed.
- **Input checks:** `render` and `merge` refuse a history file or unrelated JSON with a clear error, instead of rendering a meaningless report.
- **Merged reports** no longer show one shard's own "Shard N of M" row.
- **Tests:** `npm test` no longer relies on the shell to expand `test/*.test.js`, which Windows `cmd.exe` doesn't do.
- **Trends:** the "did not run" square is now clearly visible in dark mode.

### Changed
- `render()` redacts by default. Pass `redact: false` for the old behaviour.
- `render` in the CLI now reads input through the same path as `merge`. The output is unchanged.
- History records written before 1.2 have no per-step outcomes. For those runs, the old "missing from the failures means passed" rule still applies.

## 1.1.0

### Added
- **Retries and flaky detection.**
  - `step()` and `softStep()` take `{ retries, retryDelay }`, or use `options.retries` for every step. The step function receives `{ attempt }`.
  - A step that passes after a failure is COMPLETED and flaky, and all its attempts are kept.
  - The report shows *flaky* badges, a timeline of attempts, a *Flaky this run* card and a *Flaky* filter.
  - Run history records flaky steps. The Trends table gives each step a verdict (*flaky*, *consistent* or *fixed?*), counts its pass/fail flips and shows a strip of its recent outcomes.
- **Attachments.**
  - New methods: `attach()`, `attachLog()`, `attachFile()`, `attachVideo()` and `attachLink()`.
  - The report shows text, JSON and logs (collapsible), video (inline player), images, files and links.
  - Files up to 8 MB are embedded; bigger ones are linked relative to the report.
  - A new **Attachments** tab lists them all.
- **Playwright Test reporter**, `neuron-reporter/playwright-reporter`, set up with one line in `playwright.config`. It maps steps, retries, flaky tests, screenshots, videos, traces and stdout/stderr.
- **JUnit XML importer**, `neuron-reporter junit <files|dirs>` and `neuron-reporter/adapters/junit`.
  - Brings pytest, Maven/Gradle (JUnit, TestNG), Go, .NET, Jest, Cypress and Robot Framework results into the report.
  - Supports Surefire `flakyFailure`/`rerunFailure`, repeated test cases as retries, `system-out` logs and `[[ATTACHMENT|…]]` files.
  - `--group suite|class` turns suites or classes into collapsible test cases.
- **GitHub Action** (`uses: ashifReza/neuron-reporter@v1`). It keeps run history in the Actions cache, uploads the report and writes a job summary.
- **JSON Schema** for the CLI input (`schema/run.schema.json`), so any language can produce reports.
- **TypeScript types** for the API and the Playwright reporter.
- CLI options: `--fail-on-flaky`, `--no-embed` and `--version`.
- CI workflow (Node 18/20/22 on Linux and Windows) and a GitHub Pages workflow that publishes the sample report.

### Changed
- A failed test case with no failed step inside (a timeout, a hook, an error between steps) now appears in the failure list with its own error.
- Screenshot links no longer put the image data inside an inline `onclick` string.
- The CLI exits with `2` (not `1`) for an unknown command, so `1` always means "tests failed".
- The package is ready for npm: `types`, `prepublishOnly` and `publishConfig` are set.

## 1.0.0

- Initial release.
