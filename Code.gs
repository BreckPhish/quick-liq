/*************************
 * TIN PLATE INVENT — WEBAPP
 *
 * Google Apps Script web app backing the Tin Plate beverage management portal.
 * Bound to a Google Sheet, it serves a single-page UI (Index/Styles/JavaScript)
 * for taking bar/restaurant beverage inventory and building distributor order
 * guides. The script reads and writes the INVENT and ORDER sheets, persists UI
 * customization (sections, groups, distributors, layout) to hidden settings
 * sheets, and generates PDFs of the inventory count and order guides — which it
 * can email to recipients or bundle into a downloadable ZIP.
 *************************/

const CONFIG = {
  // WARNING: DEFAULT_SPREADSHEET_ID is a hardcoded fallback. Set the SPREADSHEET_ID
  // Script Property in Apps Script Project Settings to avoid committing a sensitive
  // resource ID to source control.
  DEFAULT_SPREADSHEET_ID: '1ZcYgv-1URnS11mq8STKsLaY383jxM7FgHK8pxgcg-h4',
  SPREADSHEET_ID_PROP: 'SPREADSHEET_ID',

  INVENT_SHEET: 'INVENT',
  ORDER_SHEET: 'ORDER',

  // 1-based columns
  COL: {
    COMMON_NAME: 2, // B
    ORDER_NAME: 3,  // C
    BOTTLE_SIZE: 4, // D
    PAR: 5,         // E
    G: 7,           // G (BAR)
    H: 8,           // H (OTHER)
    I: 9,           // I helper (G+H)
    J: 10,          // J (OFFICE)
    ID: 13,         // M
    CATEGORY: 14,   // N
    VENDOR: 15,     // O
    COST: 16,       // P
    CS_SIZE: 17,    // Q
    NOTES: 18       // R
  },

  SECTION_HEADINGS: [
    'BAR SHELF #1',
    'BAR SHELF #2',
    'BAR SHELF #3',
    'BAR SHELF #4',
    'EXTRAS/MIXERS',
    'RED WINE',
    'WHITE WINES',
    'CANNED BEERS/FRIDGE PRODUCTS',
    'KEGS',
    'FOR COOKING',
    'SODAS'
  ],

  VENDORS: ['RNDC', 'SOUTHERN', 'ELITE', 'BREAKTHRU', 'SODAS', 'SYSCO', 'OTHER'],

  CATEGORIES: [
    'WHITE WINE',
    'RED WINE',
    'VODKA',
    'GIN',
    'RUM',
    'WHISKEY',
    'LIQUEUR',
    'TEQUILA/MEZCAL',
    'MIXER',
    'COOKING',
    'BEER (CANS)',
    'BEER (KEGS)'
  ],

  DATE_LABEL_PATTERNS: ['LAST INVENTORY COMPLETED', 'INVENTORY COMPLETED', 'INVENTORY DATE'],
  INITIALS_LABEL_PATTERNS: ['INITIALS', 'INVENTORY INITIALS'],

  DATE_FALLBACK_CELL_INVENT: 'P1',
  DATE_FALLBACK_CELL_ORDER: 'P1',
  INITIALS_FALLBACK_CELL_INVENT: 'P2',
  INITIALS_FALLBACK_CELL_ORDER: 'P2',

  FORMAT_REFERENCE_ITEM_B: 'RED ROCKS CASK',

  SECTION_LABELS_PROP: 'SECTION_LABEL_OVERRIDES',
  UI_SETTINGS_SHEET: '_APP_SETTINGS',
  SECTION_GROUPS_SHEET: 'SECTION GROUPS',
  DISTRO_DATA_SHEET: 'DISTRO DATA',

  LOCKED_BG: '#2f2f2f',
  UNLOCKED_BG: '#ffffff',

  LOCK_WAIT_MS: 20000
};

const REQUIRED_DISTRIBUTORS = ['RNDC', 'BREAKTHRU', 'SOUTHERN', 'SYSCO', 'ELITE'];
const VENDOR_ALIASES = { EAGLE: 'ELITE' };

const ORDERING_TABLES = {
  // BREAKTHRU
  A: { sheet: 'BREAKTHRU', name: 'BREAK LIQWINE', tableId: 1031574663, a1: 'B4:I32' },
  B: { sheet: 'BREAKTHRU', name: 'BREAK BEER',    tableId: 1045980545, a1: 'B33:I36' },
  C: { sheet: 'BREAKTHRU', name: 'BREAK NA',      tableId: 61443856,   a1: 'B37:I40' },

  // ELITE
  D: { sheet: 'ELITE', name: 'ELITE BEER', tableId: 564112056,  a1: 'B4:I14' },
  E: { sheet: 'ELITE', name: 'ELITE LIQ',  tableId: 594999353,  a1: 'B15:I22' },
  F: { sheet: 'ELITE', name: 'ELITE WINE', tableId: 1662199859, a1: 'B23:I25' },

  // RNDC
  G: { sheet: 'RNDC', name: 'RNDC LIQ',   tableId: 1237917158, a1: 'B4:I32' },
  H: { sheet: 'RNDC', name: 'RNDC RED',   tableId: 11430817,   a1: 'B33:I47' },
  I: { sheet: 'RNDC', name: 'RNDC WHITE', tableId: 1651219300, a1: 'B48:I59' },
  J: { sheet: 'RNDC', name: 'RNDC BEER',  tableId: 1716030623, a1: 'B60:I61' },

  // SODAS
  K: { sheet: 'SODAS', name: 'SODA', tableId: 6291836, a1: 'B4:I15' },

  // SOUTHERN
  L: { sheet: 'SOUTHERN', name: 'SOUTH LIQWINE', tableId: 1798570761, a1: 'B4:I25' }
};

const ROUTE_TABLE_LETTER = {
  RNDC: {
    WHITE_WINE: 'I',
    RED_WINE: 'H',
    LIQUOR: 'G',
    BEER: 'J',
    MIXER: 'G',
    COOKING: 'G'
  },
  SOUTHERN: {
    WHITE_WINE: 'L',
    RED_WINE: 'L',
    LIQUOR: 'L',
    BEER: 'L',
    MIXER: 'L',
    COOKING: 'L'
  },
  ELITE: {
    WHITE_WINE: 'F',
    RED_WINE: 'F',
    LIQUOR: 'E',
    BEER: 'D',
    MIXER: 'E',
    COOKING: 'E'
  },
  BREAKTHRU: {
    WHITE_WINE: 'A',
    RED_WINE: 'A',
    LIQUOR: 'A',
    BEER: 'B',
    MIXER: 'C',
    COOKING: 'A'
  },
  SODAS: {
    MIXER: 'K'
  }
};

function doGet() {
  try { ensureCleanupTrigger(); } catch (e) { console.error('ensureCleanupTrigger:', e); }
  const tmpl = HtmlService.createTemplateFromFile('Index');
  tmpl.senderEmail = Session.getEffectiveUser().getEmail();
  return tmpl.evaluate()
    .setTitle('TIN PLATE — INVENT')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

/** Inlines another HtmlService file — used by Index.html scriptlets. */
function include(filename) {
  return HtmlService.createHtmlOutputFromFile(filename).getContent();
}

/**
 * Throws if the active user's email is not from an authorized domain.
 * Call at the top of public server functions that handle sensitive data.
 */
function assertAuthorized_() {
  const user = Session.getActiveUser();
  const email = (user && user.getEmail) ? user.getEmail() : '';
  if (email && !email.endsWith('@tinplatepizza.com')) {
    throw new Error('Access denied: this tool is restricted to Tin Plate staff.');
  }
}

function buildPdfExportUrl_(spreadsheetId, sheetId) {
  const base = `https://docs.google.com/spreadsheets/d/${encodeURIComponent(spreadsheetId)}/export`;
  const params = {
    format: 'pdf',
    exportFormat: 'pdf',
    id: spreadsheetId,
    gid: sheetId,
    size: 'letter',
    portrait: 'true',
    fitw: 'true',
    sheetnames: 'false',
    printtitle: 'false',
    pagenum: 'RIGHT',
    gridlines: 'true',
    fzr: 'false'
  };

  const query = Object.keys(params)
    .map(k => `${encodeURIComponent(k)}=${encodeURIComponent(params[k])}`)
    .join('&');

  return `${base}?${query}`;
}

function buildSpreadsheetPdfExportUrl_(spreadsheetId) {
  const base = `https://docs.google.com/spreadsheets/d/${encodeURIComponent(spreadsheetId)}/export`;
  const params = {
    format: 'pdf',
    exportFormat: 'pdf',
    id: spreadsheetId,
    size: 'letter',
    portrait: 'true',
    fitw: 'true',
    sheetnames: 'true',
    printtitle: 'false',
    pagenum: 'RIGHT',
    gridlines: 'true',
    fzr: 'false'
  };

  const query = Object.keys(params)
    .map(k => `${encodeURIComponent(k)}=${encodeURIComponent(params[k])}`)
    .join('&');

  return `${base}?${query}`;
}

function buildPdfFileName_(kind, date, initials) {
  const safeDate = String(date || '').replace(/[^0-9]/g, '') || '00000000';
  const safeInit = String(initials || '').replace(/[^A-Za-z0-9]/g, '').toUpperCase() || 'NA';
  return `TP-BEV-${kind}-${safeDate}-${safeInit}.pdf`;
}

function buildZipFileName_(date) {
  const tz = Session.getScriptTimeZone() || 'Etc/GMT';
  let safeDate = String(date || '').trim();
  if (!safeDate) {
    safeDate = Utilities.formatDate(new Date(), tz, 'yyyy-MM-dd');
  }
  safeDate = safeDate.replace(/[^0-9-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
  if (!safeDate) safeDate = Utilities.formatDate(new Date(), tz, 'yyyy-MM-dd');
  return `TPBEV ${safeDate}.zip`;
}

function normalizeRecipients_(raw) {
  const list = String(raw || '')
    .split(/[,\n;]+/)
    .map(s => s.trim())
    .filter(Boolean);
  return Array.from(new Set(list));
}

function buildEmailSubject_(date, initials) {
  const parts = ['TIN PLATE BEVERAGE ORDER SHEET'];
  if (date) parts.push(`Date: ${date}`);
  if (initials) parts.push(`Initials: ${initials}`);
  return parts.join(' · ');
}

function buildEmailBody_(body, orderGuide, orderGuideBlank, inventory, inventoryBlank, date, initials) {
  const content = String(body || '').trim();
  if (content) return content;

  const lines = ['Attached PDFs:'];
  if (orderGuide) lines.push('- Order Guide');
  if (orderGuideBlank) lines.push('- Blank Order Guides');
  if (inventory) lines.push('- Inventory Count');
  if (inventoryBlank) lines.push('- Blank Inventory Guide');
  if (!orderGuide && !orderGuideBlank && !inventory && !inventoryBlank) lines.push('- (none)');

  if (date || initials) lines.push('');
  if (date) lines.push(`Date: ${date}`);
  if (initials) lines.push(`Initials: ${initials}`);

  return lines.join('\n');
}

function exportSheetPdfViaTempCopy_(sheet, fileName) {
  const temp = SpreadsheetApp.create(`TMP_EXPORT_${Date.now()}`);
  const tempId = temp.getId();
  let blob = null;

  try {
    const copied = sheet.copyTo(temp);
    copied.setName(sheet.getName());
    copied.showSheet();
    temp.getSheets().forEach(s => {
      if (s.getSheetId() !== copied.getSheetId()) s.hideSheet();
    });

    SpreadsheetApp.flush();
    blob = DriveApp.getFileById(tempId).getAs(MimeType.PDF).setName(fileName);
  } finally {
    try { DriveApp.getFileById(tempId).setTrashed(true); } catch (e) { console.error(e); }
  }

  return blob;
}

function exportSheetPdf_(sheet, fileName) {
  const ss = sheet.getParent();
  const token = ScriptApp.getOAuthToken();
  const sheetId = sheet.getSheetId();
  const ssId = ss.getId();
  const urls = [
    buildPdfExportUrl_(ssId, sheetId),
    `https://docs.google.com/spreadsheets/d/${encodeURIComponent(ssId)}/export?format=pdf&exportFormat=pdf&gid=${encodeURIComponent(sheetId)}&id=${encodeURIComponent(ssId)}`
  ];

  let lastCode = 0;
  let lastText = '';
  for (const url of urls) {
    const res = UrlFetchApp.fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
      muteHttpExceptions: true
    });
    const code = res.getResponseCode();
    if (code === 200) return res.getBlob().setName(fileName);
    lastCode = code;
    lastText = res.getContentText();
  }

  try {
    const blob = exportSheetPdfViaTempCopy_(sheet, fileName);
    if (blob) return blob;
  } catch (e) {
    const detail = lastText ? ` Response: ${lastText.slice(0, 200)}` : '';
    throw new Error(`PDF export failed (${lastCode || 'unknown'}).${detail} ${e && e.message ? e.message : e}`);
  }

  throw new Error(`PDF export failed (${lastCode || 'unknown'}).`);
}

function exportSpreadsheetPdf_(ss, fileName) {
  const ssId = ss.getId();
  const url = buildSpreadsheetPdfExportUrl_(ssId);
  return fetchPdfFromUrl_(url, fileName);
}

function fetchPdfFromUrl_(url, fileName) {
  const cleanUrl = String(url || '').trim();
  if (!cleanUrl) throw new Error('Missing PDF export URL.');
  const token = ScriptApp.getOAuthToken();
  const res = UrlFetchApp.fetch(cleanUrl, {
    headers: { Authorization: `Bearer ${token}` },
    muteHttpExceptions: true
  });
  const code = res.getResponseCode();
  if (code !== 200) throw new Error(`PDF export failed (${code}).`);
  return res.getBlob().setName(fileName);
}

function getBlankOrderGuidePdf(payload) {
  const date = String(payload?.date || '').trim();
  const initials = String(payload?.initials || '').trim();
  const blob = buildBlankOrderGuideBlob_(date, initials);

  return {
    data: Utilities.base64Encode(blob.getBytes()),
    mimeType: blob.getContentType(),
    fileName: blob.getName()
  };
}

function getOrderGuidesPdf(payload) {
  const ssId = String(payload?.spreadsheetId || '').trim();
  if (!ssId) throw new Error('Missing order guide spreadsheet id.');

  const sheets = Array.isArray(payload?.sheets)
    ? payload.sheets.map(s => String(s || '').trim()).filter(Boolean)
    : [];
  if (!sheets.length) throw new Error('Select at least one sheet.');

  const date = String(payload?.date || '').trim();
  const initials = String(payload?.initials || '').trim();
  const fileName = buildPdfFileName_('ORDER-GUIDES-SELECTED', date, initials);
  const blob = exportSelectedSheetsPdf_(ssId, sheets, fileName);

  return {
    data: Utilities.base64Encode(blob.getBytes()),
    mimeType: blob.getContentType(),
    fileName: blob.getName()
  };
}

function exportSelectedSheetsPdf_(spreadsheetId, sheetNames, fileName) {
  const tempFile = DriveApp.getFileById(spreadsheetId)
    .makeCopy(`TMP_ORDER_GUIDES_SELECTED_${Date.now()}`);
  const tempId = tempFile.getId();
  let blob = null;

  try {
    const tempSs = SpreadsheetApp.openById(tempId);
    const keep = new Set(sheetNames.map(norm_));
    const sheets = tempSs.getSheets();
    const keepSheets = sheets.filter(s => keep.has(norm_(s.getName())));
    if (!keepSheets.length) throw new Error('No matching sheets found.');

    sheets.forEach(s => {
      if (!keep.has(norm_(s.getName()))) tempSs.deleteSheet(s);
    });

    SpreadsheetApp.flush();
    blob = exportSpreadsheetPdf_(tempSs, fileName);
  } finally {
    try { tempFile.setTrashed(true); } catch (e) { console.error(e); }
  }

  return blob;
}

function buildBlankOrderGuideBlob_(date, initials) {
  const ss = getSpreadsheet_();
  const fileName = buildPdfFileName_('ORDER-GUIDE-BLANK', date, initials);
  return exportBlankOrderGuideBlob_(ss, fileName);
}

function exportBlankOrderGuideBlob_(ss, fileName) {
  const tempFile = DriveApp.getFileById(ss.getId())
    .makeCopy(`TMP_ORDER_GUIDE_BLANK_${Date.now()}`);
  const tempId = tempFile.getId();
  let blob = null;

  try {
    const tempSs = SpreadsheetApp.openById(tempId);
    clearOrderGuideQuantities_(tempSs);
    SpreadsheetApp.flush();
    blob = exportSpreadsheetPdf_(tempSs, fileName);
  } finally {
    try { tempFile.setTrashed(true); } catch (e) { console.error(e); }
  }
  return blob;
}

function generateInventoryPdf(payload) {
  const ss = getSpreadsheet_();
  const sheet = ss.getSheetByName(CONFIG.INVENT_SHEET);
  if (!sheet) throw new Error(`Missing sheet: ${CONFIG.INVENT_SHEET}`);

  const date = String(payload?.date || '').trim();
  const initials = String(payload?.initials || '').trim();
  const fileName = buildPdfFileName_('INVENTORY', date, initials);
  const blob = exportSheetPdf_(sheet, fileName);

  return {
    data: Utilities.base64Encode(blob.getBytes()),
    mimeType: blob.getContentType(),
    fileName: blob.getName()
  };
}

/**
 * Deletes leftover TMP_ spreadsheets older than 1 hour.
 * Safe to run on a time-driven trigger (e.g. every hour).
 * To install: ScriptApp.newTrigger('cleanupTempFiles').timeBased().everyHours(1).create();
 */
function cleanupTempFiles() {
  const cutoff = new Date(Date.now() - 60 * 60 * 1000);
  const files = DriveApp.searchFiles(
    'title contains "TMP_EXPORT_" or title contains "TMP_ORDER_GUIDE" or title contains "TMP_ORDER_GUIDES_"'
  );
  let deleted = 0;
  while (files.hasNext()) {
    const file = files.next();
    if (file.getDateCreated() < cutoff) {
      try {
        file.setTrashed(true);
        deleted++;
      } catch (e) { console.error(e); }
    }
  }
  if (deleted) console.log(`cleanupTempFiles: trashed ${deleted} stale temp file(s).`);
}

/**
 * Ensures the hourly cleanup trigger exists. Safe to call multiple times —
 * skips creation if a trigger for cleanupTempFiles already exists.
 * Run once manually or call from doGet/onOpen to set up.
 */
function ensureCleanupTrigger() {
  const existing = ScriptApp.getProjectTriggers();
  const alreadyInstalled = existing.some(t => t.getHandlerFunction() === 'cleanupTempFiles');
  if (alreadyInstalled) return;
  ScriptApp.newTrigger('cleanupTempFiles').timeBased().everyHours(1).create();
  console.log('ensureCleanupTrigger: installed hourly cleanupTempFiles trigger.');
}

function clearOrderGuideQuantities_(ss) {
  const defs = Object.values(ORDERING_TABLES || {});
  defs.forEach(def => {
    if (!def || !def.sheet || !def.a1) return;
    const sheet = ss.getSheetByName(def.sheet);
    if (!sheet) return;

    const range = sheet.getRange(def.a1);
    const numCols = range.getNumColumns();
    const numRows = range.getNumRows();
    if (numRows < 2 || numCols < 1) return;

    const headerRow = range.getRow();
    const headerCol = range.getColumn();
    const headers = sheet.getRange(headerRow, headerCol, 1, numCols).getDisplayValues()[0];
    let cols = findBlankOrderCols_(headers);

    if (!cols.length && numCols >= 3) {
      cols = [numCols - 3, numCols - 2, numCols - 1];
    }
    if (!cols.length) return;

    const dataRows = numRows - 1;
    cols.forEach(idx => {
      const col = headerCol + idx;
      sheet.getRange(headerRow + 1, col, dataRows, 1).clearContent();
    });
  });
}

function findBlankOrderCols_(headers) {
  const out = [];
  const list = Array.isArray(headers) ? headers : [];
  list.forEach((h, idx) => {
    const text = norm_(h);
    if (isOrderGuideBlankHeader_(text)) out.push(idx);
  });
  return out;
}

function isOrderGuideBlankHeader_(text) {
  if (!text) return false;
  if (hasHeaderWord_(text, 'BAR')) return true;
  if (hasHeaderWord_(text, 'BACK')) return true;
  if (hasHeaderWord_(text, 'ORDER') && !text.includes('NAME')) return true;
  return false;
}

function hasHeaderWord_(text, word) {
  const re = new RegExp(`(^|\\s)${word}(\\s|$)`);
  return re.test(String(text || ''));
}

function buildAttachments_(payload) {
  const orderGuide = !!payload?.orderGuide;
  const inventory = !!payload?.inventory;
  const orderGuideBlank = !!payload?.orderGuideBlank;
  const inventoryBlank = !!payload?.inventoryBlank;
  if (!orderGuide && !orderGuideBlank && !inventory && !inventoryBlank) {
    throw new Error('Select at least one PDF to include.');
  }

  const date = String(payload?.date || '').trim();
  const initials = String(payload?.initials || '').trim();
  const orderGuideUrl = String(payload?.orderGuideUrl || '').trim();
  const ss = getSpreadsheet_();
  const attachments = [];

  if (orderGuide) {
    const fileName = buildPdfFileName_('ORDER-GUIDE', date, initials);
    if (orderGuideUrl) {
      attachments.push(fetchPdfFromUrl_(orderGuideUrl, fileName));
    } else {
      const sheet = ss.getSheetByName(CONFIG.ORDER_SHEET);
      if (!sheet) throw new Error(`Missing sheet: ${CONFIG.ORDER_SHEET}`);
      attachments.push(exportSheetPdf_(sheet, fileName));
    }
  }

  if (orderGuideBlank) {
    attachments.push(buildBlankOrderGuideBlob_(date, initials));
  }

  if (inventory) {
    const html = String(payload?.inventoryHtml || '').trim();
    if (html) {
      const fileName = buildPdfFileName_('INVENTORY', date, initials);
      const blob = HtmlService.createHtmlOutput(html).getAs('application/pdf').setName(fileName);
      attachments.push(blob);
    } else {
      const sheet = ss.getSheetByName(CONFIG.INVENT_SHEET);
      if (!sheet) throw new Error(`Missing sheet: ${CONFIG.INVENT_SHEET}`);
      attachments.push(exportSheetPdf_(sheet, buildPdfFileName_('INVENTORY', date, initials)));
    }
  }

  if (inventoryBlank) {
    const html = String(payload?.inventoryBlankHtml || '').trim();
    if (!html) throw new Error('Blank inventory HTML missing.');
    const fileName = buildPdfFileName_('INVENTORY-BLANK', date, initials);
    const blob = HtmlService.createHtmlOutput(html).getAs('application/pdf').setName(fileName);
    attachments.push(blob);
  }

  return attachments;
}

function emailInventorySelection(payload) {
  assertAuthorized_();
  const recipientsRaw = String(payload?.recipients || payload?.email || '').trim();
  const recipients = normalizeRecipients_(recipientsRaw);
  if (!recipients.length) throw new Error('Recipient email required.');

  const attachments = buildAttachments_(payload);
  const date = String(payload?.date || '').trim();
  const initials = String(payload?.initials || '').trim();
  const subject = String(payload?.subject || '').trim() || buildEmailSubject_(date, initials);
  const body = buildEmailBody_(payload?.body, !!payload?.orderGuide, !!payload?.orderGuideBlank, !!payload?.inventory, !!payload?.inventoryBlank, date, initials);

  MailApp.sendEmail(recipients.join(','), subject, body, { attachments });
  return { ok: true, recipients, attachments: attachments.map(b => b.getName()) };
}

function getPrintZip(payload) {
  const attachments = buildAttachments_(payload);
  const date = String(payload?.date || '').trim();
  const zipName = buildZipFileName_(date);
  const zipBlob = Utilities.zip(attachments, zipName);
  return {
    data: Utilities.base64Encode(zipBlob.getBytes()),
    mimeType: zipBlob.getContentType(),
    fileName: zipName,
    attachments: attachments.map(b => b.getName())
  };
}

function getSpreadsheet_() {
  try {
    const active = SpreadsheetApp.getActiveSpreadsheet();
    if (active) return active;
  } catch (e) { console.error(e); }

  const props = PropertiesService.getScriptProperties();
  const id = String(props.getProperty(CONFIG.SPREADSHEET_ID_PROP) || CONFIG.DEFAULT_SPREADSHEET_ID || '').trim();
  if (!id) throw new Error('Spreadsheet not found. Bind script to the sheet or set Script Property SPREADSHEET_ID.');
  return SpreadsheetApp.openById(id);
}

function norm_(s) {
  return String(s ?? '').toUpperCase().replace(/\s+/g, ' ').trim();
}

function getSectionLabelOverrides_() {
  const props = PropertiesService.getScriptProperties();
  const raw = String(props.getProperty(CONFIG.SECTION_LABELS_PROP) || '').trim();
  if (!raw) return {};
  try {
    const data = JSON.parse(raw);
    return (data && typeof data === 'object') ? data : {};
  } catch (e) {
    return {};
  }
}

function saveSectionLabelOverrides_(map) {
  const props = PropertiesService.getScriptProperties();
  const safe = map && typeof map === 'object' ? map : {};
  props.setProperty(CONFIG.SECTION_LABELS_PROP, JSON.stringify(safe));
}

function getSettingsSheet_() {
  const ss = getSpreadsheet_();
  let sheet = ss.getSheetByName(CONFIG.UI_SETTINGS_SHEET);
  if (!sheet) {
    sheet = ss.insertSheet(CONFIG.UI_SETTINGS_SHEET);
    sheet.getRange(1, 1, 1, 2).setValues([['KEY', 'VALUE']]);
    sheet.getRange(2, 1).setValue('UI_SETTINGS_JSON');
    sheet.hideSheet();
  }
  return sheet;
}

function getUiSettings_() {
  const sheet = getSettingsSheet_();
  const lastRow = Math.max(sheet.getLastRow(), 2);
  const rows = sheet.getRange(1, 1, lastRow, 2).getValues();
  const row = rows.find(r => String(r[0] || '').trim() === 'UI_SETTINGS_JSON');
  if (!row || !row[1]) return {};
  try {
    const data = JSON.parse(String(row[1]));
    return (data && typeof data === 'object') ? data : {};
  } catch (e) {
    return {};
  }
}

function saveUiSettings(payload) {
  const sheet = getSettingsSheet_();
  const json = JSON.stringify(payload || {});
  const lastRow = Math.max(sheet.getLastRow(), 2);
  const rows = sheet.getRange(1, 1, lastRow, 2).getValues();
  let idx = rows.findIndex(r => String(r[0] || '').trim() === 'UI_SETTINGS_JSON');
  if (idx === -1) {
    idx = rows.length;
    sheet.getRange(idx + 1, 1).setValue('UI_SETTINGS_JSON');
  }
  sheet.getRange(idx + 1, 2).setValue(json);
  return { ok: true };
}

function getSectionGroupsSheet_() {
  const ss = getSpreadsheet_();
  let sheet = ss.getSheetByName(CONFIG.SECTION_GROUPS_SHEET);
  if (!sheet) {
    sheet = ss.insertSheet(CONFIG.SECTION_GROUPS_SHEET);
    sheet.getRange(1, 1, 1, 2).setValues([['KEY', 'VALUE']]);
    sheet.getRange(2, 1).setValue('SECTION_GROUPS_JSON');
    sheet.hideSheet();
  }
  return sheet;
}

function getSectionGroups_() {
  const sheet = getSectionGroupsSheet_();
  const lastRow = Math.max(sheet.getLastRow(), 2);
  const rows = sheet.getRange(1, 1, lastRow, 2).getValues();
  const row = rows.find(r => String(r[0] || '').trim() === 'SECTION_GROUPS_JSON');
  if (!row || !row[1]) return [];
  try {
    const data = JSON.parse(String(row[1]));
    return Array.isArray(data) ? data : [];
  } catch (e) {
    return [];
  }
}

function saveSectionGroups_(groups) {
  const sheet = getSectionGroupsSheet_();
  const json = JSON.stringify(Array.isArray(groups) ? groups : []);
  const lastRow = Math.max(sheet.getLastRow(), 2);
  const rows = sheet.getRange(1, 1, lastRow, 2).getValues();
  let idx = rows.findIndex(r => String(r[0] || '').trim() === 'SECTION_GROUPS_JSON');
  if (idx === -1) {
    idx = rows.length;
    sheet.getRange(idx + 1, 1).setValue('SECTION_GROUPS_JSON');
  }
  sheet.getRange(idx + 1, 2).setValue(json);
  return { ok: true };
}

function normalizeGroupKey_(label) {
  return makeSectionKey_(label);
}

function normalizeGroupKeys_(keys) {
  const out = [];
  const seen = new Set();
  (Array.isArray(keys) ? keys : []).forEach(raw => {
    const key = normalizeGroupKey_(String(raw || '').trim());
    if (!key || seen.has(key)) return;
    seen.add(key);
    out.push(key);
  });
  return out;
}

function buildGroupChildrenMap_(groups) {
  const map = new Map();
  (groups || []).forEach(g => {
    const gKey = normalizeGroupKey_(String(g.key || g.name || '').trim());
    if (!gKey) return;
    const kids = normalizeGroupKeys_(g.groupKeys);
    map.set(gKey, kids);
  });
  return map;
}

function hasGroupPath_(map, fromKey, targetKey, seen) {
  if (!fromKey || !targetKey) return false;
  if (fromKey === targetKey) return true;
  const visited = seen || new Set();
  if (visited.has(fromKey)) return false;
  visited.add(fromKey);
  const children = map.get(fromKey) || [];
  for (const child of children) {
    if (hasGroupPath_(map, child, targetKey, visited)) return true;
  }
  return false;
}

function getGroupConflicts_(sectionKeys, groupKeys, excludeKey) {
  const usedSections = new Map();
  const usedGroups = new Map();
  const target = norm_(excludeKey || '');
  const groups = getSectionGroups_();
  groups.forEach(g => {
    const gKey = String(g.key || g.name || '').trim();
    if (target && norm_(gKey) === target) return;
    const gName = String(g.name || gKey || '').trim() || gKey;
    const keys = Array.isArray(g.sectionKeys) ? g.sectionKeys : [];
    keys.forEach(k => {
      const key = String(k || '').trim();
      if (key) usedSections.set(key, gName);
    });
    const kids = Array.isArray(g.groupKeys) ? g.groupKeys : [];
    kids.forEach(k => {
      const key = String(k || '').trim();
      if (key) usedGroups.set(key, gName);
    });
  });
  const conflicts = [];
  (sectionKeys || []).forEach(k => {
    const key = String(k || '').trim();
    if (!key) return;
    if (usedSections.has(key)) conflicts.push(`${key} (${usedSections.get(key)})`);
  });
  (groupKeys || []).forEach(k => {
    const key = String(k || '').trim();
    if (!key) return;
    if (usedGroups.has(key)) conflicts.push(`GROUP ${key} (${usedGroups.get(key)})`);
  });
  return conflicts;
}

function updateSectionGroupsForRename_(oldLabel, newLabel) {
  const oldKey = makeSectionKey_(oldLabel || '');
  const newKey = makeSectionKey_(newLabel || '');
  if (!oldKey || !newKey || oldKey === newKey) return;
  const groups = getSectionGroups_();
  let changed = false;
  const updated = groups.map(g => {
    const sections = Array.isArray(g.sectionKeys) ? g.sectionKeys.slice() : [];
    const nextSections = sections.map(k => (String(k) === String(oldKey) ? newKey : k));
    if (nextSections.some((k, i) => k !== sections[i])) {
      changed = true;
      return Object.assign({}, g, { sectionKeys: nextSections });
    }
    return g;
  });
  if (changed) saveSectionGroups_(updated);
}

function updateSectionGroupsForGroupRename_(oldKey, newKey) {
  const oldNorm = norm_(oldKey || '');
  const newNorm = norm_(newKey || '');
  if (!oldNorm || !newNorm || oldNorm === newNorm) return;
  const groups = getSectionGroups_();
  let changed = false;
  const updated = groups.map(g => {
    const kids = Array.isArray(g.groupKeys) ? g.groupKeys.slice() : [];
    const nextKids = kids.map(k => (norm_(k) === oldNorm ? newKey : k));
    if (nextKids.some((k, i) => k !== kids[i])) {
      changed = true;
      return Object.assign({}, g, { groupKeys: nextKids });
    }
    return g;
  });
  if (changed) saveSectionGroups_(updated);
}

function getDistroDataSheet_() {
  const ss = getSpreadsheet_();
  let sheet = ss.getSheetByName(CONFIG.DISTRO_DATA_SHEET);
  if (!sheet) {
    sheet = ss.insertSheet(CONFIG.DISTRO_DATA_SHEET);
    sheet.getRange(1, 1, 1, 11).setValues([[
      'REF', 'NAME', 'KEY', 'SHEET', 'REP_NAME', 'REP_PHONE', 'REP_EMAIL',
      'ORDER_DAYS', 'TABLE_COUNT', 'TEMPLATE', 'TABLES_JSON'
    ]]);
    sheet.hideSheet();
  }
  return sheet;
}

function distroRefForIndex_(idx) {
  let n = Math.max(0, Number(idx) || 0) + 1;
  let out = '';
  while (n > 0) {
    n -= 1;
    out = String.fromCharCode(65 + (n % 26)) + out;
    n = Math.floor(n / 26);
  }
  return out;
}

function ensureDistributorRefs_(distributors, uiSettings) {
  const list = Array.isArray(distributors) ? distributors.slice() : [];
  const used = new Set();
  list.forEach(d => {
    const ref = String(d.ref || '').trim().toUpperCase();
    if (ref) used.add(ref);
  });
  let nextIdx = 0;
  let changed = false;
  list.forEach(d => {
    let ref = String(d.ref || '').trim().toUpperCase();
    if (ref) return;
    while (used.has(distroRefForIndex_(nextIdx))) nextIdx += 1;
    ref = distroRefForIndex_(nextIdx);
    nextIdx += 1;
    d.ref = ref;
    used.add(ref);
    changed = true;
  });
  if (changed && uiSettings && typeof uiSettings === 'object') {
    uiSettings.distributors = list;
    saveUiSettings(uiSettings);
    PropertiesService.getScriptProperties().setProperty('DISTRO_DATA_DIRTY', 'true');
  }
  return list;
}

function distroDataHasRows_(sheet) {
  if (!sheet) return false;
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return false;
  const values = sheet.getRange(2, 1, lastRow - 1, 1).getDisplayValues();
  return values.some(r => String(r[0] || '').trim());
}

function shouldSyncDistroData_(uiSettings, distributors) {
  const list = Array.isArray(distributors) ? distributors : [];
  const sheet = getDistroDataSheet_();
  const hasData = distroDataHasRows_(sheet);
  if (PropertiesService.getScriptProperties().getProperty('DISTRO_DATA_DIRTY') === 'true') return true;
  if (list.length && !hasData) return true;
  if (!list.length && hasData) return true;
  return false;
}

function syncDistroDataSheetAndClear_(distributors) {
  syncDistroDataSheet_(distributors);
  PropertiesService.getScriptProperties().deleteProperty('DISTRO_DATA_DIRTY');
}

function syncDistroDataSheet_(distributors) {
  const sheet = getDistroDataSheet_();
  const list = Array.isArray(distributors) ? distributors : [];
  const values = list.map(d => ([
    String(d.ref || '').trim(),
    String(d.name || '').trim(),
    String(d.key || '').trim(),
    String(d.sheetName || '').trim(),
    String(d.repName || '').trim(),
    String(d.repPhone || '').trim(),
    String(d.repEmail || '').trim(),
    JSON.stringify(d.orderDays || {}),
    Number(d.tableCount || (d.tables || []).length || 0),
    String(d.templateSheet || '').trim(),
    JSON.stringify(d.tables || [])
  ]));
  const lastRow = Math.max(sheet.getLastRow(), 2);
  sheet.getRange(2, 1, Math.max(1, lastRow - 1), 11).clearContent();
  if (values.length) {
    sheet.getRange(2, 1, values.length, 11).setValues(values);
  }
}

function getSecondarySectionsFromSettings_(uiSettings) {
  const list = uiSettings && Array.isArray(uiSettings.secondarySections)
    ? uiSettings.secondarySections
    : [];
  return list.filter(s => s && typeof s === 'object');
}

function getSectionShortcutsFromSettings_(uiSettings) {
  const map = uiSettings && typeof uiSettings.sectionShortcuts === 'object'
    ? uiSettings.sectionShortcuts
    : {};
  return map && typeof map === 'object' ? map : {};
}

function getDistributorsFromSettings_(uiSettings) {
  const list = uiSettings && Array.isArray(uiSettings.distributors)
    ? uiSettings.distributors
    : [];
  return list.filter(d => d && typeof d === 'object');
}

function collectVendorCategoriesFromDisplay_(display) {
  const map = new Map();
  const rows = Array.isArray(display) ? display : [];
  for (let r = 0; r < rows.length; r++) {
    const row = rows[r] || [];
    const commonName = String(row[CONFIG.COL.COMMON_NAME - 1] || '').trim();
    const id = String(row[CONFIG.COL.ID - 1] || '').trim();
    if (isSectionHeading_(commonName, id)) continue;
    if (!commonName || !id) continue;
    const vendor = String(row[CONFIG.COL.VENDOR - 1] || '').trim();
    if (!vendor) continue;
    const category = String(row[CONFIG.COL.CATEGORY - 1] || '').trim();
    const key = norm_(vendor);
    if (!map.has(key)) map.set(key, { name: vendor, categories: new Set() });
    if (category) map.get(key).categories.add(category);
  }
  return map;
}

function normalizeVendorAliasesInDisplay_(sheet, display, aliasMap) {
  if (!sheet || !Array.isArray(display) || !aliasMap) return 0;
  const updates = [];
  const vendorIdx = CONFIG.COL.VENDOR - 1;
  const idIdx = CONFIG.COL.ID - 1;
  for (let r = 0; r < display.length; r++) {
    const id = String(display[r][idIdx] || '').trim();
    if (!id) continue;
    const rawVendor = String(display[r][vendorIdx] || '').trim();
    if (!rawVendor) continue;
    const alias = aliasMap[norm_(rawVendor)];
    if (!alias || norm_(alias) === norm_(rawVendor)) continue;
    display[r][vendorIdx] = alias;
    updates.push({ row: r + 1, value: alias });
  }
  if (!updates.length) return 0;
  // Batch write: group contiguous rows where possible, fallback to individual writes
  // For non-contiguous rows, individual writes are unavoidable but we batch where we can
  const vendorCol = CONFIG.COL.VENDOR;
  updates.forEach(entry => {
    sheet.getRange(entry.row, vendorCol).setValue(entry.value);
  });
  SpreadsheetApp.flush();
  return updates.length;
}

function normalizeDistributorAliases_(list, aliasMap) {
  const next = Array.isArray(list) ? list.slice() : [];
  let changed = false;
  Object.keys(aliasMap || {}).forEach(aliasKey => {
    const target = String(aliasMap[aliasKey] || '').trim();
    if (!target) return;
    const aliasNorm = norm_(aliasKey);
    const targetNorm = norm_(target);
    const aliasIdx = next.findIndex(d => norm_(d.key || d.name || d.ref || '') === aliasNorm);
    if (aliasIdx === -1) return;
    const targetIdx = next.findIndex(d => norm_(d.key || d.name || d.ref || '') === targetNorm);
    if (targetIdx !== -1) {
      next.splice(aliasIdx, 1);
      changed = true;
      return;
    }
    const renamed = Object.assign({}, next[aliasIdx], {
      key: normalizeDistributorKey_(target),
      name: target
    });
    const ss = getSpreadsheet_();
    const match = findSheetByNormalizedName_(ss, target);
    if (match) renamed.sheetName = match.getName();
    next[aliasIdx] = renamed;
    changed = true;
  });
  return { list: next, changed };
}

function ensureRequiredDistributors_(uiSettings, vendorMap, listOverride, opts) {
  const list = Array.isArray(listOverride) ? listOverride : getDistributorsFromSettings_(uiSettings);
  const options = opts && typeof opts === 'object' ? opts : {};
  const existing = new Set();
  list.forEach(d => {
    const key = norm_(d.key || d.name || d.ref || '');
    if (key) existing.add(key);
  });
  const added = [];
  REQUIRED_DISTRIBUTORS.forEach(name => {
    const key = norm_(name);
    if (!key || existing.has(key)) return;
    const entry = vendorMap && vendorMap.get(key);
    const cats = entry ? Array.from(entry.categories || []) : [];
    const created = autoCreateDistributorEntry_(name, cats, uiSettings, options);
    if (!created) return;
    list.push(created);
    existing.add(norm_(created.key || created.name || name));
    added.push(created);
  });
  return { distributors: list, added };
}

function findSheetByNormalizedName_(ss, name) {
  if (!ss) return null;
  const target = norm_(name);
  if (!target) return null;
  const sheets = ss.getSheets();
  for (let i = 0; i < sheets.length; i++) {
    const sheet = sheets[i];
    if (norm_(sheet.getName()) === target) return sheet;
  }
  return null;
}

function autoCreateDistributorEntry_(vendorName, categories, uiSettings, opts) {
  const options = opts && typeof opts === 'object' ? opts : {};
  const allowSheetCreate = options.createSheet !== false;
  const nameRaw = String(vendorName || '').trim();
  if (!nameRaw) return null;
  const key = normalizeDistributorKey_(nameRaw);
  const ss = getSpreadsheet_();
  const templateName = String(uiSettings?.orderGuideTemplate || 'RNDC').trim() || 'RNDC';
  const templateSheet = ss.getSheetByName(templateName);
  const safeName = sanitizeSheetName_(nameRaw);
  let sheet = findSheetByNormalizedName_(ss, nameRaw) || ss.getSheetByName(safeName);
  let sheetName = sheet ? sheet.getName() : '';

  if (!sheet && allowSheetCreate && templateSheet) {
    sheet = templateSheet.copyTo(ss).setName(safeName);
    sheet.showSheet();
    sheetName = sheet.getName();
  } else if (sheet && !sheetName) {
    sheetName = sheet.getName();
  }

  let blocks = [];
  if (sheet) {
    // getTables() is slow; skip it on hot paths (e.g. read-time seeding) and
    // rely on the known default ordering blocks instead.
    if (!options.skipTableScan) blocks = getTableBlocksFromSheet_(sheet);
    if (!blocks.length) blocks = getDefaultOrderingBlocksForSheet_(sheet);
  }
  const tableCount = Math.max(1, Math.min(10, blocks.length || 1));
  const cats = Array.isArray(categories)
    ? categories.map(c => String(c || '').trim()).filter(Boolean)
    : [];
  const tables = [];
  for (let i = 0; i < tableCount; i++) {
    const block = blocks[i] || {};
    tables.push({
      index: i + 1,
      name: `TABLE ${i + 1}`,
      a1: String(block.a1 || '').trim(),
      tableId: block.tableId || null,
      categories: (i === 0) ? cats.slice() : []
    });
  }

  return {
    key,
    name: nameRaw,
    repName: '',
    repPhone: '',
    repEmail: '',
    orderDays: {},
    sheetName,
    templateSheet: templateSheet ? templateName : '',
    tableCount,
    tables
  };
}

function autoSeedDistributorsFromInventory_(uiSettings, vendorMap, opts) {
  const options = opts && typeof opts === 'object' ? opts : {};
  let list = getDistributorsFromSettings_(uiSettings);
  const existing = new Set();
  list.forEach(d => {
    const key = norm_(d.key || d.name || d.ref || '');
    if (key) existing.add(key);
  });
  const builtIn = new Set((CONFIG.VENDORS || []).map(v => norm_(v)));
  const added = [];
  const seedOpts = { createSheet: false, skipTableScan: !!options.skipTableScan };
  (vendorMap || new Map()).forEach(entry => {
    const name = String(entry?.name || '').trim();
    const key = norm_(name);
    if (!key) return;
    if (existing.has(key) || builtIn.has(key)) return;
    const cats = Array.from(entry?.categories || []);
    const created = autoCreateDistributorEntry_(name, cats, uiSettings, seedOpts);
    if (!created) return;
    list.push(created);
    existing.add(key);
    added.push(created);
  });
  let changed = added.length > 0;
  const required = ensureRequiredDistributors_(uiSettings, vendorMap, list, seedOpts);
  if (required && required.distributors) {
    list = required.distributors;
    if (required.added && required.added.length) changed = true;
  }
  const aliasRes = normalizeDistributorAliases_(list, VENDOR_ALIASES);
  if (aliasRes.changed) {
    list = aliasRes.list;
    changed = true;
  }

  if (changed && uiSettings && typeof uiSettings === 'object') {
    uiSettings.distributors = list;
    saveUiSettings(uiSettings);
    PropertiesService.getScriptProperties().setProperty('DISTRO_DATA_DIRTY', 'true');
  }

  return { distributors: list, added };
}

function normalizeDistributorKey_(name) {
  return norm_(name);
}

function getDistributorByKey_(key, distributors) {
  const target = norm_(key);
  const list = Array.isArray(distributors) ? distributors : [];
  return list.find(d => (
    norm_(d.key || '') === target ||
    norm_(d.name || '') === target ||
    norm_(d.ref || '') === target
  )) || null;
}

function makeDynamicTableKey_(vendorKey, index) {
  return `DYN:${vendorKey}:${index}`;
}

function getOrderingTableDefs_(distributors) {
  const out = [];
  Object.keys(ORDERING_TABLES || {}).forEach(letter => {
    const def = ORDERING_TABLES[letter];
    if (!def) return;
    out.push({
      key: letter,
      sheet: def.sheet,
      name: def.name,
      tableId: def.tableId,
      a1: def.a1
    });
  });

  const list = Array.isArray(distributors) ? distributors : [];
  list.forEach(dist => {
    const vendorKey = normalizeDistributorKey_(dist.key || dist.name || '');
    if (!vendorKey) return;
    const sheetName = String(dist.sheetName || '').trim();
    const tables = Array.isArray(dist.tables) ? dist.tables : [];
    tables.forEach((t, idx) => {
      const index = Number(t.index || (idx + 1));
      const key = makeDynamicTableKey_(vendorKey, index);
      out.push({
        key,
        sheet: sheetName,
        name: String(t.name || `TABLE ${index}`),
        tableId: t.tableId || null,
        a1: String(t.a1 || '').trim()
      });
    });
  });

  return out;
}

function getOrderingTableDefByKey_(key, distributors) {
  const target = String(key || '');
  const defs = getOrderingTableDefs_(distributors);
  return defs.find(d => String(d.key) === target) || null;
}

function getOrderGuideSheetNames_(distributors) {
  const out = new Set();
  Object.values(ORDERING_TABLES || {}).forEach(def => {
    if (def && def.sheet) out.add(def.sheet);
  });
  const list = Array.isArray(distributors) ? distributors : [];
  list.forEach(d => {
    const sheetName = String(d.sheetName || '').trim();
    if (sheetName) out.add(sheetName);
  });
  return Array.from(out);
}

function getAllSheetNames_() {
  const ss = getSpreadsheet_();
  return ss.getSheets().map(s => String(s.getName() || '').trim()).filter(Boolean);
}

function updateSectionLabelOverride_(label, labels) {
  const key = norm_(label);
  if (!key) return;
  const overrides = getSectionLabelOverrides_();
  const updated = Object.assign({}, overrides[key] || {});
  const g = String(labels?.g ?? '').trim();
  const h = String(labels?.h ?? '').trim();
  const j = String(labels?.j ?? '').trim();
  const tab = String(labels?.tab ?? '').trim();
  const color = String(labels?.color ?? '').trim();
  const alignRaw = String(labels?.align ?? labels?.headingAlign ?? '').trim().toLowerCase();
  const align = (alignRaw === 'left' || alignRaw === 'center' || alignRaw === 'right') ? alignRaw : '';

  if (g) updated.g = g; else delete updated.g;
  if (h) updated.h = h; else delete updated.h;
  if (j) updated.j = j; else delete updated.j;
  if (tab) updated.tab = tab; else delete updated.tab;
  if (color) updated.color = color; else delete updated.color;
  if (align) updated.align = align; else delete updated.align;

  if (Object.keys(updated).length) overrides[key] = updated;
  else delete overrides[key];

  saveSectionLabelOverrides_(overrides);
}

function applyInventoryColumnSettings_(uiSettings, label, columns) {
  if (!uiSettings || typeof uiSettings !== 'object') return false;
  if (!columns || typeof columns !== 'object') return false;
  const key = norm_(label);
  if (!key) return false;
  if (!uiSettings.inventoryColumns || typeof uiSettings.inventoryColumns !== 'object') {
    uiSettings.inventoryColumns = {};
  }
  const entry = {};
  if (columns.g === false) entry.g = false;
  if (columns.h === false) entry.h = false;
  if (columns.j === false) entry.j = false;
  if (Object.keys(entry).length) uiSettings.inventoryColumns[key] = entry;
  else if (uiSettings.inventoryColumns[key]) delete uiSettings.inventoryColumns[key];
  return true;
}

function applySectionTypeSetting_(uiSettings, label, type) {
  if (!uiSettings || typeof uiSettings !== 'object') return false;
  const key = makeSectionKey_(label);
  if (!key) return false;
  if (!uiSettings.sectionTypes || typeof uiSettings.sectionTypes !== 'object') {
    uiSettings.sectionTypes = {};
  }
  const val = String(type || '').toLowerCase();
  if (val === 'secondary') uiSettings.sectionTypes[key] = 'secondary';
  else if (uiSettings.sectionTypes[key]) delete uiSettings.sectionTypes[key];
  return true;
}

function encodeSheetValues_(values) {
  const out = [];
  const rows = Array.isArray(values) ? values : [];
  rows.forEach(row => {
    const next = [];
    const cols = Array.isArray(row) ? row : [];
    cols.forEach(cell => {
      if (cell instanceof Date) next.push({ __type: 'date', value: cell.getTime() });
      else next.push(cell);
    });
    out.push(next);
  });
  return out;
}

function decodeSheetValues_(values) {
  const out = [];
  const rows = Array.isArray(values) ? values : [];
  rows.forEach(row => {
    const next = [];
    const cols = Array.isArray(row) ? row : [];
    cols.forEach(cell => {
      if (cell && typeof cell === 'object' && cell.__type === 'date') {
        next.push(new Date(cell.value));
      } else {
        next.push(cell);
      }
    });
    out.push(next);
  });
  return out;
}

function buildSheetSnapshot_(sheet) {
  const range = sheet.getDataRange();
  return {
    name: sheet.getName(),
    rowCount: range.getNumRows(),
    colCount: range.getNumColumns(),
    maxRows: sheet.getMaxRows(),
    maxCols: sheet.getMaxColumns(),
    values: encodeSheetValues_(range.getValues()),
    formulas: range.getFormulas(),
    backgrounds: range.getBackgrounds(),
    numberFormats: range.getNumberFormats()
  };
}

function ensureSheetSize_(sheet, maxRows, maxCols) {
  const wantRows = Number(maxRows) || sheet.getMaxRows();
  const wantCols = Number(maxCols) || sheet.getMaxColumns();

  const curRows = sheet.getMaxRows();
  if (wantRows > curRows) sheet.insertRowsAfter(curRows, wantRows - curRows);
  if (wantRows < curRows) sheet.deleteRows(wantRows + 1, curRows - wantRows);

  const curCols = sheet.getMaxColumns();
  if (wantCols > curCols) sheet.insertColumnsAfter(curCols, wantCols - curCols);
  if (wantCols < curCols) sheet.deleteColumns(wantCols + 1, curCols - wantCols);
}

function applyFormulaGrid_(sheet, formulas, startRow, startCol) {
  if (!Array.isArray(formulas) || !formulas.length) return;
  const rowOffset = Number(startRow) || 1;
  const colOffset = Number(startCol) || 1;
  formulas.forEach((row, rIdx) => {
    const cells = Array.isArray(row) ? row : [];
    let c = 0;
    while (c < cells.length) {
      if (!cells[c]) { c += 1; continue; }
      const start = c;
      const seg = [];
      while (c < cells.length && cells[c]) {
        seg.push(cells[c]);
        c += 1;
      }
      if (seg.length) {
        sheet.getRange(rowOffset + rIdx, colOffset + start, 1, seg.length).setFormulas([seg]);
      }
    }
  });
}

function applySheetSnapshot_(sheet, snap) {
  if (!snap || typeof snap !== 'object') return;
  const values = decodeSheetValues_(snap.values || []);
  const rowCount = Number(snap.rowCount) || (values.length || 0);
  const colCount = Number(snap.colCount) || (values[0] ? values[0].length : 0);
  if (!rowCount || !colCount) return;

  ensureSheetSize_(sheet, snap.maxRows || rowCount, snap.maxCols || colCount);

  const range = sheet.getRange(1, 1, rowCount, colCount);
  range.setValues(values);
  if (Array.isArray(snap.backgrounds)) range.setBackgrounds(snap.backgrounds);
  if (Array.isArray(snap.numberFormats)) range.setNumberFormats(snap.numberFormats);
  if (Array.isArray(snap.formulas)) applyFormulaGrid_(sheet, snap.formulas, 1, 1);
}

function exportWebappData() {
  const ss = getSpreadsheet_();
  const sheet = ss.getSheetByName(CONFIG.INVENT_SHEET);
  if (!sheet) throw new Error(`Missing sheet: ${CONFIG.INVENT_SHEET}`);

  const meta = getInventoryMeta_();
  const uiSettings = getUiSettings_();
  const sectionLabels = getSectionLabelOverrides_();
  const sectionGroups = getSectionGroups_();
  const sheetSnapshots = {};
  [CONFIG.INVENT_SHEET, CONFIG.ORDER_SHEET].forEach(name => {
    const target = ss.getSheetByName(name);
    if (target) sheetSnapshots[name] = buildSheetSnapshot_(target);
  });

  const lastRow = sheet.getLastRow();
  const counts = [];
  if (lastRow > 0) {
    const maxCol = Math.max(CONFIG.COL.J, CONFIG.COL.ID);
    const values = sheet.getRange(1, 1, lastRow, maxCol).getDisplayValues();
    const bgs = sheet.getRange(1, 1, lastRow, maxCol).getBackgrounds();
    for (let r = 0; r < lastRow; r++) {
      const id = String(values[r][CONFIG.COL.ID - 1] || '').trim();
      const name = String(values[r][CONFIG.COL.COMMON_NAME - 1] || '').trim();
      if (!id || !name) continue;
      counts.push({
        id,
        g: String(values[r][CONFIG.COL.G - 1] || '').trim(),
        h: String(values[r][CONFIG.COL.H - 1] || '').trim(),
        j: String(values[r][CONFIG.COL.J - 1] || '').trim(),
        enableG: !isDarkLockedBg_(bgs[r][CONFIG.COL.G - 1]),
        enableH: !isDarkLockedBg_(bgs[r][CONFIG.COL.H - 1]),
        enableJ: !isDarkLockedBg_(bgs[r][CONFIG.COL.J - 1])
      });
    }
  }

  const payload = {
    version: 2,
    exportedAt: new Date().toISOString(),
    spreadsheetId: ss.getId(),
    meta,
    uiSettings,
    sectionLabels,
    sectionGroups,
    counts,
    sheets: sheetSnapshots
  };

  const ts = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyyMMdd-HHmmss');
  const fileName = `TP-BEV-WEBAPP-EXPORT-${ts}.json`;
  return { ok: true, fileName, json: JSON.stringify(payload, null, 2) };
}

function importWebappData(payload) {
  const data = (typeof payload === 'string') ? JSON.parse(payload) : payload;
  if (!data || typeof data !== 'object') throw new Error('Invalid import payload.');

  if (data.uiSettings && typeof data.uiSettings === 'object') {
    saveUiSettings(data.uiSettings);
  }
  if (data.sectionLabels && typeof data.sectionLabels === 'object') {
    saveSectionLabelOverrides_(data.sectionLabels);
  }
  if (Array.isArray(data.sectionGroups)) {
    saveSectionGroups_(data.sectionGroups);
  }
  if (data.meta && typeof data.meta === 'object') {
    setInventoryMeta(data.meta.lastCompleted || data.meta.date || '', data.meta.initials || '');
  }

  const lock = getLock_();
  if (lock) lock.waitLock(CONFIG.LOCK_WAIT_MS);

  try {
    const ss = getSpreadsheet_();
    const sheets = (data.sheets && typeof data.sheets === 'object') ? data.sheets : {};
    let snapshotApplied = false;

    Object.keys(sheets).forEach(name => {
      const snap = sheets[name];
      const target = ss.getSheetByName(name);
      if (!target) return;
      applySheetSnapshot_(target, snap);
      snapshotApplied = true;
    });

    if (!snapshotApplied) {
      const sheet = ss.getSheetByName(CONFIG.INVENT_SHEET);
      if (!sheet) throw new Error(`Missing sheet: ${CONFIG.INVENT_SHEET}`);

      const lastRow = sheet.getLastRow();
      if (!lastRow) return { ok: true, missingIds: [] };

      const idCol = sheet.getRange(1, CONFIG.COL.ID, lastRow, 1).getDisplayValues();
      const rowById = new Map();
      for (let r = 0; r < idCol.length; r++) {
        const id = String(idCol[r][0] || '').trim();
        if (id) rowById.set(id, r + 1);
      }

      const missing = [];
      const counts = Array.isArray(data.counts) ? data.counts : [];
      const lockedBg = CONFIG.LOCKED_BG || '#2f2f2f';
      const unlockedBg = CONFIG.UNLOCKED_BG || '#ffffff';

      counts.forEach(entry => {
        const id = String(entry?.id || '').trim();
        if (!id) return;
        const row = rowById.get(id);
        if (!row) {
          missing.push(id);
          return;
        }

        if (Object.prototype.hasOwnProperty.call(entry, 'g')) sheet.getRange(row, CONFIG.COL.G).setValue(entry.g);
        if (Object.prototype.hasOwnProperty.call(entry, 'h')) sheet.getRange(row, CONFIG.COL.H).setValue(entry.h);
        if (Object.prototype.hasOwnProperty.call(entry, 'j')) sheet.getRange(row, CONFIG.COL.J).setValue(entry.j);

        const updateBg = (col, enabled) => {
          if (typeof enabled !== 'boolean') return;
          sheet.getRange(row, col).setBackground(enabled ? unlockedBg : lockedBg);
        };

        updateBg(CONFIG.COL.G, entry.enableG);
        updateBg(CONFIG.COL.H, entry.enableH);
        updateBg(CONFIG.COL.J, entry.enableJ);
      });

      return { ok: true, missingIds: missing };
    }

    return { ok: true, missingIds: [], snapshotApplied: true };
  } finally {
    if (lock) lock.releaseLock();
  }
}

function makeSectionKey_(heading) {
  return norm_(heading).replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}

function isSectionHeading_(value, idValue) {
  const raw = String(value || '').trim();
  if (!raw) return false;
  const v = norm_(raw);
  const matchesKnown = CONFIG.SECTION_HEADINGS.some(h => norm_(h) === v);
  if (typeof idValue !== 'undefined') {
    const id = String(idValue || '').trim();
    if (!id) return true;
    return matchesKnown;
  }
  return matchesKnown;
}

function colLetter_(col) {
  let n = col, s = '';
  while (n > 0) {
    const m = (n - 1) % 26;
    s = String.fromCharCode(65 + m) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

function hexToRgb_(hex) {
  if (!hex) return null;
  const h = String(hex).replace('#', '').trim();
  if (h.length !== 6) return null;
  const r = parseInt(h.substring(0, 2), 16);
  const g = parseInt(h.substring(2, 4), 16);
  const b = parseInt(h.substring(4, 6), 16);
  if ([r, g, b].some(n => Number.isNaN(n))) return null;
  return { r, g, b };
}

function isDarkLockedBg_(hex) {
  const rgb = hexToRgb_(hex);
  if (!rgb) return false;
  const { r, g, b } = rgb;
  const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const chroma = max - min;
  return (lum < 90 && chroma < 30);
}

function getLock_() {
  try { const l = LockService.getDocumentLock(); if (l) return l; } catch(e){ console.error(e); }
  try { const l2 = LockService.getScriptLock(); if (l2) return l2; } catch(e){ console.error(e); }
  return null;
}

function findLabeledCellRight_(sheet, patterns, fallbackA1) {
  const maxRows = Math.min(sheet.getMaxRows(), 10);
  const maxCols = Math.min(sheet.getMaxColumns(), 26);
  const rng = sheet.getRange(1, 1, maxRows, maxCols);
  const vals = rng.getDisplayValues();

  for (let r = 0; r < vals.length; r++) {
    for (let c = 0; c < vals[0].length; c++) {
      const t = norm_(vals[r][c]);
      if (!t) continue;
      if (patterns.some(p => t.includes(norm_(p)))) {
        const writeCol = Math.min(c + 2, sheet.getMaxColumns());
        return sheet.getRange(r + 1, writeCol);
      }
    }
  }
  if (fallbackA1) return sheet.getRange(fallbackA1);
  return null;
}

function findDateCell_(sheet, fallbackA1) {
  return findLabeledCellRight_(sheet, CONFIG.DATE_LABEL_PATTERNS, fallbackA1) || sheet.getRange(fallbackA1);
}

function findInitialsCell_(sheet, fallbackA1) {
  const labeled = findLabeledCellRight_(sheet, CONFIG.INITIALS_LABEL_PATTERNS, null);
  if (labeled) return labeled;

  const dateFallback =
    (sheet.getName() === CONFIG.ORDER_SHEET) ? CONFIG.DATE_FALLBACK_CELL_ORDER : CONFIG.DATE_FALLBACK_CELL_INVENT;

  const dateCell = findDateCell_(sheet, dateFallback);
  if (!dateCell) return fallbackA1 ? sheet.getRange(fallbackA1) : sheet.getRange(1, 1);

  const targetRow = Math.min(dateCell.getRow() + 1, sheet.getMaxRows());
  return sheet.getRange(targetRow, dateCell.getColumn());
}

function getInventoryMeta_() {
  const ss = getSpreadsheet_();
  const invent = ss.getSheetByName(CONFIG.INVENT_SHEET);
  const order = ss.getSheetByName(CONFIG.ORDER_SHEET);
  if (!invent) throw new Error(`Missing sheet: ${CONFIG.INVENT_SHEET}`);

  const dateInv = findDateCell_(invent, CONFIG.DATE_FALLBACK_CELL_INVENT);
  const initInv = findInitialsCell_(invent, CONFIG.INITIALS_FALLBACK_CELL_INVENT);

  let dateVal = String(dateInv.getDisplayValue() || '').trim();
  let initVal = String(initInv.getDisplayValue() || '').trim();

  if ((!dateVal || !initVal) && order) {
    const dateOrd = findDateCell_(order, CONFIG.DATE_FALLBACK_CELL_ORDER);
    const initOrd = findInitialsCell_(order, CONFIG.INITIALS_FALLBACK_CELL_ORDER);
    if (!dateVal) dateVal = String(dateOrd.getDisplayValue() || '').trim();
    if (!initVal) initVal = String(initOrd.getDisplayValue() || '').trim();
  }

  return { lastCompleted: dateVal, initials: initVal };
}

function setInventoryMeta(lastCompleted, initials) {
  const ss = getSpreadsheet_();
  const invent = ss.getSheetByName(CONFIG.INVENT_SHEET);
  const order = ss.getSheetByName(CONFIG.ORDER_SHEET);
  if (!invent) throw new Error(`Missing sheet: ${CONFIG.INVENT_SHEET}`);

  const lock = getLock_();
  if (lock) lock.waitLock(CONFIG.LOCK_WAIT_MS);

  try {
    const dateStr = String(lastCompleted || '').trim();
    const initStr = String(initials || '').toUpperCase().replace(/[^A-Z]/g, '').slice(0, 3);

    findDateCell_(invent, CONFIG.DATE_FALLBACK_CELL_INVENT).setValue(dateStr);
    findInitialsCell_(invent, CONFIG.INITIALS_FALLBACK_CELL_INVENT).setValue(initStr);

    if (order) {
      findDateCell_(order, CONFIG.DATE_FALLBACK_CELL_ORDER).setValue(dateStr);
      findInitialsCell_(order, CONFIG.INITIALS_FALLBACK_CELL_ORDER).setValue(initStr);
    }

    const meta = getInventoryMeta_();
    return { ok: true, lastCompleted: meta.lastCompleted, initials: meta.initials };
  } finally {
    if (lock) lock.releaseLock();
  }
}

function findFormatReferenceRow_(sheet) {
  const lastRow = sheet.getLastRow();
  if (lastRow < 1) return null;
  const target = norm_(CONFIG.FORMAT_REFERENCE_ITEM_B);

  const colB = sheet.getRange(1, CONFIG.COL.COMMON_NAME, lastRow, 1).getDisplayValues();
  for (let r = 0; r < colB.length; r++) {
    if (norm_(colB[r][0]) === target) return r + 1;
  }
  return null;
}

function copyFormatBlock_(sheet, exampleRow, newRow, colStart, colEnd) {
  sheet.getRange(exampleRow, colStart, 1, colEnd - colStart + 1)
    .copyFormatToRange(sheet, colStart, colEnd, newRow, newRow);
}

/**
 * ONE-TIME MAINTENANCE — shrink a bloated sheet.
 *
 * Google Sheets can accumulate formatting across all 16,384 columns (and
 * thousands of empty rows), which inflates the file to many MB and makes every
 * operation — including app load and adding distributors — slow. This deletes
 * the columns past the real data and the trailing empty rows.
 *
 * Run from the Apps Script editor: select `compactInventSheet` and press Run.
 * It keeps columns A..Z (the data ends well before that) plus a small row
 * buffer, so it is safe for this app's schema. The return value reports what
 * was removed. After running, reload the web app — it should be far faster.
 */
function compactInventSheet() {
  const ss = getSpreadsheet_();
  const sheet = ss.getSheetByName(CONFIG.INVENT_SHEET);
  if (!sheet) throw new Error(`Missing sheet: ${CONFIG.INVENT_SHEET}`);
  const res = compactSheet_(sheet, 26, 25);
  SpreadsheetApp.flush();
  return res;
}

/** Deletes columns past keepCols and rows past (lastRow + rowBuffer). */
function compactSheet_(sheet, keepCols, rowBuffer) {
  const keep = Math.max(1, Number(keepCols) || 26);
  const buffer = Math.max(0, Number(rowBuffer) || 0);
  let removedCols = 0;
  let removedRows = 0;

  const maxCols = sheet.getMaxColumns();
  if (maxCols > keep) {
    sheet.deleteColumns(keep + 1, maxCols - keep);
    removedCols = maxCols - keep;
  }

  const lastRow = Math.max(sheet.getLastRow(), 1);
  const keepRows = lastRow + buffer;
  const maxRows = sheet.getMaxRows();
  if (maxRows > keepRows) {
    sheet.deleteRows(keepRows + 1, maxRows - keepRows);
    removedRows = maxRows - keepRows;
  }

  return {
    ok: true,
    sheet: sheet.getName(),
    removedCols,
    removedRows,
    columnsNow: sheet.getMaxColumns(),
    rowsNow: sheet.getMaxRows()
  };
}

/**
 * Returns a Set of 1-based row numbers that are hidden-by-user, fetched in a
 * SINGLE Sheets API call. Calling Sheet.isRowHiddenByUser() per row is a
 * backend round-trip each, which made loads take minutes on large sheets.
 * Requires the "Google Sheets API" advanced service to be enabled in the Apps
 * Script project (Editor → Services → add "Google Sheets API"). Returns null if
 * the service isn't available so callers can fall back to the per-row check.
 */
function getHiddenRowSet_(ss, sheetName) {
  try {
    if (typeof Sheets === 'undefined' || !Sheets.Spreadsheets) return null;
    const resp = Sheets.Spreadsheets.get(ss.getId(), {
      ranges: [sheetName],
      fields: 'sheets(data(rowMetadata(hiddenByUser)))'
    });
    const sheetsArr = resp && resp.sheets;
    if (!sheetsArr || !sheetsArr.length) return null;
    const data = sheetsArr[0].data;
    if (!data || !data.length) return new Set();
    const meta = data[0].rowMetadata || [];
    const set = new Set();
    for (let i = 0; i < meta.length; i++) {
      if (meta[i] && meta[i].hiddenByUser) set.add(i + 1);
    }
    return set;
  } catch (e) {
    console.error('getHiddenRowSet_:', e);
    return null;
  }
}

function getInventData() {
  assertAuthorized_();
  const ss = getSpreadsheet_();
  const sheet = ss.getSheetByName(CONFIG.INVENT_SHEET);
  if (!sheet) throw new Error(`Missing sheet: ${CONFIG.INVENT_SHEET}`);
  const meta = getInventoryMeta_();
  const sectionLabels = getSectionLabelOverrides_();
  const uiSettings = getUiSettings_();
  let distributors = getDistributorsFromSettings_(uiSettings);
  const secondarySections = getSecondarySectionsFromSettings_(uiSettings);
  const sectionGroups = getSectionGroups_();

  const lastRow = sheet.getLastRow();
  if (lastRow < 1) {
    let changed = false;
    const required = ensureRequiredDistributors_(uiSettings, null, distributors, { createSheet: false });
    if (required && required.distributors) {
      distributors = required.distributors;
      if (required.added && required.added.length) changed = true;
    }
    const aliasRes = normalizeDistributorAliases_(distributors, VENDOR_ALIASES);
    if (aliasRes.changed) {
      distributors = aliasRes.list;
      changed = true;
    }
    if (changed && uiSettings && typeof uiSettings === 'object') {
      uiSettings.distributors = distributors;
      saveUiSettings(uiSettings);
      PropertiesService.getScriptProperties().setProperty('DISTRO_DATA_DIRTY', 'true');
    }
    distributors = ensureDistributorRefs_(distributors, uiSettings);
    if (shouldSyncDistroData_(uiSettings, distributors)) {
      syncDistroDataSheetAndClear_(distributors);
    }
    const vendorSet = new Set(CONFIG.VENDORS);
    distributors.forEach(d => {
      const name = String(d.name || '').trim();
      if (name) vendorSet.add(name);
    });
    const vendors = Array.from(vendorSet);
    const orderGuideSheets = getOrderGuideSheetNames_(distributors);
    const orderGuideSheetNames = getAllSheetNames_();
    return {
      headers: { g: 'BAR', h: 'OTHER', j: 'OFFICE' },
      rows: [],
      sections: CONFIG.SECTION_HEADINGS.map(h => ({ heading: h, key: makeSectionKey_(h), row: null })),
      sectionLabels,
      vendors,
      categories: CONFIG.CATEGORIES,
      duplicates: [],
      uiSettings,
      secondarySections,
      distributors,
      orderGuideSheets,
      orderGuideSheetNames,
      sectionGroups,
      lastCompleted: meta.lastCompleted,
      initials: meta.initials
    };
  }

  // Lightweight phase timing — shows up in the Apps Script execution log so we
  // can see exactly where load time goes.
  let _t = Date.now();
  const _mark = (label) => { const now = Date.now(); console.log(`getInventData ${label}: ${now - _t}ms`); _t = now; };

  const maxCol = Math.max(CONFIG.COL.NOTES, 18);
  const rng = sheet.getRange(1, 1, lastRow, maxCol);
  const display = rng.getDisplayValues();
  _mark('getDisplayValues');
  // Backgrounds are only needed for the G/H/J lock state — read just those
  // columns instead of the whole 18-column range (a much smaller, faster read).
  const bgStartCol = CONFIG.COL.G;
  const bgWidth = CONFIG.COL.J - CONFIG.COL.G + 1;
  const bgs = sheet.getRange(1, bgStartCol, lastRow, bgWidth).getBackgrounds();
  _mark('getBackgrounds');

  // Acquire lock for write operations (alias normalization, distributor seeding, distro sync)
  let vendorMap = new Map();
  const dataLock = getLock_();
  if (dataLock) dataLock.waitLock(CONFIG.LOCK_WAIT_MS);
  try {
    normalizeVendorAliasesInDisplay_(sheet, display, VENDOR_ALIASES);
    vendorMap = collectVendorCategoriesFromDisplay_(display);
    // skipTableScan avoids the slow getTables() call while seeding placeholder
    // distributor entries on the read path.
    const seedRes = autoSeedDistributorsFromInventory_(uiSettings, vendorMap, { skipTableScan: true });
    if (seedRes && seedRes.distributors) distributors = seedRes.distributors;
    distributors = ensureDistributorRefs_(distributors, uiSettings);
    if (shouldSyncDistroData_(uiSettings, distributors)) {
      syncDistroDataSheetAndClear_(distributors);
    }
  } finally {
    if (dataLock) dataLock.releaseLock();
  }
  _mark('lock+seed+distroSync');
  const vendorSet = new Set(CONFIG.VENDORS);
  distributors.forEach(d => {
    const name = String(d.name || '').trim();
    if (name) vendorSet.add(name);
  });
  vendorMap.forEach(entry => {
    const name = String(entry?.name || '').trim();
    if (name) vendorSet.add(name);
  });
  const vendors = Array.from(vendorSet);
  const orderGuideSheets = getOrderGuideSheetNames_(distributors);
  const orderGuideSheetNames = getAllSheetNames_();

  const seen = new Map();
  const dups = new Set();

  const rows = [];
  const sections = [];
  const sectionKeys = new Set();
  let currentSection = null;

  // Fetch all hidden-by-user rows in one call (falls back to per-row if the
  // Sheets advanced service isn't enabled).
  const hiddenRows = getHiddenRowSet_(ss, sheet.getName());
  _mark('getHiddenRowSet');

  for (let r = 0; r < lastRow; r++) {
    const rowNum = r + 1;
    if (hiddenRows ? hiddenRows.has(rowNum) : sheet.isRowHiddenByUser(rowNum)) continue;

    const commonName = String(display[r][CONFIG.COL.COMMON_NAME - 1] || '').trim();
    const id = String(display[r][CONFIG.COL.ID - 1] || '').trim();

    if (isSectionHeading_(commonName, id)) {
      currentSection = commonName;
      const key = makeSectionKey_(commonName);
      rows.push({ type: 'header', label: commonName, key, row: rowNum });
      if (!sectionKeys.has(key)) {
        sectionKeys.add(key);
        sections.push({ heading: commonName, key, row: rowNum });
      }
      continue;
    }

    if (id && commonName) {
      if (seen.has(id)) dups.add(id);
      else seen.set(id, true);

      const editable = {
        g: !isDarkLockedBg_(bgs[r][CONFIG.COL.G - bgStartCol]),
        h: !isDarkLockedBg_(bgs[r][CONFIG.COL.H - bgStartCol]),
        j: !isDarkLockedBg_(bgs[r][CONFIG.COL.J - bgStartCol])
      };

      const vendor = String(display[r][CONFIG.COL.VENDOR - 1] || '').trim();
      const orderName = String(display[r][CONFIG.COL.ORDER_NAME - 1] || '').trim();
      const bottleSize = String(display[r][CONFIG.COL.BOTTLE_SIZE - 1] || '').trim();
      const par = String(display[r][CONFIG.COL.PAR - 1] || '').trim();
      const categoryN = String(display[r][CONFIG.COL.CATEGORY - 1] || '').trim();
      const cost = String(display[r][CONFIG.COL.COST - 1] || '').trim();
      const csSize = String(display[r][CONFIG.COL.CS_SIZE - 1] || '').trim();
      const notes = String(display[r][CONFIG.COL.NOTES - 1] || '').trim();

      rows.push({
        type: 'item',
        section: currentSection || '',
        id,
        b: commonName,
        orderName,
        bottleSize,
        par,
        categoryN,
        vendor,
        cost,
        csSize,
        notes,
        o: vendor,
        g: String(display[r][CONFIG.COL.G - 1] ?? ''),
        h: String(display[r][CONFIG.COL.H - 1] ?? ''),
        j: String(display[r][CONFIG.COL.J - 1] ?? ''),
        editable
      });
    }
  }
  _mark('rowLoop');

  return {
    headers: { g: 'BAR', h: 'OTHER', j: 'OFFICE' },
    rows,
    sections: sections.length
      ? sections
      : CONFIG.SECTION_HEADINGS.map(h => ({ heading: h, key: makeSectionKey_(h) })),
    sectionLabels,
    vendors,
    categories: CONFIG.CATEGORIES,
    duplicates: Array.from(dups),
    uiSettings,
    secondarySections,
    distributors,
    orderGuideSheets,
    orderGuideSheetNames,
    sectionGroups,
    lastCompleted: meta.lastCompleted,
    initials: meta.initials
  };
}

function saveInventEdits(edits) {
  assertAuthorized_();
  const ss = getSpreadsheet_();
  const sheet = ss.getSheetByName(CONFIG.INVENT_SHEET);
  if (!sheet) throw new Error(`Missing sheet: ${CONFIG.INVENT_SHEET}`);

  const lock = getLock_();
  if (lock) lock.waitLock(CONFIG.LOCK_WAIT_MS);

  try {
    let lastRow = sheet.getLastRow();
    const scanWidth = Math.max(CONFIG.COL.NOTES, 18);
    const editList = edits || [];
    // Cache settings/distributors once for all edits
    const cachedDistributors = getDistributorsFromSettings_(getUiSettings_());

    const buildIdMap = () => {
      const idCol = sheet.getRange(1, CONFIG.COL.ID, lastRow, 1).getDisplayValues();
      const map = new Map();
      for (let r = 0; r < lastRow; r++) {
        const id = String(idCol[r][0] || '').trim();
        if (!id) continue;
        if (map.has(id)) return { map, duplicateId: id };
        map.set(id, r + 1);
      }
      return { map, duplicateId: null };
    };

    let mapResult = buildIdMap();
    if (mapResult.duplicateId) return { duplicateIds: [mapResult.duplicateId] };
    let idToRow = mapResult.map;

    const missing = [];
    const ordering = [];

    for (let i = 0; i < editList.length; i++) {
      const e = editList[i] || {};
      const id = String(e.id || '').trim();
      if (!id || !idToRow.has(id)) { missing.push(id || '(blank)'); continue; }

      let row = idToRow.get(id);

      if (Object.prototype.hasOwnProperty.call(e, 'section')) {
        const targetSection = String(e.section || '').trim();
        if (targetSection) {
          const moveRes = moveInventRowToSection_(sheet, row, targetSection, scanWidth);
          if (!moveRes.ok) throw new Error(moveRes.message || 'Move failed.');
          if (moveRes.moved) {
            row = moveRes.row;
            idToRow.set(id, row);
            if (editList.length > 1) {
              lastRow = sheet.getLastRow();
              mapResult = buildIdMap();
              if (mapResult.duplicateId) return { duplicateIds: [mapResult.duplicateId] };
              idToRow = mapResult.map;
            }
          }
        }
      }

      // Batch read: fetch entire row once instead of individual cells
      const rowRange = sheet.getRange(row, 1, 1, scanWidth);
      const rowValues = rowRange.getDisplayValues()[0].slice();

      const needsOrderingCheck = Object.prototype.hasOwnProperty.call(e, 'vendor') ||
        Object.prototype.hasOwnProperty.call(e, 'categoryN') ||
        Object.prototype.hasOwnProperty.call(e, 'orderName');

      const oldVendor = String(rowValues[CONFIG.COL.VENDOR - 1] || '').trim();
      const oldCategory = String(rowValues[CONFIG.COL.CATEGORY - 1] || '').trim();
      const oldOrderName = String(rowValues[CONFIG.COL.ORDER_NAME - 1] || '').trim();

      // Modify values in memory
      const has = (prop) => Object.prototype.hasOwnProperty.call(e, prop);
      if (has('commonName')) rowValues[CONFIG.COL.COMMON_NAME - 1] = String(e.commonName || '').trim().toUpperCase();
      if (has('orderName')) rowValues[CONFIG.COL.ORDER_NAME - 1] = String(e.orderName || '').trim().toUpperCase();
      if (has('bottleSize')) rowValues[CONFIG.COL.BOTTLE_SIZE - 1] = String(e.bottleSize || '').trim();
      if (has('par')) rowValues[CONFIG.COL.PAR - 1] = String(e.par || '').trim();
      if (has('categoryN')) rowValues[CONFIG.COL.CATEGORY - 1] = String(e.categoryN || '').trim();
      if (has('vendor')) rowValues[CONFIG.COL.VENDOR - 1] = String(e.vendor || '').trim();
      if (has('cost')) rowValues[CONFIG.COL.COST - 1] = String(e.cost || '').trim();
      if (has('csSize')) rowValues[CONFIG.COL.CS_SIZE - 1] = String(e.csSize || '').trim();
      if (has('notes')) rowValues[CONFIG.COL.NOTES - 1] = String(e.notes || '').trim();
      if (has('g')) rowValues[CONFIG.COL.G - 1] = e.g;
      if (has('h')) rowValues[CONFIG.COL.H - 1] = e.h;
      if (has('j')) rowValues[CONFIG.COL.J - 1] = e.j;

      // Batch write: single setValues call + formula
      rowRange.setValues([rowValues]);
      sheet.getRange(row, CONFIG.COL.I)
        .setFormula(`=IFERROR(${colLetter_(CONFIG.COL.G)}${row}+${colLetter_(CONFIG.COL.H)}${row},"")`);

      if (needsOrderingCheck) {
        const newVendor = has('vendor') ? String(e.vendor || '').trim() : oldVendor;
        const newCategory = has('categoryN') ? String(e.categoryN || '').trim() : oldCategory;
        const newOrderName = has('orderName') ? String(e.orderName || '').trim() : oldOrderName;

        const vendorChanged = norm_(newVendor) !== norm_(oldVendor);
        const categoryChanged = norm_(newCategory) !== norm_(oldCategory);
        const orderNameChanged = norm_(newOrderName) !== norm_(oldOrderName);

        if (vendorChanged || categoryChanged || orderNameChanged) {
          const ordRes = syncOrderingForItem_(id, newVendor, newCategory, { touch: orderNameChanged }, cachedDistributors);
          ordering.push({ id, ...ordRes });
        }
      }
    }

    if (missing.length) return { missingIds: missing, ordering };
    return { ok: true, ordering };
  } finally {
    if (lock) lock.releaseLock();
  }
}

function setInventoryInputLocks(payload) {
  const ss = getSpreadsheet_();
  const sheet = ss.getSheetByName(CONFIG.INVENT_SHEET);
  if (!sheet) throw new Error(`Missing sheet: ${CONFIG.INVENT_SHEET}`);

  const id = String(payload?.id || '').trim();
  if (!id) throw new Error('ID is required.');

  const lock = getLock_();
  if (lock) lock.waitLock(CONFIG.LOCK_WAIT_MS);

  try {
    const lastRow = sheet.getLastRow();
    if (lastRow < 1) return { ok: false, message: 'No rows found.' };

    const idCol = sheet.getRange(1, CONFIG.COL.ID, lastRow, 1).getDisplayValues();
    let row = -1;
    for (let r = 0; r < idCol.length; r++) {
      const val = String(idCol[r][0] || '').trim();
      if (val === id) {
        if (row !== -1) return { duplicateIds: [id] };
        row = r + 1;
      }
    }
    if (row === -1) return { missingIds: [id] };

    const lockedBg = CONFIG.LOCKED_BG || '#2f2f2f';
    const unlockedBg = CONFIG.UNLOCKED_BG || '#ffffff';
    const updates = [];

    const maybePush = (col, enabled) => {
      if (typeof enabled !== 'boolean') return;
      updates.push({ col, enabled });
    };

    maybePush(CONFIG.COL.G, payload?.enableG);
    maybePush(CONFIG.COL.H, payload?.enableH);
    maybePush(CONFIG.COL.J, payload?.enableJ);

    updates.forEach(u => {
      const bg = u.enabled ? unlockedBg : lockedBg;
      sheet.getRange(row, u.col).setBackground(bg);
    });

    return { ok: true };
  } finally {
    if (lock) lock.releaseLock();
  }
}

function reorderInventItem(payload) {
  const ss = getSpreadsheet_();
  const sheet = ss.getSheetByName(CONFIG.INVENT_SHEET);
  if (!sheet) throw new Error(`Missing sheet: ${CONFIG.INVENT_SHEET}`);

  const id = String(payload?.id || '').trim();
  const targetId = String(payload?.targetId || '').trim();
  const position = String(payload?.position || 'before') === 'after' ? 'after' : 'before';
  if (!id || !targetId) throw new Error('Item IDs are required.');
  if (id === targetId) return { ok: true, moved: false };

  const lock = getLock_();
  if (lock) lock.waitLock(CONFIG.LOCK_WAIT_MS);

  try {
    const lastRow = sheet.getLastRow();
    if (lastRow < 1) return { missingIds: [id, targetId] };

    const idCol = sheet.getRange(1, CONFIG.COL.ID, lastRow, 1).getDisplayValues();
    let sourceRow = -1;
    let targetRow = -1;
    for (let r = 0; r < idCol.length; r++) {
      const val = String(idCol[r][0] || '').trim();
      if (val === id) {
        if (sourceRow !== -1) return { duplicateIds: [id] };
        sourceRow = r + 1;
      }
      if (val === targetId) {
        if (targetRow !== -1) return { duplicateIds: [targetId] };
        targetRow = r + 1;
      }
    }
    if (sourceRow === -1 || targetRow === -1) {
      const missing = [];
      if (sourceRow === -1) missing.push(id);
      if (targetRow === -1) missing.push(targetId);
      return { missingIds: missing };
    }

    const colB = sheet.getRange(1, CONFIG.COL.COMMON_NAME, lastRow, 1)
      .getDisplayValues()
      .map(r => String(r[0] || '').trim());
    const colId = idCol.map(r => String(r[0] || '').trim());

    const sourceSection = findCurrentSectionLabel_(colB, colId, sourceRow);
    const targetSection = findCurrentSectionLabel_(colB, colId, targetRow);
    if (norm_(sourceSection) !== norm_(targetSection)) {
      return { ok: false, message: 'Items must stay within the same section.' };
    }

    if (sourceRow === targetRow) return { ok: true, moved: false };

    let dest = position === 'after' ? targetRow + 1 : targetRow;
    if (dest < 1) dest = 1;
    if (dest > lastRow + 1) dest = lastRow + 1;
    if (dest > sourceRow) dest -= 1;

    sheet.moveRows(sheet.getRange(sourceRow, 1, 1, 1), dest);
    return { ok: true, moved: true };
  } finally {
    if (lock) lock.releaseLock();
  }
}

function reorderSectionBlock(payload) {
  const ss = getSpreadsheet_();
  const sheet = ss.getSheetByName(CONFIG.INVENT_SHEET);
  if (!sheet) throw new Error(`Missing sheet: ${CONFIG.INVENT_SHEET}`);

  const sourceRow = parseInt(payload?.row, 10);
  const targetRow = parseInt(payload?.targetRow, 10);
  const position = String(payload?.position || 'before') === 'after' ? 'after' : 'before';
  if (!sourceRow || !targetRow) throw new Error('Section rows are required.');
  if (sourceRow === targetRow) return { ok: true, moved: false };

  const lock = getLock_();
  if (lock) lock.waitLock(CONFIG.LOCK_WAIT_MS);

  try {
    return reorderSectionBlockVisible_(sheet, sourceRow, targetRow, position);
  } finally {
    if (lock) lock.releaseLock();
  }
}

function reorderSectionByKey(payload) {
  const sourceKey = makeSectionKey_(String(payload?.sourceKey || '').trim());
  const targetKey = makeSectionKey_(String(payload?.targetKey || '').trim());
  const position = String(payload?.position || 'before') === 'after' ? 'after' : 'before';
  if (!sourceKey || !targetKey) throw new Error('Section keys are required.');
  if (norm_(sourceKey) === norm_(targetKey)) return { ok: true, moved: false };

  const ss = getSpreadsheet_();
  const sheet = ss.getSheetByName(CONFIG.INVENT_SHEET);
  if (!sheet) throw new Error(`Missing sheet: ${CONFIG.INVENT_SHEET}`);

  return reorderSectionByKeyVisible_(sheet, sourceKey, targetKey, position);
}

function getVisibleInventoryRows_(sheet, lastRow) {
  const colB = sheet.getRange(1, CONFIG.COL.COMMON_NAME, lastRow, 1).getDisplayValues();
  const colId = sheet.getRange(1, CONFIG.COL.ID, lastRow, 1).getDisplayValues();
  const rows = [];
  for (let r = 0; r < lastRow; r++) {
    const rowNum = r + 1;
    if (sheet.isRowHiddenByUser(rowNum)) continue;
    rows.push({
      row: rowNum,
      b: String(colB[r][0] || '').trim(),
      id: String(colId[r][0] || '').trim()
    });
  }
  return rows;
}

function reorderSectionBlockVisible_(sheet, sourceRow, targetRow, position) {
  const lastRow = sheet.getLastRow();
  if (lastRow < 1) return { ok: false, message: 'No rows to reorder.' };

  const visibleRows = getVisibleInventoryRows_(sheet, lastRow);
  if (!visibleRows.length) return { ok: false, message: 'No visible rows to reorder.' };

  const headers = [];
  visibleRows.forEach((row, idx) => {
    if (!isSectionHeading_(row.b, row.id)) return;
    headers.push({ idx, row: row.row, label: row.b, key: makeSectionKey_(row.b) });
  });
  if (!headers.length) return { ok: false, message: 'No section headings found.' };

  const sourceHeaderIdx = headers.findIndex(h => h.row === sourceRow);
  const targetHeaderIdx = headers.findIndex(h => h.row === targetRow);
  if (sourceHeaderIdx === -1 || targetHeaderIdx === -1) {
    return { ok: false, message: 'Section heading not found.' };
  }

  return reorderVisibleSectionBlock_(sheet, visibleRows, headers, sourceHeaderIdx, targetHeaderIdx, position);
}

function reorderSectionByKeyVisible_(sheet, sourceKey, targetKey, position) {
  const lastRow = sheet.getLastRow();
  if (lastRow < 1) return { ok: false, message: 'No rows to reorder.' };

  const visibleRows = getVisibleInventoryRows_(sheet, lastRow);
  if (!visibleRows.length) return { ok: false, message: 'No visible rows to reorder.' };

  const headers = [];
  visibleRows.forEach((row, idx) => {
    if (!isSectionHeading_(row.b, row.id)) return;
    headers.push({ idx, row: row.row, label: row.b, key: makeSectionKey_(row.b) });
  });
  if (!headers.length) return { ok: false, message: 'No section headings found.' };

  const sourceHeaderIdx = headers.findIndex(h => h.key === sourceKey);
  const targetHeaderIdx = headers.findIndex(h => h.key === targetKey);
  if (sourceHeaderIdx === -1 || targetHeaderIdx === -1) {
    const missing = [];
    if (sourceHeaderIdx === -1) missing.push(sourceKey);
    if (targetHeaderIdx === -1) missing.push(targetKey);
    return { ok: false, missingIds: missing, message: 'Section heading not found.' };
  }

  return reorderVisibleSectionBlock_(sheet, visibleRows, headers, sourceHeaderIdx, targetHeaderIdx, position);
}

function reorderVisibleSectionBlock_(sheet, visibleRows, headers, sourceHeaderIdx, targetHeaderIdx, position) {
  const sourceHeader = headers[sourceHeaderIdx];
  const targetHeader = headers[targetHeaderIdx];

  const sourceStart = sourceHeader.idx;
  const sourceEnd = (sourceHeaderIdx + 1 < headers.length)
    ? headers[sourceHeaderIdx + 1].idx - 1
    : visibleRows.length - 1;

  const targetStart = targetHeader.idx;
  const targetEnd = (targetHeaderIdx + 1 < headers.length)
    ? headers[targetHeaderIdx + 1].idx - 1
    : visibleRows.length - 1;

  if (targetStart >= sourceStart && targetStart <= sourceEnd) return { ok: true, moved: false };

  const sourceRows = visibleRows.slice(sourceStart, sourceEnd + 1).map(r => r.row);
  const targetRows = visibleRows.slice(targetStart, targetEnd + 1).map(r => r.row);
  if (!sourceRows.length || !targetRows.length) return { ok: false, message: 'Section rows not found.' };

  let insertAt = position === 'after' ? targetRows[targetRows.length - 1] + 1 : targetRows[0];
  const sourceFirst = sourceRows[0];
  const sourceLast = sourceRows[sourceRows.length - 1];
  if (insertAt >= sourceFirst && insertAt <= sourceLast + 1) return { ok: true, moved: false };

  const lastRow = sheet.getLastRow();
  const maxCol = Math.max(CONFIG.COL.NOTES, sheet.getLastColumn());
  const count = sourceRows.length;
  const contiguous = sourceRows.every((row, idx) => row === sourceRows[0] + idx);

  if (insertAt > lastRow) {
    sheet.insertRowsAfter(lastRow, count);
    insertAt = lastRow + 1;
  } else {
    sheet.insertRowsBefore(insertAt, count);
  }

  if (contiguous) {
    const sourceStart = sourceRows[0] + (insertAt <= sourceRows[0] ? count : 0);
    sheet.getRange(sourceStart, 1, count, maxCol)
      .copyTo(sheet.getRange(insertAt, 1, count, maxCol), { contentsOnly: false });
    sheet.deleteRows(sourceStart, count);
    return { ok: true, moved: true, fast: true };
  }

  const adjusted = sourceRows.map(row => row + (insertAt <= row ? count : 0));
  for (let i = 0; i < adjusted.length; i++) {
    const srcRow = adjusted[i];
    const destRow = insertAt + i;
    sheet.getRange(srcRow, 1, 1, maxCol)
      .copyTo(sheet.getRange(destRow, 1, 1, maxCol), { contentsOnly: false });
  }

  adjusted.sort((a, b) => b - a).forEach(row => sheet.deleteRow(row));
  return { ok: true, moved: true };
}

function readColBAndId_(sheet) {
  const lastRow = sheet.getLastRow();
  if (lastRow < 1) return { colB: [], colId: [], lastRow: 0 };
  const colB = sheet.getRange(1, CONFIG.COL.COMMON_NAME, lastRow, 1)
    .getDisplayValues().map(r => String(r[0] || '').trim());
  const colId = sheet.getRange(1, CONFIG.COL.ID, lastRow, 1)
    .getDisplayValues().map(r => String(r[0] || '').trim());
  return { colB, colId, lastRow };
}

function sectionExistsOnSheet_(sheet, label) {
  if (!sheet) return false;
  const { colB, colId, lastRow } = readColBAndId_(sheet);
  if (lastRow < 1) return false;
  return findSectionHeaderRow_(colB, colId, label) !== -1;
}

function findSectionHeaderRow_(colB, colId, sectionLabel) {
  const target = norm_(sectionLabel);
  if (!target) return -1;
  for (let i = 0; i < colB.length; i++) {
    const idValue = colId ? colId[i] : undefined;
    if (norm_(colB[i]) === target && isSectionHeading_(colB[i], idValue)) return i + 1;
  }
  return -1;
}

function findCurrentSectionLabel_(colB, colId, row) {
  for (let r = row; r >= 1; r--) {
    if (isSectionHeading_(colB[r - 1], colId[r - 1])) return String(colB[r - 1] || '').trim();
  }
  return '';
}

function findNextSectionHeaderRow_(colB, colId, headerRow, lastRow) {
  for (let r = headerRow + 1; r <= lastRow; r++) {
    if (isSectionHeading_(colB[r - 1], colId[r - 1])) return r;
  }
  return lastRow + 1;
}

function findInsertAfterRowInSection_(sheet, headerRow, nextHeaderRow, scanWidth) {
  const count = Math.max(nextHeaderRow - headerRow, 1);
  const values = sheet.getRange(headerRow, 1, count, scanWidth).getDisplayValues();
  let insertAfter = headerRow;
  for (let i = 1; i < values.length; i++) {
    const anyText = values[i].some(v => String(v || '').trim() !== '');
    if (anyText) insertAfter = headerRow + i;
  }
  return insertAfter;
}

function moveInventRowToSection_(sheet, row, targetSection, scanWidth) {
  const lastRow = sheet.getLastRow();
  const colB = sheet.getRange(1, CONFIG.COL.COMMON_NAME, lastRow, 1)
    .getDisplayValues()
    .map(r => String(r[0] || '').trim());
  const colId = sheet.getRange(1, CONFIG.COL.ID, lastRow, 1)
    .getDisplayValues()
    .map(r => String(r[0] || '').trim());

  const headerRow = findSectionHeaderRow_(colB, colId, targetSection);
  if (headerRow === -1) return { ok: false, message: `Could not find section heading "${targetSection}".` };

  const currentSection = findCurrentSectionLabel_(colB, colId, row);
  if (norm_(currentSection) === norm_(targetSection)) return { ok: true, moved: false, row };

  const nextHeaderRow = findNextSectionHeaderRow_(colB, colId, headerRow, lastRow);
  const insertAfter = findInsertAfterRowInSection_(sheet, headerRow, nextHeaderRow, scanWidth);

  sheet.insertRowAfter(insertAfter);
  const newRow = insertAfter + 1;
  const sourceRow = insertAfter < row ? row + 1 : row;

  sheet.getRange(sourceRow, 1, 1, scanWidth)
    .copyTo(sheet.getRange(newRow, 1, 1, scanWidth), { contentsOnly: false });
  sheet.deleteRow(sourceRow);

  const finalRow = insertAfter < row ? newRow : newRow - 1;
  return { ok: true, moved: true, row: finalRow };
}

function groupItemTargetsBySection_(itemTarget) {
  const groups = new Map();
  if (!itemTarget) return [];
  const entries = itemTarget instanceof Map ? itemTarget.entries() : Object.entries(itemTarget);
  for (const [idRaw, labelRaw] of entries) {
    const id = String(idRaw || '').trim();
    const label = String(labelRaw || '').trim();
    if (!id || !label) continue;
    if (!groups.has(label)) groups.set(label, []);
    groups.get(label).push(id);
  }
  const out = [];
  groups.forEach((ids, label) => {
    const unique = Array.from(new Set(ids.map(v => String(v || '').trim()).filter(Boolean)));
    if (unique.length) out.push({ label, ids: unique });
  });
  return out;
}

function moveItemsToSectionTargets_(sheet, targetGroups, scanWidth) {
  const groups = Array.isArray(targetGroups) ? targetGroups : [];
  if (!sheet || !groups.length) return { ok: true, moved: 0 };

  const lock = getLock_();
  if (lock) lock.waitLock(CONFIG.LOCK_WAIT_MS);

  try {
    const lastRow = sheet.getLastRow();
    if (lastRow < 1) return { ok: true, moved: 0 };

    const idCol = sheet.getRange(1, CONFIG.COL.ID, lastRow, 1).getDisplayValues();
    const colId = idCol.map(r => String(r[0] || '').trim());
    const idToRow = new Map();
    let duplicateId = null;
    for (let r = 0; r < colId.length; r++) {
      const id = colId[r];
      if (!id) continue;
      if (idToRow.has(id)) { duplicateId = id; break; }
      idToRow.set(id, r + 1);
    }
    if (duplicateId) return { duplicateIds: [duplicateId] };

    const missing = [];
    const normalizedGroups = groups.map(group => {
      const label = String(group?.label || group?.section || group?.sectionLabel || '').trim();
      const idsRaw = Array.isArray(group?.ids)
        ? group.ids
        : (Array.isArray(group?.itemIds) ? group.itemIds : []);
      const ids = Array.from(new Set(idsRaw.map(v => String(v || '').trim()).filter(Boolean)));
      const found = [];
      ids.forEach(id => {
        if (!idToRow.has(id)) missing.push(id);
        else found.push(id);
      });
      return { label, ids: found };
    }).filter(g => g.label && g.ids.length);

    if (missing.length) return { missingIds: Array.from(new Set(missing)) };

    let moved = 0;

    for (const group of normalizedGroups) {
      const label = group.label;
      const ids = group.ids;
      if (!ids.length) continue;

      const currentLastRow = sheet.getLastRow();
      if (currentLastRow < 1) break;

      const colB = sheet.getRange(1, CONFIG.COL.COMMON_NAME, currentLastRow, 1)
        .getDisplayValues()
        .map(r => String(r[0] || '').trim());
      const colIdNow = sheet.getRange(1, CONFIG.COL.ID, currentLastRow, 1)
        .getDisplayValues()
        .map(r => String(r[0] || '').trim());

      const rowSection = new Array(currentLastRow + 1).fill('');
      const idToRowNow = new Map();
      let currentSection = '';
      for (let i = 0; i < colB.length; i++) {
        if (isSectionHeading_(colB[i], colIdNow[i])) {
          currentSection = String(colB[i] || '').trim();
        }
        rowSection[i + 1] = currentSection;
        const id = String(colIdNow[i] || '').trim();
        if (!id) continue;
        if (idToRowNow.has(id)) return { duplicateIds: [id] };
        idToRowNow.set(id, i + 1);
      }

      const targetHeaderRow = findSectionHeaderRow_(colB, colIdNow, label);
      if (targetHeaderRow === -1) {
        return { ok: false, missingSections: [label], message: `Could not find section heading "${label}".` };
      }

      const targetNorm = norm_(label);
      const entries = [];
      ids.forEach(id => {
        const row = idToRowNow.get(id);
        if (!row) return;
        const currentLabel = rowSection[row] || '';
        if (norm_(currentLabel) === targetNorm) return;
        entries.push({ id, row });
      });
      if (!entries.length) continue;

      entries.sort((a, b) => a.row - b.row);

      const nextHeaderRow = findNextSectionHeaderRow_(colB, colIdNow, targetHeaderRow, currentLastRow);
      const insertAfter = findInsertAfterRowInSection_(sheet, targetHeaderRow, nextHeaderRow, scanWidth);
      const count = entries.length;

      sheet.insertRowsAfter(insertAfter, count);
      const insertStart = insertAfter + 1;

      entries.forEach((entry, idx) => {
        const sourceRow = entry.row > insertAfter ? entry.row + count : entry.row;
        const destRow = insertStart + idx;
        sheet.getRange(sourceRow, 1, 1, scanWidth)
          .copyTo(sheet.getRange(destRow, 1, 1, scanWidth), { contentsOnly: false });
      });

      const deleteRows = entries.map(entry => (entry.row > insertAfter ? entry.row + count : entry.row));
      deleteRows.sort((a, b) => b - a).forEach(row => sheet.deleteRow(row));
      moved += entries.length;
    }

    return { ok: true, moved };
  } finally {
    if (lock) lock.releaseLock();
  }
}

function renameSectionHeading(payload) {
  const ss = getSpreadsheet_();
  const sheet = ss.getSheetByName(CONFIG.INVENT_SHEET);
  if (!sheet) throw new Error(`Missing sheet: ${CONFIG.INVENT_SHEET}`);

  const nextRaw = String(payload?.newLabel || '').trim();
  if (!nextRaw) throw new Error('Section title is required.');
  const nextLabel = nextRaw.toUpperCase();

  const oldLabel = String(payload?.oldLabel || '').trim();
  const requestedRow = parseInt(payload?.row, 10);
  const labelPayload = payload?.labels || null;

  const lastRow = sheet.getLastRow();
  const colB = sheet.getRange(1, CONFIG.COL.COMMON_NAME, lastRow, 1).getDisplayValues()
    .map(r => String(r[0] || '').trim());
  const colId = sheet.getRange(1, CONFIG.COL.ID, lastRow, 1).getDisplayValues()
    .map(r => String(r[0] || '').trim());

  const matchesRow = (r) => {
    if (!r || r < 1 || r > lastRow) return false;
    if (!isSectionHeading_(colB[r - 1], colId[r - 1])) return false;
    if (!oldLabel) return !!colB[r - 1];
    return norm_(colB[r - 1]) === norm_(oldLabel);
  };

  let row = matchesRow(requestedRow) ? requestedRow : -1;
  if (row === -1 && oldLabel) {
    for (let i = 0; i < colB.length; i++) {
      if (norm_(colB[i]) === norm_(oldLabel) && isSectionHeading_(colB[i], colId[i])) { row = i + 1; break; }
    }
  }

  if (row === -1) throw new Error('Section heading not found.');

  sheet.getRange(row, CONFIG.COL.COMMON_NAME).setValue(nextLabel);

  const labelOverrides = getSectionLabelOverrides_();
  const prevKey = norm_(oldLabel || colB[row - 1] || '');
  const nextKey = norm_(nextLabel);
  const prevTypeKey = makeSectionKey_(oldLabel || colB[row - 1] || '');
  const nextTypeKey = makeSectionKey_(nextLabel);

  if (prevKey && prevKey !== nextKey && labelOverrides[prevKey] && !labelOverrides[nextKey]) {
    labelOverrides[nextKey] = labelOverrides[prevKey];
    delete labelOverrides[prevKey];
  }

  const hasLabelUpdate = !!(labelPayload &&
    (Object.prototype.hasOwnProperty.call(labelPayload, 'g') ||
     Object.prototype.hasOwnProperty.call(labelPayload, 'h') ||
     Object.prototype.hasOwnProperty.call(labelPayload, 'j') ||
     Object.prototype.hasOwnProperty.call(labelPayload, 'tab') ||
     Object.prototype.hasOwnProperty.call(labelPayload, 'align') ||
     Object.prototype.hasOwnProperty.call(labelPayload, 'headingAlign') ||
     Object.prototype.hasOwnProperty.call(labelPayload, 'color')));

  if (hasLabelUpdate) {
    const updated = Object.assign({}, labelOverrides[nextKey] || {});
    const g = String(labelPayload?.g ?? '').trim();
    const h = String(labelPayload?.h ?? '').trim();
    const j = String(labelPayload?.j ?? '').trim();
    const tab = String(labelPayload?.tab ?? '').trim();
    const alignRaw = String(labelPayload?.align ?? labelPayload?.headingAlign ?? '').trim().toLowerCase();
    const align = (alignRaw === 'left' || alignRaw === 'center' || alignRaw === 'right') ? alignRaw : '';
    const color = String(labelPayload?.color ?? '').trim();

    if (g) updated.g = g; else delete updated.g;
    if (h) updated.h = h; else delete updated.h;
    if (j) updated.j = j; else delete updated.j;
    if (tab) updated.tab = tab; else delete updated.tab;
    if (align) updated.align = align; else delete updated.align;
    if (color) updated.color = color; else delete updated.color;

    if (Object.keys(updated).length) labelOverrides[nextKey] = updated;
    else delete labelOverrides[nextKey];
  }

  saveSectionLabelOverrides_(labelOverrides);
  const uiSettings = getUiSettings_();
  let uiUpdated = false;
  if (uiSettings && typeof uiSettings === 'object') {
    if (prevKey && prevKey !== nextKey && uiSettings.inventoryColumns && typeof uiSettings.inventoryColumns === 'object') {
      const columns = uiSettings.inventoryColumns;
      if (columns[prevKey] && !columns[nextKey]) columns[nextKey] = columns[prevKey];
      if (columns[prevKey]) delete columns[prevKey];
      uiUpdated = true;
    }
    if (prevTypeKey && prevTypeKey !== nextTypeKey && uiSettings.sectionTypes && typeof uiSettings.sectionTypes === 'object') {
      const types = uiSettings.sectionTypes;
      if (types[prevTypeKey] && !types[nextTypeKey]) types[nextTypeKey] = types[prevTypeKey];
      if (types[prevTypeKey]) delete types[prevTypeKey];
      uiUpdated = true;
    }
    if (prevTypeKey && prevTypeKey !== nextTypeKey && uiSettings.sectionShortcuts && typeof uiSettings.sectionShortcuts === 'object') {
      const shortcuts = uiSettings.sectionShortcuts;
      if (shortcuts[prevTypeKey] && !shortcuts[nextTypeKey]) shortcuts[nextTypeKey] = shortcuts[prevTypeKey];
      if (shortcuts[prevTypeKey]) delete shortcuts[prevTypeKey];
      uiUpdated = true;
    }
    if (Object.prototype.hasOwnProperty.call(payload || {}, 'columns')) {
      if (applyInventoryColumnSettings_(uiSettings, nextLabel, payload.columns)) uiUpdated = true;
    }
    if (Object.prototype.hasOwnProperty.call(payload || {}, 'type')) {
      if (applySectionTypeSetting_(uiSettings, nextLabel, payload.type)) uiUpdated = true;
    }
    if (uiUpdated) saveUiSettings(uiSettings);
  }
  updateSectionGroupsForRename_(oldLabel, nextLabel);
  return { ok: true, row, label: nextLabel };
}

function normalizeCategoryGroup_(categoryN) {
  const c = norm_(categoryN);
  if (!c) return '';
  if (c === 'WHITE WINE') return 'WHITE_WINE';
  if (c === 'RED WINE') return 'RED_WINE';
  if (c === 'MIXER') return 'MIXER';
  if (c === 'COOKING') return 'COOKING';
  if (c === 'BEER (CANS)' || c === 'BEER (KEGS)' || c === 'BEER') return 'BEER';

  const LIQ = new Set(['VODKA','GIN','RUM','WHISKEY','LIQUEUR','TEQUILA/MEZCAL','TEQUILA','MEZCAL']);
  if (LIQ.has(c)) return 'LIQUOR';
  if (c.includes('TEQUILA') || c.includes('MEZCAL')) return 'LIQUOR';

  return c.replace(/[^A-Z0-9]+/g, '_');
}

function normalizeOrderingVendor_(vendor, distributorsOverride) {
  const v = norm_(vendor);
  if (!v) return '';
  if (v === 'RNDC' || v === 'SOUTHERN' || v === 'ELITE' || v === 'BREAKTHRU') return v;
  if (v === 'SODAS' || v === 'SYSCO') return 'SODAS';
  if (v === 'OTHER') return 'OTHER';
  const distributors = distributorsOverride || getDistributorsFromSettings_(getUiSettings_());
  const match = getDistributorByKey_(v, distributors);
  if (match) return normalizeDistributorKey_(match.key || match.name || v);
  return v;
}

function resolveOrderingTargetTable_(vendor, categoryN, distributorsOverride) {
  const distributors = distributorsOverride || getDistributorsFromSettings_(getUiSettings_());
  const vendorKey = normalizeOrderingVendor_(vendor, distributors);
  if (!vendorKey) return { ok: false, skipped: true, message: 'No distributor provided for ordering insertion.' };

  const dynamic = getDistributorByKey_(vendorKey, distributors);
  const categoryRaw = String(categoryN || '').trim();
  const categoryKey = norm_(categoryRaw);

  if (dynamic) {
    if (!categoryKey) return { ok: false, skipped: true, message: 'No category provided for ordering insertion.' };
    const tables = Array.isArray(dynamic.tables) ? dynamic.tables : [];
    for (let i = 0; i < tables.length; i++) {
      const table = tables[i] || {};
      const tableCats = Array.isArray(table.categories) ? table.categories : [];
      const matches = tableCats.some(c => norm_(c) === categoryKey);
      if (matches) {
        const index = Number(table.index || (i + 1));
        const tableKey = makeDynamicTableKey_(vendorKey, index);
        return { ok: true, vendor: vendorKey, categoryKey, tableKey, dynamic: true };
      }
    }
    return { ok: false, skipped: true, message: `No routing found for ${vendorKey} / ${categoryRaw || 'category'}.` };
  }

  const catGroup = normalizeCategoryGroup_(categoryN);

  if (vendorKey === 'OTHER') {
    if (catGroup === 'MIXER') return { ok: true, vendor: 'SODAS', categoryKey: catGroup, tableKey: getOrderingTableLetter_('SODAS', 'MIXER') };
    return { ok: false, skipped: true, message: `Vendor OTHER not routed for ${catGroup}.` };
  }

  if (vendorKey === 'SODAS') {
    if (catGroup === 'MIXER') return { ok: true, vendor: 'SODAS', categoryKey: catGroup, tableKey: getOrderingTableLetter_('SODAS', 'MIXER') };
    return { ok: false, skipped: true, message: `SODAS distributor only supports MIXER; got ${catGroup}.` };
  }

  if (!catGroup) return { ok: false, skipped: true, message: `No category provided for ordering insertion.` };

  const tableKey = getOrderingTableLetter_(vendorKey, catGroup);
  if (!tableKey) return { ok: false, skipped: true, message: `No routing found for ${vendorKey} / ${catGroup}.` };
  return { ok: true, vendor: vendorKey, categoryKey: catGroup, tableKey };
}

function getTableRangeByIdOrFallback_(sheet, tableId, fallbackA1, tablesCache) {
  try {
    // Only consult getTables() (a slow call) when we actually have a native
    // table id to match. Cache the result per sheet so a single ordering scan
    // doesn't call getTables() once per table definition.
    if (tableId != null && tableId !== '' && sheet && typeof sheet.getTables === 'function') {
      let tables;
      if (tablesCache) {
        const cacheKey = sheet.getName();
        if (tablesCache.has(cacheKey)) {
          tables = tablesCache.get(cacheKey);
        } else {
          tables = sheet.getTables() || [];
          tablesCache.set(cacheKey, tables);
        }
      } else {
        tables = sheet.getTables() || [];
      }
      for (const t of tables) {
        try {
          const id = (typeof t.getId === 'function') ? t.getId() : null;
          if (id !== null && String(id) === String(tableId)) {
            const r = (typeof t.getRange === 'function') ? t.getRange() : null;
            if (r) return { range: r, tableObj: t };
          }
        } catch (e) { console.error(e); }
      }
    }
  } catch (e) { console.error(e); }

  if (fallbackA1) {
    const r = sheet.getRange(fallbackA1);
    return { range: r, tableObj: null };
  }
  return { range: null, tableObj: null };
}

function insertIntoOrderingTableByKey_(tableKey, inventId) {
  const distributors = getDistributorsFromSettings_(getUiSettings_());
  const def = getOrderingTableDefByKey_(tableKey, distributors);
  if (!def) return { ok: false, skipped: true, message: `Ordering table "${tableKey}" not defined.` };

  const ss = getSpreadsheet_();
  const sheet = ss.getSheetByName(def.sheet);
  if (!sheet) return { ok: false, skipped: true, message: `Ordering sheet missing: ${def.sheet}` };

  const loc = getTableRangeByIdOrFallback_(sheet, def.tableId, def.a1);
  const tableRange = loc.range;
  const tableObj = loc.tableObj;

  if (!tableRange) return { ok: false, skipped: true, message: `Could not locate ordering table ${def.name} (${def.tableId || def.a1 || 'range'}).` };

  const startRow = tableRange.getRow();
  const startCol = tableRange.getColumn();
  const numRows = tableRange.getNumRows();
  const numCols = tableRange.getNumColumns();
  const endRow = startRow + numRows - 1;

  if (numRows < 3) return { ok: false, skipped: true, message: `Ordering table ${def.name} too small to insert.` };

  const insertRow = endRow - 1;
  const templateRow = insertRow + 1;

  sheet.insertRowsBefore(insertRow, 1);

  const src = sheet.getRange(templateRow, startCol, 1, numCols);
  const dst = sheet.getRange(insertRow, startCol, 1, numCols);
  src.copyTo(dst, { contentsOnly: false });

  sheet.getRange(insertRow, 1).setValue(String(inventId));

  try {
    if (tableObj && typeof tableObj.setRange === 'function') {
      const newRange = sheet.getRange(startRow, startCol, numRows + 1, numCols);
      tableObj.setRange(newRange);
    }
  } catch (e) { console.error(e); }

  return { ok: true, key: def.key, sheet: def.sheet, tableName: def.name, tableId: def.tableId, insertedRow: insertRow };
}

function insertIntoOrderingTable_(orderingVendor, categoryGroup, inventId) {
  const vendorKey = orderingVendor;
  const letter = (ROUTE_TABLE_LETTER[vendorKey] && ROUTE_TABLE_LETTER[vendorKey][categoryGroup]) ? ROUTE_TABLE_LETTER[vendorKey][categoryGroup] : '';
  if (!letter) return { ok: false, skipped: true, message: `No routing found for ${vendorKey} / ${categoryGroup}.` };
  return insertIntoOrderingTableByKey_(letter, inventId);
}

function resolveOrderingTarget_(vendor, categoryN) {
  const orderingVendorNorm = normalizeOrderingVendor_(vendor);
  const catGroup = normalizeCategoryGroup_(categoryN);

  if (orderingVendorNorm === 'OTHER') {
    if (catGroup === 'MIXER') return { ok: true, vendor: 'SODAS', categoryGroup: 'MIXER' };
    return { ok: false, skipped: true, message: `Vendor OTHER not routed for ${catGroup}.` };
  }

  if (orderingVendorNorm === 'SODAS') {
    if (catGroup === 'MIXER') return { ok: true, vendor: 'SODAS', categoryGroup: 'MIXER' };
    return { ok: false, skipped: true, message: `SODAS distributor only supports MIXER; got ${catGroup}.` };
  }

  if (!orderingVendorNorm) return { ok: false, skipped: true, message: `No distributor provided for ordering insertion.` };
  if (!catGroup) return { ok: false, skipped: true, message: `No category provided for ordering insertion.` };

  return { ok: true, vendor: orderingVendorNorm, categoryGroup: catGroup };
}

function getOrderingTableLetter_(vendor, categoryGroup) {
  return (ROUTE_TABLE_LETTER[vendor] && ROUTE_TABLE_LETTER[vendor][categoryGroup])
    ? ROUTE_TABLE_LETTER[vendor][categoryGroup]
    : '';
}

function findOrderingRowsForId_(ss, id) {
  const out = [];
  const idStr = String(id || '').trim();
  if (!idStr) return out;

  const distributors = getDistributorsFromSettings_(getUiSettings_());
  const tables = getOrderingTableDefs_(distributors);
  const tablesCache = new Map(); // getTables() result per sheet — avoids a slow call per def
  for (const def of tables) {
    if (!def || !def.sheet) continue;
    if (!def.tableId && !def.a1) continue;
    const sheet = ss.getSheetByName(def.sheet);
    if (!sheet) continue;

    const loc = getTableRangeByIdOrFallback_(sheet, def.tableId, def.a1, tablesCache);
    const tableRange = loc.range;
    const tableObj = loc.tableObj;
    if (!tableRange) continue;

    const startRow = tableRange.getRow();
    const startCol = tableRange.getColumn();
    const numRows = tableRange.getNumRows();
    const numCols = tableRange.getNumColumns();

    const idVals = sheet.getRange(startRow, 1, numRows, 1).getDisplayValues();
    for (let i = 0; i < idVals.length; i++) {
      const val = String(idVals[i][0] || '').trim();
      if (val === idStr) {
        out.push({
          tableKey: def.key,
          sheet,
          row: startRow + i,
          tableObj,
          startRow,
          startCol,
          numRows,
          numCols
        });
      }
    }
  }

  return out;
}

function removeOrderingRows_(rows) {
  if (!rows || !rows.length) return;
  const bySheet = new Map();
  const byTable = new Map();

  rows.forEach(info => {
    const sheetKey = info.sheet.getName();
    if (!bySheet.has(sheetKey)) bySheet.set(sheetKey, { sheet: info.sheet, rows: [] });
    bySheet.get(sheetKey).rows.push(info.row);

    const tableKey = info.tableKey || info.letter;
    if (!byTable.has(tableKey)) {
      byTable.set(tableKey, {
        sheet: info.sheet,
        tableObj: info.tableObj,
        startRow: info.startRow,
        startCol: info.startCol,
        numRows: info.numRows,
        numCols: info.numCols,
        deletedRows: []
      });
    }
    byTable.get(tableKey).deletedRows.push(info.row);
  });

  bySheet.forEach(group => {
    const rowsToDelete = group.rows.sort((a, b) => b - a);
    rowsToDelete.forEach(r => group.sheet.deleteRow(r));
  });

  byTable.forEach(table => {
    const deleted = table.deletedRows;
    const sheetRows = (bySheet.get(table.sheet.getName()) || {}).rows || [];
    const within = deleted.filter(r => r >= table.startRow && r <= table.startRow + table.numRows - 1).length;
    const above = sheetRows.filter(r => r < table.startRow).length;
    const newStartRow = table.startRow - above;
    const newNumRows = Math.max(1, table.numRows - within);
    try {
      if (table.tableObj && typeof table.tableObj.setRange === 'function') {
        const newRange = table.sheet.getRange(newStartRow, table.startCol, newNumRows, table.numCols);
        table.tableObj.setRange(newRange);
      }
    } catch (e) { console.error(e); }
  });
}

function touchOrderingRow_(rowInfo, id) {
  try {
    rowInfo.sheet.getRange(rowInfo.row, 1).setValue(String(id));
  } catch (e) { console.error(e); }
}

function syncOrderingForItem_(id, vendor, categoryN, options, distributorsOverride) {
  const ss = getSpreadsheet_();
  const idStr = String(id || '').trim();
  if (!idStr) return { ok: false, skipped: true, message: 'Missing ID for ordering sync.' };

  const existing = findOrderingRowsForId_(ss, idStr);

  // Archived items must never live in an order guide — strip them and stop,
  // even if a later vendor/category edit would otherwise re-add them.
  if (getArchivedItemIds_().has(idStr)) {
    if (existing.length) removeOrderingRows_(existing);
    return { ok: true, archivedSkip: true };
  }

  const target = resolveOrderingTargetTable_(vendor, categoryN, distributorsOverride);
  if (!target.ok) {
    if (existing.length) removeOrderingRows_(existing);
    return target;
  }

  const targetKey = target.tableKey;

  const inTarget = existing.filter(r => r.tableKey === targetKey);
  const notTarget = existing.filter(r => r.tableKey !== targetKey);

  if (notTarget.length) removeOrderingRows_(notTarget);

  if (!inTarget.length) {
    return insertIntoOrderingTableByKey_(targetKey, idStr);
  }

  if (inTarget.length > 1) {
    const sorted = inTarget.slice().sort((a, b) => a.row - b.row);
    const keep = sorted[0];
    const remove = sorted.slice(1);
    if (remove.length) removeOrderingRows_(remove);
    if (options && options.touch) touchOrderingRow_(keep, idStr);
    return { ok: true, key: targetKey, touched: !!(options && options.touch) };
  }

  if (options && options.touch) {
    touchOrderingRow_(inTarget[0], idStr);
    return { ok: true, key: targetKey, touched: true };
  }

  return { ok: true, key: targetKey };
}

function resyncOrderingForDistributor_(vendorName) {
  const vendorKey = norm_(vendorName);
  if (!vendorKey) return { ok: false, skipped: true, message: 'No distributor provided for ordering sync.' };

  const ss = getSpreadsheet_();
  const sheet = ss.getSheetByName(CONFIG.INVENT_SHEET);
  if (!sheet) return { ok: false, message: `Missing sheet: ${CONFIG.INVENT_SHEET}` };

  const lastRow = sheet.getLastRow();
  if (lastRow < 1) return { ok: true, updated: 0 };

  // Cache distributors once for all items in the loop
  const cachedDistributors = getDistributorsFromSettings_(getUiSettings_());
  const maxCol = Math.max(CONFIG.COL.ID, CONFIG.COL.VENDOR, CONFIG.COL.CATEGORY);
  const values = sheet.getRange(1, 1, lastRow, maxCol).getDisplayValues();
  let updated = 0;
  for (let r = 0; r < values.length; r++) {
    const id = String(values[r][CONFIG.COL.ID - 1] || '').trim();
    if (!id) continue;
    const vendor = String(values[r][CONFIG.COL.VENDOR - 1] || '').trim();
    if (!vendor || norm_(vendor) !== vendorKey) continue;
    const categoryN = String(values[r][CONFIG.COL.CATEGORY - 1] || '').trim();
    const res = syncOrderingForItem_(id, vendor, categoryN, { touch: false }, cachedDistributors);
    if (res && res.ok) updated += 1;
  }
  return { ok: true, updated };
}

function findAnySectionHeaderRow_(colB, colId) {
  for (let i = 0; i < colB.length; i++) {
    if (isSectionHeading_(colB[i], colId[i])) return i + 1;
  }
  return -1;
}

/** Parse and validate section entries from addSection payload. Returns { sections, type, labels, columns } or { error }. */
function parseAndValidateSections_(payload) {
  const rawType = String(payload?.type || '').trim().toLowerCase();
  const type = rawType === 'secondary' ? 'secondary' : 'home';
  const labels = payload?.labels || {};
  const columns = payload?.columns || {};
  const rawSections = Array.isArray(payload?.sections) && payload.sections.length
    ? payload.sections
    : (payload?.label ? [{ label: payload.label, itemIds: payload?.itemIds }] : []);

  const sections = rawSections.map(entry => {
    const rawLabel = String(entry?.label || '').trim();
    if (!rawLabel) return null;
    const label = rawLabel.toUpperCase();
    const itemIds = Array.isArray(entry?.itemIds)
      ? entry.itemIds.map(v => String(v || '').trim()).filter(Boolean)
      : [];
    return { label, key: makeSectionKey_(label), itemIds: Array.from(new Set(itemIds)) };
  }).filter(Boolean);

  if (!sections.length) return { error: { ok: false, message: 'Section title is required.' } };
  const labelsSeen = new Set();
  for (const section of sections) {
    const key = norm_(section.label);
    if (labelsSeen.has(key)) return { error: { ok: false, message: `Duplicate section label: ${section.label}` } };
    labelsSeen.add(key);
  }
  return { sections, type, labels, columns };
}

/** Check whether any of the given sections already exist on the sheet or in secondary settings. */
function checkForDuplicateSections_(sections, colB, colId, secondarySections) {
  const existsSecondary = new Set(secondarySections.map(s => norm_(s.label || s.heading || s.key || '')).filter(Boolean));
  const existsHome = new Set();
  colB.forEach((val, i) => {
    if (isSectionHeading_(val, colId[i])) existsHome.add(norm_(val));
  });
  for (const section of sections) {
    const key = norm_(section.label);
    if (existsHome.has(key) || existsSecondary.has(key)) {
      return { ok: false, message: `Section already exists: ${section.label}` };
    }
  }
  return null;
}

/** Insert new home-section header rows on the sheet (called inside a lock). */
function insertHomeSectionRows_(sheet, sections, scanWidth, colB, colId) {
  const templateRow = findAnySectionHeaderRow_(colB, colId);
  sections.forEach(section => {
    const insertAfter = sheet.getLastRow();
    sheet.insertRowAfter(insertAfter);
    const newRow = insertAfter + 1;
    if (templateRow !== -1) {
      sheet.getRange(templateRow, 1, 1, scanWidth)
        .copyFormatToRange(sheet, 1, scanWidth, newRow, newRow);
    }
    sheet.getRange(newRow, CONFIG.COL.COMMON_NAME).setValue(section.label);
    sheet.getRange(newRow, CONFIG.COL.ID).clearContent();
  });
}

/** Build item-movement maps: which items need to move and from which sections. */
function buildItemMovementMaps_(sections, colB, colId) {
  const itemTarget = new Map();
  const movedBySection = new Map();
  const movedIdsBySection = new Map();
  const totalBySection = new Map();
  const itemSectionById = new Map();

  for (let r = 0; r < colB.length; r++) {
    const id = String(colId[r] || '').trim();
    if (!id) continue;
    const sectionLabel = findCurrentSectionLabel_(colB, colId, r + 1);
    if (!sectionLabel) continue;
    itemSectionById.set(id, sectionLabel);
    totalBySection.set(sectionLabel, (totalBySection.get(sectionLabel) || 0) + 1);
  }

  sections.forEach(section => {
    section.itemIds.forEach(id => {
      const source = itemSectionById.get(id);
      if (!source) return;
      if (norm_(source) === norm_(section.label)) return;
      itemTarget.set(id, section.label);
      movedBySection.set(source, (movedBySection.get(source) || 0) + 1);
      if (!movedIdsBySection.has(source)) movedIdsBySection.set(source, []);
      movedIdsBySection.get(source).push(id);
    });
  });

  return { itemTarget, movedBySection, movedIdsBySection, totalBySection };
}

/** Update sectionShortcuts for partially-emptied source sections after moves. */
function updateShortcutsForMovedItems_(sectionShortcuts, movedIdsBySection, movedBySection, totalBySection, convertedKeys) {
  movedIdsBySection.forEach((ids, sectionLabel) => {
    const total = totalBySection.get(sectionLabel) || 0;
    const moved = movedBySection.get(sectionLabel) || 0;
    if (total && moved >= total) return;
    const key = makeSectionKey_(sectionLabel);
    if (!key) return;
    const existing = Array.isArray(sectionShortcuts[key]) ? sectionShortcuts[key] : [];
    const next = new Set(existing.map(v => String(v || '').trim()).filter(Boolean));
    (ids || []).forEach(id => {
      const val = String(id || '').trim();
      if (val) next.add(val);
    });
    if (next.size) sectionShortcuts[key] = Array.from(next);
    else if (sectionShortcuts[key]) delete sectionShortcuts[key];
  });
  convertedKeys.forEach(key => {
    if (sectionShortcuts[key]) delete sectionShortcuts[key];
  });
}

/** Convert fully-emptied home sections to secondary and delete their header rows. */
function convertEmptiedToSecondary_(sheet, toSecondary, nextSettings, secondarySections) {
  const nextSecondary = nextSettings.secondarySections
    ? getSecondarySectionsFromSettings_(nextSettings)
    : secondarySections.slice();
  toSecondary.forEach(sec => {
    const labelKey = norm_(sec.label);
    const idx = nextSecondary.findIndex(s => norm_(s.label || s.heading || s.key || '') === labelKey);
    const ids = Array.from(new Set(sec.itemIds.map(v => String(v || '').trim()).filter(Boolean)));
    if (idx === -1) {
      nextSecondary.push({
        key: makeSectionKey_(sec.label),
        label: sec.label,
        type: 'secondary',
        itemIds: ids,
        createdAt: new Date().toISOString()
      });
    } else {
      const existingIds = Array.isArray(nextSecondary[idx].itemIds) ? nextSecondary[idx].itemIds : [];
      nextSecondary[idx].itemIds = Array.from(new Set(existingIds.concat(ids)));
    }
  });
  nextSettings.secondarySections = nextSecondary;

  const lock2 = getLock_();
  if (lock2) lock2.waitLock(CONFIG.LOCK_WAIT_MS);
  try {
    const lastRow2 = sheet.getLastRow();
    const colB2 = sheet.getRange(1, CONFIG.COL.COMMON_NAME, lastRow2, 1)
      .getDisplayValues()
      .map(r => String(r[0] || '').trim());
    const colId2 = sheet.getRange(1, CONFIG.COL.ID, lastRow2, 1)
      .getDisplayValues()
      .map(r => String(r[0] || '').trim());
    const headerRows = [];
    toSecondary.forEach(sec => {
      const row = findSectionHeaderRow_(colB2, colId2, sec.label);
      if (row !== -1) headerRows.push(row);
    });
    headerRows.sort((a, b) => b - a).forEach(row => {
      sheet.deleteRow(row);
    });
  } finally {
    if (lock2) lock2.releaseLock();
  }
}

function addSection(payload) {
  const parsed = parseAndValidateSections_(payload);
  if (parsed.error) return parsed.error;
  const { sections, type, labels, columns } = parsed;

  const ss = getSpreadsheet_();
  const sheet = ss.getSheetByName(CONFIG.INVENT_SHEET);
  if (!sheet) throw new Error(`Missing sheet: ${CONFIG.INVENT_SHEET}`);

  const lastRow = sheet.getLastRow();
  const colB = lastRow
    ? sheet.getRange(1, CONFIG.COL.COMMON_NAME, lastRow, 1).getDisplayValues().map(r => String(r[0] || '').trim())
    : [];
  const colId = lastRow
    ? sheet.getRange(1, CONFIG.COL.ID, lastRow, 1).getDisplayValues().map(r => String(r[0] || '').trim())
    : [];

  const uiSettings = getUiSettings_();
  const secondarySections = getSecondarySectionsFromSettings_(uiSettings);
  const dupError = checkForDuplicateSections_(sections, colB, colId, secondarySections);
  if (dupError) return dupError;

  const nextSettings = uiSettings && typeof uiSettings === 'object' ? uiSettings : {};
  const sectionShortcuts = getSectionShortcutsFromSettings_(nextSettings);
  if (type === 'secondary') {
    const entries = sections.map(section => ({
      key: section.key,
      label: section.label,
      type: 'secondary',
      itemIds: section.itemIds.slice(),
      createdAt: new Date().toISOString()
    }));
    nextSettings.secondarySections = secondarySections.concat(entries);
    sections.forEach(section => {
      updateSectionLabelOverride_(section.label, labels);
      applyInventoryColumnSettings_(nextSettings, section.label, columns);
    });
    saveUiSettings(nextSettings);
    return { ok: true, type, added: sections.map(s => ({ label: s.label, key: s.key })) };
  }

  const scanWidth = Math.max(CONFIG.COL.NOTES, 18);
  const lock = getLock_();
  if (lock) lock.waitLock(CONFIG.LOCK_WAIT_MS);
  try {
    insertHomeSectionRows_(sheet, sections, scanWidth, colB, colId);
  } finally {
    if (lock) lock.releaseLock();
  }

  sections.forEach(section => {
    updateSectionLabelOverride_(section.label, labels);
    applyInventoryColumnSettings_(nextSettings, section.label, columns);
    applySectionTypeSetting_(nextSettings, section.label, 'home');
  });

  const { itemTarget, movedBySection, movedIdsBySection, totalBySection } =
    buildItemMovementMaps_(sections, colB, colId);

  if (itemTarget.size) {
    const targetGroups = groupItemTargetsBySection_(itemTarget);
    const moveRes = moveItemsToSectionTargets_(sheet, targetGroups, scanWidth);
    if (moveRes?.duplicateIds?.length) {
      return { ok: false, message: `Duplicate ID(s): ${moveRes.duplicateIds.join(', ')}` };
    }
    if (moveRes?.missingIds?.length) {
      return { ok: false, message: `Missing item ID(s): ${moveRes.missingIds.join(', ')}` };
    }
    if (moveRes?.missingSections?.length) {
      return { ok: false, message: `Missing section(s): ${moveRes.missingSections.join(', ')}` };
    }
    if (moveRes?.ok === false) {
      return { ok: false, message: moveRes.message || 'Move failed.' };
    }
  }

  const toSecondary = [];
  movedBySection.forEach((count, sectionLabel) => {
    const total = totalBySection.get(sectionLabel) || 0;
    if (total && count >= total) {
      toSecondary.push({ label: sectionLabel, itemIds: movedIdsBySection.get(sectionLabel) || [] });
    }
  });

  if (movedIdsBySection.size) {
    const convertedKeys = new Set(toSecondary.map(sec => makeSectionKey_(sec.label)));
    updateShortcutsForMovedItems_(sectionShortcuts, movedIdsBySection, movedBySection, totalBySection, convertedKeys);
    if (Object.keys(sectionShortcuts).length) nextSettings.sectionShortcuts = sectionShortcuts;
    else if (nextSettings.sectionShortcuts) delete nextSettings.sectionShortcuts;
  }

  if (toSecondary.length) {
    convertEmptiedToSecondary_(sheet, toSecondary, nextSettings, secondarySections);
  }

  saveUiSettings(nextSettings);
  return { ok: true, type, added: sections.map(s => ({ label: s.label, key: s.key })), converted: toSecondary.length };
}

function findSectionHeadingRowByCandidates_(sheet, candidates) {
  const { colB, colId, lastRow } = readColBAndId_(sheet);
  if (lastRow < 1) return -1;
  const norms = candidates.map(v => String(v || '').trim()).filter(Boolean).map(norm_);
  for (let i = 0; i < colB.length; i++) {
    if (!isSectionHeading_(colB[i], colId[i])) continue;
    if (norms.some(n => norm_(colB[i]) === n)) return i + 1;
  }
  return -1;
}

function applyLabelOverrideUpdates_(labelOverrides, prevKey, nextKeyNorm, labels) {
  if (prevKey && prevKey !== nextKeyNorm && labelOverrides[prevKey] && !labelOverrides[nextKeyNorm]) {
    labelOverrides[nextKeyNorm] = labelOverrides[prevKey];
    delete labelOverrides[prevKey];
  }
  const fields = ['g', 'h', 'j', 'tab', 'align', 'headingAlign'];
  const hasUpdate = labels && fields.some(f => Object.prototype.hasOwnProperty.call(labels, f));
  if (hasUpdate) {
    const updated = Object.assign({}, labelOverrides[nextKeyNorm] || {});
    const g = String(labels?.g ?? '').trim();
    const h = String(labels?.h ?? '').trim();
    const j = String(labels?.j ?? '').trim();
    const tab = String(labels?.tab ?? '').trim();
    const alignRaw = String(labels?.align ?? labels?.headingAlign ?? '').trim().toLowerCase();
    const align = (alignRaw === 'left' || alignRaw === 'center' || alignRaw === 'right') ? alignRaw : '';
    if (g) updated.g = g; else delete updated.g;
    if (h) updated.h = h; else delete updated.h;
    if (j) updated.j = j; else delete updated.j;
    if (tab) updated.tab = tab; else delete updated.tab;
    if (align) updated.align = align; else delete updated.align;
    if (Object.keys(updated).length) labelOverrides[nextKeyNorm] = updated;
    else delete labelOverrides[nextKeyNorm];
  }
}

function migrateInventoryColumnKey_(uiSettings, prevKey, nextKeyNorm) {
  if (!prevKey || prevKey === nextKeyNorm) return;
  if (!uiSettings.inventoryColumns || typeof uiSettings.inventoryColumns !== 'object') return;
  if (uiSettings.inventoryColumns[prevKey] && !uiSettings.inventoryColumns[nextKeyNorm]) {
    uiSettings.inventoryColumns[nextKeyNorm] = uiSettings.inventoryColumns[prevKey];
  }
  if (uiSettings.inventoryColumns[prevKey]) delete uiSettings.inventoryColumns[prevKey];
}

function convertSecondaryToHome_(secondarySections, idx, uiSettings, nextLabel, payload, itemIds) {
  const removed = secondarySections.splice(idx, 1)[0];
  uiSettings.secondarySections = secondarySections;
  saveUiSettings(uiSettings);
  const res = addSection({
    type: 'home',
    label: nextLabel,
    labels: payload?.labels || {},
    columns: payload?.columns || {},
    itemIds
  });
  if (!res || !res.ok) {
    secondarySections.splice(idx, 0, removed);
    uiSettings.secondarySections = secondarySections;
    saveUiSettings(uiSettings);
    return res;
  }
  let row = null;
  const sheet = getSpreadsheet_().getSheetByName(CONFIG.INVENT_SHEET);
  if (sheet) {
    const { colB, colId, lastRow } = readColBAndId_(sheet);
    if (lastRow > 0) {
      const found = findSectionHeaderRow_(colB, colId, nextLabel);
      if (found !== -1) row = found;
    }
  }
  return { ok: true, converted: true, label: nextLabel, row };
}

function updateSecondarySection(payload) {
  const keyRaw = String(payload?.key || '').trim();
  const oldLabel = String(payload?.oldLabel || '').trim();
  const nextRaw = String(payload?.newLabel || '').trim();
  if (!nextRaw) return { ok: false, message: 'Section title is required.' };
  const nextLabel = nextRaw.toUpperCase();
  const nextKey = makeSectionKey_(nextLabel);
  const type = String(payload?.type || 'secondary').toLowerCase() === 'home' ? 'home' : 'secondary';

  const uiSettings = getUiSettings_();
  const secondarySections = getSecondarySectionsFromSettings_(uiSettings);
  const targetNorm = norm_(keyRaw || oldLabel || nextLabel);
  let idx = secondarySections.findIndex(s => norm_(s.key || s.label || s.heading || '') === targetNorm);
  if (idx === -1) {
    const ss = getSpreadsheet_();
    const sheet = ss.getSheetByName(CONFIG.INVENT_SHEET);
    if (sheet) {
      const row = findSectionHeadingRowByCandidates_(sheet, [oldLabel, nextLabel]);
      if (row !== -1) {
        return renameSectionHeading({
          row, oldLabel, newLabel: nextLabel,
          labels: payload?.labels || {},
          columns: payload?.columns || {},
          type
        });
      }
    }
    secondarySections.push({
      key: nextKey, label: nextLabel, heading: nextLabel,
      type: 'secondary', itemIds: [], createdAt: new Date().toISOString()
    });
    uiSettings.secondarySections = secondarySections;
    idx = secondarySections.length - 1;
  }

  const nextNorm = norm_(nextLabel);
  const existsSecondary = secondarySections.some((s, i) =>
    i !== idx && norm_(s.key || s.label || s.heading || '') === nextNorm
  );
  if (existsSecondary) return { ok: false, message: 'Section already exists.' };

  const ss = getSpreadsheet_();
  const sheet = ss.getSheetByName(CONFIG.INVENT_SHEET);
  if (sectionExistsOnSheet_(sheet, nextLabel)) {
    return { ok: false, message: 'Section already exists.' };
  }

  const entry = Object.assign({}, secondarySections[idx]);
  const prevLabel = String(entry.label || entry.heading || '');
  const itemIds = Array.isArray(entry.itemIds) ? entry.itemIds.slice() : [];

  if (type === 'home') {
    return convertSecondaryToHome_(secondarySections, idx, uiSettings, nextLabel, payload, itemIds);
  }

  const labelOverrides = getSectionLabelOverrides_();
  const prevKey = norm_(oldLabel || prevLabel);
  const nextKeyNorm = norm_(nextLabel);
  applyLabelOverrideUpdates_(labelOverrides, prevKey, nextKeyNorm, payload?.labels);
  saveSectionLabelOverrides_(labelOverrides);

  entry.label = nextLabel;
  entry.key = nextKey;
  entry.heading = nextLabel;
  secondarySections[idx] = entry;
  uiSettings.secondarySections = secondarySections;
  migrateInventoryColumnKey_(uiSettings, prevKey, nextKeyNorm);
  if (Object.prototype.hasOwnProperty.call(payload || {}, 'columns')) {
    applyInventoryColumnSettings_(uiSettings, nextLabel, payload?.columns || {});
  }
  saveUiSettings(uiSettings);
  updateSectionGroupsForRename_(oldLabel || prevLabel || '', nextLabel);
  return { ok: true, label: nextLabel };
}

function addSectionGroup(payload) {
  const nameRaw = String(payload?.name || '').trim();
  if (!nameRaw) return { ok: false, message: 'Group name is required.' };
  const name = nameRaw.toUpperCase();
  const key = normalizeGroupKey_(name);
  if (!key) return { ok: false, message: 'Invalid group name.' };

  const sectionKeys = Array.isArray(payload?.sectionKeys)
    ? payload.sectionKeys.map(k => String(k || '').trim()).filter(Boolean)
    : [];
  const groupKeys = normalizeGroupKeys_(payload?.groupKeys || []);
  const conflicts = getGroupConflicts_(sectionKeys, groupKeys, null);
  if (conflicts.length) {
    return { ok: false, message: `Already grouped: ${conflicts.join(', ')}` };
  }

  const groups = getSectionGroups_();
  if (groups.some(g => norm_(g.key || g.name || '') === norm_(key))) {
    return { ok: false, message: 'Group already exists.' };
  }
  if (groupKeys.some(k => norm_(k) === norm_(key))) {
    return { ok: false, message: 'Group cannot contain itself.' };
  }
  if (groupKeys.length) {
    const known = new Set(groups.map(g => normalizeGroupKey_(g.key || g.name || '')));
    const unknown = groupKeys.filter(k => !known.has(normalizeGroupKey_(k)));
    if (unknown.length) {
      return { ok: false, message: `Unknown group(s): ${unknown.join(', ')}` };
    }
    const map = buildGroupChildrenMap_(groups.concat([{ key, groupKeys }]));
    for (const child of groupKeys) {
      if (hasGroupPath_(map, child, key)) {
        return { ok: false, message: 'Group nesting creates a cycle.' };
      }
    }
  }

  const colorRaw = String(payload?.color || '').trim();
  const alignRaw = String(payload?.headingAlign || '').trim().toLowerCase();
  const headingAlign = (alignRaw === 'left' || alignRaw === 'center' || alignRaw === 'right') ? alignRaw : '';
  const columnsRaw = payload?.columns && typeof payload.columns === 'object' ? payload.columns : null;
  const hideDisabledInputs = Object.prototype.hasOwnProperty.call(payload || {}, 'hideDisabledInputs')
    ? !!payload.hideDisabledInputs
    : null;

  const entry = {
    key,
    name,
    sectionKeys: Array.from(new Set(sectionKeys)),
    createdAt: new Date().toISOString()
  };
  if (groupKeys.length) entry.groupKeys = Array.from(new Set(groupKeys));
  if (colorRaw) entry.color = colorRaw;
  if (headingAlign) entry.headingAlign = headingAlign;
  if (columnsRaw) {
    const cols = {};
    if (columnsRaw.g === false) cols.g = false;
    if (columnsRaw.h === false) cols.h = false;
    if (columnsRaw.j === false) cols.j = false;
    if (Object.keys(cols).length) entry.columns = cols;
  }
  if (hideDisabledInputs !== null) entry.hideDisabledInputs = hideDisabledInputs;
  saveSectionGroups_(groups.concat(entry));
  return { ok: true, group: entry };
}

function updateSectionGroup(payload) {
  const keyRaw = String(payload?.key || '').trim();
  if (!keyRaw) return { ok: false, message: 'Group key is required.' };
  const groups = getSectionGroups_();
  const idx = groups.findIndex(g => norm_(g.key || g.name || '') === norm_(keyRaw));
  if (idx === -1) return { ok: false, message: 'Group not found.' };

  const nextNameRaw = String(payload?.name || '').trim();
  const nextName = nextNameRaw ? nextNameRaw.toUpperCase() : groups[idx].name || '';
  const nextKey = nextNameRaw ? normalizeGroupKey_(nextName) : (groups[idx].key || normalizeGroupKey_(nextName));
  const sectionKeys = Array.isArray(payload?.sectionKeys)
    ? payload.sectionKeys.map(k => String(k || '').trim()).filter(Boolean)
    : (Array.isArray(groups[idx].sectionKeys) ? groups[idx].sectionKeys : []);
  const groupKeys = Object.prototype.hasOwnProperty.call(payload || {}, 'groupKeys')
    ? normalizeGroupKeys_(payload.groupKeys || [])
    : normalizeGroupKeys_(groups[idx].groupKeys || []);

  const conflicts = getGroupConflicts_(sectionKeys, groupKeys, groups[idx].key || keyRaw);
  if (conflicts.length) {
    return { ok: false, message: `Already grouped: ${conflicts.join(', ')}` };
  }
  if (groupKeys.some(k => norm_(k) === norm_(nextKey))) {
    return { ok: false, message: 'Group cannot contain itself.' };
  }

  const colorRaw = String(payload?.color || '').trim();
  const alignRaw = String(payload?.headingAlign || '').trim().toLowerCase();
  const headingAlign = (alignRaw === 'left' || alignRaw === 'center' || alignRaw === 'right') ? alignRaw : '';
  const columnsRaw = payload?.columns && typeof payload.columns === 'object' ? payload.columns : null;
  const hasHideOverride = Object.prototype.hasOwnProperty.call(payload || {}, 'hideDisabledInputs');
  const hideDisabledInputs = hasHideOverride ? !!payload.hideDisabledInputs : null;

  const updated = Object.assign({}, groups[idx], {
    key: nextKey,
    name: nextName,
    sectionKeys: Array.from(new Set(sectionKeys))
  });
  if (Object.prototype.hasOwnProperty.call(payload || {}, 'groupKeys')) {
    if (groupKeys.length) updated.groupKeys = Array.from(new Set(groupKeys));
    else delete updated.groupKeys;
  }
  if (Object.prototype.hasOwnProperty.call(payload || {}, 'color')) {
    if (colorRaw) updated.color = colorRaw;
    else delete updated.color;
  }
  if (headingAlign) updated.headingAlign = headingAlign;
  else if (Object.prototype.hasOwnProperty.call(payload || {}, 'headingAlign')) delete updated.headingAlign;
  if (Object.prototype.hasOwnProperty.call(payload || {}, 'columns')) {
    const cols = {};
    if (columnsRaw && columnsRaw.g === false) cols.g = false;
    if (columnsRaw && columnsRaw.h === false) cols.h = false;
    if (columnsRaw && columnsRaw.j === false) cols.j = false;
    if (Object.keys(cols).length) updated.columns = cols;
    else delete updated.columns;
  }
  if (hasHideOverride) {
    if (hideDisabledInputs) updated.hideDisabledInputs = true;
    else delete updated.hideDisabledInputs;
  }
  const oldKey = groups[idx].key || keyRaw;
  let nextGroups = groups.map(g => Object.assign({}, g));
  nextGroups[idx] = updated;
  if (oldKey && norm_(oldKey) !== norm_(nextKey)) {
    nextGroups = nextGroups.map(g => {
      const kids = Array.isArray(g.groupKeys) ? g.groupKeys.slice() : [];
      const nextKids = kids.map(k => (norm_(k) === norm_(oldKey) ? nextKey : k));
      if (nextKids.some((k, i) => k !== kids[i])) return Object.assign({}, g, { groupKeys: nextKids });
      return g;
    });
  }
  if (groupKeys.length) {
    const known = new Set(nextGroups.map(g => normalizeGroupKey_(g.key || g.name || '')));
    const unknown = groupKeys.filter(k => !known.has(normalizeGroupKey_(k)));
    if (unknown.length) {
      return { ok: false, message: `Unknown group(s): ${unknown.join(', ')}` };
    }
    const map = buildGroupChildrenMap_(nextGroups);
    for (const child of groupKeys) {
      if (hasGroupPath_(map, child, nextKey)) {
        return { ok: false, message: 'Group nesting creates a cycle.' };
      }
    }
  }
  groups.length = 0;
  nextGroups.forEach(g => groups.push(g));
  saveSectionGroups_(groups);
  return { ok: true, group: updated, groups };
}

function setGroupSectionTypes(payload) {
  const groupKeyRaw = String(payload?.groupKey || '').trim();
  if (!groupKeyRaw) return { ok: false, message: 'Group key is required.' };
  const type = String(payload?.type || '').toLowerCase() === 'secondary' ? 'secondary' : 'home';

  const groups = getSectionGroups_();
  const group = groups.find(g => norm_(g.key || g.name || '') === norm_(groupKeyRaw));
  if (!group) return { ok: false, message: 'Group not found.' };

  const keysRaw = Array.isArray(group.sectionKeys) ? group.sectionKeys : [];
  const keys = Array.from(new Set(keysRaw.map(k => makeSectionKey_(k)).filter(Boolean)));
  if (!keys.length) return { ok: false, message: 'Group has no sections.' };

  const ss = getSpreadsheet_();
  const sheet = ss.getSheetByName(CONFIG.INVENT_SHEET);
  if (!sheet) throw new Error(`Missing sheet: ${CONFIG.INVENT_SHEET}`);

  const lastRow = sheet.getLastRow();
  if (lastRow < 1) return { ok: false, message: 'No rows to update.' };

  const colB = sheet.getRange(1, CONFIG.COL.COMMON_NAME, lastRow, 1)
    .getDisplayValues()
    .map(r => String(r[0] || '').trim());
  const colId = sheet.getRange(1, CONFIG.COL.ID, lastRow, 1)
    .getDisplayValues()
    .map(r => String(r[0] || '').trim());

  const headerMap = new Map();
  for (let i = 0; i < colB.length; i++) {
    if (sheet.isRowHiddenByUser(i + 1)) continue;
    if (!isSectionHeading_(colB[i], colId[i])) continue;
    const label = String(colB[i] || '').trim();
    const key = makeSectionKey_(label);
    if (key) headerMap.set(key, label);
  }

  const uiSettings = getUiSettings_();
  const updatedKeys = [];
  const skippedKeys = [];

  keys.forEach(key => {
    const label = headerMap.get(key);
    if (!label) {
      skippedKeys.push(key);
      return;
    }
    if (applySectionTypeSetting_(uiSettings, label, type)) updatedKeys.push(key);
  });

  saveUiSettings(uiSettings);
  return { ok: true, type, updatedKeys, skippedKeys };
}

function deleteSectionGroup(payload) {
  const keyRaw = String(payload?.key || '').trim();
  if (!keyRaw) return { ok: false, message: 'Group key is required.' };
  const groups = getSectionGroups_();
  let next = groups.filter(g => norm_(g.key || g.name || '') !== norm_(keyRaw));
  if (next.length === groups.length) return { ok: false, message: 'Group not found.' };
  const keyNorm = norm_(keyRaw);
  next = next.map(g => {
    const kids = Array.isArray(g.groupKeys) ? g.groupKeys : [];
    const filtered = kids.filter(k => norm_(k) !== keyNorm);
    return (filtered.length !== kids.length) ? Object.assign({}, g, { groupKeys: filtered }) : g;
  });
  saveSectionGroups_(next);
  return { ok: true, groups: next };
}

function setSectionGroupMembership(payload) {
  const sectionKey = String(payload?.sectionKey || '').trim();
  if (!sectionKey) return { ok: false, message: 'Section key is required.' };
  const groupKeyRaw = String(payload?.groupKey || '').trim();
  const groupKey = groupKeyRaw ? normalizeGroupKey_(groupKeyRaw) : '';

  const groups = getSectionGroups_();
  let changed = false;

  const next = groups.map(g => {
    const keys = Array.isArray(g.sectionKeys) ? g.sectionKeys.slice() : [];
    const filtered = keys.filter(k => norm_(k) !== norm_(sectionKey));
    if (filtered.length !== keys.length) changed = true;
    return (filtered.length !== keys.length) ? Object.assign({}, g, { sectionKeys: filtered }) : g;
  });

  if (groupKey) {
    const idx = next.findIndex(g => norm_(g.key || g.name || '') === norm_(groupKey));
    if (idx === -1) return { ok: false, message: 'Group not found.' };
    const keys = Array.isArray(next[idx].sectionKeys) ? next[idx].sectionKeys.slice() : [];
    if (!keys.some(k => norm_(k) === norm_(sectionKey))) {
      keys.push(sectionKey);
      next[idx] = Object.assign({}, next[idx], { sectionKeys: keys });
      changed = true;
    }
  }

  if (changed) saveSectionGroups_(next);
  return { ok: true, groups: next };
}

function setGroupSectionMemberships(payload) {
  const groupKeyRaw = String(payload?.groupKey || '').trim();
  if (!groupKeyRaw) return { ok: false, message: 'Group key is required.' };
  const groupKey = normalizeGroupKey_(groupKeyRaw);
  const sectionKeys = Array.isArray(payload?.sectionKeys)
    ? payload.sectionKeys.map(k => String(k || '').trim()).filter(Boolean)
    : [];
  if (!sectionKeys.length) return { ok: true, groups: getSectionGroups_() };

  const groups = getSectionGroups_();
  const idx = groups.findIndex(g => norm_(g.key || g.name || '') === norm_(groupKey));
  if (idx === -1) return { ok: false, message: 'Group not found.' };

  const targets = new Set(sectionKeys.map(k => norm_(k)));
  let changed = false;

  const next = groups.map(g => {
    const keys = Array.isArray(g.sectionKeys) ? g.sectionKeys.slice() : [];
    const filtered = keys.filter(k => !targets.has(norm_(k)));
    if (filtered.length !== keys.length) changed = true;
    return (filtered.length !== keys.length) ? Object.assign({}, g, { sectionKeys: filtered }) : g;
  });

  const current = next[idx];
  const existing = Array.isArray(current.sectionKeys) ? current.sectionKeys.slice() : [];
  const existingSet = new Set(existing.map(k => norm_(k)));
  sectionKeys.forEach(key => {
    if (!existingSet.has(norm_(key))) {
      existing.push(key);
      existingSet.add(norm_(key));
    }
  });
  if (existing.length !== (current.sectionKeys || []).length) {
    next[idx] = Object.assign({}, current, { sectionKeys: existing });
    changed = true;
  }

  if (changed) saveSectionGroups_(next);
  return { ok: true, groups: next };
}

function setGroupParent(payload) {
  const childKeyRaw = String(payload?.groupKey || '').trim();
  const parentKeyRaw = String(payload?.parentKey || '').trim();
  const childKey = normalizeGroupKey_(childKeyRaw);
  const parentKey = parentKeyRaw ? normalizeGroupKey_(parentKeyRaw) : '';
  if (!childKey) return { ok: false, message: 'Group key is required.' };
  if (parentKey && norm_(parentKey) === norm_(childKey)) {
    return { ok: false, message: 'Group cannot be its own parent.' };
  }

  const groups = getSectionGroups_();
  const childExists = groups.some(g => normalizeGroupKey_(g.key || g.name || '') === childKey);
  if (!childExists) return { ok: false, message: 'Group not found.' };
  if (parentKey) {
    const parentExists = groups.some(g => normalizeGroupKey_(g.key || g.name || '') === parentKey);
    if (!parentExists) return { ok: false, message: 'Parent group not found.' };
  }

  let next = groups.map(g => Object.assign({}, g));
  next = next.map(g => {
    const keys = Array.isArray(g.groupKeys) ? g.groupKeys.slice() : [];
    const filtered = keys.filter(k => normalizeGroupKey_(k) !== childKey);
    return (filtered.length !== keys.length) ? Object.assign({}, g, { groupKeys: filtered }) : g;
  });

  if (parentKey) {
    const idx = next.findIndex(g => normalizeGroupKey_(g.key || g.name || '') === parentKey);
    const keys = Array.isArray(next[idx].groupKeys) ? next[idx].groupKeys.slice() : [];
    if (!keys.some(k => normalizeGroupKey_(k) === childKey)) {
      keys.push(childKey);
      next[idx] = Object.assign({}, next[idx], { groupKeys: keys });
    }
    // A cycle exists only if the parent is already a descendant of the child,
    // i.e. the child can already reach the parent. Check that direction —
    // checking parent->child would be trivially true since we just added that edge.
    const map = buildGroupChildrenMap_(next);
    if (hasGroupPath_(map, childKey, parentKey)) {
      return { ok: false, message: 'Group nesting creates a cycle.' };
    }
  }

  saveSectionGroups_(next);
  return { ok: true, groups: next };
}

function sanitizeSheetName_(name) {
  let out = String(name || '').trim();
  out = out.replace(/[\[\]\:\*\?\/\\]/g, '');
  if (!out) out = 'NEW DISTRIBUTOR';
  return out.slice(0, 100);
}

function getTableBlocksFromSheet_(sheet) {
  const blocks = [];
  if (!sheet || typeof sheet.getTables !== 'function') return blocks;
  const tables = sheet.getTables() || [];
  tables.forEach(t => {
    try {
      const range = t.getRange();
      if (!range) return;
      blocks.push({
        a1: range.getA1Notation(),
        tableId: (typeof t.getId === 'function') ? t.getId() : null,
        name: (typeof t.getName === 'function') ? t.getName() : '',
        startRow: range.getRow(),
        startCol: range.getColumn(),
        numRows: range.getNumRows(),
        numCols: range.getNumColumns()
      });
    } catch (e) { console.error(e); }
  });
  blocks.sort((a, b) => a.startRow - b.startRow);
  return blocks;
}

function getDefaultOrderingBlocksForSheet_(sheet, lookupName) {
  const out = [];
  if (!sheet) return out;
  // Match ORDERING_TABLES by the template/origin name, not the (possibly
  // renamed) copy — a new distributor's sheet is named after the distributor,
  // so its own name never matches a built-in template like SOUTHERN.
  const name = norm_(lookupName || sheet.getName());
  Object.keys(ORDERING_TABLES || {}).forEach(letter => {
    const def = ORDERING_TABLES[letter];
    if (!def || norm_(def.sheet) !== name || !def.a1) return;
    const range = sheet.getRange(def.a1);
    out.push({
      a1: def.a1,
      tableId: def.tableId || null,
      name: def.name || '',
      startRow: range.getRow(),
      startCol: range.getColumn(),
      numRows: range.getNumRows(),
      numCols: range.getNumColumns()
    });
  });
  out.sort((a, b) => a.startRow - b.startRow);
  return out;
}

function cloneTableBlocks_(sheet, blocks, targetCount) {
  const out = blocks.slice();
  const gap = 1;
  while (out.length < targetCount) {
    const last = out[out.length - 1];
    if (!last) break;
    const startCol = last.startCol;
    const numRows = last.numRows;
    const numCols = last.numCols;
    const endRow = last.startRow + numRows - 1;
    sheet.insertRowsAfter(endRow, gap + numRows);
    const newStartRow = endRow + gap + 1;
    const src = sheet.getRange(last.startRow, startCol, numRows, numCols);
    const dst = sheet.getRange(newStartRow, startCol, numRows, numCols);
    src.copyTo(dst, { contentsOnly: false });
    out.push({
      a1: dst.getA1Notation(),
      tableId: null,
      name: last.name || '',
      startRow: newStartRow,
      startCol,
      numRows,
      numCols
    });
  }
  return out;
}

function createDistributor(payload) {
  const nameRaw = String(payload?.name || '').trim();
  if (!nameRaw) return { ok: false, message: 'Distributor name is required.' };

  const key = normalizeDistributorKey_(nameRaw);
  const uiSettings = getUiSettings_();
  const distributors = getDistributorsFromSettings_(uiSettings);
  if (distributors.some(d => norm_(d.key || d.name || '') === key)) {
    return { ok: false, message: 'Distributor already exists.' };
  }
  if (CONFIG.VENDORS.some(v => norm_(v) === key)) {
    return { ok: false, message: 'Distributor name conflicts with an existing vendor.' };
  }

  const tableCount = Math.max(1, Math.min(10, parseInt(payload?.tableCount, 10) || 0));
  if (!tableCount) return { ok: false, message: 'Table count is required.' };

  const ss = getSpreadsheet_();
  const templateName = String(payload?.templateSheet || uiSettings?.orderGuideTemplate || 'RNDC').trim();
  // Resolve exact first, then fall back to the app's normalized matching so a
  // casing/whitespace difference between the dropdown value and the real tab
  // name doesn't fail the create.
  let templateSheet = ss.getSheetByName(templateName) || findSheetByNormalizedName_(ss, templateName);
  if (!templateSheet) {
    const available = ss.getSheets().map(s => s.getName()).join(', ');
    return { ok: false, message: `Template sheet "${templateName}" not found. Available sheets: ${available}` };
  }

  const sheetName = sanitizeSheetName_(payload?.sheetName || nameRaw);
  if (ss.getSheetByName(sheetName)) {
    return { ok: false, message: `Sheet "${sheetName}" already exists.` };
  }

  const newSheet = templateSheet.copyTo(ss).setName(sheetName);
  newSheet.showSheet();

  let blocks = getTableBlocksFromSheet_(newSheet);
  if (!blocks.length) blocks = getDefaultOrderingBlocksForSheet_(newSheet, templateSheet.getName());
  if (!blocks.length) return { ok: false, message: `No tables found on template sheet "${templateSheet.getName()}". Pick a template whose order-guide layout is known, or use a sheet that has a defined table range.` };

  if (blocks.length < tableCount) {
    blocks = cloneTableBlocks_(newSheet, blocks, tableCount);
  }

  const tableCats = Array.isArray(payload?.tableCategories) ? payload.tableCategories : [];
  const tables = [];
  for (let i = 0; i < tableCount; i++) {
    const block = blocks[i];
    if (!block) break;
    const cats = Array.isArray(tableCats[i]) ? tableCats[i] : [];
    tables.push({
      index: i + 1,
      name: `TABLE ${i + 1}`,
      a1: block.a1,
      tableId: block.tableId || null,
      categories: cats.map(c => String(c || '').trim()).filter(Boolean)
    });
  }

  const orderDays = payload?.orderDays && typeof payload.orderDays === 'object' ? payload.orderDays : {};

  const entry = {
    key,
    name: nameRaw,
    repName: String(payload?.repName || '').trim(),
    repPhone: String(payload?.repPhone || '').trim(),
    repEmail: String(payload?.repEmail || '').trim(),
    orderDays,
    sheetName,
    templateSheet: templateName,
    tableCount,
    tables
  };

  const nextSettings = uiSettings && typeof uiSettings === 'object' ? uiSettings : {};
  nextSettings.distributors = distributors.concat(entry);
  const updatedList = ensureDistributorRefs_(nextSettings.distributors, nextSettings);
  nextSettings.distributors = updatedList;
  saveUiSettings(nextSettings);
  syncDistroDataSheetAndClear_(updatedList, nextSettings);

  const saved = updatedList.find(d => norm_(d.key || d.name || '') === key) || entry;
  return { ok: true, distributor: saved };
}

function updateVendorNameInInventory_(oldName, newName) {
  const oldKey = norm_(oldName);
  const newVal = String(newName || '').trim();
  if (!oldKey || !newVal || norm_(newVal) === oldKey) return;
  const ss = getSpreadsheet_();
  const sheet = ss.getSheetByName(CONFIG.INVENT_SHEET);
  if (!sheet) return;
  const lastRow = sheet.getLastRow();
  if (lastRow < 1) return;
  const col = CONFIG.COL.VENDOR;
  const values = sheet.getRange(1, col, lastRow, 1).getDisplayValues();
  for (let r = 0; r < values.length; r++) {
    const val = String(values[r][0] || '').trim();
    if (!val) continue;
    if (norm_(val) === oldKey) sheet.getRange(r + 1, col).setValue(newVal);
  }
}

function updateDistributor(payload) {
  const keyRaw = String(payload?.key || payload?.ref || payload?.name || '').trim();
  if (!keyRaw) return { ok: false, message: 'Distributor key is required.' };

  const uiSettings = getUiSettings_();
  const distributors = getDistributorsFromSettings_(uiSettings);
  const idx = distributors.findIndex(d => (
    norm_(d.key || '') === norm_(keyRaw) ||
    norm_(d.name || '') === norm_(keyRaw) ||
    norm_(d.ref || '') === norm_(keyRaw)
  ));
  if (idx === -1) return { ok: false, message: 'Distributor not found.' };

  const current = distributors[idx];
  const nameRaw = String(payload?.name || '').trim();
  const name = nameRaw ? nameRaw : String(current.name || '').trim();
  const key = normalizeDistributorKey_(name || current.name || '');

  if (nameRaw) {
    if (distributors.some((d, i) => i !== idx && norm_(d.key || d.name || '') === norm_(key))) {
      return { ok: false, message: 'Distributor name conflicts with an existing distributor.' };
    }
    if (CONFIG.VENDORS.some(v => norm_(v) === key)) {
      return { ok: false, message: 'Distributor name conflicts with an existing vendor.' };
    }
  }

  const sheetNameRaw = String(payload?.sheetName || '').trim();
  let sheetName = sheetNameRaw || String(current.sheetName || '').trim() || sanitizeSheetName_(name);
  const templateSheet = String(payload?.templateSheet || current.templateSheet || '').trim();
  const tableCount = Math.max(1, Math.min(10, parseInt(payload?.tableCount, 10) || current.tableCount || (current.tables || []).length || 1));
  const orderDays = payload?.orderDays && typeof payload.orderDays === 'object' ? payload.orderDays : (current.orderDays || {});
  // Use the payload value whenever the field is present (even ''), so a user can
  // clear a previously stored value; otherwise keep the current value.
  const hasField_ = (k) => Object.prototype.hasOwnProperty.call(payload || {}, k);
  const repName = String((hasField_('repName') ? payload.repName : current.repName) || '').trim();
  const repPhone = String((hasField_('repPhone') ? payload.repPhone : current.repPhone) || '').trim();
  const repEmail = String((hasField_('repEmail') ? payload.repEmail : current.repEmail) || '').trim();

  const ss = getSpreadsheet_();
  const lock = getLock_();
  if (lock) lock.waitLock(CONFIG.LOCK_WAIT_MS);

  try {
    let sheet = ss.getSheetByName(String(current.sheetName || '').trim());
    if (!sheet) sheet = ss.getSheetByName(sheetName);
    if (!sheet) {
      const match = findSheetByNormalizedName_(ss, sheetName);
      if (match) {
        sheet = match;
        sheetName = match.getName();
      }
    }
    if (!sheet) return { ok: false, message: `Sheet "${sheetName}" not found.` };
    if (sheet.getName() !== sheetName) {
      if (ss.getSheetByName(sheetName)) return { ok: false, message: `Sheet "${sheetName}" already exists.` };
      sheet.setName(sheetName);
    }

    let blocks = getTableBlocksFromSheet_(sheet);
    if (!blocks.length) blocks = getDefaultOrderingBlocksForSheet_(sheet, current.templateSheet || templateSheet || sheet.getName());
    // Last resort: reuse the table ranges already stored for this distributor.
    if (!blocks.length && Array.isArray(current.tables) && current.tables.length) {
      blocks = current.tables
        .filter(t => t && t.a1)
        .map(t => {
          const range = sheet.getRange(t.a1);
          return {
            a1: t.a1,
            tableId: t.tableId || null,
            name: t.name || '',
            startRow: range.getRow(),
            startCol: range.getColumn(),
            numRows: range.getNumRows(),
            numCols: range.getNumColumns()
          };
        });
    }
    if (!blocks.length) return { ok: false, message: 'No tables found on distributor sheet.' };
    if (blocks.length < tableCount) blocks = cloneTableBlocks_(sheet, blocks, tableCount);

    const providedCats = Array.isArray(payload?.tableCategories) ? payload.tableCategories : null;
    const tables = [];
    for (let i = 0; i < tableCount; i++) {
      const block = blocks[i];
      if (!block) break;
      const fallback = (current.tables && current.tables[i]) ? current.tables[i].categories : [];
      const cats = Array.isArray(providedCats ? providedCats[i] : fallback) ? (providedCats ? providedCats[i] : fallback) : [];
      tables.push({
        index: i + 1,
        name: `TABLE ${i + 1}`,
        a1: block.a1,
        tableId: block.tableId || null,
        categories: cats.map(c => String(c || '').trim()).filter(Boolean)
      });
    }

    const updated = Object.assign({}, current, {
      key,
      name,
      sheetName,
      templateSheet,
      tableCount,
      tables,
      orderDays,
      repName,
      repPhone,
      repEmail
    });

    if (nameRaw && norm_(current.name || '') !== norm_(name)) {
      updateVendorNameInInventory_(current.name, name);
    }

    distributors[idx] = updated;
    const nextSettings = uiSettings && typeof uiSettings === 'object' ? uiSettings : {};
    nextSettings.distributors = distributors;
    const updatedList = ensureDistributorRefs_(distributors, nextSettings);
    nextSettings.distributors = updatedList;
    saveUiSettings(nextSettings);
    syncDistroDataSheetAndClear_(updatedList, nextSettings);
    resyncOrderingForDistributor_(name);

    const saved = updatedList.find(d => norm_(d.key || d.name || '') === norm_(key)) || updated;
    return { ok: true, distributor: saved };
  } finally {
    if (lock) lock.releaseLock();
  }
}

function deleteDistributor(payload) {
  const keyRaw = String(payload?.key || payload?.ref || payload?.name || '').trim();
  if (!keyRaw) return { ok: false, message: 'Distributor key is required.' };
  const uiSettings = getUiSettings_();
  const distributors = getDistributorsFromSettings_(uiSettings);
  const next = [];
  let removed = null;
  distributors.forEach(d => {
    const matches = (
      norm_(d.key || '') === norm_(keyRaw) ||
      norm_(d.name || '') === norm_(keyRaw) ||
      norm_(d.ref || '') === norm_(keyRaw)
    );
    if (!matches) next.push(d);
    else removed = d;
  });
  if (!removed) return { ok: false, message: 'Distributor not found.' };
  const nextSettings = uiSettings && typeof uiSettings === 'object' ? uiSettings : {};
  nextSettings.distributors = next;
  saveUiSettings(nextSettings);
  syncDistroDataSheetAndClear_(next, nextSettings);
  return { ok: true, removed };
}

function findTemplateRowInSection_(sheet, headerRow, nextHeaderRow, newRow) {
  // Batch read: fetch ID and name columns for the section range once
  const count = Math.max(nextHeaderRow - headerRow, 1);
  const ids = sheet.getRange(headerRow, CONFIG.COL.ID, count, 1).getDisplayValues();
  const names = sheet.getRange(headerRow, CONFIG.COL.COMMON_NAME, count, 1).getDisplayValues();

  // Search backwards from newRow
  for (let r = newRow - 1; r > headerRow; r--) {
    const idx = r - headerRow;
    if (idx < 0 || idx >= count) continue;
    const id = String(ids[idx][0] || '').trim();
    const nm = String(names[idx][0] || '').trim();
    if (id && nm) return r;
  }
  // Search forwards from headerRow
  for (let r = headerRow + 1; r < nextHeaderRow; r++) {
    const idx = r - headerRow;
    if (idx < 0 || idx >= count) continue;
    const id = String(ids[idx][0] || '').trim();
    const nm = String(names[idx][0] || '').trim();
    if (id && nm) return r;
  }
  return null;
}

function addInventItem(payload) {
  assertAuthorized_();
  const ss = getSpreadsheet_();
  const sheet = ss.getSheetByName(CONFIG.INVENT_SHEET);
  if (!sheet) throw new Error(`Missing sheet: ${CONFIG.INVENT_SHEET}`);

  const lock = getLock_();
  if (lock) lock.waitLock(CONFIG.LOCK_WAIT_MS);

  try {
    const section = String(payload.section || '').trim();
    if (!section) return { ok: false, message: 'Section is required.' };

    const commonName = String(payload.commonName || '').trim().toUpperCase();
    if (!commonName) return { ok: false, message: 'COMMON NAME is required.' };

    const orderName  = String(payload.orderName  || '').trim().toUpperCase();
    const bottleSize = String(payload.bottleSize || '').trim();
    const par        = String(payload.par || '').trim();

    const vendor     = String(payload.vendor || '').trim();
    const categoryN  = String(payload.categoryN || '').trim();

    const cost  = String(payload.cost || '').trim();
    const csSize= String(payload.csSize || '').trim();
    const notes = String(payload.notes || '').trim();

    const lastRow = sheet.getLastRow();
    const scanWidth = Math.max(CONFIG.COL.NOTES, 18);

    const colB = sheet.getRange(1, CONFIG.COL.COMMON_NAME, lastRow, 1).getDisplayValues()
      .map(r => String(r[0] || '').trim());
    const colId = sheet.getRange(1, CONFIG.COL.ID, lastRow, 1).getDisplayValues()
      .map(r => String(r[0] || '').trim());

    const sectionNorm = norm_(section);

    let headerRow = -1;
    for (let i = 0; i < colB.length; i++) {
      if (norm_(colB[i]) === sectionNorm && isSectionHeading_(colB[i], colId[i])) { headerRow = i + 1; break; }
    }
    if (headerRow === -1) return { ok: false, message: `Could not find section heading "${section}" in column B.` };

    let nextHeaderRow = lastRow + 1;
    for (let r = headerRow + 1; r <= lastRow; r++) {
      if (isSectionHeading_(colB[r - 1], colId[r - 1])) { nextHeaderRow = r; break; }
    }

    let insertAfter = headerRow;
    for (let r = headerRow + 1; r < nextHeaderRow; r++) {
      const rowVals = sheet.getRange(r, 1, 1, scanWidth).getDisplayValues()[0];
      const anyText = rowVals.some(v => String(v || '').trim() !== '');
      if (anyText) insertAfter = r;
    }

    sheet.insertRowAfter(insertAfter);
    const newRow = insertAfter + 1;

    const idVals = sheet.getRange(1, CONFIG.COL.ID, sheet.getLastRow(), 1).getDisplayValues()
      .map(r => String(r[0] || '').trim()).filter(Boolean);

    // Monotonic IDs that are never recycled: deleting an item must not free its
    // ID for reuse, or a stale in-flight edit could land on a different product.
    // A persistent counter advances past deleted IDs; it self-seeds from the
    // current max, so no migration is needed and manual sheet edits stay safe.
    const used = new Set(idVals.filter(v => /^\d+$/.test(v)).map(v => parseInt(v, 10)));
    let maxExisting = 0;
    used.forEach(n => { if (n > maxExisting) maxExisting = n; });
    const idProps = PropertiesService.getScriptProperties();
    const storedNext = parseInt(idProps.getProperty('NEXT_ITEM_ID') || '0', 10) || 0;
    let nextId = Math.max(maxExisting + 1, storedNext);
    while (used.has(nextId)) nextId++;
    idProps.setProperty('NEXT_ITEM_ID', String(nextId + 1));

    const templateRow = findTemplateRowInSection_(sheet, headerRow, nextHeaderRow, newRow);
    if (templateRow) {
      sheet.getRange(templateRow, 1, 1, scanWidth)
        .copyTo(sheet.getRange(newRow, 1, 1, scanWidth), { contentsOnly: false });
    }

    // Batch write: read row into memory, set all values, write back once
    const newRowRange = sheet.getRange(newRow, 1, 1, scanWidth);
    const rowValues = newRowRange.getDisplayValues()[0].slice();
    rowValues[CONFIG.COL.COMMON_NAME - 1] = commonName;
    rowValues[CONFIG.COL.ORDER_NAME - 1] = orderName;
    rowValues[CONFIG.COL.BOTTLE_SIZE - 1] = bottleSize;
    rowValues[CONFIG.COL.PAR - 1] = par;
    rowValues[CONFIG.COL.ID - 1] = String(nextId);
    rowValues[CONFIG.COL.CATEGORY - 1] = categoryN;
    rowValues[CONFIG.COL.VENDOR - 1] = vendor;
    rowValues[CONFIG.COL.COST - 1] = cost;
    rowValues[CONFIG.COL.CS_SIZE - 1] = csSize;
    rowValues[CONFIG.COL.NOTES - 1] = notes;
    rowValues[CONFIG.COL.G - 1] = '';
    rowValues[CONFIG.COL.H - 1] = '';
    rowValues[CONFIG.COL.J - 1] = '';
    newRowRange.setValues([rowValues]);

    sheet.getRange(newRow, CONFIG.COL.I)
      .setFormula(`=IFERROR(${colLetter_(CONFIG.COL.G)}${newRow}+${colLetter_(CONFIG.COL.H)}${newRow},"")`);

    const refRow = findFormatReferenceRow_(sheet);
    if (refRow) {
      copyFormatBlock_(sheet, refRow, newRow, CONFIG.COL.COMMON_NAME, CONFIG.COL.PAR); // B:E
      copyFormatBlock_(sheet, refRow, newRow, CONFIG.COL.ID, CONFIG.COL.VENDOR);      // M:O
      copyFormatBlock_(sheet, refRow, newRow, CONFIG.COL.COST, CONFIG.COL.NOTES);     // P:R
    }

    let orderingResult = null;
    const orderingTarget = resolveOrderingTargetTable_(vendor, categoryN);
    if (!orderingTarget.ok) {
      orderingResult = orderingTarget;
    } else {
      orderingResult = insertIntoOrderingTableByKey_(orderingTarget.tableKey, nextId);
    }

    // Batch read: single call for both values and backgrounds
    const finalRange = sheet.getRange(newRow, 1, 1, scanWidth);
    const finalValues = finalRange.getDisplayValues()[0];
    const rowBgs = finalRange.getBackgrounds()[0];
    const editable = {
      g: !isDarkLockedBg_(rowBgs[CONFIG.COL.G - 1]),
      h: !isDarkLockedBg_(rowBgs[CONFIG.COL.H - 1]),
      j: !isDarkLockedBg_(rowBgs[CONFIG.COL.J - 1])
    };

    const item = {
      type: 'item',
      section,
      id: String(nextId),
      b: String(finalValues[CONFIG.COL.COMMON_NAME - 1] || '').trim(),
      orderName: String(finalValues[CONFIG.COL.ORDER_NAME - 1] || '').trim(),
      bottleSize: String(finalValues[CONFIG.COL.BOTTLE_SIZE - 1] || '').trim(),
      par: String(finalValues[CONFIG.COL.PAR - 1] || '').trim(),
      categoryN: String(finalValues[CONFIG.COL.CATEGORY - 1] || '').trim(),
      vendor: String(finalValues[CONFIG.COL.VENDOR - 1] || '').trim(),
      cost: String(finalValues[CONFIG.COL.COST - 1] || '').trim(),
      csSize: String(finalValues[CONFIG.COL.CS_SIZE - 1] || '').trim(),
      notes: String(finalValues[CONFIG.COL.NOTES - 1] || '').trim(),
      o: String(finalValues[CONFIG.COL.VENDOR - 1] || '').trim(),
      g: String(finalValues[CONFIG.COL.G - 1] ?? ''),
      h: String(finalValues[CONFIG.COL.H - 1] ?? ''),
      j: String(finalValues[CONFIG.COL.J - 1] ?? ''),
      editable
    };

    return { ok: true, id: String(nextId), row: newRow, ordering: orderingResult, item };
  } finally {
    if (lock) lock.releaseLock();
  }
}

/** Set of archived item IDs (input disabled in the UI, excluded from order guides). */
function getArchivedItemIds_() {
  const ui = getUiSettings_();
  const list = (ui && Array.isArray(ui.archivedItemIds)) ? ui.archivedItemIds : [];
  return new Set(list.map(v => String(v || '').trim()).filter(Boolean));
}

/**
 * Archive or unarchive an item. Archiving records the ID in settings and removes
 * the item from its distributor order guide(s); unarchiving clears the flag and
 * re-adds it to the correct order-guide table (vendor/categoryN supplied by the
 * client). The item's INVENT row is never touched.
 */
function setItemArchived(payload) {
  const id = String(payload?.id || '').trim();
  if (!id) return { ok: false, message: 'Item ID is required.' };
  const archived = !!payload?.archived;

  const uiSettings = getUiSettings_();
  const set = new Set(
    (Array.isArray(uiSettings.archivedItemIds) ? uiSettings.archivedItemIds : [])
      .map(v => String(v || '').trim()).filter(Boolean)
  );
  if (archived) set.add(id); else set.delete(id);
  uiSettings.archivedItemIds = Array.from(set);
  saveUiSettings(uiSettings);

  const ss = getSpreadsheet_();
  if (archived) {
    const rows = findOrderingRowsForId_(ss, id);
    if (rows.length) removeOrderingRows_(rows);
    return { ok: true, archived: true, archivedItemIds: uiSettings.archivedItemIds, removedFromOrder: rows.length };
  }
  // Unarchive: the ID is already out of the archived set above, so the sync
  // guard won't block re-adding it to its order-guide table.
  const sync = syncOrderingForItem_(id, String(payload?.vendor || '').trim(), String(payload?.categoryN || '').trim(), { touch: false });
  return { ok: true, archived: false, archivedItemIds: uiSettings.archivedItemIds, sync };
}

function deleteInventItem(payload) {
  assertAuthorized_();
  const ss = getSpreadsheet_();
  const sheet = ss.getSheetByName(CONFIG.INVENT_SHEET);
  if (!sheet) throw new Error(`Missing sheet: ${CONFIG.INVENT_SHEET}`);

  const id = String(payload?.id || '').trim();
  if (!id) throw new Error('Item ID is required.');

  const lock = getLock_();
  if (lock) lock.waitLock(CONFIG.LOCK_WAIT_MS);

  try {
    const lastRow = sheet.getLastRow();
    if (lastRow < 1) return { missingIds: [id] };

    const idCol = sheet.getRange(1, CONFIG.COL.ID, lastRow, 1).getDisplayValues();
    let row = -1;
    for (let r = 0; r < idCol.length; r++) {
      const val = String(idCol[r][0] || '').trim();
      if (val === id) {
        if (row !== -1) return { duplicateIds: [id] };
        row = r + 1;
      }
    }
    if (row === -1) return { missingIds: [id] };

    const orderingRows = findOrderingRowsForId_(ss, id);
    if (orderingRows.length) removeOrderingRows_(orderingRows);

    sheet.deleteRow(row);

    return { ok: true, id, row, orderingDeleted: orderingRows.length };
  } finally {
    if (lock) lock.releaseLock();
  }
}

// Neutral "ALL ITEMS" parking section: where an item's row is moved when it is
// detached from every location group but must still exist (so it keeps showing
// in the BY DISTRIBUTOR / BY BEVERAGE dynamic groups under ALL ITEMS).
const ALL_ITEMS_SECTION_LABEL = 'ALL ITEMS';

function removeInventItemFromHome(payload) {
  assertAuthorized_();
  const id = String(payload?.id || '').trim();
  if (!id) throw new Error('Item ID is required.');

  const ss = getSpreadsheet_();
  const sheet = ss.getSheetByName(CONFIG.INVENT_SHEET);
  if (!sheet) throw new Error(`Missing sheet: ${CONFIG.INVENT_SHEET}`);

  const scanWidth = Math.max(CONFIG.COL.NOTES, 18);
  const lock = getLock_();
  if (lock) lock.waitLock(CONFIG.LOCK_WAIT_MS);

  try {
    const readCols = () => {
      const lastRow = sheet.getLastRow();
      const colB = lastRow ? sheet.getRange(1, CONFIG.COL.COMMON_NAME, lastRow, 1).getDisplayValues().map(r => String(r[0] || '').trim()) : [];
      const colId = lastRow ? sheet.getRange(1, CONFIG.COL.ID, lastRow, 1).getDisplayValues().map(r => String(r[0] || '').trim()) : [];
      return { colB, colId };
    };

    let { colB, colId } = readCols();

    // Ensure the neutral parking section exists.
    if (findSectionHeaderRow_(colB, colId, ALL_ITEMS_SECTION_LABEL) === -1) {
      insertHomeSectionRows_(sheet, [{ label: ALL_ITEMS_SECTION_LABEL }], scanWidth, colB, colId);
      ({ colB, colId } = readCols());
    }

    // Locate the item row by ID.
    let row = -1;
    for (let r = 0; r < colId.length; r++) {
      if (colId[r] === id) {
        if (row !== -1) return { duplicateIds: [id] };
        row = r + 1;
      }
    }
    if (row === -1) return { missingIds: [id] };

    const moveRes = moveInventRowToSection_(sheet, row, ALL_ITEMS_SECTION_LABEL, scanWidth);
    if (!moveRes.ok) throw new Error(moveRes.message || 'Move failed.');

    return { ok: true, id, section: ALL_ITEMS_SECTION_LABEL, moved: !!moveRes.moved };
  } finally {
    if (lock) lock.releaseLock();
  }
}

function deleteInventSections(payload) {
  assertAuthorized_();
  const keys = Array.isArray(payload?.sectionKeys)
    ? payload.sectionKeys.map(k => String(k || '').trim()).filter(Boolean)
    : [];
  const labels = Array.isArray(payload?.sectionLabels)
    ? payload.sectionLabels.map(l => String(l || '').trim()).filter(Boolean)
    : [];

  if (!keys.length && !labels.length) return { ok: false, message: 'No sections specified.' };

  const keySet = new Set(keys.map(k => norm_(k)));
  const labelSet = new Set(labels.map(l => norm_(l)));

  const ss = getSpreadsheet_();
  const sheet = ss.getSheetByName(CONFIG.INVENT_SHEET);
  if (!sheet) throw new Error(`Missing sheet: ${CONFIG.INVENT_SHEET}`);

  const lastRow = sheet.getLastRow();
  if (lastRow < 1) return { ok: false, message: 'No rows to delete.' };

  const colB = sheet.getRange(1, CONFIG.COL.COMMON_NAME, lastRow, 1)
    .getDisplayValues()
    .map(r => String(r[0] || '').trim());
  const colId = sheet.getRange(1, CONFIG.COL.ID, lastRow, 1)
    .getDisplayValues()
    .map(r => String(r[0] || '').trim());

  const headers = [];
  for (let i = 0; i < colB.length; i++) {
    if (!isSectionHeading_(colB[i], colId[i])) continue;
    const label = String(colB[i] || '').trim();
    if (!label) continue;
    const key = makeSectionKey_(label);
    if (keySet.has(norm_(key)) || labelSet.has(norm_(label))) {
      headers.push({ row: i + 1, label, key });
    }
  }

  if (!headers.length) return { ok: false, message: 'No matching sections found.' };

  const rowsToDelete = new Set();
  const itemIds = new Set();
  headers.forEach(header => {
    const nextHeader = findNextSectionHeaderRow_(colB, colId, header.row, lastRow);
    for (let r = header.row; r < nextHeader; r++) {
      rowsToDelete.add(r);
      const id = String(colId[r - 1] || '').trim();
      if (id && !isSectionHeading_(colB[r - 1], colId[r - 1])) itemIds.add(id);
    }
  });

  const lock = getLock_();
  if (lock) lock.waitLock(CONFIG.LOCK_WAIT_MS);

  try {
    if (itemIds.size) {
      const orderingRows = [];
      itemIds.forEach(id => {
        findOrderingRowsForId_(ss, id).forEach(row => orderingRows.push(row));
      });
      if (orderingRows.length) removeOrderingRows_(orderingRows);
    }

    Array.from(rowsToDelete).sort((a, b) => b - a).forEach(r => sheet.deleteRow(r));
  } finally {
    if (lock) lock.releaseLock();
  }

  const removedKeyNorms = new Set(headers.map(h => norm_(h.key || '')));
  const removedLabelNorms = new Set(headers.map(h => norm_(h.label || '')));

  const uiSettings = getUiSettings_();
  const nextSettings = uiSettings && typeof uiSettings === 'object' ? uiSettings : {};

  if (nextSettings.sectionShortcuts && typeof nextSettings.sectionShortcuts === 'object') {
    Object.keys(nextSettings.sectionShortcuts).forEach(key => {
      if (removedKeyNorms.has(norm_(key))) delete nextSettings.sectionShortcuts[key];
    });
    if (!Object.keys(nextSettings.sectionShortcuts).length) delete nextSettings.sectionShortcuts;
  }

  if (nextSettings.sectionTypes && typeof nextSettings.sectionTypes === 'object') {
    Object.keys(nextSettings.sectionTypes).forEach(key => {
      if (removedKeyNorms.has(norm_(key))) delete nextSettings.sectionTypes[key];
    });
    if (!Object.keys(nextSettings.sectionTypes).length) delete nextSettings.sectionTypes;
  }

  if (nextSettings.inventoryColumns && typeof nextSettings.inventoryColumns === 'object') {
    Object.keys(nextSettings.inventoryColumns).forEach(key => {
      if (removedKeyNorms.has(norm_(key))) delete nextSettings.inventoryColumns[key];
    });
    if (!Object.keys(nextSettings.inventoryColumns).length) delete nextSettings.inventoryColumns;
  }

  if (Array.isArray(nextSettings.secondarySections)) {
    nextSettings.secondarySections = nextSettings.secondarySections.filter(sec => {
      const keyNorm = norm_(sec?.key || sec?.label || sec?.heading || '');
      const labelNorm = norm_(sec?.label || sec?.heading || '');
      return !(removedKeyNorms.has(keyNorm) || removedLabelNorms.has(labelNorm));
    });
    if (!nextSettings.secondarySections.length) delete nextSettings.secondarySections;
  }

  saveUiSettings(nextSettings);

  const overrides = getSectionLabelOverrides_();
  let overrideChanged = false;
  Object.keys(overrides).forEach(key => {
    if (removedKeyNorms.has(norm_(key)) || removedLabelNorms.has(norm_(key))) {
      delete overrides[key];
      overrideChanged = true;
    }
  });
  if (overrideChanged) saveSectionLabelOverrides_(overrides);

  const groups = getSectionGroups_();
  let groupChanged = false;
  const nextGroups = groups.map(group => {
    const keysList = Array.isArray(group.sectionKeys) ? group.sectionKeys.slice() : [];
    const filtered = keysList.filter(k => !removedKeyNorms.has(norm_(k)));
    if (filtered.length !== keysList.length) {
      groupChanged = true;
      return Object.assign({}, group, { sectionKeys: filtered });
    }
    return group;
  });
  if (groupChanged) saveSectionGroups_(nextGroups);

  return {
    ok: true,
    removedSections: headers.map(h => ({ label: h.label, key: h.key })),
    removedItems: itemIds.size
  };
}
