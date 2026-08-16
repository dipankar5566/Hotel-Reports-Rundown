/**
 * Web app entry points.
 */

function doGet(e) {
  var p = (e && e.parameter) || {};

  // Daily-entry app (PWA). Served for its own web-app deployment (access =
  // ANYONE, PIN-gated in Entry.gs). SECURITY: the dashboard branch below is
  // owner-only today because this project's live deployment is access=MYSELF.
  // Before making an ANYONE deployment public, gate the dashboard branch too
  // (owner identity or a secret) so `?view=entry` can't be dropped to read the
  // P&L — see the plan's Security section.
  if (p.view === 'entry') {
    return HtmlService.createHtmlOutputFromFile('Form')
      .setTitle('Daily Entry — Dream & Paradise')
      .addMetaTag('viewport', 'width=device-width, initial-scale=1, maximum-scale=1')
      .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
  }

  // Dashboard (and its json feed) are owner-only. Because the public entry
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

/** Dashboard access check. Inert (returns true) until DASHBOARD_TOKEN is set in
 * Script Properties; once set, the request must carry a matching ?k=<token>. */
function dashboardAllowed_(p) {
  var tok = PropertiesService.getScriptProperties().getProperty('DASHBOARD_TOKEN');
  if (!tok) return true;
  return String((p && p.k) || '') === String(tok);
}
