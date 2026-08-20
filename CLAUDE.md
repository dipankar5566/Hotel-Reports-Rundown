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
    │                    writers (submit/update/delete/list), PIN-gated. Handles
    │                    the rent/food/expense + recovery sections.
    ├── Report.gs        Staff-dashboard reader (PIN-gated): getDailyReport (per-day
    │                    rent/food/expense/recovery for a month) + getDuesTracker
    │                    (per-party dues: incurred vs recovered, month/year/lifetime).
    │                    Pure cores over fetched values; reuses Parser helpers.
    ├── Main.gs          doGet() -> Index.html (dashboard, DASHBOARD_TOKEN-gated)
    │                    or Form.html (entry app, ?view=entry).
    ├── Validate.gs      validateAll() — parser-vs-pivot totals check inside GAS.
    ├── Index.html       Entire dashboard client: rendering, filters, charts, AI.
    └── Form.html        Daily-entry PWA client: Entry view (PIN, dropdowns,
                         date-picker, this-month list) + Dashboard view (daily
                         report table, per-party due tracker).
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
- **Entry app** — access = ANYONE (anonymous), opened at `?view=entry`, PIN-gated. Kept separate so making it public never exposes the P&L; because both share `doGet`, the dashboard branch verifies `DASHBOARD_TOKEN` (see `dashboardAllowed_` in `Main.gs`).

**⚠️ Access-clobber gotcha.** The manifest (`appsscript.json`) has a **single** `webapp.access` field (currently `MYSELF`), but the two deployments need **different** access (dashboard = owner-only, entry = anyone). A plain `clasp redeploy <entry-id>` re-applies the manifest's `MYSELF` and silently breaks the entry app — staff then get a Drive "Sorry, unable to open the file at this time" error (the signed-in Gmail can't open an owner-only script). So **manage the entry deployment's access in the editor UI**, not via clasp: Deploy → Manage deployments → entry deployment → pencil → Who has access = **Anyone** → Deploy (edits the existing deployment, keeps the same `/exec` URL). If you must use clasp, do the flip-dance: set manifest `access` = `ANYONE_ANONYMOUS`, `clasp push -f`, `clasp redeploy <entry-id>`; then set it back to `MYSELF`, `clasp push -f`, `clasp redeploy <dashboard-id>` (redeploying only the dashboard id leaves the entry deployment untouched). Redeploy each id you changed.

**Secrets (Script Properties only, never in source):** `OPENAI_API_KEY`, `ENTRY_PIN_DREAM`, `ENTRY_PIN_PARADISE`, `DASHBOARD_TOKEN`.

### Cache gotcha

`Aggregate.gs` caches the payload under `CACHE_KEY` in `CacheService` (10 min TTL). That cache is tied to the **script project, not the deployment**, so it survives `redeploy`. Whenever the payload shape or content changes, bump `CACHE_KEY` (currently `dash_v15`) or users see stale data until the old entry expires. The entry app's writers (`submitEntry`/`updateEntry`/`deleteEntry`) call `invalidateDashboardCache_` so a fresh entry shows on the next dashboard load without waiting out the TTL.

## Daily entry app

- **Same pure/thin split.** `Entry.gs`'s core (`resolveWriteCols_`, `buildEntryRow_`, `canonicalLayout_`, `findAppendRow_`) is Node-testable and **reuses the parser's own `detectSections_`/`colFor_`** so the write side lands in exactly the columns the read side reads. Thin GAS writers open the book, take a `LockService` lock, write cells, invalidate cache.
- **Typo-proof by construction.** The picked date is written as a real `Date` object (hits `dayOf_`'s `v instanceof Date` fast path — no text parse) and the date also selects the target month tab (created with a canonical header row if missing), so a wrong month/day is impossible. Staff never touch header rows on app-created tabs.
- **Additive only, per the parser invariant.** Expense's `Category` dropdown writes into the sheet's **Particulars** column itself (matching how legacy staff sheets already put short category-ish words there — exactly what `categorize()`'s regexes are built to match), and the free-text description writes into an optional **Remark** column, same convention as rent/food/recovery. Parser.gs's `isKnownCategory_` (Config.gs) recognizes the dropdown's exact category strings in Particulars and uses them directly; a freeform legacy staff row (no known-category match) falls back to `categorize()` unchanged. An old explicit `Category` header (from an earlier app version — no real sheet has ever populated one) is still read as a defensive fallback, so nothing byte-identical breaks. A hidden `_entryId` column (inserted via `insertColumnAfter` on legacy tabs) makes edit/delete deterministic; the parser ignores it.
- **Owner data in `Config.gs`:** `ROOMS_BY_HOTEL` feeds the room dropdown (fixed lists, no free-text guessing).
- **Dues are hard-linked, not name-matched.** Every app-submitted rent row already carries a UUID `_entryId` regardless of `Due`; that id is reused as the due's own `dueId` (`buildDueIndex_` in `Report.gs`). A recovery's `Due ref` column stores the linked rent row's `_entryId` — picked from a live "open dues" list in `Form.html` (a filter-as-you-type picker, not a native `<select>`, which wheel-scrolls badly on iOS past a handful of options), not typed. Recoveries with no `Due ref` (or one that no longer resolves — the due was deleted, "orphaned") fall back to matching by normalized party-name text, same as before this hard-link existed — this is the permanent path for legacy dues that predate `_entryId` (or predate `Party`/`Due ref` on older tabs). A linked due's rollup always uses its **current, live** `Party` field, never a recovery's stale snapshot — renaming a typo'd guest moves the bucket, recoveries don't get stuck under the old spelling.
- **`Due` is a LIVE cell, not a frozen original.** `submitEntry`/`updateEntry`/`deleteEntry` write the linked due's `Due` cell down (or back up) by exactly the recovered amount every time a linked recovery is posted, edited, or removed (`adjustDueCell_`/`findRentDueRowById_` in `Entry.gs` — GAS-boundary, scans every month tab since the due may live in a different tab than the recovery). So `Due` always shows the *current* outstanding, visible directly in the raw sheet — and since `Parser.gs`'s `dueTotal` is just a live sum of that same column, the owner P&L dashboard's "Dues outstanding (recorded)" stat nets recoveries automatically, with **zero changes to Aggregate.gs/Index.html/CACHE_KEY** (`dueTotal` was never folded into revenue/net, and `validateAll()` doesn't touch `Due` at all, so a value that moves over time doesn't violate the parser's byte-identical-totals invariant). `buildDueIndex_` reads `outstanding` straight from the cell and **derives** the original incurred amount as `outstanding + recovered` — no separate "original due" column needed, correct as long as `Due` is only ever adjusted through the linked-recovery write-back or an explicit manual correction (both are just "this is what's currently owed," no invariant to violate either way — manual `Due` edits via the rent edit form are intentionally unguarded).
- **Referential-integrity guards for delete/link-edit, not for manual Due edits.** `deleteEntry` refuses to delete a rent row with anything recovered against it — gated on `recoveredAgainstDue_` **alone**, not on the row's current `Due` value: a fully-recovered due legitimately shows `Due=0` while still having recovery history, so gating on "Due is currently >0" would wrongly allow deleting it (a real bug caught during review — fixed by dropping the `dueVal` param from `canDeleteDue_` entirely). Editing or deleting a *recovery* row rebalances the linked due's cell by the delta (`updateEntry` validates the new amount against a "what-if-restored" outstanding before committing both writes; `deleteEntry` restores the due's cell by the deleted recovery's amount). `submitEntry` re-checks a linked due's live outstanding inside the `LockService` lock before writing a new recovery (`canRecoverAmount_`) — closes the race where two staff post against the same due in the same window. All guards call `Report.gs`'s pure predicates (`canDeleteDue_`/`canRecoverAmount_`, built on `findDueById_`/`recoveredAgainstDue_`) so the write side and the dashboard read side can never disagree. An over-recovered due (should never happen given the guards) still renders honestly — `outstanding` is never clamped to 0.
- **A recovery's Cash/Bank updates the BOOKING ROW itself, not a separate accumulator.** First attempt at this (folding recovery's Cash/Banking & UPI into `parseTab_`'s own top-level `recoveryCash`/`recoveryBank` output, summed into `entry.cashIn`/`bankIn` by `Aggregate.gs`) got corrected by the owner: they wanted the *booking row's own* Cash/Bank cells to move, not a dashboard-only aggregate — "the due data [should be] updated on that particular row where we recorded that particular transaction." So `Entry.gs`'s live-`Due`-cell mechanism (above) was widened: `adjustDueCell_(ss, dueId, deltaDue, deltaCash, deltaBank)` now also bumps the linked booking row's own `Cash`/`Banking & UPI` cells by exactly what was collected in that recovery — `submitEntry` increases them, `updateEntry`/`deleteEntry` correctly reverse/rebalance them (same restore-then-apply pattern already used for `Due`). `findRentDueRowById_` resolves `cashCol`/`bankCol` alongside `dueCol` (no retrofit needed — rent's Cash/Bank columns predate this whole feature). Result: `Cash + Bank + Due` stays equal to a booking's `Amount` on that one row, visible without cross-referencing anything. The `parseTab_`/`Aggregate.gs` separate-accumulator mechanism was **fully reverted** (would double-count once the row's own cells are mutated) — `entry.cashIn`/`bankIn` go back to being a pure sum of `s.cash`/`s.bank` across rent/food, and recovered money flows through automatically once the row is mutated, same "zero Aggregate.gs/Index.html changes" pattern as the `Due` cell itself. `CACHE_KEY` bumped again (`dash_v14`) for the revert, per the same content-changed rule. The staff PWA's Daily Report still splits its Recovery column into `recoveryCash`/`recoveryBank` per day (`buildDailyReport_` in `Report.gs`) — that reads the recovery section's own Cash/Bank columns directly via `sumSectionByDay_`, entirely independent of this mechanism, unaffected by the revert.
- **Verify** with a Node harness that concatenates `Config.gs`+`Parser.gs`+`Entry.gs`+`Report.gs`(+`Aggregate.gs` for the cash/bank payload asserts) and asserts a build→append→`parseTab_` round-trip (totals, `Σ days.rent == total`, `Σ nights == roomNights`, explicit-Category override, legacy fallback unchanged) plus, for dues: `parseTab_` totals byte-identical with/without a recovery section or `Due ref`/`Party` columns present; `buildDueIndex_` correctly derives `amount = outstanding + recovered` from fixtures that model the sheet's *already-decremented* live state (not a static original); partial payments across different month tabs; a party-rename-after-linking test; an orphaned-`Due ref` test; **a fully-recovered-due (`Due=0`) still refuses deletion** (the regression test for the bug above); an ordinary non-due booking is fully excluded from the index (not a zero-amount phantom entry); and for cash/bank: `parseTab_`'s `recoveryCash`/`recoveryBank` extraction with rent/food/expense byte-identical whether or not recovery cash/bank is present, `buildPayloadFromBooks_`'s `cashIn`/`bankIn` correctly summing rent+food+recovery, and `buildDailyReport_`'s day/totals split. The live sheet write can't run from a harness — end every change with one real submit per section on a scratch/real sheet, including partially recovering a due and confirming `Due` visibly drops in the raw sheet, attempting to delete a due with recovery history (confirm refusal), submitting a recovery with a cash/bank split and confirming the owner dashboard's Money Control numbers move, and confirming the owner dashboard's "Dues outstanding" stat and `validateAll()` (no new flags) both reflect it correctly.

## Data model notes

- One sheet tab per month; up to four side-by-side sections per tab (rent / food / expense / recovery). The recovery ledger is PWA-only and invisible to the P&L parser.
- `entry.days[d]` holds per-day `{ rev, exp, net, rent, nights }` — `rent`/`nights` exist so the AI can compare an in-progress month against prior months cut to the **same day-of-month** (see `truncateMonth` in `Index.html`).
- Two owner-stated adjustments that are **not** in the books: a fixed staff salary per hotel per month (prorated for the running month), and — for Dream only — an assumed 40% of food revenue as in-house kitchen cost. All "net" figures are after both.

## AI analysis

- Model is set by `AI_MODEL` in `Config.gs` (a non-reasoning OpenAI model on the standard Chat Completions path — `temperature` + `max_completion_tokens` + strict `json_schema`). If you switch to a reasoning model, it needs `reasoning_effort` and rejects `temperature`; test one call first.
- **The OpenAI API key is never in source.** It lives only in Script Properties (Apps Script editor → Project Settings → Script Properties) as `OPENAI_API_KEY`, set once by the owner.
- On a running month, the client truncates prior months to the current month's elapsed days before sending, so the model doesn't mistake a partial month for a decline. Fields with no per-day data (GST/dues/cash) are sent `null` for truncated months and must not be cross-compared.
