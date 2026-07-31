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
 * CURRENT_MONTH/PREV_MONTH objects (already computed by monthsInScope()). */
function runAiAnalysis(curMonth, prevMonth) {
  if (!curMonth || !curMonth.ym) throw new Error('No month data provided for AI analysis.');
  var apiKey = getOpenAiKey_();
  var compact = buildAiInput_(curMonth, prevMonth);
  var requestBody = buildOpenAiRequest_(compact);
  return callOpenAi_(requestBody, apiKey);
}

/** Compacts an entry (or merged "Both"-scope entry) into what actually gets
 * sent to OpenAI — rounded KPIs, top expense categories, and the flattened
 * row-level expense line items (the only row-level bookkeeping data the
 * payload has; rent/food sections are day-aggregated only). */
function buildAiInput_(curMonth, prevMonth) {
  function kpis(m) {
    if (!m) return null;
    return {
      ym: m.ym,
      revenue: Math.round(m.revenue), rent: Math.round(m.rent), food: Math.round(m.food),
      expense: Math.round(m.expense), salary: Math.round(m.salary), foodCost: Math.round(m.foodCost || 0),
      totalCost: Math.round(m.totalCost), net: Math.round(m.net),
      roomNights: m.roomNights, occupancyPct: Math.round((m.occupancy || 0) * 1000) / 10,
      adr: Math.round(m.adr), revpar: Math.round(m.revpar),
      cashIn: Math.round(m.cashIn), bankIn: Math.round(m.bankIn), gst: Math.round(m.gst),
      dueTotal: Math.round(m.dueTotal), discountTotal: Math.round(m.discountTotal),
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

  var rows = [];
  Object.keys(curMonth.expByCatRows || {}).forEach(function (cat) {
    curMonth.expByCatRows[cat].forEach(function (r) {
      rows.push({ day: r.day, category: cat, particular: r.particular, amount: Math.round(r.amount), hotel: r.hotel });
    });
  });
  rows.sort(function (a, b) { return (a.day || 0) - (b.day || 0); });
  var truncated = rows.length > AI_MAX_EXPENSE_ROWS;
  if (truncated) rows = rows.slice(0, AI_MAX_EXPENSE_ROWS);

  return {
    scopeLabel: (curMonth.hotels || []).length > 1 ? 'Both hotels (combined)' : ((curMonth.hotels || [])[0] || {}).hotel || 'Unknown',
    current: kpis(curMonth),
    previous: kpis(prevMonth),
    topExpenseCategories: topCats(curMonth, 12),
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
          description: 'A 3-5 sentence plain-English narrative of this month\'s P&L performance for a small hotel owner, referencing concrete figures from the data given.'
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
              reason: { type: 'string', description: 'Specific, concrete reason grounded in the given data - not a generic statement.' }
            },
            required: ['severity', 'day', 'particular', 'amount', 'category', 'reason'],
            additionalProperties: false
          }
        }
      },
      required: ['summary', 'anomalies'],
      additionalProperties: false
    }
  };
}

function buildOpenAiRequest_(compact) {
  var systemPrompt = [
    'You are a financial analyst assistant for a small Indian hotel business (guesthouses named Dream and Paradise).',
    'You are given structured JSON for one month (and optionally the previous month for comparison) - revenue, costs, KPIs, and the actual expense line items recorded in the owner\'s bookkeeping.',
    'Task 1 - summary: write a short (3-5 sentence) plain-English narrative of this month\'s P&L for a small business owner, not a corporate report. Reference concrete numbers. Compare to the previous month only if "previous" data is given.',
    'Task 2 - anomalies: review ONLY the "expenseLineItems" array and flag entries that look like possible mistakes (e.g. an unusually large one-off vs. the rest of that category, likely-duplicate entries on the same day/amount, suspiciously round numbers, a particular that doesn\'t match its assigned category). Do not comment on rent/food revenue or on category-level trends here - that belongs in the summary, not in anomalies.',
    'If nothing looks anomalous, return an empty anomalies array. Never invent an anomaly to fill the list.',
    'Use ONLY the numbers present in the JSON provided. Never invent, estimate, or assume a figure that is not given. If "previous" is null, do not fabricate a month-over-month comparison.',
    'Output must strictly match the provided JSON schema.'
  ].join(' ');

  return {
    model: AI_MODEL,
    temperature: 0.3,
    max_completion_tokens: 1200,
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
