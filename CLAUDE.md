# Hotel P&L Dashboard — Dream & Paradise

A Google Apps Script web app that reads two staff-maintained Google Sheets (one per hotel) and renders a monthly/daily P&L dashboard: KPIs, break-even, money control, food business, YoY, and an on-demand OpenAI analysis.

## Layout

All code is in `src/` (Apps Script concatenates every `.gs` at runtime, so top-level `var`s are shared globally; declare order matters — see below):

- `Config.gs` — hotels + source spreadsheet IDs, room counts, salary/food-cost assumptions, expense category rules, AI model + tunables.
- `Parser.gs` — turns one monthly sheet tab (a 2D values array) into normalized sections (rent / food / expense). Locates sections by anchor headers because column positions shift month to month; skips embedded pivot ("SUM of …") blocks.
- `Aggregate.gs` — builds the full dashboard payload from both books; gzip'd `CacheService` cache.
- `AI.gs` — on-demand OpenAI analysis (summary, trend/forecast, recommendations, expense anomalies). Runs only when the user clicks the button.
- `Main.gs` — `doGet()` serves `Index.html`.
- `Index.html` — the entire client (Chart.js via CDN, all rendering + the AI panel).
- `Validate.gs` — `validateAll()` reproduces the parser-vs-pivot totals check in GAS.

## Build / deploy

Uses [`clasp`](https://github.com/google/clasp) (logged in as the project owner). From the repo root:

```
clasp push -f
clasp redeploy <DEPLOYMENT_ID>
```

The deployment id is the long `AKfycb…` string for the web-app deployment (execute-as-owner, access = owner only). `clasp push` alone updates the editor project but not the live URL — you must `redeploy` the existing deployment id to publish.

### Cache gotcha

`Aggregate.gs` caches the payload under `CACHE_KEY` in `CacheService` (10 min TTL). That cache is tied to the **script project, not the deployment**, so it survives `redeploy`. Whenever the payload *shape or content* changes, bump `CACHE_KEY` (e.g. `dash_v8` → `dash_v9`) or users see stale data until the old entry expires.

## Data model notes

- One sheet tab per month; up to three side-by-side sections per tab (rent / food / expense).
- `entry.days[d]` holds per-day `{ rev, exp, net, rent, nights }` — `rent`/`nights` exist so the AI can compare an in-progress month against prior months cut to the **same day-of-month** (see `truncateMonth` in `Index.html`).
- Two owner-stated adjustments that are **not** in the books: a fixed staff salary per hotel per month (prorated for the running month), and — for Dream only — an assumed 40% of food revenue as in-house kitchen cost. All "net" figures are after both.

## AI analysis

- Model is set by `AI_MODEL` in `Config.gs` (a non-reasoning OpenAI model on the standard Chat Completions path — `temperature` + `max_completion_tokens` + strict `json_schema`). If you switch to a reasoning model, it needs `reasoning_effort` and rejects `temperature`; test one call first.
- **The OpenAI API key is never in source.** It lives only in Script Properties (Apps Script editor → Project Settings → Script Properties) as `OPENAI_API_KEY`, set once by the owner.
- On a running month, the client truncates prior months to the current month's elapsed days before sending, so the model doesn't mistake a partial month for a decline. Fields with no per-day data (GST/dues/cash) are sent `null` for truncated months and must not be cross-compared.

## Testing

The `.gs` builders are written to be runnable outside GAS. Verify changes by concatenating the relevant `.gs` files and requiring them in a Node harness (see the project's scratchpad harnesses), asserting against real or synthetic sheet data. The live OpenAI call can only be confirmed by clicking the button in the deployed app.
