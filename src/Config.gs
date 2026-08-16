/**
 * Config: source spreadsheets, month parsing, expense categorisation.
 */

// Dream only: owner-estimated cost of in-house kitchen/ingredients as a % of
// food revenue, not recorded anywhere in the books (owner-confirmed July
// 2026 — Dream's books have zero entries under "Kitchen & Groceries",
// "LPG / Gas", or "Water & Dairy", ever). Additive on top of whatever real
// food-related expense IS booked (e.g. "Outside Food" purchases) — those
// represent a different real cost, not a duplicate. Paradise already books
// real food costs across all four categories, so its foodCostPct is 0.
var HOTELS = [
  { hotel: 'Dream',    id: '1e7pwaNFInbfwoKIWTWqvGQ9gFCk7E7QfreY67Yfage4', rooms: 9, foodCostPct: 0.40 },
  { hotel: 'Paradise', id: '18ar_kORdq952C25JJVo6L0rBTHv-hTZBoDy8xD302tQ', rooms: 5, foodCostPct: 0 }
];

// Fixed staff salary per hotel per month, not recorded in the books
// (owner-confirmed July 2026). Prorated for the in-progress month.
var SALARY_PER_HOTEL_MONTH = 50000;

// Canonical room list per hotel for the entry app's Room dropdown. Fixed
// lists make a mistyped room impossible and let the app write a clean
// Room/Source instead of relying on the parser's OYO/Walk-in guessing.
// TODO(owner): replace these placeholders with the REAL room labels used in
// the books — include any non-numeric ones like 'BAR AREA' or 'T-20' if they
// occur. Counts should match HOTELS[].rooms (Dream 9, Paradise 5).
var ROOMS_BY_HOTEL = {
  Dream: ['401', '402', '403', '404', '405', '406', '301', '302', '303'],
  Paradise: ['108', '109', '110', '111', '112']
};

var MONTH_INDEX = {
  JAN: 1, FEB: 2, MAR: 3, APR: 4, MAY: 5, JUN: 6,
  JUL: 7, AUG: 8, SEP: 9, OCT: 10, NOV: 11, DEC: 12
};

/**
 * Tab name -> {year, month} or null.
 * Handles "AUGUST'24", "OCTOBER.24", "DEC -25", "JAN 26", "SEPT25", "APRIL-26"...
 */
function tabMonth(name) {
  var s = String(name).toUpperCase();
  var alpha = s.replace(/[^A-Z]/g, '').slice(0, 3);
  var mon = MONTH_INDEX[alpha];
  var yr = s.match(/(\d{2})\s*$/);
  if (!mon || !yr) return null;
  return { year: 2000 + Number(yr[1]), month: mon };
}

/**
 * Expense "Particulers" -> category. Ordered rules; first match wins.
 * Spellings observed in the books: KICHEN/KITCHEN, GENAREL/GENEREL/GENERAL,
 * COMITION/COMMITION, LOUNDRY/LAUNDRY, GENERETOR/GENERATOR, DISEL, BOTTOL...
 */
var CATEGORY_RULES = [
  [/gst/i,                                            'GST Payable'],
  [/extra\s*savings/i,                                'Owner Savings (7%)'],
  [/paid\s*to|probas|provash|pravash|salary|wages|advance/i, 'Staff & Contractor Payments'],
  [/kich|kitch|vegit|vegetable|grocer|salt|sugar|onion|ginger|butter|cream|laddu/i, 'Kitchen & Groceries'],
  [/out\s*side\s*food|outside\s*food|boss\s*food/i,   'Outside Food'],
  [/water|milk|tea\b/i,                               'Water & Dairy'],
  [/laundry|loundry/i,                                'Laundry'],
  [/gener[ae]tor|\bdg\b|disel|diesel|petrol|fuel/i,   'Generator & Fuel'],
  [/lpg|\bgas\b/i,                                    'LPG / Gas'],
  [/electric|light|current\s*bill/i,                  'Electricity'],
  [/travel|transport|auto|fare|faer|toto/i,           'Travel & Transport'],
  [/com+ition|commission/i,                           'Commission'],
  [/tax|panchayat/i,                                  'Taxes & Govt'],
  [/donation|p\/s\s*exp/i,                            'Donations & Local'],
  [/damage|bed\s*exp|matteress|mattress|furniture|t\.?v\b/i, 'Assets & Property'],
  [/repair|mainten|maintain|mistry|paint|plumb|welding|fitting/i, 'Repairs & Maintenance'],
  [/clean|phynyl|mosquito|match\s*box|broom/i,        'Cleaning & Consumables'],
  [/puja|flower|dhunochi|festival/i,                  'Puja & Festival'],
  [/print|station[ae]ry/i,                            'Printing & Stationery'],
  [/rent\b/i,                                         'Rent & Hire'],
  [/discount/i,                                       'Discounts Given'],
  [/laptop|mobile|recharge|internet|wifi/i,           'Tech & Comms']
];

function categorize(particular) {
  var p = String(particular || '').trim();
  if (!p) return 'General & Misc';
  for (var i = 0; i < CATEGORY_RULES.length; i++) {
    if (CATEGORY_RULES[i][0].test(p)) return CATEGORY_RULES[i][1];
  }
  return 'General & Misc';
}

// Model for the on-demand "Run AI Analysis" button (AI.gs). gpt-4.1 is a
// strong non-reasoning model that keeps the exact same Chat Completions
// request path as before — standard "temperature", "max_completion_tokens",
// and strict json_schema Structured Outputs, with no reasoning-model quirks.
// If you swap to a reasoning model later (e.g. gpt-5-mini) test one call
// first — reasoning models need a "reasoning_effort" param this code doesn't
// send, and may reject "temperature".
// NOTE: the OpenAI API key is NOT here. It lives only in Script Properties
// (Apps Script editor > Project Settings > Script Properties), set once by
// the owner directly in the editor UI, and is never committed to source.
var AI_MODEL = 'gpt-4.1';

// Safety cap on expense line items sent to OpenAI in one AI Analysis call.
// Typical month has 50-150 rows (well under this); this just bounds
// cost/latency in the unusual case of an outsized month.
var AI_MAX_EXPENSE_ROWS = 400;

// How many trailing months (including the current one) of compact KPI
// snapshots to feed the AI so it can read trends and give an early-warning
// forecast. Mirrored client-side as AI_TREND_MONTHS in Index.html.
var AI_TREND_MONTHS = 6;
