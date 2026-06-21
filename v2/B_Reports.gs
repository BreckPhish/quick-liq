/**
 * B_Reports.gs — PDF generation + email.
 *
 * GAS can't render HTML→PDF directly, so we build a throwaway spreadsheet, format it,
 * fetch its PDF export, and trash it — the reliable Apps Script pattern. Reports are
 * derived from the same data the UI shows (counts + batch demand, on-hand vs par).
 */

/** Build a PDF blob from a simple table (header row + data rows). */
function exportTableToPdfBlob_(title, columns, rows) {
  const tmp = SpreadsheetApp.create('TMP_REPORT_' + Date.now());
  try {
    const sheet = tmp.getSheets()[0];
    const matrix = [columns].concat(rows.length ? rows : [columns.map(function () { return ''; })]);
    sheet.getRange(1, 1, matrix.length, columns.length).setValues(matrix);
    sheet.getRange(1, 1, 1, columns.length).setFontWeight('bold').setBackground('#eeeeee');
    sheet.setFrozenRows(1);
    sheet.autoResizeColumns(1, columns.length);
    SpreadsheetApp.flush();
    const url = 'https://docs.google.com/spreadsheets/d/' + tmp.getId()
      + '/export?format=pdf&size=letter&portrait=true&gridlines=false&fitw=true'
      + '&top_margin=0.4&bottom_margin=0.4&left_margin=0.4&right_margin=0.4';
    const resp = UrlFetchApp.fetch(url, {
      headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() },
      muteHttpExceptions: true,
    });
    if (resp.getResponseCode() !== 200) throw new Error('PDF export failed (' + resp.getResponseCode() + ').');
    return resp.getBlob().setName(title + '.pdf').copyBlob();
  } finally {
    try { DriveApp.getFileById(tmp.getId()).setTrashed(true); } catch (e) {}
  }
}

/** Inventory report: one row per item with per-location counts, batch, and total. */
function inventoryReport_() {
  const locations = new LocationsRepo().activeOrdered();
  const counts = new CountsRepo().byItem();
  const batch = computeBatchContributions_();
  const items = new ItemsRepo().all();
  const itemsById = {}; items.forEach(function (it) { itemsById[String(it.id)] = it; });
  const sectionItems = new SectionItemsRepo().bySection();
  const sections = new SectionsRepo().ordered();

  const columns = ['Section', 'Item'].concat(locations.map(function (l) { return l.name; })).concat(['Batch', 'Total']);
  const rows = [];
  sections.forEach(function (sec) {
    (sectionItems[String(sec.id)] || []).forEach(function (itemId) {
      const it = itemsById[String(itemId)];
      if (!it || bool_(it.archived)) return;
      const locQtys = counts[String(itemId)] || {};
      const b = batch[String(itemId)] || 0;
      const locVals = locations.map(function (l) { const q = locQtys[String(l.id)]; return q == null ? '' : q; });
      rows.push([sec.name, it.commonName].concat(locVals)
        .concat([b > 0 ? round_(b, 1) : '', itemTotal_(locQtys, b)]));
    });
  });
  return { title: 'Inventory', columns: columns, rows: rows };
}

/** Order report: a header row per distributor (reps / order-by / minimum) then its lines. */
function orderReport_() {
  const items = new ItemsRepo().all();
  const itemsById = {}; items.forEach(function (it) { itemsById[String(it.id)] = it; });
  const vendorsById = {}; new VendorsRepo().all().forEach(function (v) { vendorsById[String(v.id)] = v; });
  const groups = buildOrderGuide_(items, onHandTotals_(), {});
  groups.forEach(function (g) { g.vendorName = (vendorsById[g.vendorId] && vendorsById[g.vendorId].name) || g.vendorId || 'UNASSIGNED'; });
  groups.sort(function (a, b) { return String(a.vendorName).localeCompare(String(b.vendorName)); });

  const columns = ['Distributor', 'Item', 'On hand', 'Par', 'Order', 'Cases'];
  const rows = [];
  groups.forEach(function (g) {
    const meta = vendorMeta_(vendorsById[g.vendorId]);
    let est = 0;
    g.lines.forEach(function (l) { est += num_((itemsById[String(l.itemId)] || {}).cost, 0) * num_(l.suggestedUnits, 0); });
    const metaBits = [];
    meta.reps.forEach(function (r) {
      const c = [r.name, r.phone, r.email].filter(Boolean).join(' ');
      if (c) metaBits.push('Rep: ' + c);
    });
    if (meta.orderDays.length) metaBits.push('Order by: ' + meta.orderDays.join(', '));
    if (meta.orderNote) metaBits.push(meta.orderNote);
    if (meta.minOrder > 0) {
      metaBits.push('Min $' + meta.minOrder.toFixed(2) + ' (est $' + est.toFixed(2) + (est < meta.minOrder ? ' — UNDER' : '') + ')');
    }
    rows.push([g.vendorName, metaBits.join('  ·  '), '', '', '', '']);
    g.lines.forEach(function (l) {
      rows.push(['', l.orderName, l.onHand, l.par, l.suggestedUnits, l.suggestedCases || '']);
    });
  });
  return { title: 'Order Guide', columns: columns, rows: rows };
}

function blobToResult_(blob) {
  return { data: Utilities.base64Encode(blob.getBytes()), mimeType: 'application/pdf', fileName: blob.getName() };
}

/* ---- Endpoints ---- */

function generateInventoryPdf() {
  return api_(function () {
    assertAccess_();
    const rep = inventoryReport_();
    return blobToResult_(exportTableToPdfBlob_('Inventory', rep.columns, rep.rows));
  });
}

function generateOrderGuidePdf() {
  return api_(function () {
    assertAccess_();
    const rep = orderReport_();
    return blobToResult_(exportTableToPdfBlob_('Order Guide', rep.columns, rep.rows));
  });
}

/**
 * Email selected reports.
 * @param {Object} payload { recipients, subject, body, includeInventory, includeOrder }
 */
function emailReports(payload) {
  return api_(function () {
    assertAccess_();
    payload = payload || {};
    const recipients = String(payload.recipients || '').split(/[,;\n]+/)
      .map(function (s) { return s.trim(); }).filter(Boolean);
    if (!recipients.length) throw new Error('At least one recipient is required.');
    const attachments = [];
    if (payload.includeInventory) {
      const r = inventoryReport_(); attachments.push(exportTableToPdfBlob_('Inventory', r.columns, r.rows));
    }
    if (payload.includeOrder) {
      const r = orderReport_(); attachments.push(exportTableToPdfBlob_('Order Guide', r.columns, r.rows));
    }
    if (!attachments.length) throw new Error('Select at least one report to send.');
    MailApp.sendEmail({
      to: recipients.join(','),
      subject: String(payload.subject || 'Tin Plate — Beverage Report'),
      body: String(payload.body || 'Reports attached.'),
      attachments: attachments,
    });
    return { ok: true, recipients: recipients.length, attachments: attachments.length };
  });
}
