# Hotel P&L Dashboard — Dream & Paradise

A Google Apps Script (GAS) web app that reads two staff-maintained Google Sheets (one per hotel) and renders a monthly/daily P&L dashboard: KPIs, break-even, money control, food business, YoY, and an on-demand OpenAI analysis. A separate **daily-entry PWA** (same GAS project, its own web-app deployment) lets hotel staff add clean rent/food/expense rows from a phone — killing the free-text date typos that used to silently zero a section. Coexists with manual sheet edits today; designed to become the sole input source.

## Repo map

```
.
├── CLAUDE.md            This file.
├── .clasp.json          clasp config: script id + rootDir (src).
├── appsscript.json      (in src/) GAS manifest — scopes, web-app access.
└── src/
    ├── Config.gs        Hotels + spreadsheet IDs, room counts, per-hotel room
    │                    lists, salary/food-cost assumptions, expense category
    │                    rules, AI model + tunables.
    ├── Parser.gs        One month tab (2D values) -> normalized sections
    │                    (rent/food/expense). Anchor-based; skips pivot blocks.
    ├── Aggregate.gs     Both books -> full dashboard payload; gzip'd cache.
    ├── AI.gs            On-demand OpenAI analysis (summary, trend, recs, anomalies).
    ├── Entry.gs         Daily-entry app server: pure column-resolution + row-build
    │                    (reuses Parser's detectSections_/colFor_) + thin sheet
    │                    writers (submit/update/delete/list), PIN-gated.
    ├── Main.gs          doGet() -> Index.html (dashboard, DASHBOARD_TOKEN-gated)
    │                    or Form.html (entry app, ?view=entry).
    ├── Validate.gs      validateAll() — parser-vs-pivot totals check inside GAS.
    ├── Index.html       Entire dashboard client: rendering, filters, charts, AI.
    └── Form.html        Daily-entry PWA client: PIN, dropdowns, date-picker,
                         this-month list with edit/delete.
```

External dependencies: Chart.js (CDN, dashboard client only) and the OpenAI REST API (server, on-demand). No build step, no npm, no bundler.

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

`clasp push` alone updates the editor project but not the live URL — you must `redeploy` the existing deployment id to publish. **There are two web-app deployments off the one project** (both execute-as-owner):

- **Dashboard** — access = owner only, `DASHBOARD_TOKEN`-gated (URL needs `?k=<token>`).
- **Entry app** — access = ANYONE, opened at `?view=entry`, PIN-gated. Kept separate so making it public never exposes the P&L; because both share `doGet`, the dashboard branch verifies `DASHBOARD_TOKEN` (see `dashboardAllowed_` in `Main.gs`). `clasp redeploy <entry-id>` preserves its ANYONE access.

Redeploy each id you changed. New `Deploy → New deployment` with a different access level must be done in the editor UI (clasp uses the manifest's single access setting).

**Secrets (Script Properties only, never in source):** `OPENAI_API_KEY`, `ENTRY_PIN_DREAM`, `ENTRY_PIN_PARADISE`, `DASHBOARD_TOKEN`.

### Cache gotcha

`Aggregate.gs` caches the payload under `CACHE_KEY` in `CacheService` (10 min TTL). That cache is tied to the **script project, not the deployment**, so it survives `redeploy`. Whenever the payload shape or content changes, bump `CACHE_KEY` (currently `dash_v10`) or users see stale data until the old entry expires. The entry app's writers (`submitEntry`/`updateEntry`/`deleteEntry`) call `invalidateDashboardCache_` so a fresh entry shows on the next dashboard load without waiting out the TTL.

## Daily entry app

- **Same pure/thin split.** `Entry.gs`'s core (`resolveWriteCols_`, `buildEntryRow_`, `canonicalLayout_`, `findAppendRow_`) is Node-testable and **reuses the parser's own `detectSections_`/`colFor_`** so the write side lands in exactly the columns the read side reads. Thin GAS writers open the book, take a `LockService` lock, write cells, invalidate cache.
- **Typo-proof by construction.** The picked date is written as a real `Date` object (hits `dayOf_`'s `v instanceof Date` fast path — no text parse) and the date also selects the target month tab (created with a canonical header row if missing), so a wrong month/day is impossible. Staff never touch header rows on app-created tabs.
- **Additive only, per the parser invariant.** Expense gains an optional `Category` column that the parser prefers over `categorize()` when present; legacy tabs (no such header) stay byte-identical. A hidden `_entryId` column (inserted via `insertColumnAfter` on legacy tabs) makes edit/delete deterministic; the parser ignores it.
- **Owner data in `Config.gs`:** `ROOMS_BY_HOTEL` feeds the room dropdown (fixed lists, no free-text guessing).
- **Verify** with a Node harness that concatenates `Config.gs`+`Parser.gs`+`Entry.gs` and asserts a build→append→`parseTab_` round-trip (totals, `Σ days.rent == total`, `Σ nights == roomNights`, explicit-Category override, legacy fallback unchanged). The live sheet write can't run from a harness — end every change with one real submit per section on a scratch/real sheet and confirm the dashboard total moves and `validateAll()` shows no new flags.

## Data model notes

- One sheet tab per month; up to three side-by-side sections per tab (rent / food / expense).
- `entry.days[d]` holds per-day `{ rev, exp, net, rent, nights }` — `rent`/`nights` exist so the AI can compare an in-progress month against prior months cut to the **same day-of-month** (see `truncateMonth` in `Index.html`).
- Two owner-stated adjustments that are **not** in the books: a fixed staff salary per hotel per month (prorated for the running month), and — for Dream only — an assumed 40% of food revenue as in-house kitchen cost. All "net" figures are after both.

## AI analysis

- Model is set by `AI_MODEL` in `Config.gs` (a non-reasoning OpenAI model on the standard Chat Completions path — `temperature` + `max_completion_tokens` + strict `json_schema`). If you switch to a reasoning model, it needs `reasoning_effort` and rejects `temperature`; test one call first.
- **The OpenAI API key is never in source.** It lives only in Script Properties (Apps Script editor → Project Settings → Script Properties) as `OPENAI_API_KEY`, set once by the owner.
- On a running month, the client truncates prior months to the current month's elapsed days before sending, so the model doesn't mistake a partial month for a decline. Fields with no per-day data (GST/dues/cash) are sent `null` for truncated months and must not be cross-compared.
