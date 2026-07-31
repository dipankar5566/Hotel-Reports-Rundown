/**
 * Parser: turns one monthly tab (2D values array) into normalized rows.
 *
 * Tabs contain up to three side-by-side sections, located by anchor headers
 * because their column positions shift from month to month:
 *   rent    -> "Room WITH SOURCE" / "Room no."
 *   food    -> "Room (food & others)"
 *   expense -> "Particulers"
 * Embedded pivot blocks ("SUM of ...") share rows with raw data and must be
 * excluded by bounding each section's columns.
 */

function norm_(v) {
  return v === null || v === undefined
    ? ''
    : String(v).replace(/\s+/g, ' ').trim().toLowerCase();
}

/** Cell -> number. "-" and "" -> 0; " INR  1,100.00 " -> 1100; other text -> null. */
function num_(v) {
  if (v === null || v === undefined || v === '') return 0;
  if (typeof v === 'number') return isFinite(v) ? v : 0;
  var s = String(v).trim();
  if (s === '-' || s === '—' || s === '') return 0;
  s = s.replace(/inr/ig, '').replace(/,/g, '').trim();
  var n = parseFloat(s);
  return isNaN(n) ? null : n;
}

/**
 * Cell -> day of month (1..31) or null. The tab name fixes month/year, so we
 * only extract the day: Date objects, "13/11/2025", "11/25/2025", "16Nov",
 * "17 Nov", "1-Aug", "01.JAN", "1JUI", "18NON"...
 */
function dayOf_(v, month) {
  if (v instanceof Date) return v.getDate();
  if (v === null || v === undefined) return null;
  var s = String(v).trim();
  if (!s) return null;
  var m = s.match(/^(\d{1,2})[\/-](\d{1,2})[\/-]\d{2,4}/);
  if (m) {
    var a = Number(m[1]), b = Number(m[2]);
    if (b === month && a >= 1 && a <= 31) return a; // dd/mm/yyyy
    if (a === month && b >= 1 && b <= 31) return b; // mm/dd/yyyy
    return a >= 1 && a <= 31 ? a : null;
  }
  m = s.match(/(\d{1,2})/);
  if (m) {
    var d = Number(m[1]);
    return d >= 1 && d <= 31 ? d : null;
  }
  return null;
}

function anchorType_(h) {
  if (h.indexOf('particuler') !== -1 || h.indexOf('particular') !== -1) return 'expense';
  if (h.indexOf('room (food') === 0) return 'food';
  if (h === 'room with source' || h.indexOf('room no') === 0) return 'rent';
  return null;
}

function isPivotHeader_(h) {
  return /^(sum of|count|average|number of)/.test(h);
}

/** Find header row (first 4 rows) and section descriptors. */
function detectSections_(values) {
  var maxCols = values.length ? values[0].length : 0;
  for (var hr = 0; hr < Math.min(4, values.length); hr++) {
    var anchors = [];
    for (var c = 0; c < maxCols; c++) {
      var t = anchorType_(norm_(values[hr][c]));
      if (t) anchors.push({ col: c, type: t });
    }
    if (!anchors.length) continue;
    var sections = [];
    for (var i = 0; i < anchors.length; i++) {
      var ac = anchors[i].col;
      var start = Math.max(0, ac - 2);
      var end = i + 1 < anchors.length
        ? anchors[i + 1].col - 3
        : Math.min(ac + 14, maxCols - 1);
      var heads = {};
      var blankRun = 0;
      for (var cc = start; cc <= end; cc++) {
        var h = norm_(values[hr][cc]);
        if (isPivotHeader_(h)) break;
        if (h) {
          blankRun = 0;
          if (!(h in heads)) heads[h] = cc;
        } else if (Object.keys(heads).length && ++blankRun >= 3) {
          // 3+ blank header cells after this section's own headers means
          // we've drifted into an unrelated ad-hoc table further right on
          // the same row (e.g. a staff payment tracker) — stop here rather
          // than absorbing its headers (a stray "date"/"amount" column can
          // silently break date/amount detection for the real section).
          break;
        }
      }
      var dc = 'date' in heads ? heads['date'] : null;
      if (dc === null && ac > 0 && norm_(values[hr][ac - 1]) === '') dc = ac - 1;
      if (dc === null) dc = colFor_(heads, ['date of arrival']);
      if (dc === null) continue;
      sections.push({ type: anchors[i].type, dateCol: dc, heads: heads });
    }
    if (sections.length) return { headerRow: hr, sections: sections };
  }
  return null;
}

/** Exact-match first, then prefix-match, over candidate header names. */
function colFor_(heads, cands) {
  var h;
  for (var i = 0; i < cands.length; i++) {
    if (cands[i] in heads) return heads[cands[i]];
  }
  for (var j = 0; j < cands.length; j++) {
    for (h in heads) {
      if (h.indexOf(cands[j]) === 0) return heads[h];
    }
  }
  return null;
}

/**
 * Parse one tab. Returns:
 * { sections: [{type, rows, total, cash, bank, gst, days:{d:amt}, cats:{cat:amt},
 *   catRows:{cat:[{day,particular,amount}]}, sources:{src:amt}}], flags: [...] }
 */
function parseTab_(values, year, month) {
  var det = detectSections_(values);
  var out = { sections: [], flags: [] };
  if (!det) {
    out.flags.push('no sections detected');
    return out;
  }
  det.sections.forEach(function (sec) {
    var heads = sec.heads;
    var t = sec.type;
    var amtCol = t === 'rent'
      ? colFor_(heads, ['total revenue', 'grand total', 'amount'])
      : colFor_(heads, ['amount', 'amount(rs)']);
    var cashCol = colFor_(heads, ['cash', 'cash/bank']);
    var bankCol = colFor_(heads, ['banking', 'banking & upi']);
    var gstCol = colFor_(heads, ['gst']);
    var partCol = colFor_(heads, ['particulers', 'particulars']);
    var srcCol = colFor_(heads, ['source']);
    var roomCol = colFor_(heads, ['room with source', 'room no.', 'room (food & others)']);
    var nightsCol = t === 'rent'
      ? colFor_(heads, ['night', 'nights', 'duration of stay', 'duration'])
      : null;
    var dueCol = colFor_(heads, ['due']);
    var discCol = colFor_(heads, ['discount', 'dicount']);
    if (amtCol === null) {
      out.flags.push(t + ': no amount column');
      return;
    }
    var s = { type: t, rows: 0, total: 0, cash: 0, bank: 0, gst: 0,
              nights: 0, due: 0, discount: 0,
              days: {}, cats: {}, catRows: {}, sources: {} };
    var lastDay = null;
    for (var r = det.headerRow + 1; r < values.length; r++) {
      var row = values[r];
      var amt = num_(row[amtCol]);
      if (amt === null || amt === 0) continue;
      var d = dayOf_(row[sec.dateCol], month);
      if (d === null) {
        var raw = row[sec.dateCol];
        if ((raw === null || raw === undefined || raw === '') && lastDay !== null) {
          d = lastDay;
          out.flags.push(t + ' r' + (r + 1) + ': blank date, used day ' + d);
        } else {
          out.flags.push(t + ' r' + (r + 1) + ': bad date "' + raw + '" (amount ' + amt + ' skipped)');
          continue;
        }
      }
      lastDay = d;
      s.rows++;
      s.total += amt;
      s.days[d] = (s.days[d] || 0) + amt;
      if (cashCol !== null) { var cv = num_(row[cashCol]); if (cv) s.cash += cv; }
      if (bankCol !== null) { var bv = num_(row[bankCol]); if (bv) s.bank += bv; }
      if (gstCol !== null) { var gv = num_(row[gstCol]); if (gv) s.gst += gv; }
      if (nightsCol !== null) {
        var nv = num_(row[nightsCol]);
        s.nights += (nv && nv > 0 && nv < 100) ? nv : 1; // text/blank/garbage -> 1 night
      }
      // Due/Discount columns hold numbers or free text ("DUE PAID"); only sum numbers
      if (dueCol !== null) { var dv = num_(row[dueCol]); if (dv) s.due += dv; }
      if (discCol !== null) { var xv = num_(row[discCol]); if (xv) s.discount += xv; }
      if (t === 'expense' && partCol !== null) {
        var cat = categorize(row[partCol]);
        s.cats[cat] = (s.cats[cat] || 0) + amt;
        var particular = String(row[partCol] || '').replace(/\s+/g, ' ').trim();
        if (particular) {
          if (!s.catRows[cat]) s.catRows[cat] = [];
          s.catRows[cat].push({ day: d, particular: particular, amount: amt });
        }
      }
      if (t === 'rent') {
        var src = 'Walk-in';
        if (srcCol !== null) {
          src = /oyo/i.test(String(row[srcCol])) ? 'OYO' : 'Walk-in';
        } else if (roomCol !== null && /oyo/i.test(String(row[roomCol]))) {
          src = 'OYO';
        }
        s.sources[src] = (s.sources[src] || 0) + amt;
      }
    }
    out.sections.push(s);
  });
  return out;
}
