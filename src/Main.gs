/**
 * Web app entry points.
 */

/* ------------------------------ PURE CORE ------------------------------ */

/** Pure: is `email` on the comma-separated allowlist `allowCsv`? Case/space-
 * insensitive. Inert (returns true) when allowCsv is unset/blank — same idiom
 * as DASHBOARD_TOKEN. Never the sole gate; dashboardAllowed_ ANDs it with
 * tokenOk. Never set in source, only in Script Properties. */
function emailAllowed_(email, allowCsv) {
  if (!allowCsv) return true;
  var list = String(allowCsv).split(',').map(function (s) {
    return s.trim().toLowerCase();
  }).filter(function (s) { return s.length > 0; });
  return list.indexOf(String(email || '').trim().toLowerCase()) !== -1;
}

/* ----------------------------- GAS BOUNDARY ----------------------------- */

function doGet(e) {
  var p = (e && e.parameter) || {};

  // Daily-entry app (PWA). Served for its own web-app deployment (access =
  // ANYONE, PIN-gated in Entry.gs). SECURITY: the dashboard branch below is
  // gated behind DASHBOARD_TOKEN + DASHBOARD_ALLOWED_EMAILS (see
  // dashboardAllowed_) so `?view=entry` can't be dropped to read the P&L.
  if (p.view === 'entry') {
    return HtmlService.createHtmlOutputFromFile('Form')
      .setTitle('Daily Entry — Dream & Paradise')
      .addMetaTag('viewport', 'width=device-width, initial-scale=1, maximum-scale=1')
      .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
  }

  // Dashboard (and its json feed) are gated. Because the public entry
  // deployment shares this doGet, gate them behind a secret so dropping
  // ?view=entry can't expose the P&L. The gate is inert until DASHBOARD_TOKEN
  // is set in Script Properties (so it never locks the owner out mid-setup);
  // once set, the dashboard URL must carry ?k=<token>.
  if (!dashboardAllowed_(p)) {
    return HtmlService.createHtmlOutput(
      '<p style="font-family:sans-serif;padding:24px;color:#333">Access denied.</p>')
      .setTitle('Hotel P&L');
  }

  if (p.json === '1') {
    // Diagnostic endpoint: raw payload for verification.
    return ContentService.createTextOutput(getDashboardData(p.force === '1'))
      .setMimeType(ContentService.MimeType.JSON);
  }
  return HtmlService.createHtmlOutputFromFile('Index')
    .setTitle('Hotel P&L — Dream & Paradise')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

/** Dashboard access check: two independent layers, both must pass.
 *  1. DASHBOARD_TOKEN (?k=<token>) — inert (allow) until set.
 *  2. DASHBOARD_ALLOWED_EMAILS — per-account allowlist checked against the
 *     signed-in caller's identity, inert (allow) until set.
 *  See emailAllowed_ for the pure comparison. */
function dashboardAllowed_(p) {
  var props = PropertiesService.getScriptProperties();
  var tok = props.getProperty('DASHBOARD_TOKEN');
  var tokenOk = !tok || String((p && p.k) || '') === String(tok);
  var allowCsv = props.getProperty('DASHBOARD_ALLOWED_EMAILS');
  var email = Session.getActiveUser().getEmail();
  return tokenOk && emailAllowed_(email, allowCsv);
}

// Node-harness export (ignored inside GAS, where `module` is undefined).
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { emailAllowed_: emailAllowed_ };
}
