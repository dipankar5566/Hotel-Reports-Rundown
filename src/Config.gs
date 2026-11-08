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

// The fixed set of category labels the entry-app dropdown offers and Parser.gs
// checks a Particulars cell against (isKnownCategory_) before falling back to
// categorize()'s regex guess. Single source of truth for both.
function knownCategories_() {
  var cats = CATEGORY_RULES.map(function (r) { return r[1]; });
  cats.push('General & Misc');
  return cats.filter(function (c, i) { return cats.indexOf(c) === i; });
}

function isKnownCategory_(text) {
  var t = String(text || '').trim();
  if (!t) return false;
  var cats = knownCategories_();
  for (var i = 0; i < cats.length; i++) {
    if (cats[i].toLowerCase() === t.toLowerCase()) return true;
  }
  return false;
}

// Shared inventory item catalog. Dream and Paradise stock the same items;
// each hotel's OWN "Inventory Items" tab holds that hotel's stock number —
// this array is only ever the fixed set of valid NAMES + metadata, same
// role CATEGORY_RULES plays for expense categories. Owner adds/renames
// items HERE (a code change), same workflow as ROOMS_BY_HOTEL.
// `hotelOnly` (optional) hides the item from the other hotel's picker —
// same mechanism Form.html already uses for Paradise's Dream Food Amount.
// Seeded Sep 2026 from Paradise's informal tracking sheet; both hotels
// start every item at 0 stock (owner declined to import old counts).
// A few names are best-guess typo cleanups needing an owner glance before
// go-live: 'Plastic Stool' (was "PLASTIC TOOL"), 'Staplex' (kept verbatim,
// likely staple pins), 'Gripper' (was "GRIPER", meaning unclear), 'Catcher'
// (kept verbatim, meaning unclear), 'Collin' (kept verbatim - maybe
// cologne/spray), 'Soap Dispenser' (was "SHOP DISPENSER", guessed typo).
var INVENTORY_ITEMS = [
  { name: 'Big Towel', category: 'Housekeeping' },
  { name: 'Hand Towel', category: 'Housekeeping' },
  { name: 'Bed Cover', category: 'Housekeeping' },
  { name: 'Pillow Cover', category: 'Housekeeping' },
  { name: 'Pillow', category: 'Housekeeping' },
  { name: 'Cushion Pillow', category: 'Housekeeping' },
  { name: 'Blanket', category: 'Housekeeping' },
  { name: 'Blanket Cover', category: 'Housekeeping' },
  { name: 'Bathroom Mat', category: 'Housekeeping' },
  { name: 'Carpet', category: 'Housekeeping' },
  { name: 'Toilet Mug', category: 'Housekeeping' },
  { name: 'Bathroom Bucket', category: 'Housekeeping' },
  { name: 'Toilet Folding Brush', category: 'Housekeeping' },
  { name: 'Toilet Cleaning Gloves', category: 'Housekeeping' },
  { name: 'Soap Dispenser', category: 'Housekeeping' },
  { name: 'Jharu', category: 'Housekeeping' },
  { name: 'Swing Broom', category: 'Housekeeping' },
  { name: 'Mop', category: 'Housekeeping' },
  { name: 'Belcha', category: 'Housekeeping' },
  { name: 'Dustbin', category: 'Housekeeping' },
  { name: 'Garbage Bag', category: 'Housekeeping' },
  { name: 'Duster', category: 'Housekeeping' },
  { name: 'Laundry Basket', category: 'Housekeeping' },
  { name: 'Room Freshener (SPR)', category: 'Housekeeping' },
  { name: 'Air Revitalizer', category: 'Housekeeping' },
  { name: 'Godrej Aer Pocket', category: 'Housekeeping' },
  { name: 'All Out Machine', category: 'Housekeeping' },
  { name: 'All Out Refill', category: 'Housekeeping' },
  { name: 'Harpic', category: 'Housekeeping' },
  { name: 'Phenyl', category: 'Housekeeping' },
  { name: 'Clinar', category: 'Housekeeping' },
  { name: 'Shampoo', category: 'Housekeeping' },
  { name: 'Soap', category: 'Housekeeping' },
  { name: 'Hand Wash', category: 'Housekeeping' },
  { name: 'Toothpaste', category: 'Housekeeping' },
  { name: 'Toothbrush', category: 'Housekeeping' },
  { name: 'Comb', category: 'Housekeeping' },
  { name: 'Collin', category: 'Housekeeping' },
  { name: 'Tissue', category: 'Housekeeping' },
  { name: 'Tissue Stand', category: 'Housekeeping' },
  { name: 'Ashtray', category: 'Housekeeping' },
  { name: 'Umbrella', category: 'Housekeeping' },
  { name: 'Agarbati Stand', category: 'Housekeeping' },
  { name: 'Whisky Glass', category: 'Kitchen & Dining' },
  { name: 'Water Glass', category: 'Kitchen & Dining' },
  { name: 'Glass Mug (180ml)', category: 'Kitchen & Dining' },
  { name: 'Glass Mug (500ml)', category: 'Kitchen & Dining' },
  { name: 'Water Bottle (500ml)', category: 'Kitchen & Dining' },
  { name: 'Water Bottle (1L)', category: 'Kitchen & Dining' },
  { name: 'Plastic Bottle', category: 'Kitchen & Dining' },
  { name: 'Toothpicks', category: 'Kitchen & Dining' },
  { name: 'Fork & Spoon', category: 'Kitchen & Dining' },
  { name: 'Spoon', category: 'Kitchen & Dining' },
  { name: 'Tea Spoon', category: 'Kitchen & Dining' },
  { name: 'Tea Plate', category: 'Kitchen & Dining' },
  { name: 'Dinner Plate', category: 'Kitchen & Dining' },
  { name: 'Quarter Plates', category: 'Kitchen & Dining' },
  { name: 'Chinese Bowl', category: 'Kitchen & Dining' },
  { name: 'Roti Basket', category: 'Kitchen & Dining' },
  { name: 'Hot Pot', category: 'Kitchen & Dining' },
  { name: 'Salt Pot', category: 'Kitchen & Dining' },
  { name: 'Service Tray', category: 'Kitchen & Dining' },
  { name: 'Small Plastic Food Storage Containers', category: 'Kitchen & Dining' },
  { name: 'Medium Plastic Food Storage Containers', category: 'Kitchen & Dining' },
  { name: 'Vim Bar Soap', category: 'Kitchen & Dining' },
  { name: 'Milk Boiler', category: 'Kitchen & Dining' },
  { name: 'Arch File', category: 'Office & Stationery' },
  { name: 'Document Folder', category: 'Office & Stationery' },
  { name: 'Copy Book', category: 'Office & Stationery' },
  { name: 'Register Book', category: 'Office & Stationery' },
  { name: 'Room Journal Book', category: 'Office & Stationery' },
  { name: 'Attendance Register', category: 'Office & Stationery' },
  { name: 'Cash Book', category: 'Office & Stationery' },
  { name: 'Advance Book', category: 'Office & Stationery' },
  { name: 'GST Bill Book', category: 'Office & Stationery' },
  { name: 'Hotel Booking Form Pad', category: 'Office & Stationery' },
  { name: 'Carbon Paper', category: 'Office & Stationery' },
  { name: 'Paid Stamp', category: 'Office & Stationery' },
  { name: 'Property Stamper', category: 'Office & Stationery', hotelOnly: 'Paradise' },
  { name: 'Pen Holder', category: 'Office & Stationery' },
  { name: 'Marker Pen', category: 'Office & Stationery' },
  { name: 'Correction Pen', category: 'Office & Stationery' },
  { name: 'Glue Stick', category: 'Office & Stationery' },
  { name: 'Eraser', category: 'Office & Stationery' },
  { name: 'Pencil Sharpener', category: 'Office & Stationery' },
  { name: 'Scissors', category: 'Office & Stationery' },
  { name: 'Stapler', category: 'Office & Stationery' },
  { name: 'Staplex', category: 'Office & Stationery' },
  { name: 'Puncher', category: 'Office & Stationery' },
  { name: 'Tape', category: 'Office & Stationery' },
  { name: 'Office Pin', category: 'Office & Stationery' },
  { name: 'Nickel Plated Round Clips', category: 'Office & Stationery' },
  { name: 'Steel Clip', category: 'Office & Stationery' },
  { name: 'Gripper', category: 'Office & Stationery' },
  { name: 'Catcher', category: 'Office & Stationery' },
  { name: 'Paper Weight', category: 'Office & Stationery' },
  { name: 'Steel Scale', category: 'Office & Stationery' },
  { name: 'Calculator', category: 'Office & Stationery' },
  { name: 'Wall Mounted Fan', category: 'Electronics & Furniture' },
  { name: 'Exhaust Fan', category: 'Electronics & Furniture' },
  { name: 'Tube Light', category: 'Electronics & Furniture' },
  { name: 'LED Light', category: 'Electronics & Furniture' },
  { name: '3-Pin Socket', category: 'Electronics & Furniture' },
  { name: 'T.V.', category: 'Electronics & Furniture' },
  { name: 'A.C.', category: 'Electronics & Furniture' },
  { name: 'Cooler', category: 'Electronics & Furniture' },
  { name: 'Fridge / Freezer', category: 'Electronics & Furniture' },
  { name: 'Microwave Oven', category: 'Electronics & Furniture' },
  { name: 'Chair', category: 'Electronics & Furniture' },
  { name: 'Bed Table', category: 'Electronics & Furniture' },
  { name: 'Plastic Stool', category: 'Electronics & Furniture' },
  { name: 'Mattress', category: 'Electronics & Furniture' }
];

var INVENTORY_CATEGORIES = ['Housekeeping', 'Kitchen & Dining', 'Office & Stationery', 'Electronics & Furniture'];

// Bootstrap default for a brand-new item row's Min Stock (low-stock
// threshold) — fires once, the first time an item is touched with no row
// yet on a hotel's Inventory Items tab. Owner-tunable directly in the
// sheet at any time; only matters at row creation. A durable/non-consumable
// item (A.C., Mattress, Cooler, Fridge/Freezer, Microwave Oven, furniture)
// should have its row's Min Stock set to 0 explicitly (not left blank —
// blank falls back to this default) to opt out of low-stock alerting.
var INVENTORY_DEFAULT_MIN_STOCK = 2;

// Fixed set of item names the inventory picker offers and submitInventoryTxn
// validates against (isKnownInventoryItem_) — same "single source of truth,
// checked by a guard function" pattern as knownCategories_/isKnownCategory_
// above, applied to INVENTORY_ITEMS instead of CATEGORY_RULES. `hotel` filters
// out any hotelOnly item that doesn't belong to the caller's hotel.
function knownInventoryItems_(hotel) {
  return INVENTORY_ITEMS.filter(function (it) { return !it.hotelOnly || it.hotelOnly === hotel; });
}

function isKnownInventoryItem_(name, hotel) {
  var n = String(name || '').trim().toLowerCase();
  if (!n) return false;
  return knownInventoryItems_(hotel).some(function (it) { return it.name.toLowerCase() === n; });
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

// Drive file ID of each hotel's logo (PNG/JPG), shown in the closing stock PDF
// header. Leave '' for a name-only header. Owner: upload the image to Drive,
// copy the ID from its share link, paste it here.
var HOTEL_LOGO_FILE_ID = { Dream: '', Paradise: '' };
