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
