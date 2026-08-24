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

var ENTRY_SECTIONS_ = ['rent', 'food', 'expense', 'recovery'];

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
            'Cash', 'Banking & UPI', 'GST', 'Due', 'Discount', 'Remark', 'Party', 'Entered by', '_entryId'];
  }
  if (section === 'food') {
    return ['Date', 'Room (food & others)', 'Amount', 'Cash', 'Banking & UPI', 'Remark', 'Entered by', '_entryId'];
  }
  if (section === 'recovery') {
    // Due-recovery ledger. Anchor header 'Recovery party' is what anchorType_
    // keys on. parseTab_ skips this section's Amount (never a P&L total) but
    // DOES read Cash/Banking & UPI into money-control totals (recoveryCash/
    // recoveryBank), same header text as rent/food. 'Due ref' hard-links a
    // recovery to the exact rent row it pays down (that row's own _entryId,
    // reused as a foreign key — see buildDueIndex_ in Report.gs); blank when
    // the staff picked "Other / not listed" and typed a party name instead.
    return ['Date', 'Recovery party', 'Room', 'Amount', 'Cash', 'Banking & UPI', 'Remark', 'Due ref', 'Entered by', '_entryId'];
  }
  return ['Date', 'Particulers', 'Amount', 'Remark', 'Entered by', '_entryId']; // expense
}

// Fixed left-edge column of each section on an app-created tab, plus grid
// width — DERIVED from each section's canonicalLayout_() length, never hand-
// maintained. Parser.gs's detectSections_ bounds a section's header scan at
// `nextAnchorCol - 3` (see its file header), which only lines up correctly
// when each section occupies EXACTLY its own header count with a single
// blank gap column before the next section starts (nextStart = start+width+1).
// Deriving this avoids silently desyncing that invariant the next time a
// column is added to canonicalLayout_ (a fixed offset requires re-deriving
// this arithmetic by hand — error-prone and exactly how a header can end up
// unreadable on a freshly created tab).
function computeSectionLayout_() {
  var starts = {}, col = 0;
  ENTRY_SECTIONS_.forEach(function (sec) {
    starts[sec] = col;
    col += canonicalLayout_(sec).length + 1; // +1 blank gap before the next section
  });
  return { starts: starts, width: col - 1 }; // no trailing gap after the last section
}
var SECTION_LAYOUT_ = computeSectionLayout_();
var SECTION_START_ = SECTION_LAYOUT_.starts;
var CANONICAL_WIDTH_ = SECTION_LAYOUT_.width;

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
    enteredBy: ['entered by', 'enteredby'],
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
    map.remark = ['remark', 'remarks'];
    map.party = ['party', 'debtor', 'guest']; // debtor named when Due > 0
  } else if (section === 'food') {
    map.room = ['room (food & others)', 'room'];
    map.remark = ['remark', 'remarks'];
  } else if (section === 'recovery') {
    // cash/bank already set universally above (used by rent/food/recovery).
    map.party = ['recovery party', 'party', 'debtor', 'guest'];
    map.room = ['room'];
    map.remark = ['remark', 'remarks'];
    map.dueRef = ['due ref', 'dueref'];
  } else { // expense
    map.category = ['particulers', 'particulars']; // dropdown value now lands in the Particulars column
    map.remark = ['remark', 'remarks'];
  }
  return map;
}

/** Fields that MUST resolve or the write is refused (never misalign into a
 * legacy tab). Date is handled separately via detectSections_.dateCol. */
function essentialFields_(section) {
  if (section === 'expense') return ['category', 'amount'];
  if (section === 'recovery') return ['party', 'amount'];
  return ['room', 'amount'];
}

/** Ordered field list per section for building/writing a row. */
function entryWriteFields_(section) {
  if (section === 'rent') return ['room', 'source', 'nights', 'amount', 'cash', 'bank', 'gst', 'due', 'discount', 'remark', 'party', 'enteredBy'];
  if (section === 'food') return ['room', 'amount', 'cash', 'bank', 'remark', 'enteredBy'];
  if (section === 'recovery') return ['party', 'room', 'amount', 'cash', 'bank', 'remark', 'dueRef', 'enteredBy'];
  return ['category', 'amount', 'remark', 'enteredBy']; // expense
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
  // Every column that belongs to this section (its date + all headered columns).
  // A row is only a safe append target when ALL of these are empty — so a real
  // booking that left 'amount' blank (e.g. an advance/due-only row) is not
  // clobbered. Used by findAppendRow_.
  var occ = [];
  if (sec.dateCol !== null && sec.dateCol !== undefined) occ.push(sec.dateCol);
  for (var hk in sec.heads) {
    var hc = sec.heads[hk];
    if (typeof hc === 'number' && occ.indexOf(hc) === -1) occ.push(hc);
  }
  return {
    ok: missing.length === 0,
    headerRow: det.headerRow,
    dateCol: sec.dateCol,
    cols: cols,
    occupancyCols: occ,
    missing: missing
  };
}

/**
 * Cell writes for one entry, given resolved columns. Only fields with a
 * resolved column AND a provided value are included; the date is always a real
 * Date built from the picked Y/M/D (timezone-agnostic day).
 * form = { year, month, day, room, source, nights, amount, cash, bank, gst,
 *          due, discount, category, remark }.
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

/** First data row index (0-based) at/after headerRow+1 where the section is
 * entirely empty — where this section's next row is appended. `occCols` is the
 * list of the section's own columns (from resolveWriteCols_.occupancyCols); a
 * bare number is accepted as a single column for back-compat. A row counts as
 * occupied if ANY of those columns holds a value, so a real booking with a
 * blank amount cell (advance/due-only row) is never overwritten. Returns
 * values.length to append past the end. */
function findAppendRow_(values, headerRow, occCols) {
  var cols = (typeof occCols === 'number') ? [occCols] : (occCols || []);
  for (var r = headerRow + 1; r < values.length; r++) {
    var used = false;
    for (var i = 0; i < cols.length; i++) {
      var v = values[r][cols[i]];
      if (v !== null && v !== undefined && v !== '') { used = true; break; }
    }
    if (!used) return r;
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
 * 4-section header row (rent/food/expense/recovery). */
function findOrCreateMonthSheet_(ss, year, month) {
  var sheets = ss.getSheets();
  for (var i = 0; i < sheets.length; i++) {
    var ym = tabMonth(sheets[i].getName());
    if (ym && ym.year === year && ym.month === month) return sheets[i];
  }
  var sheet = ss.insertSheet(monthTabName_(year, month));
  var header = canonicalHeaderRow_();
  // A new sheet defaults to 26 columns; the canonical grid is wider, so widen
  // it before writing or the header setValues would exceed the grid bounds.
  if (sheet.getMaxColumns() < header.length) {
    sheet.insertColumnsAfter(sheet.getMaxColumns(), header.length - sheet.getMaxColumns());
  }
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

/** Ensure a 'Remark' column exists so free-text notes land in a real column
 * the parser reads. Canonical app tabs and real staff tabs already have it;
 * this only fires on app tabs created before Remark existed for that section.
 * Inserted immediately LEFT of _entryId so it stays inside the section's
 * detect window. Returns a re-resolved cols object. */
function ensureRemarkColumn_(sheet, values, res, section) {
  if (res.cols.remark !== null && res.cols.remark !== undefined) return res;
  var idCol = res.cols.entryId;
  if (idCol === null || idCol === undefined) return res; // no anchor -> skip (remark dropped gracefully)
  sheet.insertColumnBefore(idCol + 1);                   // 1-based; pushes _entryId right by one
  sheet.getRange(res.headerRow + 1, idCol + 1).setValue('Remark');
  var fresh = sheet.getDataRange().getValues();
  return resolveWriteCols_(fresh, section);
}

/** Ensure an 'Entered by' column exists so a submitted/edited row can be
 * attributed to the staff member who made it — no per-staff PIN, just a
 * plain name field (STATE.staffName in Form.html). Same retrofit pattern as
 * ensureRemarkColumn_: fires on any tab (app-created or legacy) that
 * predates this attribution feature. Inserted immediately LEFT of
 * _entryId. */
function ensureEnteredByColumn_(sheet, values, res, section) {
  if (res.cols.enteredBy !== null && res.cols.enteredBy !== undefined) return res;
  var idCol = res.cols.entryId;
  if (idCol === null || idCol === undefined) return res; // no anchor -> skip (attribution dropped gracefully)
  sheet.insertColumnBefore(idCol + 1);                   // 1-based; pushes _entryId right by one
  sheet.getRange(res.headerRow + 1, idCol + 1).setValue('Entered by');
  var fresh = sheet.getDataRange().getValues();
  return resolveWriteCols_(fresh, section);
}

/** Rent only: ensure a 'Party' column exists so a due can be attributed to a
 * debtor. Canonical app tabs have it; this fires on rent tabs created before
 * Party existed. Inserted immediately LEFT of _entryId (stays inside the rent
 * detect window). Returns a re-resolved cols object. */
function ensurePartyColumn_(sheet, values, res, section) {
  if (section !== 'rent') return res;
  if (res.cols.party !== null && res.cols.party !== undefined) return res;
  var idCol = res.cols.entryId;
  if (idCol === null || idCol === undefined) return res; // no anchor -> skip (party dropped gracefully)
  sheet.insertColumnBefore(idCol + 1);                   // 1-based; pushes _entryId right by one
  sheet.getRange(res.headerRow + 1, idCol + 1).setValue('Party');
  var fresh = sheet.getDataRange().getValues();
  return resolveWriteCols_(fresh, section);
}

/** Recovery only: ensure the tab has a recovery section. App-created tabs get it
 * from canonicalHeaderRow_; a tab that predates this feature has none, so we lay
 * the recovery header block down two columns right of the last used header (one
 * blank gap, matching the other sections) and re-resolve. Returns a re-resolved
 * cols object (or the original res if no header row could be found). */
function ensureRecoverySection_(sheet, values, res, section) {
  if (section !== 'recovery') return res;
  if (res.ok) return res; // recovery section already present & resolved
  var det = detectSections_(values);
  if (!det) return res;   // foreign/empty tab -> caller throws on !res.ok
  var headerRow = det.headerRow;
  var lastUsed = -1;
  var hrow = values[headerRow] || [];
  for (var c = 0; c < hrow.length; c++) {
    if (norm_(hrow[c]) !== '') lastUsed = c;
  }
  var start = lastUsed + 2; // one blank gap column before the recovery block
  var layout = canonicalLayout_('recovery');
  var need = start + layout.length;            // 1-based count of columns required
  var have = sheet.getMaxColumns();
  if (need > have) sheet.insertColumnsAfter(have, need - have); // widen grid so the write fits
  sheet.getRange(headerRow + 1, start + 1, 1, layout.length).setValues([layout]);
  var fresh = sheet.getDataRange().getValues();
  return resolveWriteCols_(fresh, section);
}

/** Recovery only: ensure a 'Due ref' column exists so a recovery can be hard-
 * linked to the rent row it pays down. Canonical/freshly-retrofitted recovery
 * sections already have it (canonicalLayout_ includes it); this only fires on
 * a recovery section created before the hard-link feature existed. Inserted
 * immediately LEFT of _entryId. Returns a re-resolved cols object. */
function ensureDueRefColumn_(sheet, values, res, section) {
  if (section !== 'recovery') return res;
  if (res.cols.dueRef !== null && res.cols.dueRef !== undefined) return res;
  var idCol = res.cols.entryId;
  if (idCol === null || idCol === undefined) return res; // no anchor -> skip (dueRef dropped gracefully)
  sheet.insertColumnBefore(idCol + 1);                   // 1-based; pushes _entryId right by one
  sheet.getRange(res.headerRow + 1, idCol + 1).setValue('Due ref');
  var fresh = sheet.getDataRange().getValues();
  return resolveWriteCols_(fresh, section);
}

/** Recovery only: ensure a 'Cash' column exists. Canonical recovery sections
 * created fresh already have it; this retrofits recovery sections that
 * predate the cash/bank split (deployed earlier this session). Inserted
 * immediately LEFT of _entryId. Returns a re-resolved cols object. */
function ensureRecoveryCashColumn_(sheet, values, res, section) {
  if (section !== 'recovery') return res;
  if (res.cols.cash !== null && res.cols.cash !== undefined) return res;
  var idCol = res.cols.entryId;
  if (idCol === null || idCol === undefined) return res;
  sheet.insertColumnBefore(idCol + 1);
  sheet.getRange(res.headerRow + 1, idCol + 1).setValue('Cash');
  var fresh = sheet.getDataRange().getValues();
  return resolveWriteCols_(fresh, section);
}

/** Recovery only: ensure a 'Banking & UPI' column exists. Same retrofit
 * pattern as ensureRecoveryCashColumn_. */
function ensureRecoveryBankColumn_(sheet, values, res, section) {
  if (section !== 'recovery') return res;
  if (res.cols.bank !== null && res.cols.bank !== undefined) return res;
  var idCol = res.cols.entryId;
  if (idCol === null || idCol === undefined) return res;
  sheet.insertColumnBefore(idCol + 1);
  sheet.getRange(res.headerRow + 1, idCol + 1).setValue('Banking & UPI');
  var fresh = sheet.getDataRange().getValues();
  return resolveWriteCols_(fresh, section);
}

/** Locate the SHEET+ROW of a rent row by its own _entryId, scanning every
 * tabMonth_-named sheet in the book — the linked due may live in a different
 * month's tab than the recovery referencing it (partial payments over time).
 * Returns { sheet, rowNum, dueCol, cashCol, bankCol, remarkCol } (any of
 * cashCol/bankCol/remarkCol may be null on a tab missing that header — Due is
 * required, the others are not) or null if not found (deleted/unknown). */
function findRentDueRowById_(ss, dueId) {
  var sheets = ss.getSheets();
  for (var i = 0; i < sheets.length; i++) {
    if (!tabMonth(sheets[i].getName())) continue;
    var values = sheets[i].getDataRange().getValues();
    var res = resolveWriteCols_(values, 'rent');
    var idCol = res.cols && res.cols.entryId;
    var dueCol = res.cols && res.cols.due;
    if (idCol === null || idCol === undefined || dueCol === null || dueCol === undefined) continue;
    for (var r = res.headerRow + 1; r < values.length; r++) {
      if (String(values[r][idCol]) === String(dueId)) {
        return {
          sheet: sheets[i], rowNum: r + 1, dueCol: dueCol,
          cashCol: res.cols.cash, bankCol: res.cols.bank, remarkCol: res.cols.remark
        };
      }
    }
  }
  return null;
}

/** '15-Aug' style label for a recovery-remark stamp. Pure — no SpreadsheetApp,
 * so it's the one piece of this feature a Node harness can verify directly. */
function shortDateLabel_(year, month, day) {
  var full = MONTH_NAMES_[month - 1];
  var mon3 = full.charAt(0) + full.slice(1, 3).toLowerCase();
  return day + '-' + mon3;
}

/** Overwrite the linked booking row's Remark with "Recovered ₹X on DD-Mon" —
 * every NEW recovery replaces whatever was there (a prior manual note, or an
 * earlier recovery's own stamp; owner-confirmed overwrite, not append). Only
 * called from submitEntry — updateEntry/deleteEntry never touch or revert
 * this, it's a one-way "last activity" stamp, not a reversible ledger like
 * Due/Cash/Bank. No-op if the row can't be found or has no Remark column
 * (Remark has existed on rent since before this whole dues feature, so this
 * only fires on a genuinely pre-app row). */
function stampRecoveryRemark_(ss, dueId, amount, year, month, day) {
  var hit = findRentDueRowById_(ss, dueId);
  if (!hit || hit.remarkCol === null || hit.remarkCol === undefined) return false;
  var note = 'Recovered ₹' + amount + ' on ' + shortDateLabel_(year, month, day);
  hit.sheet.getRange(hit.rowNum, hit.remarkCol + 1).setValue(note);
  return true;
}

/** Adjust a linked due's LIVE Due/Cash/Bank cells — Due by `deltaDue`
 * (negative = a recovery was just posted, due goes down; positive = a
 * recovery was edited down/deleted, due is restored up), Cash/Bank by
 * `deltaCash`/`deltaBank` (the opposite sign: a posted recovery INCREASES
 * cash/bank collected on that booking; a removed/reduced one gives it back).
 * So the booking row stays self-consistent: Cash+Bank+Due always equals its
 * Amount, visible on that one row without cross-referencing the recovery.
 * Reads each cell fresh at call time (not a stale snapshot), so this is safe
 * to call more than once within one locked request. deltaCash/deltaBank are
 * optional (0/omitted skips that cell). No-op (returns false) if the due row
 * can't be found — the caller has already validated against findDueById_
 * before this point, so that only happens if the row was deleted in the same
 * instant (a race the script lock already prevents) or the tab was otherwise
 * altered out of band. */
function adjustDueCell_(ss, dueId, deltaDue, deltaCash, deltaBank) {
  var hit = findRentDueRowById_(ss, dueId);
  if (!hit) return false;
  function bump(col, delta) {
    if (!delta || col === null || col === undefined) return;
    var cell = hit.sheet.getRange(hit.rowNum, col + 1);
    var current = num_(cell.getValue()) || 0;
    cell.setValue(current + delta);
  }
  bump(hit.dueCol, deltaDue);
  bump(hit.cashCol, deltaCash);
  bump(hit.bankCol, deltaBank);
  return true;
}

/** Write [{col,value,isDate}] pairs to one row in as few calls as possible.
 * On a canonical (app-created or app-retrofitted) tab, a section's resolved
 * columns are always perfectly contiguous (canonicalLayout_/ensure*Column_
 * always insert immediately adjacent), so one batched setValues() call covers
 * the whole write — shrinking the interruption window (GAS quota/6-min cap
 * mid-write leaving a half-written, un-owned row) from N calls to 1. A legacy
 * staff tab whose columns happen to have a gap falls back to per-cell
 * setValue, in ascending column order (never touches a column outside
 * `pairs`) — entryId is always the section's rightmost resolved column
 * (ensureEntryIdColumn_ inserts it there), so ascending order also means it's
 * written/cleared last in the fallback path, same safety property either way. */
function writeRowCells_(sheet, rowNum, pairs) {
  if (!pairs.length) return;
  var sorted = pairs.slice().sort(function (a, b) { return a.col - b.col; });
  var minCol = sorted[0].col, maxCol = sorted[sorted.length - 1].col;
  var contiguous = (maxCol - minCol + 1) === sorted.length;
  if (contiguous) {
    for (var i = 1; i < sorted.length; i++) {
      if (sorted[i].col !== minCol + i) { contiguous = false; break; }
    }
  }
  if (contiguous) {
    var row = sorted.map(function (p) { return p.value; });
    sheet.getRange(rowNum, minCol + 1, 1, row.length).setValues([row]);
  } else {
    sorted.forEach(function (p) {
      sheet.getRange(rowNum, p.col + 1).setValue(p.value);
    });
  }
  sorted.forEach(function (p) {
    if (p.isDate) sheet.getRange(rowNum, p.col + 1).setNumberFormat('d-mmm');
  });
}

/** Write one entry's cells into rowNum (1-based). Blank optionals are cleared
 * to '' so an edit that removes a value takes effect. Date gets a date-only
 * number format. `entryId`, if passed, is written in the SAME batch as the
 * rest of the row (see writeRowCells_) so a new row never has a window where
 * its data is visible but its id isn't. */
function writeEntryCells_(sheet, rowNum, section, form, res, entryId) {
  var pairs = [];
  if (res.dateCol !== null && res.dateCol !== undefined) {
    pairs.push({ col: res.dateCol, value: new Date(form.year, form.month - 1, form.day), isDate: true });
  }
  entryWriteFields_(section).forEach(function (f) {
    var col = res.cols[f];
    if (col === null || col === undefined) return;
    var v = form[f];
    pairs.push({ col: col, value: v === null || v === undefined || v === '' ? '' : v });
  });
  if (entryId !== undefined && res.cols.entryId !== null && res.cols.entryId !== undefined) {
    pairs.push({ col: res.cols.entryId, value: entryId });
  }
  writeRowCells_(sheet, rowNum, pairs);
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
  // Staff attribution — sent once per session (STATE.staffName in Form.html),
  // not per-field, so it lives at the payload's top level rather than inside
  // `fields`.
  form.enteredBy = String(payload.enteredBy || '').trim();
  var amt = Number(form.amount);
  if (!(amt > 0)) throw new Error('Amount must be a positive number.'); // 0 rows are skipped by the parser
  form.amount = amt;
  ['nights', 'cash', 'bank', 'gst', 'due', 'discount'].forEach(function (f) {
    if (form[f] !== null && form[f] !== undefined && form[f] !== '') {
      var n = Number(form[f]);
      if (isNaN(n)) throw new Error('"' + f + '" must be a number.');
      form[f] = n;
    }
  });
  // Cash+Bank(+Due) must reconcile to Amount — the row's own money-in figure
  // has to be internally consistent (see adjustDueCell_'s doc: "Cash + Bank +
  // Due stays equal to a booking's Amount on that one row"). Rent has a Due
  // column (partial/unpaid balance); food/recovery don't, so their full
  // Amount must be Cash+Bank. Expense has no split fields — nothing to check.
  var cash = form.cash || 0, bank = form.bank || 0, due = form.due || 0;
  if (section === 'rent') {
    var rentSum = cash + bank + due;
    if (Math.abs(rentSum - amt) > 0.01) {
      throw new Error('Cash+Bank+Due = ₹' + rentSum + ' but Amount = ₹' + amt +
        (rentSum < amt ? ' — short by ₹' + (amt - rentSum) + '.' : ' — over by ₹' + (rentSum - amt) + '.'));
    }
  } else if (section === 'food' || section === 'recovery') {
    var sum2 = cash + bank;
    if (Math.abs(sum2 - amt) > 0.01) {
      throw new Error('Cash+Bank = ₹' + sum2 + ' but Amount = ₹' + amt +
        (sum2 < amt ? ' — short by ₹' + (amt - sum2) + '.' : ' — over by ₹' + (sum2 - amt) + '.'));
    }
  }
  // The 'General & Misc' category is the parser's terminal catch-all
  // (Config.gs categorize()) — require a Remark so an unmatched real cost
  // stays traceable instead of silently vanishing into the generic bucket.
  if (section === 'expense' && form.category === 'General & Misc' && !String(form.remark || '').trim()) {
    throw new Error('"General & Misc" needs a Remark describing the expense.');
  }
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
    if (!res.ok && norm.section === 'recovery') {
      res = ensureRecoverySection_(sheet, values, res, norm.section); // retrofit on older tabs
      values = sheet.getDataRange().getValues();
    }
    if (!res.ok) {
      throw new Error('Cannot place a ' + norm.section + ' entry on tab "' +
        sheet.getName() + '" (missing: ' + res.missing.join(', ') +
        '). Fix that column header, or let the app create the month.');
    }
    res = ensureEntryIdColumn_(sheet, values, res, norm.section);
    values = sheet.getDataRange().getValues(); // may have changed after insert
    if (norm.form.remark) {
      res = ensureRemarkColumn_(sheet, values, res, norm.section);
      values = sheet.getDataRange().getValues(); // may have changed again
    }
    if (norm.form.party) {
      res = ensurePartyColumn_(sheet, values, res, norm.section); // rent debtor attribution
      values = sheet.getDataRange().getValues();
    }
    if (norm.form.enteredBy) {
      res = ensureEnteredByColumn_(sheet, values, res, norm.section);
      values = sheet.getDataRange().getValues();
    }
    if (norm.section === 'recovery' && norm.form.cash) {
      res = ensureRecoveryCashColumn_(sheet, values, res, norm.section);
      values = sheet.getDataRange().getValues();
    }
    if (norm.section === 'recovery' && norm.form.bank) {
      res = ensureRecoveryBankColumn_(sheet, values, res, norm.section);
      values = sheet.getDataRange().getValues();
    }
    if (norm.form.dueRef) {
      res = ensureDueRefColumn_(sheet, values, res, norm.section); // recovery hard-link
      values = sheet.getDataRange().getValues();
    }
    if (norm.section === 'recovery' && norm.form.dueRef) {
      // Re-check the LIVE due inside the lock — the client's cached openDues
      // list can be stale (another staff member just recovered against it, or
      // it was deleted), so this is the actual guard against over-recovery.
      var due = findDueById_(collectAllTabs_(ss), norm.form.dueRef);
      var canRec = canRecoverAmount_(due, norm.form.amount);
      if (!canRec.ok) {
        if (canRec.reason === 'not_found') {
          throw new Error('That due could no longer be found (it may have been deleted). Pick another, or use "Other / not listed".');
        }
        throw new Error('This due now shows only ₹' + canRec.outstanding +
          ' outstanding (recovered elsewhere). Enter ₹' + canRec.outstanding + ' or less.');
      }
    }
    var rowIdx = findAppendRow_(values, res.headerRow, res.occupancyCols || res.cols.amount);
    var rowNum = rowIdx + 1;
    var entryId = Utilities.getUuid();
    writeEntryCells_(sheet, rowNum, norm.section, norm.form, res, entryId);
    if (norm.section === 'recovery' && norm.form.dueRef) {
      // Keep the linked booking row LIVE and self-consistent: Due visibly
      // drops by what was recovered, and that same row's own Cash/Bank rise
      // by exactly how this recovery was collected — Cash+Bank+Due stays
      // equal to the booking's Amount on that one row. The owner P&L
      // dashboard's "Dues outstanding" and money-control stats, which just
      // sum these same columns, net it automatically.
      adjustDueCell_(ss, norm.form.dueRef, -norm.form.amount,
        Number(norm.form.cash) || 0, Number(norm.form.bank) || 0);
      // One-way stamp of this recovery activity onto the booking row's own
      // Remark (overwrites; never reverted by a later edit/delete of this
      // recovery — see stampRecoveryRemark_).
      stampRecoveryRemark_(ss, norm.form.dueRef, norm.form.amount, norm.year, norm.month, norm.form.day);
    }
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
        var label = section === 'expense' ? (fields.category || '')
          : section === 'recovery' ? (fields.party || '')
          : (fields.room || '');
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
  // The row may still live in the month it was ORIGINALLY entered under, not
  // the (possibly just-edited) date's month — findEntryById_ only searches
  // one tab, so it must be pointed at the entry's current tab, not the new
  // date's tab. Form.html sends this as the list-month the entry was opened
  // from; older callers that omit it fall back to norm's own month (same as
  // the pre-fix behavior — same-month edits only).
  var orig = (payload || {}).origYm ? ymParts_(payload.origYm) : { year: norm.year, month: norm.month };
  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    var ss = SpreadsheetApp.openById(hotelCfg_(hotel).id);
    var hit = findEntryById_(ss, orig.year, orig.month, entryId);
    if (!hit) throw new Error('Entry not found (it may have been changed in the sheet).');
    if (hit.section !== norm.section) throw new Error('Cannot move an entry between sections.');

    // A rent row's Amount can't be edited once money's been recovered against
    // it — the recovered figure was collected against the OLD amount, so
    // changing it now would desync the whole due ledger (buildDueIndex_
    // derives the original incurred amount as outstanding+recovered).
    if (hit.section === 'rent') {
      var recAgainst = recoveredAgainstDue_(collectAllTabs_(ss), entryId);
      if (recAgainst.recovered > 0) {
        var amtColChk = hit.res.cols.amount;
        var oldRentAmount = (amtColChk !== null && amtColChk !== undefined)
          ? (num_(hit.sheet.getRange(hit.rowNum, amtColChk + 1).getValue()) || 0) : 0;
        if (Math.abs(Number(norm.form.amount) - oldRentAmount) > 0.01) {
          throw new Error('₹' + recAgainst.recovered + ' already recovered against this booking — ' +
            'Amount can\'t be changed. Correct via the recovery entries instead.');
        }
      }
    }

    // Editing a recovery's amount/link/cash/bank must rebalance the linked
    // booking row's live Due/Cash/Bank cells. Read the OLD link/amount/cash/
    // bank from the row's CURRENT (pre-write, pre-move) columns — reading
    // never needs the ensure*Column_ retrofits below, only writing does.
    // Validate against what the target due's outstanding WOULD be once the
    // old contribution is restored (covers same-due corrections and moving a
    // recovery to a different due); apply both adjustments only after
    // validation passes and the row write below succeeds, so a rejected edit
    // never partially mutates.
    var oldDueRef = '', oldAmount = 0, oldCash = 0, oldBank = 0;
    if (hit.section === 'recovery') {
      var refCol = hit.res.cols.dueRef, amtCol = hit.res.cols.amount;
      var oldCashCol = hit.res.cols.cash, oldBankCol = hit.res.cols.bank;
      oldDueRef = (refCol !== null && refCol !== undefined)
        ? String(hit.sheet.getRange(hit.rowNum, refCol + 1).getValue() || '').trim() : '';
      oldAmount = (amtCol !== null && amtCol !== undefined)
        ? (num_(hit.sheet.getRange(hit.rowNum, amtCol + 1).getValue()) || 0) : 0;
      oldCash = (oldCashCol !== null && oldCashCol !== undefined)
        ? (num_(hit.sheet.getRange(hit.rowNum, oldCashCol + 1).getValue()) || 0) : 0;
      oldBank = (oldBankCol !== null && oldBankCol !== undefined)
        ? (num_(hit.sheet.getRange(hit.rowNum, oldBankCol + 1).getValue()) || 0) : 0;
      var newDueRef = norm.form.dueRef || '';
      var newAmount = Number(norm.form.amount) || 0;
      if (newDueRef) {
        var liveDue = findDueById_(collectAllTabs_(ss), newDueRef);
        if (!liveDue) throw new Error('That due could no longer be found (it may have been deleted). Pick another, or use "Other / not listed".');
        var effectiveOutstanding = liveDue.outstanding + (newDueRef === oldDueRef ? oldAmount : 0);
        if (newAmount > effectiveOutstanding + 0.01) {
          throw new Error('This due now shows only ₹' + effectiveOutstanding +
            ' outstanding (recovered elsewhere). Enter ₹' + effectiveOutstanding + ' or less.');
        }
      }
    }

    var moving = orig.year !== norm.year || orig.month !== norm.month;
    if (moving) {
      // The date edit crossed a month boundary — the row has to relocate to
      // the target month's tab. Keep the SAME entryId (never regenerate):
      // findRentDueRowById_ already scans every month tab, so a rent row (or
      // a recovery's dueRef pointing at one) keeps working across the move
      // with zero extra bookkeeping. This is a relocation, not a deletion —
      // no canDeleteDue_ guard, no due-restore; the due amount/link isn't
      // going anywhere, only which physical row it lives on.
      var targetSheet = findOrCreateMonthSheet_(ss, norm.year, norm.month);
      var values2 = targetSheet.getDataRange().getValues();
      var res2 = resolveWriteCols_(values2, hit.section);
      if (!res2.ok && hit.section === 'recovery') {
        res2 = ensureRecoverySection_(targetSheet, values2, res2, hit.section);
        values2 = targetSheet.getDataRange().getValues();
      }
      if (!res2.ok) {
        throw new Error('Cannot move this entry to "' + targetSheet.getName() +
          '" (missing: ' + res2.missing.join(', ') + '). Fix that column header, or let the app create the month.');
      }
      res2 = ensureEntryIdColumn_(targetSheet, values2, res2, hit.section);
      values2 = targetSheet.getDataRange().getValues();
      if (norm.form.remark) {
        res2 = ensureRemarkColumn_(targetSheet, values2, res2, hit.section);
        values2 = targetSheet.getDataRange().getValues();
      }
      if (norm.form.party && hit.section === 'rent') {
        res2 = ensurePartyColumn_(targetSheet, values2, res2, hit.section);
        values2 = targetSheet.getDataRange().getValues();
      }
      if (norm.form.enteredBy) {
        res2 = ensureEnteredByColumn_(targetSheet, values2, res2, hit.section);
        values2 = targetSheet.getDataRange().getValues();
      }
      if (hit.section === 'recovery' && norm.form.cash) {
        res2 = ensureRecoveryCashColumn_(targetSheet, values2, res2, hit.section);
        values2 = targetSheet.getDataRange().getValues();
      }
      if (hit.section === 'recovery' && norm.form.bank) {
        res2 = ensureRecoveryBankColumn_(targetSheet, values2, res2, hit.section);
        values2 = targetSheet.getDataRange().getValues();
      }
      if (norm.form.dueRef && hit.section === 'recovery') {
        res2 = ensureDueRefColumn_(targetSheet, values2, res2, hit.section);
        values2 = targetSheet.getDataRange().getValues();
      }
      var rowIdx2 = findAppendRow_(values2, res2.headerRow, res2.occupancyCols || res2.cols.amount);
      var rowNum2 = rowIdx2 + 1;
      writeEntryCells_(targetSheet, rowNum2, hit.section, norm.form, res2, entryId);
      // Clear the old row (same-id relocation, not a delete) using the ORIGINAL
      // location's already-resolved columns — no ensure-calls needed to blank
      // cells that already exist.
      var oldClearCols = [hit.res.dateCol, hit.res.cols.entryId];
      entryWriteFields_(hit.section).forEach(function (f) {
        if (hit.res.cols[f] !== null && hit.res.cols[f] !== undefined) oldClearCols.push(hit.res.cols[f]);
      });
      writeRowCells_(hit.sheet, hit.rowNum, oldClearCols
        .filter(function (c) { return c !== null && c !== undefined; })
        .map(function (c) { return { col: c, value: '' }; }));
      hit.sheet = targetSheet;
      hit.rowNum = rowNum2;
    } else {
      if (norm.form.remark && (hit.section === 'rent' || hit.section === 'food' || hit.section === 'expense')) {
        hit.res = ensureRemarkColumn_(hit.sheet, hit.sheet.getDataRange().getValues(), hit.res, hit.section);
      }
      if (norm.form.party && hit.section === 'rent') {
        hit.res = ensurePartyColumn_(hit.sheet, hit.sheet.getDataRange().getValues(), hit.res, hit.section);
      }
      if (norm.form.enteredBy) {
        hit.res = ensureEnteredByColumn_(hit.sheet, hit.sheet.getDataRange().getValues(), hit.res, hit.section);
      }
      if (norm.form.cash && hit.section === 'recovery') {
        hit.res = ensureRecoveryCashColumn_(hit.sheet, hit.sheet.getDataRange().getValues(), hit.res, hit.section);
      }
      if (norm.form.bank && hit.section === 'recovery') {
        hit.res = ensureRecoveryBankColumn_(hit.sheet, hit.sheet.getDataRange().getValues(), hit.res, hit.section);
      }
      if (norm.form.dueRef && hit.section === 'recovery') {
        hit.res = ensureDueRefColumn_(hit.sheet, hit.sheet.getDataRange().getValues(), hit.res, hit.section);
      }
      writeEntryCells_(hit.sheet, hit.rowNum, hit.section, norm.form, hit.res);
    }

    if (hit.section === 'recovery') {
      if (oldDueRef) adjustDueCell_(ss, oldDueRef, oldAmount, -oldCash, -oldBank); // restore old contribution
      if (norm.form.dueRef) {
        adjustDueCell_(ss, norm.form.dueRef, -Number(norm.form.amount),
          Number(norm.form.cash) || 0, Number(norm.form.bank) || 0); // apply new
      }
    }
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
    if (hit.section === 'rent') {
      // Gated on recoveredAgainstDue_ alone, not the row's current Due value —
      // a fully-recovered due legitimately shows Due=0 while still having
      // recovery history that must not be orphaned.
      var canDel = canDeleteDue_(collectAllTabs_(ss), entryId);
      if (!canDel.ok) {
        throw new Error('Cannot delete: ' + canDel.count + ' recovery entr' +
          (canDel.count === 1 ? 'y references' : 'ies reference') + ' this due (₹' +
          canDel.recovered + ' recovered). Delete/reassign those first.');
      }
    }
    var delDueRef = '', delAmount = 0, delCash = 0, delBank = 0;
    if (hit.section === 'recovery') {
      var refCol = res.cols.dueRef, amtCol = res.cols.amount;
      var delCashCol = res.cols.cash, delBankCol = res.cols.bank;
      delDueRef = (refCol !== null && refCol !== undefined)
        ? String(hit.sheet.getRange(hit.rowNum, refCol + 1).getValue() || '').trim() : '';
      delAmount = (amtCol !== null && amtCol !== undefined)
        ? (num_(hit.sheet.getRange(hit.rowNum, amtCol + 1).getValue()) || 0) : 0;
      delCash = (delCashCol !== null && delCashCol !== undefined)
        ? (num_(hit.sheet.getRange(hit.rowNum, delCashCol + 1).getValue()) || 0) : 0;
      delBank = (delBankCol !== null && delBankCol !== undefined)
        ? (num_(hit.sheet.getRange(hit.rowNum, delBankCol + 1).getValue()) || 0) : 0;
    }
    var clearCols = [res.dateCol, res.cols.entryId];
    entryWriteFields_(hit.section).forEach(function (f) {
      if (res.cols[f] !== null && res.cols[f] !== undefined) clearCols.push(res.cols[f]);
    });
    // Batched clear (writeRowCells_ sorts ascending -> entryId, always the
    // rightmost resolved column, clears last even on a legacy tab's
    // non-contiguous fallback path — a row stays app-owned/discoverable
    // until every other cell is already blank).
    writeRowCells_(hit.sheet, hit.rowNum, clearCols
      .filter(function (c) { return c !== null && c !== undefined; })
      .map(function (c) { return { col: c, value: '' }; }));
    // Restore what this recovery had paid down: give the due back, take back
    // the cash/bank it had added to the booking row.
    if (delDueRef) adjustDueCell_(ss, delDueRef, delAmount, -delCash, -delBank);
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
