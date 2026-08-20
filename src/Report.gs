/**
 * Report.gs: read-only server for the staff PWA's Dashboard view.
 *
 * Two things the owner asked for, both scoped to the PIN'd hotel:
 *   1. Daily entry report — per-day rent/food/expense/recovery totals for a
 *      chosen month (getDailyReport).
 *   2. Per-party due tracker — reconciles dues incurred against recoveries
 *      (the recovery ledger section), rolled up this-month / this-year /
 *      lifetime (getDuesTracker). A recovery hard-links to the exact rent row
 *      it pays down via 'Due ref' (that row's own _entryId, reused as a
 *      foreign key — buildDueIndex_); only recoveries with no link, or a link
 *      that no longer resolves, fall back to matching by normalized 'Party'
 *      text (the legacy behavior, kept for dues that predate _entryId/Due ref).
 *
 * The rent 'Due' cell is LIVE, not a frozen original: Entry.gs's submitEntry/
 * updateEntry/deleteEntry write the linked due's Due cell down (or back up) by
 * exactly the recovered amount every time a linked recovery is posted, edited,
 * or removed (adjustDueCell_/findRentDueRowById_, both GAS-boundary — the
 * write-back can't run from a Node harness). So `Due` always shows the CURRENT
 * outstanding, visible directly in the raw sheet — and because Parser.gs's
 * dueTotal is just a live sum of that same column, the owner P&L dashboard's
 * "Dues outstanding (recorded)" stat nets recoveries automatically, with zero
 * changes to Aggregate.gs/Index.html/CACHE_KEY (dueTotal was never folded into
 * revenue/net, so a value that moves over time doesn't violate the parser's
 * byte-identical-totals invariant — confirmed: validateAll() doesn't touch Due
 * at all). buildDueIndex_ below reads Due as the current outstanding directly
 * and DERIVES the original incurred amount as outstanding+recovered, rather
 * than storing a separate "original" column — correct as long as Due is only
 * ever adjusted through the linked-recovery write-back or an explicit manual
 * correction (both are just "this is what's currently owed," no invariant to
 * violate either way).
 *
 * Same pure/thin split as the rest of the project: the cores below take
 * already-fetched 2D values and are Node-testable; the thin GAS wrappers open
 * the book and verify the PIN. Both cores REUSE the parser's own helpers
 * (detectSections_/colFor_/dayOf_/num_/norm_ in Parser.gs) so the read side
 * lands on exactly the columns the entry app wrote — no drift.
 */

/* ------------------------------ PURE CORE ------------------------------ */

/** Sum one section's amount column by day-of-month. Mirrors parseTab_'s row
 * walk (blank-date carries the previous row's day) so Σ byDay == section total
 * for the same data. Returns { byDay:{d:amt}, total }. */
function sumSectionByDay_(values, det, type, month, amtCands) {
  var sec = null;
  for (var i = 0; i < det.sections.length; i++) {
    if (det.sections[i].type === type) { sec = det.sections[i]; break; }
  }
  var byDay = {}, total = 0;
  if (!sec) return { byDay: byDay, total: total };
  var amtCol = colFor_(sec.heads, amtCands);
  if (amtCol === null) return { byDay: byDay, total: total };
  var lastDay = null;
  for (var r = det.headerRow + 1; r < values.length; r++) {
    var amt = num_(values[r][amtCol]);
    if (amt === null || amt === 0) continue;
    var d = dayOf_(values[r][sec.dateCol], month);
    if (d === null) { if (lastDay !== null) d = lastDay; else continue; }
    lastDay = d;
    byDay[d] = (byDay[d] || 0) + amt;
    total += amt;
  }
  return { byDay: byDay, total: total };
}

/**
 * Daily report for one month tab. `net` is the day's operating net
 * (rent + food − expense); recovery is a separate cash-in column, deliberately
 * NOT folded into net (the original due was never booked as revenue, so adding
 * a recovery to net would double-count). Per-day recovery is split into
 * cash/bank (owner asked for the split, not a lump figure, in the Daily
 * Report); `totals.recovery` stays sourced from the Amount column directly
 * (a trustworthy grand total even if a row's cash+bank don't sum to its
 * amount — the same looseness rent/food already tolerate), while
 * `totals.recoveryCash`/`recoveryBank` match what the day rows sum to.
 * Returns { days:[{day,rent,food,expense,recoveryCash,recoveryBank,net}],
 *           totals:{rent,food,expense,recovery,recoveryCash,recoveryBank,net} }.
 */
function buildDailyReport_(values, month) {
  var det = detectSections_(values);
  if (!det) return { days: [], totals: { rent: 0, food: 0, expense: 0, recovery: 0, recoveryCash: 0, recoveryBank: 0, net: 0 } };
  var rent = sumSectionByDay_(values, det, 'rent', month, ['total revenue', 'grand total', 'amount']);
  var food = sumSectionByDay_(values, det, 'food', month, ['amount', 'amount(rs)']);
  var exp  = sumSectionByDay_(values, det, 'expense', month, ['amount', 'amount(rs)']);
  var rec  = sumSectionByDay_(values, det, 'recovery', month, ['amount', 'amount(rs)']);
  var recCash = sumSectionByDay_(values, det, 'recovery', month, ['cash', 'cash/bank']);
  var recBank = sumSectionByDay_(values, det, 'recovery', month, ['banking', 'banking & upi']);
  var daysSet = {};
  [rent, food, exp, recCash, recBank].forEach(function (s) { for (var d in s.byDay) daysSet[d] = true; });
  var days = Object.keys(daysSet).map(Number).sort(function (a, b) { return a - b; }).map(function (d) {
    var rt = rent.byDay[d] || 0, fd = food.byDay[d] || 0, ex = exp.byDay[d] || 0;
    var rcc = recCash.byDay[d] || 0, rcb = recBank.byDay[d] || 0;
    return { day: d, rent: rt, food: fd, expense: ex, recoveryCash: rcc, recoveryBank: rcb, net: rt + fd - ex };
  });
  return {
    days: days,
    totals: {
      rent: rent.total, food: food.total, expense: exp.total, recovery: rec.total,
      recoveryCash: recCash.total, recoveryBank: recBank.total,
      net: rent.total + food.total - exp.total
    }
  };
}

/** raw party cell -> { key (normalized for matching), display }. Blank -> the
 * "Unattributed" bucket (legacy dues with no party named). */
function partyOf_(raw) {
  var disp = String(raw === null || raw === undefined ? '' : raw).replace(/\s+/g, ' ').trim();
  if (!disp) return { key: '__unattributed__', display: 'Unattributed' };
  return { key: disp.toLowerCase(), display: disp };
}

/**
 * Index of due records by dueId (the linked rent row's own _entryId — every
 * app-submitted row gets one on write, rent included, regardless of Due; see
 * Entry.gs submitEntry). `outstanding` is read DIRECTLY from the rent row's
 * live Due cell (Entry.gs keeps it in sync on every linked recovery write);
 * `recovered` is independently summed from every recovery row whose 'Due ref'
 * resolves here; `amount` (the original incurred figure) is DERIVED as
 * outstanding+recovered — correct as long as Due is only ever adjusted
 * through the linked-recovery write-back (see the file header). No stored
 * "original due" column is needed. Rows with no resolvable _entryId (pre-app
 * manual rows) are NOT linkable and are left for buildDuesLedger_'s legacy
 * party-name fallback.
 *
 * Every rent row with a non-blank _entryId is indexed regardless of its
 * current Due value — a fully-recovered due legitimately shows Due=0 (still
 * outstanding-searchable-by-id, just not openDues-listable) and must stay
 * findable so a recovery referencing it is never mistaken for orphaned.
 * Ordinary bookings that never had a due (Due=0, no recovery history either)
 * are filtered out of the returned byId/list (amount would compute to 0).
 *
 * Pure — shared by buildDuesLedger_ (dashboard display) and Entry.gs's
 * write-time guards (deleteEntry/updateEntry/submitEntry), so both paths read
 * the exact same live numbers and can never disagree.
 *
 * Returns { byId: {dueId: dueRecord}, list: [dueRecord,...] } (list sorted
 * newest-first) where dueRecord = { dueId, party, room, year, month, day, ym,
 * amount, recovered, recoveryCount, outstanding }. `outstanding` is NEVER
 * clamped — an over-recovered due (should be prevented by the guards, but
 * shown honestly if it ever happens) reads negative rather than silently 0.
 */
function buildDueIndex_(tabs) {
  var byId = {};
  (tabs || []).forEach(function (tab) {
    var values = tab.values, month = tab.month, year = tab.year;
    var det = detectSections_(values);
    if (!det) return;
    var sec = null;
    for (var i = 0; i < det.sections.length; i++) {
      if (det.sections[i].type === 'rent') { sec = det.sections[i]; break; }
    }
    if (!sec) return;
    var heads = sec.heads;
    var dueCol = colFor_(heads, ['due']);
    var idCol = colFor_(heads, ['_entryid']);
    if (dueCol === null || idCol === null) return; // nothing linkable on this tab
    var partyCol = colFor_(heads, ['party', 'debtor', 'guest']);
    var roomCol = colFor_(heads, ['room with source', 'room no.', 'room no', 'room']);
    var lastDay = null;
    for (var r = det.headerRow + 1; r < values.length; r++) {
      var idRaw = values[r][idCol];
      var dueId = (idRaw === null || idRaw === undefined) ? '' : String(idRaw).trim();
      if (!dueId) continue; // legacy row, no id -> handled by the fallback path
      var dueVal = num_(values[r][dueCol]) || 0; // current live outstanding (may be 0)
      var d = dayOf_(values[r][sec.dateCol], month);
      if (d === null) d = lastDay; else lastDay = d;
      byId[dueId] = {
        dueId: dueId,
        party: partyCol !== null ? String(values[r][partyCol] || '').replace(/\s+/g, ' ').trim() : '',
        room: roomCol !== null ? String(values[r][roomCol] || '').replace(/\s+/g, ' ').trim() : '',
        year: year, month: month, day: d, ym: year + '-' + (month < 10 ? '0' : '') + month,
        outstanding: dueVal, recovered: 0, recoveryCount: 0, amount: 0 // amount filled in below
      };
    }
  });
  (tabs || []).forEach(function (tab) {
    var values = tab.values;
    var det = detectSections_(values);
    if (!det) return;
    var sec = null;
    for (var i = 0; i < det.sections.length; i++) {
      if (det.sections[i].type === 'recovery') { sec = det.sections[i]; break; }
    }
    if (!sec) return;
    var heads = sec.heads;
    var amtCol = colFor_(heads, ['amount', 'amount(rs)']);
    var refCol = colFor_(heads, ['due ref', 'dueref']);
    if (amtCol === null || refCol === null) return;
    for (var r = det.headerRow + 1; r < values.length; r++) {
      var amt = num_(values[r][amtCol]);
      if (!amt || amt <= 0) continue;
      var refRaw = values[r][refCol];
      var ref = (refRaw === null || refRaw === undefined) ? '' : String(refRaw).trim();
      if (!ref || !byId[ref]) continue; // unlinked or orphaned -> not this due's problem
      byId[ref].recovered += amt;
      byId[ref].recoveryCount++;
    }
  });
  var list = [];
  var filteredById = {};
  for (var k in byId) {
    var e = byId[k];
    e.amount = e.outstanding + e.recovered; // derive original incurred
    if (e.amount === 0) continue; // ordinary booking, never a due -> drop
    list.push(e);
    filteredById[k] = e;
  }
  list.sort(function (a, b) { return (b.year - a.year) || (b.month - a.month) || ((b.day || 0) - (a.day || 0)); });
  return { byId: filteredById, list: list };
}

/** One due record by id across tabs, or null if not found (unknown/deleted). */
function findDueById_(tabs, dueId) {
  if (!dueId) return null;
  return buildDueIndex_(tabs).byId[String(dueId).trim()] || null;
}

/** { recovered, count } already posted against dueId, or zeros if unresolved.
 * Used by Entry.gs's delete/update guards to check before mutating a due. */
function recoveredAgainstDue_(tabs, dueId) {
  var d = findDueById_(tabs, dueId);
  return d ? { recovered: d.recovered, count: d.recoveryCount } : { recovered: 0, count: 0 };
}

/** Pure predicate: can this rent row (identified by entryId) be deleted?
 * Refuses if anything's already been recovered against it — that would
 * silently orphan the recovery (see buildDuesLedger_'s orphaned-line
 * handling) — regardless of what the row's CURRENT Due cell shows. Checked on
 * `recoveredAgainstDue_` alone, not the caller's own read of Due: a
 * fully-recovered due legitimately shows Due=0 while still having recovery
 * history, so gating on "Due is currently >0" would wrongly allow deleting
 * it. Returns { ok } or { ok:false, count, recovered }. */
function canDeleteDue_(tabs, entryId) {
  var ref = recoveredAgainstDue_(tabs, entryId);
  if (ref.recovered > 0) return { ok: false, count: ref.count, recovered: ref.recovered };
  return { ok: true };
}

/** Pure predicate: can a recovery of `amount` be posted against `due` (a
 * dueRecord from findDueById_, or null if it couldn't be resolved)? Checked
 * inside submitEntry's lock against the LIVE due so two staff can't both post
 * a full recovery against the same due in the same window. */
function canRecoverAmount_(due, amount) {
  if (!due) return { ok: false, reason: 'not_found' };
  if (Number(amount) > due.outstanding + 0.01) return { ok: false, reason: 'exceeds', outstanding: due.outstanding };
  return { ok: true };
}

/**
 * Per-party due ledger over many month tabs. `tabs` = [{year, month, values}].
 * `now` = { year, month } fixes the this-month/this-year windows (the thin
 * wrapper passes the current date; tests pass a fixed one).
 *
 * Dues linked via a resolvable dueId (buildDueIndex_) bucket by the due's
 * CURRENT/live Party field, not any recovery's snapshot — renaming a typo'd
 * party later moves the bucket, recoveries don't get stuck under a stale name.
 * Rent rows with no id (legacy, pre-app) fall back to their own Party cell,
 * same as before this feature existed. Recoveries with a 'Due ref' that
 * resolves attribute to the linked due's live party; recoveries with no ref,
 * or a ref that fails to resolve (the source due was deleted — 'orphaned'),
 * fall back to the recovery row's own denormalized party text.
 *
 * Returns { parties:[{party,incurred,recovered,outstanding,lines:[...]}],
 *           scopes:{month,year,lifetime}, outstandingParties:[name,...],
 *           openDues:[{dueId,party,room,ym,year,month,day,amount,recovered,
 *                      outstanding},...] }  (openDues: outstanding>0, newest-first)
 */
function buildDuesLedger_(tabs, now) {
  now = now || {};
  var dueIdx = buildDueIndex_(tabs);
  var byKey = {};
  function bucket(key, display) {
    if (!byKey[key]) byKey[key] = { party: display, incurred: 0, recovered: 0, lines: [] };
    return byKey[key];
  }

  // Linked dues: always bucketed by the due's live party (dueIdx is fresh).
  dueIdx.list.forEach(function (d) {
    var p = partyOf_(d.party);
    var b = bucket(p.key, p.display);
    b.incurred += d.amount;
    b.lines.push({
      type: 'due', year: d.year, month: d.month, day: d.day, amount: d.amount,
      room: d.room, remark: '', dueId: d.dueId
    });
  });

  (tabs || []).forEach(function (tab) {
    var values = tab.values, month = tab.month, year = tab.year;
    var det = detectSections_(values);
    if (!det) return;
    det.sections.forEach(function (sec) {
      var heads = sec.heads;
      if (sec.type === 'rent') {
        // Legacy dues only (no resolvable _entryId) — linked rows are already
        // counted above via dueIdx, so skip anything dueIdx already claimed.
        var dueCol = colFor_(heads, ['due']);
        if (dueCol === null) return;
        var idCol = colFor_(heads, ['_entryid']);
        var partyCol = colFor_(heads, ['party', 'debtor', 'guest']);
        var roomCol = colFor_(heads, ['room with source', 'room no.', 'room no', 'room']);
        var lastDay = null;
        for (var r = det.headerRow + 1; r < values.length; r++) {
          var due = num_(values[r][dueCol]);
          if (!due || due <= 0) continue;
          var d0 = dayOf_(values[r][sec.dateCol], month);
          if (d0 === null) d0 = lastDay; else lastDay = d0;
          var idRaw = idCol !== null ? values[r][idCol] : null;
          var hasId = idRaw !== null && idRaw !== undefined && String(idRaw).trim() !== '';
          if (hasId) continue; // linked -> already counted via dueIdx above
          var p = partyOf_(partyCol !== null ? values[r][partyCol] : '');
          var b = bucket(p.key, p.display);
          b.incurred += due;
          b.lines.push({
            type: 'due', year: year, month: month, day: d0, amount: due,
            room: roomCol !== null ? String(values[r][roomCol] || '').replace(/\s+/g, ' ').trim() : '',
            remark: ''
          });
        }
      } else if (sec.type === 'recovery') {
        var amtCol = colFor_(heads, ['amount', 'amount(rs)']);
        if (amtCol === null) return;
        var pcol = colFor_(heads, ['recovery party', 'party', 'debtor', 'guest']);
        var rmcol = colFor_(heads, ['room']);
        var rkcol = colFor_(heads, ['remark', 'remarks']);
        var refCol = colFor_(heads, ['due ref', 'dueref']);
        var lastD = null;
        for (var rr = det.headerRow + 1; rr < values.length; rr++) {
          var amt = num_(values[rr][amtCol]);
          if (!amt || amt <= 0) continue;
          var dd = dayOf_(values[rr][sec.dateCol], month);
          if (dd === null) dd = lastD; else lastD = dd;
          var refRaw = refCol !== null ? values[rr][refCol] : null;
          var ref = (refRaw === null || refRaw === undefined) ? '' : String(refRaw).trim();
          var linkedDue = ref ? dueIdx.byId[ref] : null;
          var bb, orphaned = false;
          if (linkedDue) {
            var lp = partyOf_(linkedDue.party);
            bb = bucket(lp.key, lp.display);
          } else {
            if (ref) orphaned = true; // had a ref, but it doesn't resolve -> dangling
            var pp = partyOf_(pcol !== null ? values[rr][pcol] : '');
            bb = bucket(pp.key, pp.display);
          }
          bb.recovered += amt;
          bb.lines.push({
            type: 'recovery', year: year, month: month, day: dd, amount: amt,
            room: rmcol !== null ? String(values[rr][rmcol] || '').replace(/\s+/g, ' ').trim() : '',
            remark: rkcol !== null ? String(values[rr][rkcol] || '').replace(/\s+/g, ' ').trim() : '',
            dueId: ref || null, orphaned: orphaned
          });
        }
      }
    });
  });

  var parties = [];
  for (var k in byKey) {
    var e = byKey[k];
    e.lines.sort(function (a, b) { return (a.year - b.year) || (a.month - b.month) || ((a.day || 0) - (b.day || 0)); });
    parties.push({
      party: e.party, incurred: e.incurred, recovered: e.recovered,
      outstanding: e.incurred - e.recovered, lines: e.lines
    });
  }
  parties.sort(function (a, b) { return b.outstanding - a.outstanding; });

  function blank() { return { incurred: 0, recovered: 0, outstanding: 0 }; }
  var scopes = { month: blank(), year: blank(), lifetime: blank() };
  parties.forEach(function (p) {
    p.lines.forEach(function (ln) {
      var field = ln.type === 'due' ? 'incurred' : 'recovered';
      scopes.lifetime[field] += ln.amount;
      if (now.year && ln.year === now.year) {
        scopes.year[field] += ln.amount;
        if (now.month && ln.month === now.month) scopes.month[field] += ln.amount;
      }
    });
  });
  ['month', 'year', 'lifetime'].forEach(function (s) {
    scopes[s].outstanding = scopes[s].incurred - scopes[s].recovered;
  });

  var outstandingParties = parties
    .filter(function (p) { return p.outstanding > 0 && p.party !== 'Unattributed'; })
    .map(function (p) { return p.party; });

  var openDues = dueIdx.list
    .filter(function (d) { return d.outstanding > 0; })
    .map(function (d) {
      return {
        dueId: d.dueId, party: d.party || 'Unattributed', room: d.room, ym: d.ym,
        year: d.year, month: d.month, day: d.day, amount: d.amount,
        recovered: d.recovered, outstanding: d.outstanding
      };
    }); // dueIdx.list is already sorted newest-first

  return { parties: parties, scopes: scopes, outstandingParties: outstandingParties, openDues: openDues };
}

/* ----------------------------- GAS BOUNDARY ---------------------------- */

/** Every tabMonth_-named sheet in a book -> [{year, month, values}]. Shared by
 * getDuesTracker and Entry.gs's write-time due guards (deleteEntry/updateEntry/
 * submitEntry) so both read the exact same whole-book snapshot. */
function collectAllTabs_(ss) {
  var sheets = ss.getSheets(), tabs = [];
  for (var i = 0; i < sheets.length; i++) {
    var t = tabMonth(sheets[i].getName());
    if (t) tabs.push({ year: t.year, month: t.month, values: sheets[i].getDataRange().getValues() });
  }
  return tabs;
}

/** Daily report for one month. ym = 'YYYY-MM'. PIN-gated, hotel-scoped. */
function getDailyReport(hotel, pin, ym) {
  verifyPin_(hotel, pin);
  var p = ymParts_(ym);
  var ss = SpreadsheetApp.openById(hotelCfg_(hotel).id);
  var sheets = ss.getSheets();
  for (var i = 0; i < sheets.length; i++) {
    var t = tabMonth(sheets[i].getName());
    if (t && t.year === p.year && t.month === p.month) {
      var rep = buildDailyReport_(sheets[i].getDataRange().getValues(), p.month);
      rep.ym = ym; rep.tab = sheets[i].getName();
      return rep;
    }
  }
  return { days: [], totals: { rent: 0, food: 0, expense: 0, recovery: 0, recoveryCash: 0, recoveryBank: 0, net: 0 }, ym: ym, tab: null };
}

/** Per-party due tracker across the whole hotel book. PIN-gated, hotel-scoped.
 * Scans every month tab (small books; add a short-TTL cache here if it grows). */
function getDuesTracker(hotel, pin) {
  verifyPin_(hotel, pin);
  var ss = SpreadsheetApp.openById(hotelCfg_(hotel).id);
  var tabs = collectAllTabs_(ss);
  var d = new Date();
  return buildDuesLedger_(tabs, { year: d.getFullYear(), month: d.getMonth() + 1 });
}

// Node-harness export (ignored inside GAS, where `module` is undefined).
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    sumSectionByDay_: sumSectionByDay_, buildDailyReport_: buildDailyReport_,
    partyOf_: partyOf_, buildDueIndex_: buildDueIndex_, findDueById_: findDueById_,
    recoveredAgainstDue_: recoveredAgainstDue_, canDeleteDue_: canDeleteDue_,
    canRecoverAmount_: canRecoverAmount_, buildDuesLedger_: buildDuesLedger_
  };
}
