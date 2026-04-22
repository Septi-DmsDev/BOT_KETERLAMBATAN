const AUTH_TOKEN = 'ganti-token-rahasia-kamu';

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

  if (!body.autoCreateSheet) {
    throw new Error('Sheet tidak ditemukan: ' + sheetName);
  }

  if (body.sheetTemplateName) {
    const templateSheet = ss.getSheetByName(body.sheetTemplateName);
    if (templateSheet) {
      sheet = templateSheet.copyTo(ss).setName(sheetName);
      return sheet;
    }
  }

  return ss.insertSheet(sheetName);
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
