# Insurance

Electron desktop client for the insurance agency: worker login, the daily
dashboard (insurances, cash, brokers, emails, reconciliation), the walk-in policy
form, the admin tools, and the desktop helpers for scanning, printing and the
Bulins portal.

The UI is Bulgarian with an English translation layer, and every page talks to
the `InsuranceServer` API (`https://bulsig.online`).

## Requirements

- Node.js 20 or newer and npm (the test suite is run under Node 24).
- Windows. The app targets Windows: desktop scanning uses the Windows OCR
  engine, PDF printing goes through the shell, and the installer is an NSIS
  package.
- For the server-side tests, a checkout of the API repository at
  `../InsuranceServer` (next to this repository). Point `INSURANCE_SERVER_DIR`
  at it if it lives elsewhere.

## Layout

| Path | Contents |
| --- | --- |
| `src/` | Main-process code: the Electron entry point, configuration, the outbox, the Bulins browser view, scans/OCR, PDF field reading and the Desktop PDF watcher. |
| `renderer/` | Renderer process: `LoginPage/`, `WorkPage/` (dashboard), `AddInsurance/` (walk-in form), `AdminInsurance/`, plus the shared classic scripts (`common.js`, `dateField.js`, `diag.js`, `presence.js`, …) and the styles. |
| `test/` | Node test suite (no test framework). `test/client/` covers the renderer and main-process modules, `test/server/` loads the real `InsuranceServer` files, `test/fixtures/` holds binary test inputs. |
| `tools/` | One-off engineering scripts: the WebSocket prober/diagnostic and the PC 403 diagnostic. |
| `docs/` | Engineering notes, e.g. how the client diagnoses intermittent 403s. |
| `Icons/` | Application icon used by the installer (`frosttide23.ico`). |
| `dist/` | Build output of `electron-builder` (not committed). |

Nothing here touches the database directly: the schema, the repair scripts and
the one-off upgrades live in the `InsuranceServer` repository (`db/setup.js` and
the scripts next to it).

## Commands

```bash
npm install          # install dependencies
npm start            # run the app with Electron
npm test             # run the whole Node test suite
npm run pack         # build an unpacked app into dist/ (no installer)
npm run dist         # build the NSIS installer and publish the release
npm run release      # same as dist
```

`.env` is local-only (ignored by git) and is read by the server, not by the
client.

## Tests

The suite is plain Node — each file is a script that prints `PASS`/`FAIL` lines
and exits non-zero on failure, so no framework is involved. `npm test` runs all
of them in sequence (client, then server) and stops at the first failure; the
runner accepts filters:

```bash
npm test                           # everything
node test/run-all.cjs broker       # only paths containing "broker"
node test/run-all.cjs server       # only test/server
node test/client/dateField.test.cjs   # a single file
```

- `test/client/` tests the code the app actually runs (renderer scripts are
  loaded into a `vm` with a minimal DOM, main-process modules are imported
  directly).
- `test/server/` loads the real files from the sibling `InsuranceServer`
  checkout (`test/serverPath.cjs`) inside a `vm` with stubbed requires and an
  in-memory fake MySQL, so the assertions are about the queries that really run
  in production.
- The tests are self-contained: no sample business documents are kept in the
  repository. Excel reading/writing is covered by round-tripping a generated
  workbook (`insuranceExport.test.cjs`), and the daily-report layout is
  reproduced in memory (`reconcile.test.cjs`).
