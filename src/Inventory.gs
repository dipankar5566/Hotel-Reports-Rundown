/**
 * Inventory.gs: staff PWA stock tracking for both hotels (linens, cleaning
 * supplies, room amenities, stationery, small appliances — the shared
 * catalog lives in Config.gs's INVENTORY_ITEMS).
 *
 * Split like the rest of the project into a PURE core (Node-testable — no
 * SpreadsheetApp/Utilities/Lock) and a THIN GAS boundary (opens books, takes
 * a script lock, writes cells, invalidates the dashboard cache).
 *
 * Unlike rent/food/expense/recovery, these are NOT month tabs — one
 * "Inventory Items" tab (live per-item running stock) and one "Inventory
 * Log" tab (append-only transaction ledger) per hotel book, created once and
 * reused forever. tabMonth() returns null for both names, so they're
 * automatically invisible to the P&L parser (buildPayloadFromBooks_'s
 * `if (!ym) return;` filter) and to validateAll() ("NOT MONTHLY") with zero
 * Parser.gs changes.
 *
 * Three transaction types, always recorded as a signed delta actually
 * applied to Current Stock — this one invariant is what makes delete's
 * reversal correct for all three types with no branching:
 *   Purchase: +qty      Usage: -qty      Recount: countedTotal - liveStock
 *
 * No cost/valuation anywhere — pure quantity tracking, zero interaction
 * with Aggregate.gs's revenue/expense/net.
 */

/* ------------------------------ PURE CORE ------------------------------ */

var INVENTORY_ITEMS_TAB_ = 'Inventory Items';
var INVENTORY_LOG_TAB_ = 'Inventory Log';
var INVENTORY_ITEMS_HEADER_ = ['Item', 'Current Stock', 'Min Stock', 'Last Updated'];
var INVENTORY_LOG_HEADER_ = ['Date', 'Item', 'Type', 'Qty Change', 'Resulting Stock',
  'Reason', 'Remark', 'Entered by', '_entryId'];
var INVENTORY_TXN_TYPES_ = ['Purchase', 'Usage', 'Recount'];
var INVENTORY_USAGE_REASONS_ = ['Used', 'Damaged', 'Lost', 'Given away', 'Other'];

// A daily, staff-submitted, permanent snapshot of the live stock numbers
// above ("closing stock statement" for the owner) — a third non-month tab,
// same tabMonth()-safety as INVENTORY_ITEMS_TAB_/INVENTORY_LOG_TAB_ ("Closing
// Stock" -> "CLO" -> not a MONTH_INDEX key). One row per catalog item per
// submission (long/normalized, matches this codebase's style everywhere
// else); Statement Id groups a batch back together and disambiguates
// same-day re-submissions. Immutable — no edit/delete for v1.
var CLOSING_STOCK_TAB_ = 'Closing Stock';
var CLOSING_STOCK_HEADER_ = ['Date', 'Item', 'Category', 'Current Stock', 'Min Stock', 'Low',
  'Submitted By', 'Submitted At', 'Statement Id'];

/** One row -> {item, currentStock, minStock, lastUpdated} or null if blank.
 * `lastUpdated` is stringified (never a raw Date): a Date object anywhere in a
 * google.script.run return value makes the whole response arrive as `null` on
 * the client — silently, via the SUCCESS handler, not the failure handler.
 * This is exactly the Paradise-only empty-dropdown bug (its one stock row had
 * a Date in Last Updated; Dream's tab had no dated rows so it serialized fine).
 * Every other cross-bridge read here already stringifies dates (listInventoryLog
 * etc.); this was the one spot that leaked a raw Date. */
function parseInventoryItemRow_(row) {
  var item = String(row[0] || '').trim();
  if (!item) return null;
  var minRaw = row[2];
  return {
    item: item,
    currentStock: num_(row[1]) || 0,
    minStock: (minRaw === '' || minRaw === null || minRaw === undefined) ? null : num_(minRaw),
    lastUpdated: row[3] instanceof Date ? closingDateKey_(row[3]) : (row[3] || '')
  };
}

/** Inventory Items sheet values -> {byName: {normName: row+rowIndex}, list: [row]}. */
function parseInventoryItemsSheet_(values) {
  var byName = {}, list = [];
  for (var r = 1; r < values.length; r++) {
    var parsed = parseInventoryItemRow_(values[r]);
    if (!parsed) continue;
    parsed.rowIndex = r;
    byName[norm_(parsed.item)] = parsed;
    list.push(parsed);
  }
  return { byName: byName, list: list };
}

/**
 * Merge the shared catalog (Config.gs's INVENTORY_ITEMS, hotel-filtered) with
 * one hotel's live "Inventory Items" rows. Every catalog item appears exactly
 * once even with no row yet (stock 0 / default MinStock). A sheet row whose
 * name fell out of the catalog (retired/renamed in Config.gs) is appended
 * tagged orphaned:true — same vocabulary as Report.gs's recovery "orphaned"
 * flag — so existing stock is never silently hidden. View-only: never writes.
 */
function buildInventoryStockView_(values, hotel) {
  var idx = parseInventoryItemsSheet_(values || [INVENTORY_ITEMS_HEADER_]);
  var seen = {};
  var catalog = INVENTORY_ITEMS.filter(function (it) { return !it.hotelOnly || it.hotelOnly === hotel; });
  var out = catalog.map(function (it) {
    var hit = idx.byName[norm_(it.name)];
    seen[norm_(it.name)] = true;
    var currentStock = hit ? hit.currentStock : 0;
    var minStock = (hit && hit.minStock !== null) ? hit.minStock : INVENTORY_DEFAULT_MIN_STOCK;
    return {
      item: it.name, category: it.category, currentStock: currentStock, minStock: minStock,
      lastUpdated: hit ? hit.lastUpdated : '', low: currentStock <= minStock, orphaned: false
    };
  });
  idx.list.forEach(function (r) {
    if (seen[norm_(r.item)]) return;
    var minStock = r.minStock !== null ? r.minStock : INVENTORY_DEFAULT_MIN_STOCK;
    out.push({
      item: r.item, category: 'Other', currentStock: r.currentStock, minStock: minStock,
      lastUpdated: r.lastUpdated, low: r.currentStock <= minStock, orphaned: true
    });
  });
  return out;
}

/**
 * Validate + normalize a submitted transaction. Throws a descriptive Error
 * on bad input (mirrors Entry.gs's normalizeEntryPayload_). Recount's actual
 * delta can't be computed here — it needs the LIVE stock, read inside the
 * GAS boundary's lock — so qty is returned null for Recount; rawQty (the
 * counted total) is what the caller diffs against the live value.
 */
function normalizeInventoryPayload_(payload) {
  payload = payload || {};
  var hotel = payload.hotel;
  var item = String(payload.item || '').trim();
  if (!isKnownInventoryItem_(item, hotel)) throw new Error('Unknown item: ' + item);
  var type = payload.type;
  if (INVENTORY_TXN_TYPES_.indexOf(type) === -1) throw new Error('Bad transaction type: ' + type);
  var d = payload.date || {};
  var year = Number(d.year), month = Number(d.month), day = Number(d.day);
  if (!(year >= 2000) || !(month >= 1 && month <= 12) || !(day >= 1 && day <= 31)) {
    throw new Error('Invalid date.');
  }
  var enteredBy = String(payload.enteredBy || '').trim();
  var remark = String(payload.remark || '').trim();
  var reason = '', qty, rawQty = Number(payload.qty);

  if (type === 'Recount') {
    if (!(rawQty >= 0)) throw new Error('Counted quantity must be zero or a positive number.');
    qty = null;
  } else {
    if (!(rawQty > 0)) throw new Error('Quantity must be a positive number.');
    qty = type === 'Purchase' ? rawQty : -rawQty;
    if (type === 'Usage') {
      reason = String(payload.reason || '').trim();
      if (INVENTORY_USAGE_REASONS_.indexOf(reason) === -1) throw new Error('Pick a reason for the usage.');
      if (reason === 'Other' && !remark) throw new Error('"Other" needs a Remark describing the usage.');
    }
  }
  return {
    hotel: hotel, item: item, type: type, qty: qty, rawQty: rawQty, reason: reason,
    remark: remark, enteredBy: enteredBy, year: year, month: month, day: day
  };
}

/** Date -> 'YYYY-MM-DD', local-calendar-day key (mirrors Entry.gs's small
 * date-formatting helpers like shortDateLabel_). */
function closingDateKey_(d) {
  var p = function (n) { return (n < 10 ? '0' : '') + n; };
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
}

/** A buildInventoryStockView_ result + submission metadata -> the exact rows
 * to write (one per catalog item), in CLOSING_STOCK_HEADER_ column order. */
function buildClosingStockRows_(stock, meta) {
  return stock.map(function (s) {
    return [meta.date, s.item, s.category, s.currentStock, s.minStock, s.low,
      meta.submittedBy, meta.submittedAt, meta.statementId];
  });
}

/** Inverse of buildClosingStockRows_: sheet values -> parsed row objects. */
function parseClosingStockSheet_(values) {
  var out = [];
  for (var r = 1; r < values.length; r++) {
    var row = values[r];
    if (!row[8]) continue; // no Statement Id -> blank/malformed row
    var d = row[0] instanceof Date ? row[0] : new Date(row[0]);
    var sa = row[7] instanceof Date ? row[7] : new Date(row[7]);
    out.push({
      date: closingDateKey_(d), item: row[1], category: row[2],
      currentStock: num_(row[3]) || 0, minStock: num_(row[4]) || 0, low: !!row[5],
      submittedBy: row[6] || '', submittedAt: sa, statementId: String(row[8]), rowIndex: r
    });
  }
  return out;
}

/** Parsed rows -> one entry per submission, newest submittedAt first. Feeds
 * both the staff-facing status/history list and generateClosingStockPdf's
 * (Report.gs) "which submission for date X" lookup. */
function groupClosingStockByStatement_(rows) {
  var byId = {};
  rows.forEach(function (r) {
    if (!byId[r.statementId]) {
      byId[r.statementId] = {
        statementId: r.statementId, date: r.date, submittedBy: r.submittedBy,
        submittedAt: r.submittedAt, items: []
      };
    }
    byId[r.statementId].items.push(r);
  });
  return Object.keys(byId).map(function (id) { return byId[id]; })
    .sort(function (a, b) { return b.submittedAt.getTime() - a.submittedAt.getTime(); });
}

/* ----------------------------- GAS BOUNDARY ---------------------------- */

function findOrCreateInventoryItemsSheet_(ss) {
  var sheet = ss.getSheetByName(INVENTORY_ITEMS_TAB_);
  if (sheet) return sheet;
  sheet = ss.insertSheet(INVENTORY_ITEMS_TAB_);
  sheet.getRange(1, 1, 1, INVENTORY_ITEMS_HEADER_.length).setValues([INVENTORY_ITEMS_HEADER_]);
  sheet.setFrozenRows(1);
  return sheet;
}

function findOrCreateInventoryLogSheet_(ss) {
  var sheet = ss.getSheetByName(INVENTORY_LOG_TAB_);
  if (sheet) return sheet;
  sheet = ss.insertSheet(INVENTORY_LOG_TAB_);
  sheet.getRange(1, 1, 1, INVENTORY_LOG_HEADER_.length).setValues([INVENTORY_LOG_HEADER_]);
  sheet.setFrozenRows(1);
  return sheet;
}

/** Find-only, never creates. Returns null if the tab or the item's row
 * doesn't exist yet (mirrors Entry.gs's findDueRowById_ contract). */
function findItemRowByName_(ss, itemName) {
  var sheet = ss.getSheetByName(INVENTORY_ITEMS_TAB_);
  if (!sheet) return null;
  var idx = parseInventoryItemsSheet_(sheet.getDataRange().getValues());
  var hit = idx.byName[norm_(itemName)];
  if (!hit) return null;
  return { sheet: sheet, rowNum: hit.rowIndex + 1, currentStock: hit.currentStock, minStock: hit.minStock };
}

/** Creates the tab (if missing) and/or a bootstrap row (stock 0, default Min
 * Stock) for itemName if either doesn't exist yet. Always returns a hit —
 * the row-level analogue of Entry.gs's ensureXColumn_ column-level retrofits. */
function ensureItemRow_(ss, itemName) {
  var hit = findItemRowByName_(ss, itemName);
  if (hit) return hit;
  var sheet = findOrCreateInventoryItemsSheet_(ss);
  var lastRow = sheet.getLastRow();
  var rowNum = Math.max(lastRow + 1, 2);
  sheet.getRange(rowNum, 1, 1, 4).setValues([[itemName, 0, INVENTORY_DEFAULT_MIN_STOCK, '']]);
  return { sheet: sheet, rowNum: rowNum, currentStock: 0, minStock: INVENTORY_DEFAULT_MIN_STOCK };
}

/** Live-cell-adjustment analogue of Entry.gs's adjustDueCell_: bumps
 * itemName's Current Stock by `delta` and stamps Last Updated. Never clamps
 * to zero (same philosophy as Report.gs's unclamped `outstanding`). Returns
 * false if the row can't be found (callers needing it to exist call
 * ensureItemRow_ first). */
function adjustStockCell_(ss, itemName, delta) {
  var hit = findItemRowByName_(ss, itemName);
  if (!hit) return false;
  var cell = hit.sheet.getRange(hit.rowNum, 2);
  var next = (num_(cell.getValue()) || 0) + delta;
  cell.setValue(next);
  hit.sheet.getRange(hit.rowNum, 4).setValue(new Date());
  return next;
}

/** Scans the Inventory Log for a row by its _entryId. Returns
 * {rowNum, item, type, delta} or null. */
function findInventoryLogRowById_(logSheet, entryId) {
  var values = logSheet.getDataRange().getValues();
  var idCol = INVENTORY_LOG_HEADER_.length - 1; // _entryId is always rightmost
  for (var r = 1; r < values.length; r++) {
    if (String(values[r][idCol]) === String(entryId)) {
      return { rowNum: r + 1, item: String(values[r][1] || ''), type: values[r][2], delta: num_(values[r][3]) || 0 };
    }
  }
  return null;
}

/** Client bootstrap: verify PIN, return catalog/reasons/types + first stock snapshot. */
// `items` was dropped from this response (Sep 2026): knownInventoryItems_'s
// raw catalog objects are non-uniform in shape for Paradise specifically
// (Property Stamper alone carries an extra hotelOnly key) — the one
// structural difference between Dream's and Paradise's payload, and the
// prime suspect for a google.script.run browser-bridge serialization
// failure that left Paradise's entire response empty on the client while
// Dream's (fully uniform items array) worked fine. `stock` already carries
// {item, category, ...} for every catalog entry via a reconstructed,
// always-uniform shape (buildInventoryStockView_ never copies hotelOnly
// through), so the client builds its item picker from that instead — see
// Form.html's buildItemSelect. knownInventoryItems_/isKnownInventoryItem_
// are unchanged and still used for server-side validation.
function getInventoryConfig(hotel, pin) {
  verifyPin_(hotel, pin);
  return {
    hotel: hotel,
    categories: INVENTORY_CATEGORIES.slice(),
    reasons: INVENTORY_USAGE_REASONS_.slice(),
    types: INVENTORY_TXN_TYPES_.slice(),
    stock: getInventoryStock(hotel, pin)
  };
}

function getInventoryStock(hotel, pin) {
  verifyPin_(hotel, pin);
  var ss = SpreadsheetApp.openById(hotelCfg_(hotel).id);
  var sheet = ss.getSheetByName(INVENTORY_ITEMS_TAB_);
  var values = sheet ? sheet.getDataRange().getValues() : [INVENTORY_ITEMS_HEADER_];
  return buildInventoryStockView_(values, hotel);
}

function submitInventoryTxn(payload) {
  var hotel = (payload || {}).hotel;
  verifyPin_(hotel, (payload || {}).pin);
  var norm = normalizeInventoryPayload_(payload);
  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    var ss = SpreadsheetApp.openById(hotelCfg_(hotel).id);
    var hit = ensureItemRow_(ss, norm.item);
    var delta = norm.type === 'Recount' ? (norm.rawQty - hit.currentStock) : norm.qty;
    var resultingStock = adjustStockCell_(ss, norm.item, delta);
    var logSheet = findOrCreateInventoryLogSheet_(ss);
    var entryId = Utilities.getUuid();
    logSheet.getRange(logSheet.getLastRow() + 1, 1, 1, INVENTORY_LOG_HEADER_.length).setValues([[
      new Date(norm.year, norm.month - 1, norm.day), norm.item, norm.type, delta,
      resultingStock, norm.reason, norm.remark, norm.enteredBy, entryId
    ]]);
    invalidateDashboardCache_();
    return { ok: true, entryId: entryId, resultingStock: resultingStock, delta: delta };
  } finally {
    lock.releaseLock();
  }
}

/** Reverses exactly the logged delta (not a re-diff against current stock,
 * so it's well-defined even if later transactions have since moved the
 * balance) and clears the log row (same "clear, don't remove" idiom as
 * Entry.gs's deleteEntry). No delete-guard needed — nothing else references
 * an inventory log row as a foreign key. */
function deleteInventoryTxn(hotel, pin, entryId) {
  verifyPin_(hotel, pin);
  if (!entryId) throw new Error('No entryId to delete.');
  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    var ss = SpreadsheetApp.openById(hotelCfg_(hotel).id);
    var logSheet = ss.getSheetByName(INVENTORY_LOG_TAB_);
    var hit = logSheet && findInventoryLogRowById_(logSheet, entryId);
    if (!hit) throw new Error('Entry not found (it may already have been deleted).');
    adjustStockCell_(ss, hit.item, -hit.delta);
    logSheet.getRange(hit.rowNum, 1, 1, INVENTORY_LOG_HEADER_.length)
      .setValues([INVENTORY_LOG_HEADER_.map(function () { return ''; })]);
    invalidateDashboardCache_();
    return { ok: true, entryId: entryId };
  } finally {
    lock.releaseLock();
  }
}

/** Newest-first transaction history. */
function listInventoryLog(hotel, pin) {
  verifyPin_(hotel, pin);
  var ss = SpreadsheetApp.openById(hotelCfg_(hotel).id);
  var sheet = ss.getSheetByName(INVENTORY_LOG_TAB_);
  if (!sheet) return [];
  var values = sheet.getDataRange().getValues();
  var idCol = INVENTORY_LOG_HEADER_.length - 1;
  var out = [];
  for (var r = 1; r < values.length; r++) {
    var row = values[r];
    if (!row[idCol]) continue; // cleared/deleted row
    out.push({
      entryId: String(row[idCol]),
      date: row[0] instanceof Date ? row[0].toISOString().slice(0, 10) : String(row[0] || ''),
      item: row[1], type: row[2], qty: num_(row[3]) || 0, resultingStock: num_(row[4]) || 0,
      reason: row[5] || '', remark: row[6] || '', enteredBy: row[7] || ''
    });
  }
  return out.reverse();
}

function findOrCreateClosingStockSheet_(ss) {
  var sheet = ss.getSheetByName(CLOSING_STOCK_TAB_);
  if (sheet) return sheet;
  sheet = ss.insertSheet(CLOSING_STOCK_TAB_);
  sheet.getRange(1, 1, 1, CLOSING_STOCK_HEADER_.length).setValues([CLOSING_STOCK_HEADER_]);
  sheet.setFrozenRows(1);
  return sheet;
}

/** One-tap freeze of today's live stock into a permanent record. Locked —
 * two staff submitting in the same instant would otherwise both compute the
 * same getLastRow() before either writes (the same append race every other
 * write path in this codebase guards against), even though there's no
 * delta-math to protect here. No invalidateDashboardCache_()/CACHE_KEY bump:
 * getDashboardData()'s payload never reads this tab. */
function submitClosingStock(hotel, pin, enteredBy) {
  verifyPin_(hotel, pin);
  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    var ss = SpreadsheetApp.openById(hotelCfg_(hotel).id);
    var itemsSheet = ss.getSheetByName(INVENTORY_ITEMS_TAB_);
    var itemsValues = itemsSheet ? itemsSheet.getDataRange().getValues() : [INVENTORY_ITEMS_HEADER_];
    var stock = buildInventoryStockView_(itemsValues, hotel);
    var now = new Date();
    var meta = {
      date: now, submittedBy: String(enteredBy || '').trim(), submittedAt: now,
      statementId: Utilities.getUuid()
    };
    var rows = buildClosingStockRows_(stock, meta);
    var sheet = findOrCreateClosingStockSheet_(ss);
    sheet.getRange(sheet.getLastRow() + 1, 1, rows.length, CLOSING_STOCK_HEADER_.length).setValues(rows);
    return { statementId: meta.statementId, submittedAt: now.toISOString(), itemCount: rows.length };
  } finally {
    lock.releaseLock();
  }
}

/** Newest-first list of past submissions (grouped, not every row) — for the
 * staff PWA's status line and date-picker sanity-checking. */
function listClosingStockSubmissions(hotel, pin) {
  verifyPin_(hotel, pin);
  var ss = SpreadsheetApp.openById(hotelCfg_(hotel).id);
  var sheet = ss.getSheetByName(CLOSING_STOCK_TAB_);
  if (!sheet) return [];
  var rows = parseClosingStockSheet_(sheet.getDataRange().getValues());
  var groups = groupClosingStockByStatement_(rows);
  return groups.map(function (g) {
    return {
      statementId: g.statementId, date: g.date, submittedBy: g.submittedBy,
      submittedAt: g.submittedAt.toISOString(), itemCount: g.items.length
    };
  });
}

// Node-harness export (ignored inside GAS, where `module` is undefined).
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    parseInventoryItemRow_: parseInventoryItemRow_, parseInventoryItemsSheet_: parseInventoryItemsSheet_,
    buildInventoryStockView_: buildInventoryStockView_, normalizeInventoryPayload_: normalizeInventoryPayload_,
    findOrCreateInventoryItemsSheet_: findOrCreateInventoryItemsSheet_,
    findOrCreateInventoryLogSheet_: findOrCreateInventoryLogSheet_,
    findItemRowByName_: findItemRowByName_, ensureItemRow_: ensureItemRow_,
    adjustStockCell_: adjustStockCell_, findInventoryLogRowById_: findInventoryLogRowById_,
    getInventoryConfig: getInventoryConfig, getInventoryStock: getInventoryStock,
    submitInventoryTxn: submitInventoryTxn, deleteInventoryTxn: deleteInventoryTxn,
    listInventoryLog: listInventoryLog,
    closingDateKey_: closingDateKey_, buildClosingStockRows_: buildClosingStockRows_,
    parseClosingStockSheet_: parseClosingStockSheet_, groupClosingStockByStatement_: groupClosingStockByStatement_,
    findOrCreateClosingStockSheet_: findOrCreateClosingStockSheet_,
    submitClosingStock: submitClosingStock, listClosingStockSubmissions: listClosingStockSubmissions,
    INVENTORY_ITEMS_TAB_: INVENTORY_ITEMS_TAB_, INVENTORY_LOG_TAB_: INVENTORY_LOG_TAB_,
    INVENTORY_ITEMS_HEADER_: INVENTORY_ITEMS_HEADER_, INVENTORY_LOG_HEADER_: INVENTORY_LOG_HEADER_,
    INVENTORY_TXN_TYPES_: INVENTORY_TXN_TYPES_, INVENTORY_USAGE_REASONS_: INVENTORY_USAGE_REASONS_,
    CLOSING_STOCK_TAB_: CLOSING_STOCK_TAB_, CLOSING_STOCK_HEADER_: CLOSING_STOCK_HEADER_
  };
}
