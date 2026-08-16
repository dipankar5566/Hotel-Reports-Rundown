/**
 * Entry.gs: the daily-entry app's server side.
 *
 * Split like the rest of the project into a PURE core (Node-testable — no
 * SpreadsheetApp/Utilities/Lock) and a THIN GAS boundary (opens books, takes
 * a script lock, writes cells, invalidates the dashboard cache).
 *
 * The app appends clean, well-formed rows into the same monthly tabs the
 * dashboard reads. Two properties kill the date-typo class of bug at source:
 *   1. The date cell is written as a real Date object, so dayOf_ takes its
 *      `v instanceof Date` fast path (Parser.gs) — no text parsing, no typo.
 *   2. The picked date also selects which month tab is targeted (created if
 *      missing), so an entry can never land in the wrong month.
 * On tabs the app creates it owns the header row (canonicalLayout_ below), so
 * a mistyped "Date" header can't recur either.
 */

/* ------------------------------ PURE CORE ------------------------------ */

var ENTRY_SECTIONS_ = ['rent', 'food', 'expense'];

var MONTH_NAMES_ = ['JANUARY', 'FEBRUARY', 'MARCH', 'APRIL', 'MAY', 'JUNE',
  'JULY', 'AUGUST', 'SEPTEMBER', 'OCTOBER', 'NOVEMBER', 'DECEMBER'];

/**
 * Section -> the canonical header row the app lays down on a tab it creates.
 * Header texts are exactly what parseTab_ keys on, so a freshly created tab
 * parses with zero flags. '_entryId' is an unmapped column the parser ignores;
 * it makes in-app edit/delete deterministic (match by id, robust against any
 * coexisting manual edits).
 */
function canonicalLayout_(section) {
  if (section === 'rent') {
    return ['Date', 'Room with source', 'Source', 'Nights', 'Total revenue',
            'Cash', 'Banking & UPI', 'GST', 'Due', 'Discount', '_entryId'];
  }
  if (section === 'food') {
    return ['Date', 'Room (food & others)', 'Amount', 'Cash', 'Banking & UPI', '_entryId'];
  }
  return ['Date', 'Particulers', 'Category', 'Amount', '_entryId']; // expense
}

// Fixed left-edge column of each section on an app-created tab, plus grid
// width. Sections sit side by side with blank gap columns between them so
// detectSections_ bounds each correctly (the next anchor truncates a
// section's window well before the 3-blank guard would even trigger).
var SECTION_START_ = { rent: 0, food: 13, expense: 21 };
var CANONICAL_WIDTH_ = 26;

/** Full header row (length CANONICAL_WIDTH_) for a brand-new tab. */
function canonicalHeaderRow_() {
  var row = [];
  for (var i = 0; i < CANONICAL_WIDTH_; i++) row.push('');
  ENTRY_SECTIONS_.forEach(function (sec) {
    var start = SECTION_START_[sec];
    canonicalLayout_(sec).forEach(function (h, j) { row[start + j] = h; });
  });
  return row;
}

/**
 * Logical field -> candidate header names, mirroring parseTab_'s own colFor_
 * lookups so the write side lands in exactly the columns the read side reads.
 */
function entryFieldHeaders_(section) {
  var map = {
    amount: section === 'rent'
      ? ['total revenue', 'grand total', 'amount']
      : ['amount', 'amount(rs)'],
    cash: ['cash', 'cash/bank'],
    bank: ['banking', 'banking & upi'],
    entryId: ['_entryid']
  };
  if (section === 'rent') {
    // 'room' prefix is the catch-all: the rent anchor is always a "Room…"
    // header, so this resolves the room/append column even on legacy tabs
    // whose header is "Room no" (no period) or "Room With Source" variants.
    map.room = ['room with source', 'room no.', 'room no', 'room'];
    map.source = ['source'];
    map.nights = ['night', 'nights', 'duration of stay', 'duration'];
    map.gst = ['gst'];
    map.due = ['due'];
    map.discount = ['discount', 'dicount'];
  } else if (section === 'food') {
    map.room = ['room (food & others)', 'room'];
  } else { // expense
    map.particular = ['particulers', 'particulars'];
    map.category = ['category'];
  }
  return map;
}

/** Fields that MUST resolve or the write is refused (never misalign into a
 * legacy tab). Date is handled separately via detectSections_.dateCol. */
function essentialFields_(section) {
  return section === 'expense' ? ['particular', 'amount'] : ['room', 'amount'];
}

/** Ordered field list per section for building/writing a row. */
function entryWriteFields_(section) {
  if (section === 'rent') return ['room', 'source', 'nights', 'amount', 'cash', 'bank', 'gst', 'due', 'discount'];
  if (section === 'food') return ['room', 'amount', 'cash', 'bank'];
  return ['particular', 'category', 'amount']; // expense
}

/**
 * Resolve where each field of `section` goes in a tab's 2D values, reusing the
 * parser's own detection so read and write stay in lockstep.
 * Returns { ok, headerRow, dateCol, cols:{field->colIndex|null}, missing:[...] }.
 */
function resolveWriteCols_(values, section) {
  var det = detectSections_(values);
  if (!det) return { ok: false, missing: ['no sections detected'], cols: {} };
  var sec = null;
  for (var i = 0; i < det.sections.length; i++) {
    if (det.sections[i].type === section) { sec = det.sections[i]; break; }
  }
  if (!sec) return { ok: false, missing: ['section "' + section + '" not on tab'], cols: {} };
  var fh = entryFieldHeaders_(section);
  var cols = { date: sec.dateCol }; // date lives left of the anchor; expose it in cols too
  for (var f in fh) cols[f] = colFor_(sec.heads, fh[f]);
  var missing = [];
  essentialFields_(section).forEach(function (k) {
    if (cols[k] === null || cols[k] === undefined) missing.push(k);
  });
  if (sec.dateCol === null || sec.dateCol === undefined) missing.push('date');
  return {
    ok: missing.length === 0,
    headerRow: det.headerRow,
    dateCol: sec.dateCol,
    cols: cols,
    missing: missing
  };
}

/**
 * Cell writes for one entry, given resolved columns. Only fields with a
 * resolved column AND a provided value are included; the date is always a real
 * Date built from the picked Y/M/D (timezone-agnostic day).
 * form = { year, month, day, room, source, nights, amount, cash, bank, gst,
 *          due, discount, particular, category }.
 * Returns [{ col, value, isDate }].
 */
function buildEntryRow_(section, form, cols) {
  var writes = [];
  if (cols.date !== null && cols.date !== undefined) {
    writes.push({ col: cols.date, value: new Date(form.year, form.month - 1, form.day), isDate: true });
  }
  entryWriteFields_(section).forEach(function (f) {
    var col = cols[f];
    if (col === null || col === undefined) return;
    var v = form[f];
    if (v === null || v === undefined || v === '') return;
    writes.push({ col: col, value: v, isDate: false });
  });
  return writes;
}

/** First data row index (0-based) at/after headerRow+1 whose amount cell is
 * empty — where this section's next row is appended. Returns values.length to
 * append a brand-new row past the end. */
function findAppendRow_(values, headerRow, amountCol) {
  for (var r = headerRow + 1; r < values.length; r++) {
    var v = values[r][amountCol];
    if (v === null || v === undefined || v === '') return r;
  }
  return values.length;
}

/** Right-most resolved column of a section (for placing a retrofit id col). */
function sectionRightmostCol_(res) {
  var maxCol = res.dateCol || 0;
  for (var f in res.cols) {
    var c = res.cols[f];
    if (typeof c === 'number' && c > maxCol) maxCol = c;
  }
  return maxCol;
}

/** Tab name the app creates for a month, e.g. (2026, 8) -> "AUGUST 26".
 * Parses back cleanly via tabMonth() (3-letter month + trailing 2-digit yr). */
function monthTabName_(year, month) {
  return MONTH_NAMES_[month - 1] + ' ' + String(year).slice(-2);
}

/* ----------------------------- GAS BOUNDARY ---------------------------- */

function getEntryPin_(hotel) {
  return PropertiesService.getScriptProperties()
    .getProperty('ENTRY_PIN_' + String(hotel).toUpperCase());
}

/** Throws unless the supplied PIN matches ENTRY_PIN_<HOTEL> in Script Properties. */
function verifyPin_(hotel, pin) {
  var expected = getEntryPin_(hotel);
  if (!expected) {
    throw new Error('Entry PIN not configured for ' + hotel +
      ' — set ENTRY_PIN_' + String(hotel).toUpperCase() + ' in Script Properties.');
  }
  if (String(pin || '') !== String(expected)) throw new Error('Incorrect PIN.');
}

function hotelCfg_(hotel) {
  for (var i = 0; i < HOTELS.length; i++) if (HOTELS[i].hotel === hotel) return HOTELS[i];
  throw new Error('Unknown hotel: ' + hotel);
}

function invalidateDashboardCache_() {
  try { CacheService.getScriptCache().remove(CACHE_KEY); } catch (e) { /* best effort */ }
}

/** Client bootstrap: verify PIN, return the config the form needs to render. */
function getEntryConfig(hotel, pin) {
  verifyPin_(hotel, pin);
  return {
    hotel: hotel,
    rooms: ROOMS_BY_HOTEL[hotel] || [],
    sources: ['Walk-in', 'OYO'],
    categories: getKnownCategories_(), // shared with the AI path (AI.gs)
    sections: ENTRY_SECTIONS_.slice()
  };
}

/** Find the Sheet for (year, month) in a book, or create it with the canonical
 * 3-section header row. */
function findOrCreateMonthSheet_(ss, year, month) {
  var sheets = ss.getSheets();
  for (var i = 0; i < sheets.length; i++) {
    var ym = tabMonth(sheets[i].getName());
    if (ym && ym.year === year && ym.month === month) return sheets[i];
  }
  var sheet = ss.insertSheet(monthTabName_(year, month));
  var header = canonicalHeaderRow_();
  sheet.getRange(1, 1, 1, header.length).setValues([header]);
  sheet.setFrozenRows(1);
  return sheet;
}

/** Ensure the section has an _entryId column so edit/delete can find its rows.
 * Canonical tabs already have one. On a legacy staff tab we insert a fresh
 * column immediately right of the section's fields (headers+data move together,
 * so nothing misaligns) and label it. Returns a re-resolved cols object. */
function ensureEntryIdColumn_(sheet, values, res, section) {
  if (res.cols.entryId !== null && res.cols.entryId !== undefined) return res;
  var afterCol = sectionRightmostCol_(res); // 0-based
  sheet.insertColumnAfter(afterCol + 1);    // insert to its right (1-based arg)
  sheet.getRange(res.headerRow + 1, afterCol + 2).setValue('_entryId');
  var fresh = sheet.getDataRange().getValues();
  return resolveWriteCols_(fresh, section);
}

/** Write one entry's cells into rowNum (1-based). Blank optionals are cleared
 * to '' so an edit that removes a value takes effect. Date gets a date-only
 * number format. */
function writeEntryCells_(sheet, rowNum, section, form, res) {
  if (res.dateCol !== null && res.dateCol !== undefined) {
    var dcell = sheet.getRange(rowNum, res.dateCol + 1);
    dcell.setValue(new Date(form.year, form.month - 1, form.day));
    dcell.setNumberFormat('d-mmm');
  }
  entryWriteFields_(section).forEach(function (f) {
    var col = res.cols[f];
    if (col === null || col === undefined) return;
    var v = form[f];
    sheet.getRange(rowNum, col + 1).setValue(v === null || v === undefined || v === '' ? '' : v);
  });
}

/** Validate + normalize the incoming payload into a form object. */
function normalizeEntryPayload_(payload) {
  payload = payload || {};
  var section = payload.section;
  if (ENTRY_SECTIONS_.indexOf(section) === -1) throw new Error('Bad section: ' + section);
  var d = payload.date || {};
  var year = Number(d.year), month = Number(d.month), day = Number(d.day);
  if (!(year >= 2000) || !(month >= 1 && month <= 12) || !(day >= 1 && day <= 31)) {
    throw new Error('Invalid date.');
  }
  var form = {};
  var src = payload.fields || {};
  for (var k in src) form[k] = src[k];
  form.year = year; form.month = month; form.day = day;
  var amt = Number(form.amount);
  if (!(amt > 0)) throw new Error('Amount must be a positive number.'); // 0 rows are skipped by the parser
  form.amount = amt;
  ['nights', 'cash', 'bank', 'gst', 'due', 'discount'].forEach(function (f) {
    if (form[f] !== null && form[f] !== undefined && form[f] !== '') form[f] = Number(form[f]);
  });
  return { section: section, form: form, year: year, month: month };
}

/**
 * Append one daily entry. payload = { hotel, pin, section, date:{year,month,day},
 * fields:{...} }. Serialized with a script lock so concurrent submits can't
 * collide on the append row. Returns { ok, entryId, tab, row }.
 */
function submitEntry(payload) {
  var hotel = (payload || {}).hotel;
  verifyPin_(hotel, (payload || {}).pin);
  var norm = normalizeEntryPayload_(payload);
  var cfg = hotelCfg_(hotel);
  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    var ss = SpreadsheetApp.openById(cfg.id);
    var sheet = findOrCreateMonthSheet_(ss, norm.year, norm.month);
    var values = sheet.getDataRange().getValues();
    var res = resolveWriteCols_(values, norm.section);
    if (!res.ok) {
      throw new Error('Cannot place a ' + norm.section + ' entry on tab "' +
        sheet.getName() + '" (missing: ' + res.missing.join(', ') +
        '). Fix that column header, or let the app create the month.');
    }
    res = ensureEntryIdColumn_(sheet, values, res, norm.section);
    values = sheet.getDataRange().getValues(); // may have changed after insert
    var rowIdx = findAppendRow_(values, res.headerRow, res.cols.amount);
    var rowNum = rowIdx + 1;
    var entryId = Utilities.getUuid();
    writeEntryCells_(sheet, rowNum, norm.section, norm.form, res);
    sheet.getRange(rowNum, res.cols.entryId + 1).setValue(entryId);
    invalidateDashboardCache_();
    return { ok: true, entryId: entryId, tab: sheet.getName(), row: rowNum };
  } finally {
    lock.releaseLock();
  }
}

/** Locate the sheet + row of an app-written entry by its id, across sections.
 * Returns { sheet, rowNum, section, res } or null. */
function findEntryById_(ss, year, month, entryId) {
  var sheets = ss.getSheets();
  for (var i = 0; i < sheets.length; i++) {
    var ym = tabMonth(sheets[i].getName());
    if (!ym || ym.year !== year || ym.month !== month) continue;
    var values = sheets[i].getDataRange().getValues();
    for (var s = 0; s < ENTRY_SECTIONS_.length; s++) {
      var res = resolveWriteCols_(values, ENTRY_SECTIONS_[s]);
      var idCol = res.cols && res.cols.entryId;
      if (idCol === null || idCol === undefined) continue;
      for (var r = res.headerRow + 1; r < values.length; r++) {
        if (String(values[r][idCol]) === String(entryId)) {
          return { sheet: sheets[i], rowNum: r + 1, section: ENTRY_SECTIONS_[s], res: res };
        }
      }
    }
  }
  return null;
}

function ymParts_(ym) {
  var parts = String(ym).split('-');
  return { year: Number(parts[0]), month: Number(parts[1]) };
}

/** List this-month's app-written (id-bearing) entries so the client can offer
 * edit/delete. ym = 'YYYY-MM'. Rows without an _entryId (pre-app manual rows)
 * are not listed — those are corrected in the sheet. */
function listEntries(hotel, pin, ym) {
  verifyPin_(hotel, pin);
  var p = ymParts_(ym);
  var ss = SpreadsheetApp.openById(hotelCfg_(hotel).id);
  var sheets = ss.getSheets();
  var out = [];
  for (var i = 0; i < sheets.length; i++) {
    var t = tabMonth(sheets[i].getName());
    if (!t || t.year !== p.year || t.month !== p.month) continue;
    var values = sheets[i].getDataRange().getValues();
    ENTRY_SECTIONS_.forEach(function (section) {
      var res = resolveWriteCols_(values, section);
      var idCol = res.cols && res.cols.entryId;
      if (idCol === null || idCol === undefined) return;
      var numericFields = ['amount', 'nights', 'cash', 'bank', 'gst', 'due', 'discount'];
      for (var r = res.headerRow + 1; r < values.length; r++) {
        var id = values[r][idCol];
        if (id === null || id === undefined || id === '') continue;
        // Read every resolved field back so the edit form can prefill fully —
        // updateEntry rewrites the whole row, so a partial prefill would blank
        // the omitted fields.
        var fields = {};
        entryWriteFields_(section).forEach(function (f) {
          var c = res.cols[f];
          if (c === null || c === undefined) return;
          var raw = values[r][c];
          if (numericFields.indexOf(f) !== -1) {
            var n = num_(raw);
            fields[f] = (n === null || n === undefined) ? '' : n;
          } else {
            fields[f] = (raw === null || raw === undefined) ? '' : String(raw);
          }
        });
        var label = section === 'expense' ? (fields.particular || '') : (fields.room || '');
        out.push({
          entryId: String(id),
          section: section,
          day: dayOf_(values[r][res.dateCol], p.month),
          label: label,
          amount: fields.amount,
          fields: fields
        });
      }
    });
  }
  out.sort(function (a, b) { return (a.day || 0) - (b.day || 0); });
  return out;
}

/** Overwrite an existing entry (found by id) with new field values. */
function updateEntry(payload) {
  var hotel = (payload || {}).hotel;
  verifyPin_(hotel, (payload || {}).pin);
  var entryId = (payload || {}).entryId;
  if (!entryId) throw new Error('No entryId to update.');
  var norm = normalizeEntryPayload_(payload);
  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    var ss = SpreadsheetApp.openById(hotelCfg_(hotel).id);
    var hit = findEntryById_(ss, norm.year, norm.month, entryId);
    if (!hit) throw new Error('Entry not found (it may have been changed in the sheet).');
    if (hit.section !== norm.section) throw new Error('Cannot move an entry between sections.');
    writeEntryCells_(hit.sheet, hit.rowNum, hit.section, norm.form, hit.res);
    invalidateDashboardCache_();
    return { ok: true, entryId: entryId, tab: hit.sheet.getName(), row: hit.rowNum };
  } finally {
    lock.releaseLock();
  }
}

/** Delete an entry (found by id) by clearing only its section's cells on that
 * row — other sections sharing the row are untouched; the blank amount cell is
 * reused by the next append. */
function deleteEntry(hotel, pin, ym, entryId) {
  verifyPin_(hotel, pin);
  if (!entryId) throw new Error('No entryId to delete.');
  var p = ymParts_(ym);
  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    var ss = SpreadsheetApp.openById(hotelCfg_(hotel).id);
    var hit = findEntryById_(ss, p.year, p.month, entryId);
    if (!hit) throw new Error('Entry not found (it may have been changed in the sheet).');
    var res = hit.res;
    var clearCols = [res.dateCol, res.cols.entryId];
    entryWriteFields_(hit.section).forEach(function (f) {
      if (res.cols[f] !== null && res.cols[f] !== undefined) clearCols.push(res.cols[f]);
    });
    clearCols.forEach(function (c) {
      if (c !== null && c !== undefined) hit.sheet.getRange(hit.rowNum, c + 1).setValue('');
    });
    invalidateDashboardCache_();
    return { ok: true, entryId: entryId };
  } finally {
    lock.releaseLock();
  }
}

// Node-harness export (ignored inside GAS, where `module` is undefined).
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    canonicalLayout_: canonicalLayout_, canonicalHeaderRow_: canonicalHeaderRow_,
    entryFieldHeaders_: entryFieldHeaders_, essentialFields_: essentialFields_,
    entryWriteFields_: entryWriteFields_, resolveWriteCols_: resolveWriteCols_,
    buildEntryRow_: buildEntryRow_, findAppendRow_: findAppendRow_,
    sectionRightmostCol_: sectionRightmostCol_, monthTabName_: monthTabName_,
    SECTION_START_: SECTION_START_, CANONICAL_WIDTH_: CANONICAL_WIDTH_
  };
}
