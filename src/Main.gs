/**
 * Web app entry points.
 */

function doGet(e) {
  if (e && e.parameter && e.parameter.json === '1') {
    // Diagnostic endpoint: raw payload for verification.
    return ContentService.createTextOutput(getDashboardData(e.parameter.force === '1'))
      .setMimeType(ContentService.MimeType.JSON);
  }
  return HtmlService.createHtmlOutputFromFile('Index')
    .setTitle('Hotel P&L — Dream & Paradise')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}
