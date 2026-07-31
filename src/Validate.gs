/**
 * Validation harness: prints per-tab section totals in the same format as the
 * local Python prototype (proto_parser.py), so the two parsers can be diffed.
 * Run validateAll() from the Apps Script editor or `clasp run validateAll`.
 */

function validateAll() {
  var lines = [];
  HOTELS.forEach(function (h) {
    lines.push('##### ' + h.hotel.toUpperCase());
    var ss = SpreadsheetApp.openById(h.id);
    ss.getSheets().forEach(function (sheet) {
      var ym = tabMonth(sheet.getName());
      if (!ym) {
        lines.push(sheet.getName() + ': NOT MONTHLY');
        return;
      }
      var parsed = parseTab_(sheet.getDataRange().getValues(), ym.year, ym.month);
      var secs = parsed.sections.map(function (s) {
        return s.type + ' rows=' + s.rows + ' total=' + Math.round(s.total) +
          ' cash=' + Math.round(s.cash) + ' bank=' + Math.round(s.bank) +
          (s.gst ? ' gst=' + Math.round(s.gst) : '');
      }).join(' || ');
      lines.push(sheet.getName() + ' (' + ym.year + '-' + ym.month + '): ' + secs +
        (parsed.flags.length ? '  FLAGS=' + parsed.flags.length : ''));
    });
  });
  var report = lines.join('\n');
  Logger.log(report);
  return report;
}
