/**
 * Aggregate: builds the full dashboard payload from both spreadsheets,
 * with gzip'd CacheService caching (payload exceeds the 100KB plain limit).
 */

var CACHE_KEY = 'dash_v8';
var CACHE_SECS = 600; // 10 min

function getDashboardData(forceRefresh) {
  var cache = CacheService.getScriptCache();
  if (!forceRefresh) {
    var hit = cache.get(CACHE_KEY);
    if (hit) {
      try {
        var bytes = Utilities.base64Decode(hit);
        var json = Utilities.ungzip(Utilities.newBlob(bytes, 'application/x-gzip'))
          .getDataAsString();
        return json;
      } catch (e) { /* fall through to rebuild */ }
    }
  }
  var payload = buildPayload_();
  var json2 = JSON.stringify(payload);
  try {
    var gz = Utilities.gzip(Utilities.newBlob(json2, 'application/octet-stream'));
    cache.put(CACHE_KEY, Utilities.base64Encode(gz.getBytes()), CACHE_SECS);
  } catch (e) { /* payload too big for cache: serve uncached */ }
  return json2;
}

function buildPayload_() {
  var books = [];
  var errors = [];
  HOTELS.forEach(function (h) {
    try {
      var ss = SpreadsheetApp.openById(h.id);
      books.push({
        hotel: h.hotel,
        tabs: ss.getSheets().map(function (sheet) {
          return { name: sheet.getName(), values: sheet.getDataRange().getValues() };
        })
      });
    } catch (e) {
      errors.push(h.hotel + ': cannot open spreadsheet (' + e.message + ')');
    }
  });
  return buildPayloadFromBooks_(books, errors);
}

/** Pure aggregation over pre-fetched tab values (unit-testable outside GAS). */
function buildPayloadFromBooks_(books, errors) {
  var months = []; // one entry per hotel-month
  errors = errors || [];
  var now = new Date();
  books.forEach(function (h) {
    var hotelCfg = null;
    for (var i = 0; i < HOTELS.length; i++) {
      if (HOTELS[i].hotel === h.hotel) hotelCfg = HOTELS[i];
    }
    h.tabs.forEach(function (sheet) {
      var ym = tabMonth(sheet.name);
      if (!ym) return; // not a monthly tab
      var parsed = parseTab_(sheet.values, ym.year, ym.month);
      var daysInMonth = new Date(ym.year, ym.month, 0).getDate();
      var isCurrent = ym.year === now.getFullYear() && ym.month === now.getMonth() + 1;
      var daysElapsed = isCurrent ? Math.min(now.getDate(), daysInMonth) : daysInMonth;
      var entry = {
        hotel: h.hotel,
        tab: sheet.name,
        ym: ym.year + '-' + (ym.month < 10 ? '0' : '') + ym.month,
        year: ym.year,
        month: ym.month,
        rent: 0, food: 0, expense: 0,
        gst: 0, cashIn: 0, bankIn: 0,
        roomNights: 0, bookings: 0,
        dueTotal: 0, discountTotal: 0,
        rooms: hotelCfg ? hotelCfg.rooms : 0,
        daysInMonth: daysInMonth,
        daysElapsed: daysElapsed,
        salary: Math.round(SALARY_PER_HOTEL_MONTH * daysElapsed / daysInMonth),
        rentBySource: {},
        expByCat: {},
        expByCatRows: {}, // category -> [{ day, particular, amount, hotel }]
        // per-day: { d: {rev, exp} }
        days: {},
        flags: parsed.flags.slice(0, 40)
      };
      parsed.sections.forEach(function (s) {
        var d;
        entry.dueTotal += s.due || 0;
        entry.discountTotal += s.discount || 0;
        if (s.type === 'rent') {
          entry.rent += s.total;
          entry.gst += s.gst;
          entry.bookings += s.rows;
          entry.roomNights += s.nights > 0 ? s.nights : s.rows;
          entry.cashIn += s.cash;
          entry.bankIn += s.bank;
          for (d in s.sources) {
            entry.rentBySource[d] = (entry.rentBySource[d] || 0) + s.sources[d];
          }
          for (d in s.days) {
            entry.days[d] = entry.days[d] || { rev: 0, exp: 0, rent: 0, nights: 0 };
            entry.days[d].rev += s.days[d];
            entry.days[d].rent += s.days[d]; // room revenue only (for same-date ADR/RevPAR)
          }
          for (d in s.nightsByDay) {
            entry.days[d] = entry.days[d] || { rev: 0, exp: 0, rent: 0, nights: 0 };
            entry.days[d].nights += s.nightsByDay[d]; // room-nights per day (for same-date occupancy)
          }
        } else if (s.type === 'food') {
          entry.food += s.total;
          entry.cashIn += s.cash;
          entry.bankIn += s.bank;
          for (d in s.days) {
            entry.days[d] = entry.days[d] || { rev: 0, exp: 0, rent: 0, nights: 0 };
            entry.days[d].rev += s.days[d];
          }
        } else if (s.type === 'expense') {
          entry.expense += s.total;
          for (d in s.cats) {
            entry.expByCat[d] = (entry.expByCat[d] || 0) + s.cats[d];
          }
          for (d in s.catRows) {
            if (!entry.expByCatRows[d]) entry.expByCatRows[d] = [];
            var tagged = s.catRows[d].map(function (r) {
              return { day: r.day, particular: r.particular, amount: r.amount, hotel: h.hotel };
            });
            entry.expByCatRows[d] = entry.expByCatRows[d].concat(tagged);
          }
          for (d in s.days) {
            entry.days[d] = entry.days[d] || { rev: 0, exp: 0, rent: 0, nights: 0 };
            entry.days[d].exp += s.days[d];
          }
        }
      });
      for (var dnum in entry.days) {
        entry.days[dnum].net = entry.days[dnum].rev - entry.days[dnum].exp;
      }
      entry.revenue = entry.rent + entry.food;
      // Dream only (Paradise's foodCostPct is 0): owner-assumed cost of
      // unbooked in-house kitchen ingredients, additive on top of
      // entry.expense (which already includes any real "Outside Food"
      // bookings for Dream). See HOTELS config comment.
      entry.foodCost = hotelCfg ? Math.round(entry.food * (hotelCfg.foodCostPct || 0)) : 0;
      entry.totalCost = entry.expense + entry.salary + entry.foodCost;
      entry.net = entry.revenue - entry.totalCost;
      var availableNights = entry.rooms * entry.daysElapsed;
      entry.occupancy = availableNights > 0 ? entry.roomNights / availableNights : 0;
      entry.adr = entry.roomNights > 0 ? entry.rent / entry.roomNights : 0;
      entry.revpar = availableNights > 0 ? entry.rent / availableNights : 0;
      months.push(entry);
    });
  });
  months.sort(function (a, b) {
    return a.ym < b.ym ? -1 : a.ym > b.ym ? 1 : a.hotel < b.hotel ? -1 : 1;
  });
  return {
    generatedAt: new Date().toISOString(),
    hotels: HOTELS.map(function (h) { return h.hotel; }),
    months: months,
    errors: errors
  };
}
