const AUTH_TOKEN = 'ganti-token-rahasia-kamu';
const MONTH_NAMES_ID = ['Januari', 'Februari', 'Maret', 'April', 'Mei', 'Juni', 'Juli', 'Agustus', 'September', 'Oktober', 'November', 'Desember'];
const MONTH_NUMBER_BY_NAME = Object.freeze({
  januari: 1,
  februari: 2,
  maret: 3,
  april: 4,
  mei: 5,
  juni: 6,
  juli: 7,
  agustus: 8,
  september: 9,
  oktober: 10,
  november: 11,
  desember: 12
});

function doPost(e) {
  let lock;

  try {
    const body = JSON.parse((e && e.postData && e.postData.contents) || '{}');

    if (AUTH_TOKEN && body.token !== AUTH_TOKEN) {
      return jsonResponse({
        success: false,
        message: 'Unauthorized token'
      });
    }

    lock = LockService.getScriptLock();
    lock.waitLock(30000);

    if (body.action === 'appendLog') {
      return handleAppendLog(body);
    }

    if (body.action === 'appendData') {
      return handleAppendData(body);
    }

    if (body.action === 'appendLatenessReport') {
      return handleAppendLatenessReport(body);
    }

    return jsonResponse({
      success: false,
      message: 'Action tidak dikenal'
    });
  } catch (error) {
    return jsonResponse({
      success: false,
      message: error.message
    });
  } finally {
    if (lock) {
      try {
        lock.releaseLock();
      } catch (err) {}
    }
  }
}

function handleAppendData(body) {
  validateDataPayload(body);

  const ss = SpreadsheetApp.openById(body.spreadsheetId);
  const sheet = getOrCreateMainSheet(ss, body.sheetName, body);

  const rowData = buildMainRow(body);
  const nextRow = sheet.getLastRow() + 1;

  sheet.getRange(nextRow, 1, 1, rowData.length).setValues([rowData]);

  return jsonResponse({
    success: true,
    message: 'Data berhasil ditambahkan',
    sheet: sheet.getName(),
    requestedSheetName: body.sheetName,
    row: nextRow,
    type: body.type,
    data: rowData
  });
}

function getOrCreateMainSheet(ss, sheetName, body) {
  let sheet = ss.getSheetByName(sheetName);
  if (sheet) {
    return sheet;
  }

  const compatibleSheet = findCompatibleMainSheet(ss, sheetName);
  if (compatibleSheet) {
    return compatibleSheet;
  }

  const preferredSheetName = getPreferredMainSheetName(sheetName);
  const preferredSheet = ss.getSheetByName(preferredSheetName);
  if (preferredSheet) {
    return preferredSheet;
  }

  if (!body.autoCreateSheet) {
    throw new Error('Sheet tidak ditemukan: ' + preferredSheetName);
  }

  if (body.sheetTemplateName) {
    const templateSheet = ss.getSheetByName(body.sheetTemplateName);
    if (templateSheet) {
      sheet = templateSheet.copyTo(ss).setName(preferredSheetName);
      return sheet;
    }
  }

  return ss.insertSheet(preferredSheetName);
}

function findCompatibleMainSheet(ss, requestedSheetName) {
  const requestedInfo = extractMonthYearFromSheetName(requestedSheetName);
  if (!requestedInfo) return null;

  let best = null;

  ss.getSheets().forEach(function(candidateSheet) {
    const candidateName = candidateSheet.getName();
    const candidateInfo = extractMonthYearFromSheetName(candidateName, requestedInfo.year);
    if (!candidateInfo) return;
    if (candidateInfo.month !== requestedInfo.month) return;
    if (requestedInfo.year && candidateInfo.year && candidateInfo.year !== requestedInfo.year) return;

    let score = 10;
    if (candidateInfo.hasMonthPrefix) score += 5;
    if (candidateInfo.hasYear) score += 3;
    if (/keterlambatan/i.test(candidateName)) score += 2;

    if (!best || score > best.score) {
      best = { score, sheet: candidateSheet };
    }
  });

  return best ? best.sheet : null;
}

function getPreferredMainSheetName(rawName) {
  const parsed = extractMonthYearFromSheetName(rawName);
  if (!parsed) return String(rawName || '').trim() || 'Sheet 1';

  const monthLabel = MONTH_NAMES_ID[parsed.month - 1] || 'Sheet';
  return pad2(parsed.month) + '. ' + monthLabel + ' ' + parsed.year;
}

function extractMonthYearFromSheetName(name, fallbackYear) {
  const source = String(name || '').trim();
  if (!source) return null;

  const normalized = normalizeSheetNameText(source);
  const yearMatch = normalized.match(/\b(20\d{2})\b/);
  const year = yearMatch ? Number(yearMatch[1]) : Number(fallbackYear || 0);
  if (!year) return null;

  const monthPrefixMatch = source.match(/^\s*(\d{1,2})\s*[.)-]/);
  const monthFromPrefix = monthPrefixMatch ? Number(monthPrefixMatch[1]) : null;
  const monthFromName = getMonthFromText(normalized);

  let month = monthFromName;
  if (!month && monthFromPrefix && monthFromPrefix >= 1 && monthFromPrefix <= 12) {
    month = monthFromPrefix;
  }

  if (!month) return null;

  return {
    month: month,
    year: year,
    hasYear: Boolean(yearMatch),
    hasMonthPrefix: Boolean(monthFromPrefix && monthFromPrefix >= 1 && monthFromPrefix <= 12)
  };
}

function getMonthFromText(normalizedText) {
  const monthNames = Object.keys(MONTH_NUMBER_BY_NAME);
  for (var i = 0; i < monthNames.length; i += 1) {
    var monthName = monthNames[i];
    var pattern = new RegExp('\\b' + monthName + '\\b', 'i');
    if (pattern.test(normalizedText)) {
      return MONTH_NUMBER_BY_NAME[monthName];
    }
  }
  return null;
}

function normalizeSheetNameText(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function pad2(value) {
  return String(value).padStart(2, '0');
}

function handleAppendLog(body) {
  if (!body.spreadsheetId) {
    throw new Error('spreadsheetId kosong untuk log');
  }

  if (!body.record) {
    throw new Error('record log kosong');
  }

  const ss = SpreadsheetApp.openById(body.spreadsheetId);
  const status = String(body.record.status || '').toUpperCase();
  const sheetName = status === 'SUCCESS'
    ? (body.logSuccessSheetName || 'BOT_SUCCESS_LOG')
    : (body.logErrorSheetName || 'BOT_ERROR_LOG');

  const sheet = getOrCreateLogSheet(ss, sheetName);
  const rowData = buildLogRow(body.record);

  sheet.appendRow(rowData);

  return jsonResponse({
    success: true,
    message: 'Log berhasil ditambahkan',
    sheet: sheetName
  });
}

function handleAppendLatenessReport(body) {
  if (!body.spreadsheetId) {
    throw new Error('spreadsheetId kosong untuk lateness report');
  }

  if (!body.summary) {
    throw new Error('summary lateness report kosong');
  }

  const ss = SpreadsheetApp.openById(body.spreadsheetId);
  const summarySheet = getOrCreateLatenessSummarySheet(ss, body.summarySheetName || 'BOT_LATENESS_SUMMARY');
  const itemSheet = getOrCreateLatenessItemSheet(ss, body.itemSheetName || 'BOT_LATENESS_ITEMS');

  summarySheet.appendRow(buildLatenessSummaryRow(body.summary));

  const items = Array.isArray(body.items) ? body.items : [];
  if (items.length) {
    const rows = items.map(buildLatenessItemRow);
    itemSheet.getRange(itemSheet.getLastRow() + 1, 1, rows.length, rows[0].length).setValues(rows);
  }

  return jsonResponse({
    success: true,
    message: 'Lateness report berhasil ditambahkan',
    summarySheet: summarySheet.getName(),
    itemSheet: itemSheet.getName(),
    itemCount: items.length
  });
}

function getOrCreateLogSheet(ss, sheetName) {
  let sheet = ss.getSheetByName(sheetName);

  if (!sheet) {
    sheet = ss.insertSheet(sheetName);
    sheet.getRange(1, 1, 1, 13).setValues([[
      'AT',
      'STATUS',
      'REASON',
      'GROUP_NAME',
      'SENDER',
      'MESSAGE_ID',
      'TYPE',
      'KODE_JOB_RESI',
      'READY_STOCK',
      'PRODUK',
      'PJ_DIVISI',
      'MATCHED_TRIGGER',
      'CONFIDENCE'
    ]]);
  }

  return sheet;
}

function getOrCreateLatenessSummarySheet(ss, sheetName) {
  let sheet = ss.getSheetByName(sheetName);

  if (!sheet) {
    sheet = ss.insertSheet(sheetName);
    sheet.getRange(1, 1, 1, 13).setValues([[
      'AT',
      'GROUP_NAME',
      'SENDER',
      'MESSAGE_ID',
      'STORE_COUNT',
      'HEADER_TOTAL',
      'ITEM_TOTAL',
      'COMPLETED_TOTAL',
      'INCOMPLETE_TOTAL',
      'MIXED_TOTAL',
      'UNKNOWN_TOTAL',
      'AGING_SUMMARY',
      'FINDINGS'
    ]]);
  }

  return sheet;
}

function getOrCreateLatenessItemSheet(ss, sheetName) {
  let sheet = ss.getSheetByName(sheetName);

  if (!sheet) {
    sheet = ss.insertSheet(sheetName);
    sheet.getRange(1, 1, 1, 13).setValues([[
      'AT',
      'GROUP_NAME',
      'SENDER',
      'MESSAGE_ID',
      'STORE_LABEL',
      'STORE_HEADER_TOTAL',
      'ITEM_NO',
      'AGING',
      'SUBSECTION',
      'TYPE',
      'STATUS',
      'LINE_NUMBER',
      'CONTENT'
    ]]);
  }

  return sheet;
}

function buildMainRow(body) {
  return [
    '',                          // A - NO
    '',                          // B - PEKAN
    body.tanggal || '',          // C - TGL
    body.kode_job_resi || '',    // D - Kode Job/Resi
    body.ready_stock || '',      // E - Ready Stock
    body.produk || '',           // F - Produk
    body.pj_divisi || '',        // G - PJ Divisi
    body.banding || ''           // H - Banding
  ];
}

function buildLogRow(record) {
  return [
    record.at || '',
    record.status || '',
    record.reason || '',
    record.group_name || '',
    record.sender || '',
    record.message_id || '',
    record.type || '',
    record.kode_job_resi || '',
    record.ready_stock || '',
    record.produk || '',
    record.pj_divisi || '',
    record.matched_trigger || '',
    record.confidence || 0
  ];
}

function buildLatenessSummaryRow(summary) {
  return [
    summary.at || '',
    summary.group_name || '',
    summary.sender || '',
    summary.message_id || '',
    summary.store_count || 0,
    summary.header_total || 0,
    summary.item_total || 0,
    summary.completed_total || 0,
    summary.incomplete_total || 0,
    summary.mixed_total || 0,
    summary.unknown_total || 0,
    summary.aging_summary || '',
    summary.findings || ''
  ];
}

function buildLatenessItemRow(item) {
  return [
    item.at || '',
    item.group_name || '',
    item.sender || '',
    item.message_id || '',
    item.store_label || '',
    item.store_header_total || 0,
    item.item_no || 0,
    item.aging || '',
    item.subsection || '',
    item.type || '',
    item.status || '',
    item.line_number || 0,
    item.content || ''
  ];
}

function validateDataPayload(body) {
  const required = ['spreadsheetId', 'sheetName', 'tanggal', 'produk', 'pj_divisi', 'type'];

  required.forEach(function(key) {
    if (!body[key]) {
      throw new Error('Field wajib kosong: ' + key);
    }
  });

  if (body.type === 'custom' && !body.kode_job_resi) {
    throw new Error('Custom wajib memiliki kode_job_resi');
  }

  if (body.type === 'ready' && !body.ready_stock) {
    throw new Error('Ready stock wajib memiliki ready_stock');
  }
}

function jsonResponse(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
