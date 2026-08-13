# Hotel P&L Dashboard — Dream & Paradise

A Google Apps Script (GAS) web app that reads two staff-maintained Google Sheets (one per hotel) and renders a monthly/daily P&L dashboard: KPIs, break-even, money control, food business, YoY, and an on-demand OpenAI analysis.

## Repo map

```
.
├── CLAUDE.md            This file.
├── .clasp.json          clasp config: script id + rootDir (src).
├── appsscript.json      (in src/) GAS manifest — scopes, web-app access.
└── src/
    ├── Config.gs        Hotels + spreadsheet IDs, room counts, salary/food-cost
    │                    assumptions, expense category rules, AI model + tunables.
    ├── Parser.gs        One month tab (2D values) -> normalized sections
    │                    (rent/food/expense). Anchor-based; skips pivot blocks.
    ├── Aggregate.gs     Both books -> full dashboard payload; gzip'd cache.
    ├── AI.gs            On-demand OpenAI analysis (summary, trend, recs, anomalies).
    ├── Main.gs          doGet() -> serves Index.html.
    ├── Validate.gs      validateAll() — parser-vs-pivot totals check inside GAS.
    └── Index.html       Entire client: rendering, filters, charts, AI panel.
```

External dependencies: Chart.js (CDN, client only) and the OpenAI REST API (server, on-demand). No build step, no npm, no bundler.

## Architecture rules

- **Keep the GAS I/O boundary thin; the core is pure.** All spreadsheet reads live in a thin outer function (`buildPayload_` calls `SpreadsheetApp`); the real work is a pure function over already-fetched values (`buildPayloadFromBooks_`, `parseTab_`). This is what lets the logic run in a plain Node harness. New logic goes in the pure layer, not next to an API call.
- **Locate sheet data by anchor headers, never by fixed column index.** Staff shift columns month to month; `Parser.gs` finds sections by header text. Don't hard-code column positions.
- **Change data shape additively.** The parser totals are validated against each tab's embedded pivot. When you need new per-row/per-day detail, *add* fields alongside the existing sums (e.g. per-day `rent`/`nights`) so month totals stay byte-identical and the validation invariant holds. Don't rework an existing accumulation to get new data.
- **The on-demand AI path is separate from the dashboard payload.** `runAiAnalysis` does not go through `getDashboardData`/`CACHE_KEY`; AI-only changes never need a cache bump. Conversely, any change to the dashboard payload's shape or content *must* bump `CACHE_KEY`.
- **Secrets only in Script Properties**, never in source, never echoed into chat (`OPENAI_API_KEY`).
- **Centralize owner-stated assumptions in `Config.gs`** (salary per hotel, Dream's 40% food cost, room counts). Don't scatter magic numbers into Parser/Aggregate.
- **GAS concatenates all `.gs` files and runs top-level statements in (roughly alphabetical) file order.** A top-level `var` that reads another file's top-level `var` can see `undefined`. So anything depending on `CATEGORY_RULES`/`HOTELS` is read *inside a function*, or built lazily (see `getAiResponseSchema_` in `AI.gs`).

## Naming conventions

- **Trailing underscore = private/helper** (GAS treats a plain function name as a callable web endpoint, so `_` marks "not an entry point"): `parseTab_`, `buildPayloadFromBooks_`, `buildAiInput_`, `getOpenAiKey_`. Public entry points have no underscore: `doGet`, `getDashboardData`, `runAiAnalysis`, `validateAll`.
- **`UPPER_SNAKE_CASE` for top-level constants**: `HOTELS`, `SALARY_PER_HOTEL_MONTH`, `CATEGORY_RULES`, `MONTH_INDEX`, `AI_MODEL`, `AI_MAX_EXPENSE_ROWS`, `AI_TREND_MONTHS`, `CACHE_KEY`, `CACHE_SECS`.
- **`camelCase` for functions, locals, and payload fields**: `roomNights`, `expByCat`, `expByCatRows`, `rentBySource`, `daysElapsed`, `foodCost`, `truncateMonth`.
- **ES5 style throughout** — `var`, `function () {}`, no `const`/`let`/arrow/template-literal even though V8 allows them. The client JS in `Index.html` follows the same ES5 style.
- **`ym` is a `'YYYY-MM'` string** (e.g. `'2026-08'`); category keys and expense labels are human-readable strings (`'Kitchen & Groceries'`), not codes.
- **Mirror a value, flag it.** A constant duplicated across the server/client boundary (e.g. `AI_TREND_MONTHS` in both `Config.gs` and `Index.html`) carries a comment pointing at its twin.

## Test expectations

- **The `.gs` builders must stay runnable outside GAS.** Verify a change by concatenating the relevant `.gs` files, `module.exports`-ing the builders, and `require`-ing them in a Node harness that asserts against synthetic or real sheet data. When testing client logic, extract the real function text from `Index.html` and `eval` it rather than re-implementing it, so the test can't drift from shipped code.
- **Assert the invariants, not just the happy path.** For parser/aggregate changes, prove month totals are unchanged and that any new per-day detail reconciles to them (`Σ days[d].rent == entry.rent`, `Σ nights == roomNights`). Hand-check at least one arithmetic case (mean/stddev, proration, occupancy) with known inputs.
- **`validateAll()` (`Validate.gs`)** reproduces the parser-vs-pivot totals check inside GAS; run it after parser changes.
- **The live OpenAI call cannot be tested from a harness** (the key isn't available outside GAS). Every AI change ends with a manual click of "Run AI Analysis" per hotel scope in the deployed app as the real end-to-end check.

## Build / deploy

Uses [`clasp`](https://github.com/google/clasp) (logged in as the project owner). From the repo root:

```
clasp push -f
clasp redeploy <DEPLOYMENT_ID>
```

The deployment id is the long `AKfycb…` string for the web-app deployment (execute-as-owner, access = owner only). `clasp push` alone updates the editor project but not the live URL — you must `redeploy` the existing deployment id to publish.

### Cache gotcha

`Aggregate.gs` caches the payload under `CACHE_KEY` in `CacheService` (10 min TTL). That cache is tied to the **script project, not the deployment**, so it survives `redeploy`. Whenever the payload shape or content changes, bump `CACHE_KEY` (e.g. `dash_v8` → `dash_v9`) or users see stale data until the old entry expires.

## Data model notes

- One sheet tab per month; up to three side-by-side sections per tab (rent / food / expense).
- `entry.days[d]` holds per-day `{ rev, exp, net, rent, nights }` — `rent`/`nights` exist so the AI can compare an in-progress month against prior months cut to the **same day-of-month** (see `truncateMonth` in `Index.html`).
- Two owner-stated adjustments that are **not** in the books: a fixed staff salary per hotel per month (prorated for the running month), and — for Dream only — an assumed 40% of food revenue as in-house kitchen cost. All "net" figures are after both.

## AI analysis

- Model is set by `AI_MODEL` in `Config.gs` (a non-reasoning OpenAI model on the standard Chat Completions path — `temperature` + `max_completion_tokens` + strict `json_schema`). If you switch to a reasoning model, it needs `reasoning_effort` and rejects `temperature`; test one call first.
- **The OpenAI API key is never in source.** It lives only in Script Properties (Apps Script editor → Project Settings → Script Properties) as `OPENAI_API_KEY`, set once by the owner.
- On a running month, the client truncates prior months to the current month's elapsed days before sending, so the model doesn't mistake a partial month for a decline. Fields with no per-day data (GST/dues/cash) are sent `null` for truncated months and must not be cross-compared.
