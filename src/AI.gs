/**
 * AI.gs: on-demand OpenAI analysis (plain-English summary + expense
 * anomaly flags) for whatever hotel/month/scope is currently on screen.
 * Only ever runs when the client explicitly calls runAiAnalysis() via the
 * "Run AI Analysis" button — never on page load or scope/month change.
 */

function getOpenAiKey_() {
  var key = PropertiesService.getScriptProperties().getProperty('OPENAI_API_KEY');
  if (!key) {
    throw new Error(
      'OpenAI API key not configured — set OPENAI_API_KEY in Script Properties ' +
      '(Apps Script editor -> Project Settings -> Script Properties).'
    );
  }
  return key;
}

/** google.script.run entry point. curMonth/prevMonth are the client's own
 * CURRENT_MONTH/PREV_MONTH objects (already computed by monthsInScope()).
 * trendMonths is a client-built array of compact KPI snapshots for the
 * trailing AI_TREND_MONTHS (oldest->newest, including current) so the model
 * can read trends and give an early-warning forecast. */
function runAiAnalysis(curMonth, prevMonth, trendMonths, meta) {
  if (!curMonth || !curMonth.ym) throw new Error('No month data provided for AI analysis.');
  var apiKey = getOpenAiKey_();
  var compact = buildAiInput_(curMonth, prevMonth, trendMonths, meta);
  var requestBody = buildOpenAiRequest_(compact);
  return callOpenAi_(requestBody, apiKey);
}

/** Compacts an entry (or merged "Both"-scope entry) into what actually gets
 * sent to OpenAI — rounded KPIs, a trailing multi-month KPI trend, top
 * expense categories, per-category statistical baselines, and the flattened
 * row-level expense line items (the only row-level bookkeeping data the
 * payload has; rent/food sections are day-aggregated only). */
function buildAiInput_(curMonth, prevMonth, trendMonths, meta) {
  // Round, but preserve null (a truncated prior month has no per-day data for
  // gst/dues/cash, so those come through as null and must not be compared).
  function rr(x) { return x == null ? null : Math.round(x); }
  function kpis(m) {
    if (!m) return null;
    return {
      ym: m.ym,
      revenue: Math.round(m.revenue), rent: Math.round(m.rent), food: Math.round(m.food),
      expense: Math.round(m.expense), salary: Math.round(m.salary), foodCost: Math.round(m.foodCost || 0),
      totalCost: Math.round(m.totalCost), net: Math.round(m.net),
      roomNights: m.roomNights, occupancyPct: Math.round((m.occupancy || 0) * 1000) / 10,
      adr: Math.round(m.adr), revpar: Math.round(m.revpar),
      cashIn: rr(m.cashIn), bankIn: rr(m.bankIn), gst: rr(m.gst),
      dueTotal: rr(m.dueTotal), discountTotal: rr(m.discountTotal),
      daysElapsed: m.daysElapsed, daysInMonth: m.daysInMonth,
      byHotel: (m.hotels || []).map(function (h) {
        return { hotel: h.hotel, revenue: Math.round(h.revenue), totalCost: Math.round(h.totalCost), net: Math.round(h.net) };
      })
    };
  }
  function topCats(m, n) {
    if (!m || !m.expByCat) return [];
    return Object.keys(m.expByCat)
      .map(function (k) { return { category: k, amount: Math.round(m.expByCat[k]) }; })
      .sort(function (a, b) { return b.amount - a.amount; })
      .slice(0, n);
  }

  // Per-category statistical baseline over ALL rows in the current month
  // (computed before any truncation) so the model can judge whether a line
  // item is a genuine outlier rather than guessing from round numbers.
  function catStats(m) {
    var out = [];
    Object.keys(m.expByCatRows || {}).forEach(function (cat) {
      var amounts = m.expByCatRows[cat].map(function (r) { return r.amount; });
      var n = amounts.length;
      if (!n) return;
      var total = amounts.reduce(function (s, a) { return s + a; }, 0);
      var mean = total / n;
      var varSum = amounts.reduce(function (s, a) { return s + (a - mean) * (a - mean); }, 0);
      var stddev = Math.sqrt(varSum / n); // population stddev
      out.push({
        category: cat, count: n, total: Math.round(total),
        mean: Math.round(mean), max: Math.round(Math.max.apply(null, amounts)),
        stddev: Math.round(stddev)
      });
    });
    return out.sort(function (a, b) { return b.total - a.total; });
  }

  // Trailing multi-month KPI trend (oldest->newest). Client sends compact
  // snapshots; round defensively in case full month objects come through.
  function trendCompact(arr) {
    return (arr || []).map(function (m) {
      return {
        ym: m.ym,
        revenue: Math.round(m.revenue || 0), expense: Math.round(m.expense || 0),
        totalCost: Math.round(m.totalCost || 0), net: Math.round(m.net || 0),
        roomNights: m.roomNights || 0,
        occupancyPct: Math.round((m.occupancyPct != null ? m.occupancyPct : (m.occupancy || 0) * 100) * 10) / 10,
        adr: Math.round(m.adr || 0), revpar: Math.round(m.revpar || 0)
      };
    });
  }

  var rows = [];
  Object.keys(curMonth.expByCatRows || {}).forEach(function (cat) {
    curMonth.expByCatRows[cat].forEach(function (r) {
      rows.push({ day: r.day, category: cat, particular: r.particular, amount: Math.round(r.amount), hotel: r.hotel });
    });
  });
  rows.sort(function (a, b) { return (a.day || 0) - (b.day || 0); });
  var truncated = rows.length > AI_MAX_EXPENSE_ROWS;
  if (truncated) rows = rows.slice(0, AI_MAX_EXPENSE_ROWS);

  var m = meta || {};
  var comparisonBasis = m.partial
    ? ('SAME-DATE: "current" covers the first ' + m.cutoffDay + ' days of the month so far, and "previous"/"trend" have each been recomputed to the SAME first ' + m.cutoffDay + ' days of their month for a like-for-like comparison. Do NOT describe the current month as smaller/declining just because it is mid-month - the prior figures are already cut to the same day count. Fields shown as null in "previous" (gst, dues, cash) have no same-date value; never compare those across months.')
    : 'FULL MONTHS: current, previous, and trend are all complete months and directly comparable.';

  return {
    scopeLabel: (curMonth.hotels || []).length > 1 ? 'Both hotels (combined)' : ((curMonth.hotels || [])[0] || {}).hotel || 'Unknown',
    comparisonBasis: comparisonBasis,
    current: kpis(curMonth),
    previous: kpis(prevMonth),
    trend: trendCompact(trendMonths),
    topExpenseCategories: topCats(curMonth, 12),
    categoryStats: catStats(curMonth),
    expenseLineItems: rows,
    expenseLineItemCount: rows.length,
    expenseLineItemsTruncated: truncated
  };
}

function getKnownCategories_() {
  var cats = CATEGORY_RULES.map(function (r) { return r[1]; });
  cats.push('General & Misc');
  return cats.filter(function (c, i) { return cats.indexOf(c) === i; });
}

// Built lazily (not a top-level var) because it depends on CATEGORY_RULES
// from Config.gs: Apps Script concatenates all .gs files and runs top-level
// statements in file order (roughly alphabetical), so a top-level var here
// would run before Config.gs's top-level CATEGORY_RULES assignment,
// reading it as undefined. Every other file in this project only touches
// HOTELS/CATEGORY_RULES from inside functions for the same reason.
function getAiResponseSchema_() {
  return {
    name: 'hotel_pl_analysis',
    strict: true,
    schema: {
      type: 'object',
      properties: {
        summary: {
          type: 'string',
          description: 'A 3-5 sentence plain-English narrative of this month\'s P&L performance for a small hotel owner, referencing concrete figures including the operating KPIs (occupancy, ADR, RevPAR, GST, dues) where present.'
        },
        trend: {
          type: 'string',
          description: 'A 2-4 sentence read of the multi-month trajectory in the "trend" array (revenue/net/occupancy direction) plus a plain early-warning or simple forecast. If the trend array has fewer than 3 months, say history is too short for a reliable trend.'
        },
        recommendations: {
          type: 'array',
          description: 'Prioritized, concrete actions the owner can take, each grounded in the given numbers (e.g. cut a specific cost, chase a specific due, adjust rate for occupancy). Empty array if the data warrants none - do not pad the list.',
          items: {
            type: 'object',
            properties: {
              priority: { type: 'string', enum: ['high', 'medium', 'low'] },
              action: { type: 'string', description: 'The specific action to take, in plain language.' },
              rationale: { type: 'string', description: 'Why, referencing concrete figures from the data.' }
            },
            required: ['priority', 'action', 'rationale'],
            additionalProperties: false
          }
        },
        anomalies: {
          type: 'array',
          description: 'Individual expenseLineItems entries that look like possible bookkeeping mistakes or outliers. Empty array if nothing looks anomalous - do not invent findings.',
          items: {
            type: 'object',
            properties: {
              severity: { type: 'string', enum: ['low', 'medium', 'high'] },
              day: { type: ['integer', 'null'] },
              particular: { type: 'string' },
              amount: { type: 'number' },
              category: { type: 'string', enum: getKnownCategories_() },
              reason: { type: 'string', description: 'Specific, concrete reason grounded in the given data - reference the category\'s baseline (count/mean/max/stddev) from categoryStats when calling something an outlier. Not a generic statement.' }
            },
            required: ['severity', 'day', 'particular', 'amount', 'category', 'reason'],
            additionalProperties: false
          }
        }
      },
      required: ['summary', 'trend', 'recommendations', 'anomalies'],
      additionalProperties: false
    }
  };
}

function buildOpenAiRequest_(compact) {
  var systemPrompt = [
    'You are a financial analyst assistant for a small Indian hotel business (guesthouses named Dream and Paradise).',
    'You are given structured JSON for one month ("current"), optionally the previous month ("previous"), a trailing multi-month KPI series ("trend"), per-category expense baselines ("categoryStats"), and the actual expense line items ("expenseLineItems") recorded in the owner\'s bookkeeping.',
    'CRITICAL - read "comparisonBasis" first and obey it. When it says SAME-DATE, every month (current, previous, trend) has already been cut to the same number of days, so comparisons are fair - do NOT say revenue/net "dropped" or "is much lower" merely because the current month is still in progress. Any null field must not be compared across months.',
    'Task 1 - summary: write a short (3-5 sentence) plain-English narrative of this month\'s P&L for a small business owner, not a corporate report. Reference concrete numbers AND the operating KPIs (occupancy, ADR, RevPAR, GST, dues, discounts) where they are present. Compare to "previous" only if it is given.',
    'Task 2 - trend: using the "trend" array (oldest to newest), describe the trajectory of revenue, net, and occupancy over the months given, and give a plain early-warning or simple forecast (e.g. "net has fallen three months running"). If fewer than 3 months are present, say the history is too short for a reliable trend.',
    'Task 3 - recommendations: give a short, prioritized list of concrete actions the owner can actually take, each grounded in the given numbers (cut a named cost, chase a specific due, adjust the room rate given occupancy/ADR, fix a GST gap). Order by priority. Return an empty array if the data genuinely warrants no action - never pad the list.',
    'Task 4 - anomalies: review ONLY the "expenseLineItems" array and flag entries that look like possible bookkeeping mistakes. Judge outliers against that category\'s baseline in "categoryStats" (count/mean/max/stddev) - e.g. an amount far above the category mean, likely-duplicate entries on the same day/amount, or a particular that does not match its assigned category. Do not put rent/food-revenue or category-level trend commentary here - that belongs in summary/trend.',
    'If nothing looks anomalous, return an empty anomalies array. Never invent an anomaly to fill the list.',
    'Use ONLY the numbers present in the JSON provided. Never invent, estimate, or assume a figure that is not given. If "previous" is null, do not fabricate a month-over-month comparison.',
    'Output must strictly match the provided JSON schema.'
  ].join(' ');

  return {
    model: AI_MODEL,
    temperature: 0.3,
    max_completion_tokens: 2000,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: JSON.stringify(compact) }
    ],
    response_format: { type: 'json_schema', json_schema: getAiResponseSchema_() }
  };
}

function callOpenAi_(requestBody, apiKey) {
  var options = {
    method: 'post',
    contentType: 'application/json',
    headers: { Authorization: 'Bearer ' + apiKey },
    payload: JSON.stringify(requestBody),
    muteHttpExceptions: true,
    timeoutSeconds: 55
  };
  var resp = UrlFetchApp.fetch('https://api.openai.com/v1/chat/completions', options);
  var code = resp.getResponseCode();
  var bodyText = resp.getContentText();

  if (code !== 200) {
    var msg = 'OpenAI request failed (HTTP ' + code + ')';
    try {
      var errJson = JSON.parse(bodyText);
      if (errJson && errJson.error && errJson.error.message) msg += ': ' + errJson.error.message;
    } catch (e) { /* non-JSON error body, use generic message */ }
    throw new Error(msg);
  }

  var data = JSON.parse(bodyText);
  var msgObj = data.choices && data.choices[0] && data.choices[0].message;
  if (!msgObj) throw new Error('OpenAI returned an unexpected response shape.');
  if (msgObj.refusal) throw new Error('OpenAI declined to analyze this data: ' + msgObj.refusal);

  return JSON.parse(msgObj.content); // { summary, anomalies }
}
