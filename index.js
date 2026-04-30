const { Boom } = require('@hapi/boom');
const pino = require('pino');
const qrcode = require('qrcode-terminal');
const fetch = (...args) => import('node-fetch').then(({ default: fetch }) => fetch(...args));
const fs = require('fs');
const path = require('path');

const appConfig = JSON.parse(fs.readFileSync('./sheets-config.json', 'utf8'));

const BOT_TIMEZONE = 'Asia/Jakarta';
const MONTH_NAMES_ID = ['Januari', 'Februari', 'Maret', 'April', 'Mei', 'Juni', 'Juli', 'Agustus', 'September', 'Oktober', 'November', 'Desember'];
const groupNameCache = new Map();
const messageCache = new Map();
const SUMMARY_DIVISIONS = ['SMB', 'Creative', 'Printing', 'Finishing'];
const DEFAULT_LATENESS_REPORT_OPTIONS = {
  completedMarkers: ['✅', '☑️', '✔️', '✔'],
  incompleteMarkers: ['❌', '✘', '✖'],
  subsectionMarkers: ['CUSTOM', 'READY STOK', 'READY STOCK']
};
const MOJIBAKE_SYMBOL_MAP = {
  'âœ…': '✅',
  'â˜‘ï¸': '☑️',
  'âœ”ï¸': '✔️',
  'âœ”': '✔',
  'âŒ': '❌',
  'âœ˜': '✘',
  'âœ–': '✖',
  'ðŸ“Š': '📊',
  'ðŸ“‹': '📋',
  'ðŸ†”': '🆔',
  'ðŸ•’': '🕒',
  'ðŸ“Œ': '📌',
  'ðŸ—‚ï¸': '🗂️',
  'ðŸ”': '🔁',
  'ðŸ”•': '🔕',
  'ðŸ“': '📝',
  'âš ï¸': '⚠️',
  'âœ…': '✅',
  'âŒ': '❌'
};
let watchdogTimer = null;
let dailySummaryTimer = null;
let retryQueueTimer = null;
let retryQueueInProgress = false;
let runtimeStateCache = null;
let activeSock = null;

function startWatchdog() {
  clearTimeout(watchdogTimer);
  watchdogTimer = setTimeout(() => {
    console.error('🚨 [WATCHDOG FATAL] Bot gagal konek/hang terlalu lama. Restart paksa...');
    process.exit(1);
  }, 180000);
}

function stopWatchdog() {
  clearTimeout(watchdogTimer);
  console.log('🛡️ [WATCHDOG] Aman.');
}

function getTimestamp(date = new Date(), timeZone = BOT_TIMEZONE) {
  const options = {
    timeZone,
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  };
  const parts = new Intl.DateTimeFormat('id-ID', options).formatToParts(date);
  const map = new Map(parts.map(p => [p.type, p.value]));
  return `${map.get('day')}/${map.get('month')}/ ${map.get('hour')}.${map.get('minute')}`;
}

function getNowParts(timeZone = BOT_TIMEZONE, date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  }).formatToParts(date);

  return new Map(parts.map(part => [part.type, part.value]));
}

function getDateKey(timeZone = BOT_TIMEZONE, date = new Date()) {
  const parts = getNowParts(timeZone, date);
  return `${parts.get('year')}-${parts.get('month')}-${parts.get('day')}`;
}

function getDisplayDate(timeZone = BOT_TIMEZONE, date = new Date()) {
  const parts = getNowParts(timeZone, date);
  return `${parts.get('day')}/${parts.get('month')}/${parts.get('year')}`;
}

function getTimeKey(timeZone = BOT_TIMEZONE, date = new Date()) {
  const parts = getNowParts(timeZone, date);
  return `${parts.get('hour')}:${parts.get('minute')}`;
}

function getMonthlySheetName(timeZone = BOT_TIMEZONE, date = new Date(), rules = {}) {
  const parts = getNowParts(timeZone, date);
  const periodStartDay = Math.min(31, Math.max(1, Number(rules.sheetPeriodStartDay || 26)));
  const monthlySheetNameFormat = String(rules.monthlySheetNameFormat || 'numbered').toLowerCase();
  let month = Number(parts.get('month'));
  let year = Number(parts.get('year'));
  const day = Number(parts.get('day'));

  if (day >= periodStartDay) {
    month += 1;
    if (month > 12) {
      month = 1;
      year += 1;
    }
  }

  const monthIndex = month - 1;
  const monthLabel = MONTH_NAMES_ID[monthIndex] || 'Sheet';
  if (monthlySheetNameFormat === 'plain') {
    return `${monthLabel} ${year}`;
  }

  return `${String(month).padStart(2, '0')}. ${monthLabel} ${year}`;
}

function getSummaryConfig(rules = {}) {
  return rules.dailySummary || {};
}

function getLatenessSummaryConfig(rules = {}) {
  return rules.latenessSummary || {};
}

function getNotificationConfig(rules = {}) {
  return rules.notifications || {};
}

function getStateFilePath(rules = {}) {
  return rules.stateFile || './logs/bot-state.json';
}

function getRetryDelayMs(rules = {}) {
  return Math.max(60000, Number(rules.retryDelayMs || 300000));
}

function getRetryWorkerIntervalMs(rules = {}) {
  return Math.max(30000, Number(rules.retryWorkerIntervalMs || 60000));
}

function getRetryMaxAttempts(rules = {}) {
  return Math.max(1, Number(rules.retryMaxAttempts || 5));
}

function getDedupWindowMs(rules = {}) {
  return Math.max(60000, Number(rules.dedupWindowMs || 24 * 60 * 60 * 1000));
}

function getCurrentSheetName(rules = {}, date = new Date()) {
  if (String(rules.sheetMode || '').toLowerCase() === 'monthly') {
    return getMonthlySheetName(rules.timeZone || BOT_TIMEZONE, date, rules);
  }

  return rules.sheetName || getMonthlySheetName(rules.timeZone || BOT_TIMEZONE, date, rules);
}

function parseTimeValue(value = '16:30') {
  const match = String(value || '').trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!match) {
    return { hour: 16, minute: 30 };
  }

  return {
    hour: Math.min(23, Number(match[1])),
    minute: Math.min(59, Number(match[2]))
  };
}

function hasReachedScheduledTime(value = '16:30', timeZone = BOT_TIMEZONE, date = new Date()) {
  const target = parseTimeValue(value);
  const parts = getNowParts(timeZone, date);
  const hour = Number(parts.get('hour'));
  const minute = Number(parts.get('minute'));
  return hour > target.hour || (hour === target.hour && minute >= target.minute);
}

function createDailyStats() {
  return {
    successCount: 0,
    duplicateCount: 0,
    parseErrorCount: 0,
    webhookErrorCount: 0,
    divisions: Object.fromEntries(SUMMARY_DIVISIONS.map(name => [name, 0]))
  };
}

function createInitialRuntimeState() {
  return {
    version: 1,
    knownGroups: {},
    dedup: {},
    retryQueue: [],
    dailyStats: {},
    summary: {
      lastSentByDate: {}
    },
    latenessReports: {
      stores: {}
    },
    latenessSummary: {
      lastSentTimeByDate: {}
    }
  };
}

function ensureDailyStatsEntry(state, dayKey) {
  if (!state.dailyStats[dayKey]) {
    state.dailyStats[dayKey] = createDailyStats();
  }

  state.dailyStats[dayKey].divisions = state.dailyStats[dayKey].divisions || {};
  for (const division of SUMMARY_DIVISIONS) {
    if (typeof state.dailyStats[dayKey].divisions[division] !== 'number') {
      state.dailyStats[dayKey].divisions[division] = 0;
    }
  }

  return state.dailyStats[dayKey];
}

function pruneRuntimeState(state, rules = {}) {
  const now = Date.now();
  const summaryConfig = getSummaryConfig(rules);
  const latenessSummaryConfig = getLatenessSummaryConfig(rules);
  const keepDays = Math.max(7, Number(rules.summaryRetentionDays || 45));
  const keepMs = keepDays * 24 * 60 * 60 * 1000;
  const groupKeepMs = Math.max(keepMs, Number(summaryConfig.recentGroupWindowMs || 7 * 24 * 60 * 60 * 1000));
  const latenessKeepMs = Math.max(12 * 60 * 60 * 1000, Number(latenessSummaryConfig.snapshotWindowMs || 72 * 60 * 60 * 1000));
  const queuedDedupKeys = new Set((state.retryQueue || []).map(item => item.dedupKey).filter(Boolean));

  for (const [dedupKey, entry] of Object.entries(state.dedup || {})) {
    const expiresAt = Number(entry?.expiresAt || 0);
    if (expiresAt > now) continue;
    if (entry?.status === 'pending' && queuedDedupKeys.has(dedupKey)) continue;
    delete state.dedup[dedupKey];
  }

  const minAllowedDate = getDateKey(BOT_TIMEZONE, new Date(now - keepMs));
  for (const dayKey of Object.keys(state.dailyStats || {})) {
    if (dayKey < minAllowedDate) {
      delete state.dailyStats[dayKey];
    }
  }

  for (const dayKey of Object.keys(state.summary?.lastSentByDate || {})) {
    if (dayKey < minAllowedDate) {
      delete state.summary.lastSentByDate[dayKey];
    }
  }

  for (const dayKey of Object.keys(state.latenessSummary?.lastSentTimeByDate || {})) {
    if (dayKey < minAllowedDate) {
      delete state.latenessSummary.lastSentTimeByDate[dayKey];
    }
  }

  for (const [jid, info] of Object.entries(state.knownGroups || {})) {
    const lastSeenAt = Date.parse(info?.lastSeenAt || 0);
    if (!lastSeenAt || now - lastSeenAt <= groupKeepMs) continue;
    delete state.knownGroups[jid];
  }

  for (const [storeKey, snapshot] of Object.entries(state.latenessReports?.stores || {})) {
    const updatedAt = Date.parse(snapshot?.updatedAt || 0);
    if (!updatedAt || now - updatedAt > latenessKeepMs) {
      delete state.latenessReports.stores[storeKey];
    }
  }
}

function getRuntimeState(rules = {}) {
  if (runtimeStateCache) return runtimeStateCache;

  const stateFile = getStateFilePath(rules);
  try {
    if (fs.existsSync(stateFile)) {
      runtimeStateCache = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    } else {
      runtimeStateCache = createInitialRuntimeState();
    }
  } catch (error) {
    console.error('⚠️ Gagal membaca state lokal, membuat state baru:', error.message);
    runtimeStateCache = createInitialRuntimeState();
  }

  runtimeStateCache = Object.assign(createInitialRuntimeState(), runtimeStateCache || {});
  runtimeStateCache.knownGroups = runtimeStateCache.knownGroups || {};
  runtimeStateCache.dedup = runtimeStateCache.dedup || {};
  runtimeStateCache.retryQueue = Array.isArray(runtimeStateCache.retryQueue) ? runtimeStateCache.retryQueue : [];
  runtimeStateCache.dailyStats = runtimeStateCache.dailyStats || {};
  runtimeStateCache.summary = runtimeStateCache.summary || { lastSentByDate: {} };
  runtimeStateCache.summary.lastSentByDate = runtimeStateCache.summary.lastSentByDate || {};
  runtimeStateCache.latenessReports = runtimeStateCache.latenessReports || { stores: {} };
  runtimeStateCache.latenessReports.stores = runtimeStateCache.latenessReports.stores || {};
  runtimeStateCache.latenessSummary = runtimeStateCache.latenessSummary || { lastSentTimeByDate: {} };
  runtimeStateCache.latenessSummary.lastSentTimeByDate = runtimeStateCache.latenessSummary.lastSentTimeByDate || {};

  pruneRuntimeState(runtimeStateCache, rules);
  return runtimeStateCache;
}

function saveRuntimeState(rules = {}) {
  const stateFile = getStateFilePath(rules);
  const state = getRuntimeState(rules);
  pruneRuntimeState(state, rules);
  ensureDirForFile(stateFile);
  fs.writeFileSync(stateFile, JSON.stringify(state, null, 2), 'utf8');
}

function updateRuntimeState(rules, updater) {
  const state = getRuntimeState(rules);
  const result = updater(state);
  saveRuntimeState(rules);
  return result;
}

function normalizeKeyPart(text = '') {
  return normalizeSpaces(String(text || '').toUpperCase());
}

function buildDedupKey(parsed, groupJid = '') {
  return [
    normalizeKeyPart(groupJid),
    normalizeKeyPart(parsed.type),
    normalizeKeyPart(parsed.kode_job_resi || parsed.ready_stock),
    normalizeKeyPart(parsed.produk),
    normalizeKeyPart(parsed.pj_divisi)
  ].join('|');
}

function isDuplicatePayload(rules, dedupKey) {
  const entry = getRuntimeState(rules).dedup?.[dedupKey];
  return Boolean(entry && Number(entry.expiresAt || 0) > Date.now());
}

function markDedupEntry(rules, dedupKey, status = 'success', extra = {}) {
  if (!dedupKey) return;

  updateRuntimeState(rules, state => {
    state.dedup[dedupKey] = {
      status,
      expiresAt: Date.now() + getDedupWindowMs(rules),
      updatedAt: new Date().toISOString(),
      ...extra
    };
  });
}

function clearDedupEntry(rules, dedupKey) {
  if (!dedupKey) return;

  updateRuntimeState(rules, state => {
    delete state.dedup[dedupKey];
  });
}

function incrementStat(rules, dayKey, field, amount = 1) {
  updateRuntimeState(rules, state => {
    const stats = ensureDailyStatsEntry(state, dayKey);
    stats[field] = Number(stats[field] || 0) + amount;
  });
}

function incrementDivisionSuccess(rules, dayKey, division) {
  updateRuntimeState(rules, state => {
    const stats = ensureDailyStatsEntry(state, dayKey);
    stats.successCount = Number(stats.successCount || 0) + 1;
    if (division) {
      stats.divisions[division] = Number(stats.divisions[division] || 0) + 1;
    }
  });
}

function rememberKnownGroup(rules, jid, groupName = '') {
  if (!jid) return;

  const nowIso = new Date().toISOString();
  updateRuntimeState(rules, state => {
    const current = state.knownGroups[jid] || {};
    state.knownGroups[jid] = {
      name: groupName || current.name || '',
      lastSeenAt: nowIso
    };
  });
}

function getRetryQueueLength(rules = {}) {
  return getRuntimeState(rules).retryQueue.length;
}

function buildSummarySnapshot(rules, dayKey) {
  const state = getRuntimeState(rules);
  const source = state.dailyStats?.[dayKey] || createDailyStats();
  const divisions = Object.fromEntries(
    SUMMARY_DIVISIONS.map(name => [name, Number(source.divisions?.[name] || 0)])
  );

  return {
    successCount: Number(source.successCount || 0),
    duplicateCount: Number(source.duplicateCount || 0),
    parseErrorCount: Number(source.parseErrorCount || 0),
    webhookErrorCount: Number(source.webhookErrorCount || 0),
    divisions
  };
}

function buildDailySummaryMessage(rules, dayKey) {
  const stats = buildSummarySnapshot(rules, dayKey);
  const displayDate = getDisplayDate(rules.timeZone || BOT_TIMEZONE);

  return [
    'Laporan Bot Harian',
    `Tanggal: ${displayDate}`,
    '',
    `Berhasil masuk sheet: ${stats.successCount}`,
    `Duplicate ditolak: ${stats.duplicateCount}`,
    `Gagal parse: ${stats.parseErrorCount}`,
    `Gagal webhook: ${stats.webhookErrorCount}`,
    '',
    'Per divisi:',
    `SMB: ${stats.divisions.SMB}`,
    `Creative: ${stats.divisions.Creative}`,
    `Printing: ${stats.divisions.Printing}`,
    `Finishing: ${stats.divisions.Finishing}`
  ].join('\n');
}

function getDisplayName(value = '') {
  const text = normalizeSpaces(String(value || ''));
  return text || '-';
}

function getSenderPrivateJid(msg) {
  const participant = msg?.key?.participant || msg?.participant || '';
  return participant || '';
}

function buildErrorPreviewLines(items = [], limit = 5) {
  return items.slice(0, limit).map((item, index) => `${index + 1}. ${item.line} -> ${item.reason}`);
}

function buildParseErrorPrivateMessage(parseErrors = []) {
  if (!parseErrors.length) return '';

  return [
    '?? Ada baris yang belum bisa diproses oleh bot:',
    '',
    ...buildErrorPreviewLines(parseErrors, 8),
    parseErrors.length > 8 ? `...dan ${parseErrors.length - 8} baris lainnya` : '',
    '',
    'Silakan perbaiki format lalu kirim ulang.'
  ].filter(Boolean).join('\n');
}

function buildReportGroupMessage(context, parseErrors = [], webhookErrors = []) {
  const parts = [
    '?? Log Report Keterlambatan',
    `Grup: ${getDisplayName(context.groupName)}`,
    `Pengirim: ${getDisplayName(context.sender)}`,
    `Parse error: ${parseErrors.length}`,
    `Webhook error: ${webhookErrors.length}`
  ];

  if (parseErrors.length) {
    parts.push('', 'Detail parse error:');
    parts.push(...buildErrorPreviewLines(parseErrors, 5));
    if (parseErrors.length > 5) {
      parts.push(`...dan ${parseErrors.length - 5} parse error lainnya`);
    }
  }

  if (webhookErrors.length) {
    parts.push('', 'Detail webhook error:');
    parts.push(...buildErrorPreviewLines(webhookErrors, 5));
    if (webhookErrors.length > 5) {
      parts.push(`...dan ${webhookErrors.length - 5} webhook error lainnya`);
    }
  }

  return parts.join('\n');
}

function getSummaryTargetGroupJids(rules = {}) {
  const summaryConfig = getSummaryConfig(rules);
  const explicitTargets = (summaryConfig.targetGroupJids || []).filter(Boolean);
  if (explicitTargets.length) return explicitTargets;
  if (summaryConfig.sendToKnownGroups === false) return [];

  const now = Date.now();
  const recentWindowMs = Math.max(60 * 60 * 1000, Number(summaryConfig.recentGroupWindowMs || 7 * 24 * 60 * 60 * 1000));
  const state = getRuntimeState(rules);

  return Object.entries(state.knownGroups || {})
    .filter(([, info]) => {
      const lastSeenAt = Date.parse(info?.lastSeenAt || 0);
      return lastSeenAt && now - lastSeenAt <= recentWindowMs;
    })
    .map(([jid]) => jid);
}

async function maybeSendDailySummary(sock, rules) {
  const summaryConfig = getSummaryConfig(rules);
  if (summaryConfig.enabled === false) return;
  if (!sock) return;

  const dayKey = getDateKey(rules.timeZone || BOT_TIMEZONE);
  const state = getRuntimeState(rules);
  if (state.summary?.lastSentByDate?.[dayKey]) return;
  if (!hasReachedScheduledTime(summaryConfig.time || '16:30', rules.timeZone || BOT_TIMEZONE)) return;

  const targets = getSummaryTargetGroupJids(rules);
  if (!targets.length) return;

  const message = buildDailySummaryMessage(rules, dayKey);
  let successSendCount = 0;

  for (const jid of targets) {
    try {
      await sock.sendMessage(jid, { text: message });
      successSendCount += 1;
    } catch (error) {
      console.error(`⚠️ Gagal kirim summary harian ke ${jid}:`, error.message);
    }
  }

  if (successSendCount > 0) {
    updateRuntimeState(rules, currentState => {
      currentState.summary.lastSentByDate[dayKey] = new Date().toISOString();
    });
  }
}

function normalizeScheduleTimes(values = [], fallback = []) {
  const source = Array.isArray(values) && values.length ? values : fallback;
  const unique = Array.from(new Set(source.map(value => String(value || '').trim()).filter(Boolean)));
  return unique
    .filter(value => /^\d{1,2}:\d{2}$/.test(value))
    .sort((a, b) => {
      const aParts = parseTimeValue(a);
      const bParts = parseTimeValue(b);
      return (aParts.hour * 60 + aParts.minute) - (bParts.hour * 60 + bParts.minute);
    });
}

function compareScheduleTimeKeys(left = '', right = '') {
  const leftParts = parseTimeValue(left || '00:00');
  const rightParts = parseTimeValue(right || '00:00');
  return (leftParts.hour * 60 + leftParts.minute) - (rightParts.hour * 60 + rightParts.minute);
}

function getLatestDueScheduleTime(times = [], timeZone = BOT_TIMEZONE, date = new Date()) {
  let latest = '';

  for (const value of times) {
    if (hasReachedScheduledTime(value, timeZone, date)) {
      latest = value;
    }
  }

  return latest;
}

function getLatenessSummaryTargetGroupJids(rules = {}) {
  const config = getLatenessSummaryConfig(rules);
  const explicitTargets = (config.targetGroupJids || []).filter(Boolean);
  if (explicitTargets.length) return explicitTargets;

  const notificationConfig = getNotificationConfig(rules);
  if (config.useReportGroup !== false && notificationConfig.reportGroupJid) {
    return [notificationConfig.reportGroupJid];
  }

  return [];
}

function buildLatenessStoreKey(storeLabel = '', context = {}) {
  return [
    normalizeKeyPart(context.groupJid || context.groupName || 'unknown-group'),
    normalizeKeyPart(storeLabel || 'unknown-store')
  ].join('|');
}

function rememberLatenessReportSnapshot(rules, parsedReport, context = {}) {
  if (!parsedReport?.stores?.length) return;

  updateRuntimeState(rules, state => {
    state.latenessReports = state.latenessReports || { stores: {} };
    state.latenessReports.stores = state.latenessReports.stores || {};

    for (const store of parsedReport.stores) {
      const storeKey = buildLatenessStoreKey(store.header?.storeLabel, context);
      state.latenessReports.stores[storeKey] = {
        key: storeKey,
        storeLabel: store.header?.storeLabel || '',
        headerTotal: Number(store.header?.totalInHeader || 0),
        itemCount: Number(store.itemCount || 0),
        mismatchWithHeader: Number(store.mismatchWithHeader || 0),
        agingCounts: store.agingCounts || {},
        statusCounts: store.statusCounts || {},
        typoVariant: Boolean(store.header?.typoVariant),
        groupJid: context.groupJid || '',
        groupName: context.groupName || '',
        sender: context.sender || '',
        messageId: context.messageId || '',
        updatedAt: new Date().toISOString()
      };
    }
  });
}

function getActiveLatenessStoreSnapshots(rules = {}, date = new Date()) {
  const config = getLatenessSummaryConfig(rules);
  const snapshotWindowMs = Math.max(12 * 60 * 60 * 1000, Number(config.snapshotWindowMs || 72 * 60 * 60 * 1000));
  const minUpdatedAt = date.getTime() - snapshotWindowMs;

  return Object.values(getRuntimeState(rules).latenessReports?.stores || {})
    .filter(snapshot => {
      const updatedAt = Date.parse(snapshot?.updatedAt || 0);
      return updatedAt && updatedAt >= minUpdatedAt;
    })
    .sort((a, b) => String(a.storeLabel || '').localeCompare(String(b.storeLabel || ''), 'id'));
}

function buildAggregatedLatenessReport(rules = {}, date = new Date()) {
  const snapshots = getActiveLatenessStoreSnapshots(rules, date);
  const aggregated = {
    totals: {
      stores: snapshots.length,
      headerTotal: 0,
      items: 0,
      aging: {},
      status: {
        completed: 0,
        incomplete: 0,
        mixed: 0,
        unknown: 0
      }
    },
    stores: [],
    formatFindings: []
  };

  for (const snapshot of snapshots) {
    aggregated.totals.headerTotal += Number(snapshot.headerTotal || 0);
    aggregated.totals.items += Number(snapshot.itemCount || 0);

    for (const [aging, count] of Object.entries(snapshot.agingCounts || {})) {
      aggregated.totals.aging[aging] = Number(aggregated.totals.aging[aging] || 0) + Number(count || 0);
    }

    for (const [statusKey, count] of Object.entries(snapshot.statusCounts || {})) {
      aggregated.totals.status[statusKey] = Number(aggregated.totals.status[statusKey] || 0) + Number(count || 0);
    }

    aggregated.stores.push({
      header: {
        storeLabel: snapshot.storeLabel || '',
        totalInHeader: Number(snapshot.headerTotal || 0),
        typoVariant: Boolean(snapshot.typoVariant)
      },
      itemCount: Number(snapshot.itemCount || 0),
      mismatchWithHeader: Number(snapshot.mismatchWithHeader || 0),
      agingCounts: snapshot.agingCounts || {},
      statusCounts: snapshot.statusCounts || {},
      groupName: snapshot.groupName || '',
      updatedAt: snapshot.updatedAt || ''
    });
  }

  const mismatchStores = aggregated.stores.filter(store => store.mismatchWithHeader !== 0);
  if (mismatchStores.length) {
    aggregated.formatFindings.push({
      code: 'HEADER_ITEM_MISMATCH',
      count: mismatchStores.length
    });
  }

  const noHPlusStores = aggregated.stores.filter(store => Number(store.agingCounts?.NO_H_PLUS || 0) > 0);
  if (noHPlusStores.length) {
    aggregated.formatFindings.push({
      code: 'STORE_WITHOUT_H_PLUS_BLOCK',
      count: noHPlusStores.length
    });
  }

  const typoStores = aggregated.stores.filter(store => store.header.typoVariant);
  if (typoStores.length) {
    aggregated.formatFindings.push({
      code: 'HEADER_TYPO_KETELAMBATAN',
      count: typoStores.length
    });
  }

  return aggregated;
}

async function maybeSendLatenessSummary(sock, rules, date = new Date()) {
  const config = getLatenessSummaryConfig(rules);
  if (config.enabled === false) return;
  if (!sock) return;

  const times = normalizeScheduleTimes(config.times, ['06:00', '16:30']);
  if (!times.length) return;

  const dueTime = getLatestDueScheduleTime(times, rules.timeZone || BOT_TIMEZONE, date);
  if (!dueTime) return;

  const dayKey = getDateKey(rules.timeZone || BOT_TIMEZONE, date);
  const lastSentTime = String(getRuntimeState(rules).latenessSummary?.lastSentTimeByDate?.[dayKey] || '');
  if (lastSentTime && compareScheduleTimeKeys(lastSentTime, dueTime) >= 0) return;

  const targets = getLatenessSummaryTargetGroupJids(rules);
  if (!targets.length) return;

  const aggregated = buildAggregatedLatenessReport(rules, date);
  if (!aggregated.stores.length && config.sendWhenEmpty === false) return;

  const message = buildLatenessSummaryMessage(aggregated, {
    storeLimit: Number(config.storeLimit || 20),
    title: '📊 *REKAP LAPORAN KETERLAMBATAN*',
    subtitle: `Jadwal: ${getDisplayDate(rules.timeZone || BOT_TIMEZONE, date)} ${dueTime} WIB`,
    emptyMessage: 'Belum ada snapshot laporan keterlambatan aktif.'
  });

  let successSendCount = 0;
  for (const jid of targets) {
    try {
      await sock.sendMessage(jid, { text: message });
      successSendCount += 1;
    } catch (error) {
      console.error(`Gagal kirim rekap keterlambatan ke ${jid}:`, error.message);
    }
  }

  if (successSendCount > 0) {
    updateRuntimeState(rules, state => {
      state.latenessSummary = state.latenessSummary || { lastSentTimeByDate: {} };
      state.latenessSummary.lastSentTimeByDate = state.latenessSummary.lastSentTimeByDate || {};
      state.latenessSummary.lastSentTimeByDate[dayKey] = dueTime;
    });
  }
}

function buildWebhookPayload(parsed, rules) {
  return {
    ...parsed,
    sheetName: getCurrentSheetName(rules)
  };
}

async function sendLatenessReportToWebhook(parsedReport, context, rules) {
  const config = rules.latenessReport || {};
  if (config.sendStructuredToSheet === false) return null;

  const payload = buildLatenessStructuredPayload(parsedReport, context);
  const res = await fetch(rules.webhook, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      action: 'appendLatenessReport',
      token: rules.token,
      spreadsheetId: rules.spreadsheetId,
      summarySheetName: config.summarySheetName || 'BOT_LATENESS_SUMMARY',
      itemSheetName: config.itemSheetName || 'BOT_LATENESS_ITEMS',
      summary: payload.summary,
      items: payload.items
    })
  });

  const raw = await res.text();
  let data = null;

  try {
    data = JSON.parse(raw);
  } catch {
    data = null;
  }

  if (!res.ok || !data || data.success === false) {
    throw createWebhookError(summarizeWebhookError((data && data.message) || raw, res.status), {
      statusCode: res.status,
      retryable: false,
      kind: 'lateness_report',
      raw
    });
  }

  return data;
}

async function sendTextMessage(sock, jid, text, options = {}) {
  if (!sock || !jid || !text) return false;

  try {
    await sock.sendMessage(jid, { text }, options);
    return true;
  } catch (error) {
    console.error(`⚠️ Gagal kirim pesan ke ${jid}:`, error.message);
    return false;
  }
}

async function sendReportGroupLog(sock, rules, context, parseErrors = [], webhookErrors = []) {
  const notificationConfig = getNotificationConfig(rules);
  if (!notificationConfig.sendErrorLogToReportGroup) return false;

  const reportGroupJid = notificationConfig.reportGroupJid || '';
  if (!reportGroupJid) return false;
  if (!parseErrors.length && !webhookErrors.length) return false;

  const message = buildReportGroupMessage(context, parseErrors, webhookErrors);
  return sendTextMessage(sock, reportGroupJid, message);
}

async function sendParseErrorsToPrivate(sock, rules, privateJid, parseErrors = []) {
  const notificationConfig = getNotificationConfig(rules);
  if (!notificationConfig.sendParseErrorToPrivate) return false;
  if (!privateJid || !parseErrors.length) return false;

  const message = buildParseErrorPrivateMessage(parseErrors);
  return sendTextMessage(sock, privateJid, message);
}

function createLogRecord(status, reason, context, parsed = {}, extra = {}) {
  return {
    at: getTimestamp(),
    status,
    reason,
    raw_error: extra.raw_error || '',
    group_name: context.groupName || '',
    sender: context.sender || '',
    message_id: context.messageId || '',
    line: context.line || '',
    cleaned_line: extra.cleanedLine || parsed.raw_text || context.cleanedLine || '',
    type: parsed.type || extra.type || '',
    kode_job_resi: parsed.kode_job_resi || '',
    ready_stock: parsed.ready_stock || '',
    produk: parsed.produk || '',
    pj_divisi: parsed.pj_divisi || '',
    matched_trigger: parsed.meta?.matchedTrigger || '',
    confidence: parsed.confidence || 0,
    dedup_key: extra.dedupKey || '',
    sheet_name: extra.sheetName || ''
  };
}

async function writeAndSendLog(record, rules) {
  if (rules.enableLocalLog) {
    writeLocalLog(rules.localLogFile, record);
  }

  await sendLogToWebhook(record, rules);
}

function normalizeSpaces(text = '') {
  return String(text)
    .replace(/[*_~`]/g, '')
    .replace(/\u00A0/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function cleanLinePrefix(text = '') {
  return String(text).replace(/^\s*\d+[\.\)]\s*/, '').trim();
}

function hasLineNumberPrefix(text = '') {
  return /^\s*\d+[\.\)]\s+/.test(String(text || ''));
}

function escapeRegex(text = '') {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function stripSquareBrackets(text = '') {
  return String(text).replace(/\[[^\]]*]/g, ' ');
}

function stripRoundBrackets(text = '') {
  return String(text).replace(/\([^)]*\)/g, ' ');
}

function replaceSeparators(text = '') {
  return String(text).replace(/[-_]+/g, ' ');
}

function upperCode(text = '') {
  return normalizeSpaces(String(text).toUpperCase());
}

function isCustomCodeStart(text = '') {
  return /^[A-Z]{2,3}\s\d{1,5}\b/i.test(String(text || ''));
}

function isReadyStockCode(text = '') {
  const token = normalizeTokenText(text);
  return /^[A-Z0-9]{10,}$/i.test(token) && /[A-Za-z]/.test(token) && /\d/.test(token);
}

function normalizeReadyStockCandidate(text = '') {
  const cleaned = normalizeSpaces(String(text || ''));
  if (!cleaned) return null;

  const directMatch = cleaned.match(/^([A-Z0-9]{10,})\b\s*(.*)$/i);
  if (directMatch && isReadyStockCode(directMatch[1])) {
    return {
      normalized: cleaned,
      code: upperCode(directMatch[1]),
      rest: normalizeSpaces(directMatch[2] || '')
    };
  }

  const noiseMatch = cleaned.match(/^\d{12,}\s*-\s*(.+)$/);
  if (!noiseMatch) return null;

  const afterNoise = normalizeSpaces(noiseMatch[1]);
  const readyMatch = afterNoise.match(/^([A-Z0-9]{10,})\b\s*(.*)$/i);
  if (!readyMatch || !isReadyStockCode(readyMatch[1])) return null;

  return {
    normalized: afterNoise,
    code: upperCode(readyMatch[1]),
    rest: normalizeSpaces(readyMatch[2] || '')
  };
}

function looksLikeOperasionalLine(text = '') {
  const cleaned = normalizeSpaces(String(text || ''));
  return isCustomCodeStart(cleaned) || Boolean(normalizeReadyStockCandidate(cleaned));
}

function hasDigitToken(token = '') {
  return /\d/.test(token);
}

function isLongAlpha(token = '') {
  return /^[A-Za-z]{5,}$/.test(token);
}

function isShortUpper(token = '') {
  return /^[A-Z]{1,4}$/.test(token);
}

function isWordLikeToken(token = '') {
  return /^[A-Za-z0-9*,./]+$/.test(token);
}

function splitTokens(text = '') {
  return normalizeSpaces(text).split(' ').filter(Boolean);
}

function hasAnyMarker(text = '', markers = []) {
  const source = String(text || '');
  return (markers || []).some(marker => marker && source.includes(marker));
}

function isHeaderLine(text = '') {
  const cleaned = normalizeSpaces(cleanLinePrefix(text)).replace(/[:\-]+$/, '').trim();
  return /^H\+\d+\b$/i.test(cleaned);
}


function maybeDecodeMojibake(text = '') {
  let current = String(text || '');

  for (let index = 0; index < 2; index += 1) {
    if (!/[\u00c2\u00c3\u00e2\u00f0\u00ef]/.test(current)) break;

    const decoded = Buffer.from(current, 'latin1').toString('utf8');
    if (!decoded || decoded === current) break;
    current = decoded;
  }

  return current;
}

function normalizeReportSpaces(text = '') {
  return maybeDecodeMojibake(String(text || ''))
    .replace(/[\u0000-\u001f]+/g, ' ')
    .replace(/[\u200B-\u200D\uFEFF]/g, ' ')
    .replace(/\u00A0/g, ' ')
    .replace(/\t+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeMarkerList(markers = []) {
  return (markers || [])
    .map(marker => normalizeReportSpaces(marker))
    .filter(Boolean);
}

function cleanReportLine(text = '') {
  return normalizeReportSpaces(String(text || '').replace(/^\uFEFF/, '').trim());
}

function isIgnorableReportLine(text = '') {
  const cleaned = cleanReportLine(text);
  if (!cleaned) return true;

  const unwrapped = cleaned.replace(/^\*+|\*+$/g, '').trim();
  if (!unwrapped) return true;

  return /^note\b/i.test(unwrapped);
}

function normalizeStoreName(raw = '') {
  let name = normalizeReportSpaces(raw)
    .replace(/^shopee\s+/i, '')
    .replace(/\s+keterlambatan$/i, '')
    .replace(/\s+ketelambatan$/i, '')
    .trim();

  return name.replace(/\s+/g, ' ').toUpperCase();
}

function parseStoreHeaderLine(text = '') {
  const cleaned = cleanReportLine(text).replace(/[:\-]+$/, '');
  if (!cleaned) return null;

  const match = cleaned.match(/^(shopee(?:\s+mall)?\s+.+?)\s+(keterlambatan|ketelambatan)\s+(\d+)\s*$/i);
  if (!match) return null;

  return {
    raw: cleaned,
    title: normalizeReportSpaces(`${match[1]} ${match[2]}`),
    storeLabel: normalizeStoreName(match[1]),
    totalInHeader: Number(match[3]),
    typoVariant: /^ketelambatan$/i.test(match[2])
  };
}

function parseAgingHeaderLine(text = '') {
  const cleaned = cleanReportLine(text).replace(/[:\-]+$/, '');
  const match = cleaned.match(/^H\s*\+\s*(\d+)$/i);
  if (!match) return null;

  return {
    raw: cleaned,
    label: `H+${match[1]}`,
    dayOffset: Number(match[1])
  };
}

function parseSubsectionHeaderLine(text = '', options = DEFAULT_LATENESS_REPORT_OPTIONS) {
  const cleaned = cleanReportLine(text);
  if (!cleaned) return null;

  const wrappedMatch = cleaned.match(/^\*(.+?)\*$/);
  const content = wrappedMatch ? wrappedMatch[1] : cleaned;
  const normalized = normalizeReportSpaces(content).toUpperCase();
  if (!normalized) return null;

  return (options.subsectionMarkers || []).includes(normalized) ? normalized : null;
}

function isQuotedWholeLine(text = '') {
  const cleaned = cleanReportLine(text);
  return /^".*"$/.test(cleaned);
}

function unquoteWholeLine(text = '') {
  const cleaned = cleanReportLine(text);
  return isQuotedWholeLine(cleaned) ? cleaned.slice(1, -1).trim() : cleaned;
}

function parseNumberedReportLine(text = '') {
  const cleaned = unquoteWholeLine(text);
  const match = cleaned.match(/^(\d+)\.\s*(.+)$/);
  if (!match) return null;

  return {
    itemNo: Number(match[1]),
    content: normalizeReportSpaces(match[2])
  };
}

function classifyLatenessEntryType(content = '') {
  const cleaned = cleanReportLine(content);
  if (!cleaned) return 'unknown';

  if (isCustomCodeStart(cleaned)) return 'custom';
  if (normalizeReadyStockCandidate(cleaned)) return 'ready_stock';
  return 'unknown';
}

function extractLatenessStatus(content = '', options = DEFAULT_LATENESS_REPORT_OPTIONS) {
  const source = normalizeReportSpaces(content);
  const completedMarkers = options.completedMarkers || DEFAULT_LATENESS_REPORT_OPTIONS.completedMarkers;
  const incompleteMarkers = options.incompleteMarkers || DEFAULT_LATENESS_REPORT_OPTIONS.incompleteMarkers;

  const hasCompleted = completedMarkers.some(marker => marker && source.includes(marker));
  const hasIncomplete = incompleteMarkers.some(marker => marker && source.includes(marker));

  let label = 'unknown';
  if (hasCompleted && hasIncomplete) label = 'mixed';
  else if (hasCompleted) label = 'completed';
  else if (hasIncomplete) label = 'incomplete';

  return {
    label,
    hasCompleted,
    hasIncomplete
  };
}

function createLatenessStoreBucket(header) {
  return {
    header,
    items: [],
    agingCounts: {},
    subsectionCounts: {},
    statusCounts: {
      completed: 0,
      incomplete: 0,
      mixed: 0,
      unknown: 0
    },
    typeCounts: {
      custom: 0,
      ready_stock: 0,
      unknown: 0
    },
    itemCount: 0,
    mismatchWithHeader: 0,
    notes: []
  };
}

function resolveLatenessMarkers(candidateMarkers = [], fallbackMarkers = []) {
  const normalizedCandidates = normalizeMarkerList(candidateMarkers);
  const hasMeaningfulMarker = normalizedCandidates.some(marker => /[^\?\s]/.test(marker));
  if (hasMeaningfulMarker) {
    return normalizedCandidates;
  }

  return normalizeMarkerList(fallbackMarkers);
}

function getLatenessReportOptions(rules = {}) {
  return {
    completedMarkers: resolveLatenessMarkers(
      Array.isArray(rules.completedMarkers) ? rules.completedMarkers : [],
      ['✅', '☑️', '✔️', '✔']
    ),
    incompleteMarkers: resolveLatenessMarkers(
      Array.isArray(rules.incompleteMarkers) ? rules.incompleteMarkers : [],
      ['❌', '✘', '✖']
    ),
    subsectionMarkers: Array.isArray(rules.latenessSubsectionMarkers) && rules.latenessSubsectionMarkers.length
      ? rules.latenessSubsectionMarkers.map(item => normalizeReportSpaces(item).toUpperCase())
      : DEFAULT_LATENESS_REPORT_OPTIONS.subsectionMarkers
  };
}

function parseLatenessReport(text = '', rules = {}) {
  const options = getLatenessReportOptions(rules);
  const lines = String(text || '').split(/\r?\n/);

  const result = {
    stores: [],
    totals: {
      stores: 0,
      items: 0,
      headerTotal: 0,
      aging: {},
      status: {
        completed: 0,
        incomplete: 0,
        mixed: 0,
        unknown: 0
      },
      types: {
        custom: 0,
        ready_stock: 0,
        unknown: 0
      }
    },
    unmatchedLines: [],
    formatFindings: []
  };

  let currentStore = null;
  let currentAging = null;
  let currentSubsection = null;

  for (let index = 0; index < lines.length; index += 1) {
    const rawLine = lines[index];
    const cleaned = cleanReportLine(rawLine);
    if (!cleaned) continue;
    if (isIgnorableReportLine(cleaned)) continue;

    const storeHeader = parseStoreHeaderLine(cleaned);
    if (storeHeader) {
      currentStore = createLatenessStoreBucket(storeHeader);
      result.stores.push(currentStore);
      result.totals.stores += 1;
      result.totals.headerTotal += storeHeader.totalInHeader;
      currentAging = null;
      currentSubsection = null;

      if (storeHeader.typoVariant) {
        currentStore.notes.push('Header memakai typo "ketelambatan".');
      }
      continue;
    }

    const agingHeader = parseAgingHeaderLine(cleaned);
    if (agingHeader) {
      currentAging = agingHeader.label;
      currentSubsection = null;
      continue;
    }

    const subsection = parseSubsectionHeaderLine(cleaned, options);
    if (subsection) {
      currentSubsection = subsection;
      continue;
    }

    const item = parseNumberedReportLine(cleaned);
    if (item && currentStore) {
      const entryType = classifyLatenessEntryType(item.content);
      const status = extractLatenessStatus(item.content, options);
      const bucketAging = currentAging || 'NO_H_PLUS';
      const bucketSubsection = currentSubsection || 'GENERAL';

      const entry = {
        lineNumber: index + 1,
        itemNo: item.itemNo,
        aging: bucketAging,
        subsection: bucketSubsection,
        type: entryType,
        status,
        raw: cleaned,
        content: item.content
      };

      currentStore.items.push(entry);
      currentStore.itemCount += 1;
      currentStore.agingCounts[bucketAging] = (currentStore.agingCounts[bucketAging] || 0) + 1;
      currentStore.subsectionCounts[bucketSubsection] = (currentStore.subsectionCounts[bucketSubsection] || 0) + 1;
      currentStore.statusCounts[status.label] = (currentStore.statusCounts[status.label] || 0) + 1;
      currentStore.typeCounts[entryType] = (currentStore.typeCounts[entryType] || 0) + 1;

      result.totals.items += 1;
      result.totals.aging[bucketAging] = (result.totals.aging[bucketAging] || 0) + 1;
      result.totals.status[status.label] = (result.totals.status[status.label] || 0) + 1;
      result.totals.types[entryType] = (result.totals.types[entryType] || 0) + 1;
      continue;
    }

    result.unmatchedLines.push({
      lineNumber: index + 1,
      raw: cleaned,
      contextStore: currentStore?.header?.storeLabel || null
    });
  }

  for (const store of result.stores) {
    store.mismatchWithHeader = store.itemCount - store.header.totalInHeader;

    if (store.header.totalInHeader !== store.itemCount) {
      store.notes.push(`Jumlah header ${store.header.totalInHeader} tidak sama dengan item terbaca ${store.itemCount}.`);
    }

    if (!Object.keys(store.agingCounts).length) {
      store.notes.push('Belum ada bucket H+ yang terbaca.');
    }

    if (store.agingCounts.NO_H_PLUS) {
      store.notes.push(`${store.agingCounts.NO_H_PLUS} item tidak berada di bawah header H+.`);
    }
  }

  if (result.unmatchedLines.length) {
    result.formatFindings.push({
      code: 'UNMATCHED_LINES',
      count: result.unmatchedLines.length,
      example: result.unmatchedLines[0]?.raw || ''
    });
  }

  const quotedItems = result.stores.flatMap(store => store.items).filter(item => isQuotedWholeLine(item.raw));
  if (quotedItems.length) {
    result.formatFindings.push({
      code: 'QUOTED_ITEM_LINES',
      count: quotedItems.length,
      example: quotedItems[0]?.raw || ''
    });
  }

  const typoStores = result.stores.filter(store => store.header.typoVariant);
  if (typoStores.length) {
    result.formatFindings.push({
      code: 'HEADER_TYPO_KETELAMBATAN',
      count: typoStores.length,
      example: typoStores[0]?.header?.raw || ''
    });
  }

  const noHPlusStores = result.stores.filter(store => store.agingCounts.NO_H_PLUS);
  if (noHPlusStores.length) {
    result.formatFindings.push({
      code: 'STORE_WITHOUT_H_PLUS_BLOCK',
      count: noHPlusStores.length,
      example: noHPlusStores[0]?.header?.raw || ''
    });
  }

  return result;
}

function isLikelyLatenessReportText(text = '', rules = {}) {
  const parsed = parseLatenessReport(text, rules);
  return parsed.stores.length > 0 && parsed.totals.items > 0;
}

function buildLatenessStructuredPayload(parsed, context = {}) {
  const now = getTimestamp();
  const summary = {
    at: now,
    group_name: context.groupName || '',
    sender: context.sender || '',
    message_id: context.messageId || '',
    store_count: parsed.totals.stores,
    header_total: parsed.totals.headerTotal,
    item_total: parsed.totals.items,
    completed_total: parsed.totals.status.completed,
    incomplete_total: parsed.totals.status.incomplete,
    mixed_total: parsed.totals.status.mixed,
    unknown_total: parsed.totals.status.unknown,
    aging_summary: buildCompactAgingSummary(parsed.totals.aging),
    findings: JSON.stringify(parsed.formatFindings || [])
  };

  const items = [];
  for (const store of parsed.stores) {
    for (const item of store.items) {
      items.push({
        at: now,
        group_name: context.groupName || '',
        sender: context.sender || '',
        message_id: context.messageId || '',
        store_label: store.header.storeLabel || '',
        store_header_total: store.header.totalInHeader || 0,
        item_no: item.itemNo || 0,
        aging: item.aging || '',
        subsection: item.subsection || '',
        type: item.type || '',
        status: item.status?.label || 'unknown',
        line_number: item.lineNumber || 0,
        content: item.content || '',
        raw: item.raw || ''
      });
    }
  }

  return { summary, items };
}

function buildCompactAgingSummary(agingCounts = {}) {
  const entries = Object.entries(agingCounts || {})
    .sort((a, b) => {
      const aIsNoBucket = a[0] === 'NO_H_PLUS';
      const bIsNoBucket = b[0] === 'NO_H_PLUS';
      if (aIsNoBucket !== bIsNoBucket) {
        return aIsNoBucket ? 1 : -1;
      }

      const aNum = Number(String(a[0]).replace(/\D+/g, ''));
      const bNum = Number(String(b[0]).replace(/\D+/g, ''));
      if (Number.isNaN(aNum) || Number.isNaN(bNum)) return a[0].localeCompare(b[0]);
      return aNum - bNum;
    })
    .map(([label, count]) => `${label}=${count}`);

  return entries.length ? entries.join(', ') : '-';
}

function buildLatenessSummaryMessage(parsed, options = {}) {
  const title = options.title || '📊 *REKAP LAPORAN KETERLAMBATAN*';
  const subtitle = options.subtitle || '';
  const storeLimit = Math.max(1, Number(options.storeLimit || 12));
  const emptyMessage = options.emptyMessage || 'Belum ada data laporan keterlambatan.';
  const lines = [title];

  if (subtitle) {
    lines.push(subtitle);
  }

  if (!parsed?.stores?.length) {
    lines.push(emptyMessage);
    return lines.join('\n').trim();
  }

  lines.push(`Toko: ${parsed.totals.stores} | Header: ${parsed.totals.headerTotal} | Item: ${parsed.totals.items}`);
  lines.push(`Aging: ${buildCompactAgingSummary(parsed.totals.aging)}`);
  lines.push(`Status: ✅ ${parsed.totals.status.completed} | ❌ ${parsed.totals.status.incomplete} | ? ${parsed.totals.status.unknown} | mix ${parsed.totals.status.mixed}`);
  lines.push('');
  lines.push('*Per toko:*');

  parsed.stores.slice(0, storeLimit).forEach((store, index) => {
    const mismatchTag = store.mismatchWithHeader === 0
      ? ''
      : ` | selisih ${store.mismatchWithHeader > 0 ? '+' : ''}${store.mismatchWithHeader}`;
    const agingSummary = buildCompactAgingSummary(store.agingCounts);
    const statusSummary = `✅${store.statusCounts.completed} ❌${store.statusCounts.incomplete} ?${store.statusCounts.unknown}`;
    lines.push(`${index + 1}. ${store.header.storeLabel}: ${store.itemCount}/${store.header.totalInHeader}${mismatchTag} | ${agingSummary} | ${statusSummary}`);
  });

  if (parsed.stores.length > storeLimit) {
    lines.push(`...dan ${parsed.stores.length - storeLimit} toko lainnya`);
  }

  const notes = [];
  const mismatchStores = parsed.stores.filter(store => store.mismatchWithHeader !== 0);
  if (mismatchStores.length) {
    notes.push(`Mismatch header/item: ${mismatchStores.map(store => `${store.header.storeLabel} ${store.header.totalInHeader}->${store.itemCount}`).join(', ')}`);
  }

  const noHPlusStores = parsed.stores.filter(store => Number(store.agingCounts?.NO_H_PLUS || 0) > 0);
  if (noHPlusStores.length) {
    notes.push(`Tanpa bucket H+: ${noHPlusStores.map(store => store.header.storeLabel).join(', ')}`);
  }

  const typoStores = parsed.stores.filter(store => store.header.typoVariant);
  if (typoStores.length) {
    notes.push(`Typo header: ${typoStores.map(store => store.header.storeLabel).join(', ')}`);
  }

  if (notes.length) {
    lines.push('');
    lines.push('*Temuan format:*');
    notes.forEach(note => lines.push(`- ${note}`));
  }

  return lines.join('\n').trim();
}

function normalizeTokenText(token = '') {
  return String(token).replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9]+$/g, '');
}

function isLikelyTrackingToken(token = '') {
  const cleaned = normalizeTokenText(token);
  return cleaned.length >= 6 && /[A-Za-z]/i.test(cleaned) && /\d/.test(cleaned);
}

function stripTrailingTrackingTokens(text = '') {
  const tokens = splitTokens(text);
  let end = tokens.length;

  while (end > 0 && isLikelyTrackingToken(tokens[end - 1])) {
    end -= 1;
  }

  return normalizeSpaces(tokens.slice(0, end).join(' '));
}

function stripHtmlTags(html = '') {
  return String(html)
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

function summarizeWebhookError(raw = '', statusCode = 0) {
  const text = String(raw || '');
  if (!text) return `Webhook error${statusCode ? ` (HTTP ${statusCode})` : ''}`;

  const lowered = text.toLowerCase();

  if (lowered.includes('<!doctype html') || lowered.includes('<html')) {
    const plain = stripHtmlTags(text).toLowerCase();

    if (plain.includes('akses ditolak') || plain.includes('anda memerlukan akses')) {
      return 'Webhook ditolak akses. Cek deployment Apps Script dan izin Web App.';
    }

    if (plain.includes('halaman tidak ditemukan')) {
      return 'Webhook tidak ditemukan. Cek URL deployment Apps Script.';
    }

    if (plain.includes('login') || plain.includes('sign in')) {
      return 'Webhook meminta login. Web App belum publik.';
    }

    return `Webhook mengembalikan HTML, bukan JSON${statusCode ? ` (HTTP ${statusCode})` : ''}.`;
  }

  const compact = stripHtmlTags(text);
  if (!compact) return `Webhook error${statusCode ? ` (HTTP ${statusCode})` : ''}`;
  return compact.length > 180 ? `${compact.slice(0, 180)}...` : compact;
}

function buildGroupWebhookErrorMessage(reason) {
  return `Gagal kirim ke sheet.\nAlasan: ${reason}`;
}

function buildTriggerRegex(trigger) {
  const t = String(trigger || '').toLowerCase().trim();
  if (!t) return null;

  if (t === 'job masuk') return /(^|[\s/,-])job\s*masuk(?=$|[\s/,-])/i;
  if (t === 'acc pertama') return /(^|[\s/,-])acc\s*pertama(?=$|[\s/,-])/i;
  if (t === 'acc per') return /(^|[\s/,-])acc\s*per(?=$|[\s/,-])/i;

  if (t === 'packing' || t === 'pack') return /(^|[\s/,-])pack(?:ing)?(?=$|[\s/,-]|\d)/i;
  if (t === 'checker') return /(^|[\s/,-])checker(?=$|[\s/,-]|\d)/i;
  if (t === 'cheker') return /(^|[\s/,-])cheker(?=$|[\s/,-]|\d)/i;
  if (t === 'potong') return /(^|[\s/,-])potong(?=$|[\s/,-]|\d)/i;
  if (t === 'ptng') return /(^|[\s/,-])ptng(?=$|[\s/,-]|\d)/i;
  if (t === 'pkg') return /(^|[\s/,-])pkg(?=$|[\s/,-]|\d)/i;
  if (t === 'fn') return /(^|[\s/,-])fn(?=$|[\s/,-]|\d)/i;
  if (t === 'cp') return /(^|[\s/,-])cp(?=$|[\s/,-]|\d)/i;
  if (t === 'ck') return /(^|[\s/,-])ck(?=$|[\s/,-]|\d)/i;
  if (t === 'pt') return /(^|[\s/,-])pt(?=$|[\s/,-]|\d)/i;
  if (t === 'pr') return /(^|[\s/,-])pr(?=$|[\s/,-]|\d)/i;
  if (t === 'prt') return /(^|[\s/,-])prt(?=$|[\s/,-]|\d)/i;
  if (t === 'print') return /(^|[\s/,-])print(?:ing)?(?=$|[\s/,-]|\d)/i;
  if (t === 'printing') return /(^|[\s/,-])print(?:ing)?(?=$|[\s/,-]|\d)/i;
  if (t === 'dm') return /(^|[\s/,-])dm(?=$|[\s/,-]|\d)/i;
  if (t === 'cs') return /(^|[\s/,-])cs(?=$|[\s/,-]|\d)/i;
  if (t === 'desain') return /(^|[\s/,-])desain(?=$|[\s/,-]|\d)/i;

  return new RegExp(`(^|[\\s/,-])${escapeRegex(t).replace(/\s+/g, '\\s*')}(?=$|[\\s/,-]|\\d)`, 'i');
}

function buildDivisionMatchers(divisionTriggers = {}) {
  const items = [];

  for (const [division, triggers] of Object.entries(divisionTriggers)) {
    for (const trigger of triggers || []) {
      const regex = buildTriggerRegex(trigger);
      if (!regex) continue;
      items.push({
        division,
        trigger,
        regex,
        length: String(trigger).length
      });
    }
  }

  items.sort((a, b) => b.length - a.length);
  return items;
}

function detectDivision(rawText, divisionTriggers = {}) {
  const matchers = buildDivisionMatchers(divisionTriggers);
  const source = normalizeSpaces(stripSquareBrackets(rawText));
  const slashIndex = source.lastIndexOf('/');
  const tail = slashIndex >= 0 ? source.slice(slashIndex + 1).trim() : source;

  for (const segment of [tail, source]) {
    for (const item of matchers) {
      if (item.regex.test(segment)) {
        return {
          division: item.division,
          trigger: item.trigger,
          sourceText: segment
        };
      }
    }
  }

  const setorPPInfo = detectSetorPPDivision(source);
  if (setorPPInfo) {
    return setorPPInfo;
  }

  return null;
}

function detectSetorPPDivision(rawText = '') {
  const source = normalizeSpaces(stripSquareBrackets(rawText));
  if (!/\bsetor\s*pp\b/i.test(source)) return null;

  const timeMatch = source.match(/\b(?:jam|jm)\s*(\d{1,2})[.:](\d{2})\b/i);
  if (!timeMatch) return null;

  const hour = Number(timeMatch[1]);
  const minute = Number(timeMatch[2]);
  if (Number.isNaN(hour) || Number.isNaN(minute)) return null;

  const totalMinutes = (hour * 60) + minute;
  const thresholdMinutes = (12 * 60) + 31;
  const isFinishing = totalMinutes < thresholdMinutes;

  return {
    division: isFinishing ? 'Finishing' : 'SMB',
    trigger: isFinishing ? 'setor pp < 12.31' : 'setor pp >= 12.31',
    sourceText: source
  };
}

function buildAnchorRegex(anchor) {
  const flexible = String(anchor)
    .trim()
    .split(/\s+/)
    .map(escapeRegex)
    .join('[\\s\\-_/]*');

  return new RegExp(`\\b${flexible}\\b`, 'i');
}

function findShippingCutIndex(text, anchors = []) {
  const content = String(text || '');
  let bestIndex = -1;

  for (const anchor of anchors) {
    const regex = buildAnchorRegex(anchor);
    const match = regex.exec(content);
    if (!match) continue;

    const remainder = content.slice(match.index);
    const looksMeta = /(?:\b\d{1,4}\b|\b[A-Z0-9]{4,20}\b|\bspx\b|\bjnt\b|\bjne\b|\bsicepat\b|\banteraja\b|\bkargo\b|\bcargo\b|\bstandard\b|\bcashless\b|\bhemat\b|\breguler\b|\bregular\b)/i.test(remainder);

    if (!looksMeta) continue;

    if (bestIndex === -1 || match.index < bestIndex) {
      bestIndex = match.index;
    }
  }

  return bestIndex;
}

function prepareBodySegment(text = '', rules = {}) {
  let body = stripSquareBrackets(text);
  const slashIndex = body.lastIndexOf('/');
  if (slashIndex >= 0) {
    body = body.slice(0, slashIndex);
  }

  body = stripRoundBrackets(body);

  const shippingCutIndex = findShippingCutIndex(body, rules.shippingAnchors || []);
  if (shippingCutIndex >= 0) {
    body = body.slice(0, shippingCutIndex);
  }

  const setorPPCutIndex = body.search(/\bsetor\s*pp\b/i);
  if (setorPPCutIndex >= 0) {
    body = body.slice(0, setorPPCutIndex);
  }

  body = normalizeSpaces(replaceSeparators(body));
  body = body.replace(/^\s*[-:]+\s*/, '');
  body = stripTrailingTrackingTokens(body);

  return {
    body,
    shippingCutFound: shippingCutIndex >= 0
  };
}

function scoreProductCandidate(candidateTokens, totalLength) {
  const tokens = candidateTokens || [];
  const len = tokens.length;
  const first = tokens[0] || '';
  const second = tokens[1] || '';
  const third = tokens[2] || '';
  const last = tokens[len - 1] || '';
  let score = 0;

  if (len === 1) score += 1;
  if (len === 2) score += 7;
  if (len === 3) score += 10;
  if (len === 4) score += 9;
  if (len === 5) score += 5;

  if (tokens.some(hasDigitToken)) score += 6;
  if (hasDigitToken(last)) score += 4;
  if (isShortUpper(first)) score += 2;
  if (isShortUpper(second)) score += 2;
  if (tokens.every(isWordLikeToken)) score += 1;

  if (first.includes('*')) score -= 7;

  if (len === 4 && isLongAlpha(first) && isLongAlpha(second) && isLongAlpha(third) && hasDigitToken(last)) {
    score -= 7;
  }

  if (len === 5 && isLongAlpha(first) && isLongAlpha(second) && hasDigitToken(last)) {
    score -= 8;
  }

  if (len === 4 && totalLength > len && isLongAlpha(first) && isShortUpper(second) && hasDigitToken(last)) {
    score -= 3;
  }

  if (len === 4 && totalLength === len && isLongAlpha(first) && isShortUpper(second) && hasDigitToken(last)) {
    score += 2;
  }

  score += (totalLength - len) * 0.5;

  return score;
}

function extractProductFromSegment(text) {
  const cleaned = normalizeSpaces(
    replaceSeparators(
      stripRoundBrackets(
        stripSquareBrackets(text)
      )
    )
  );

  const tokens = splitTokens(cleaned);
  if (!tokens.length) return '';

  const maxLen = Math.min(7, tokens.length);
  let best = null;

  for (let len = 1; len <= maxLen; len++) {
    const candidate = tokens.slice(tokens.length - len);
    const score = scoreProductCandidate(candidate, tokens.length);

    if (!best || score > best.score || (score === best.score && candidate.length > best.tokens.length)) {
      best = { score, tokens: candidate };
    }
  }

  return best ? normalizeSpaces(best.tokens.join(' ')) : '';
}

function extractOrderDateTime(text = '') {
  const source = normalizeSpaces(stripSquareBrackets(text));
  const orderMatch = source.match(/\border\s+(\d{1,2})\s+jam\s+(\d{1,2})[.:](\d{2})\b/i);
  if (!orderMatch) return null;

  const day = Number(orderMatch[1]);
  const hour = Number(orderMatch[2]);
  const minute = Number(orderMatch[3]);
  
  if (Number.isNaN(day) || Number.isNaN(hour) || Number.isNaN(minute)) return null;
  if (day < 1 || day > 31 || hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;

  return {
    day,
    hour,
    minute,
    totalMinutes: (hour * 60) + minute,
    isBeforeNoon: hour < 12,
    raw: orderMatch[0]
  };
}

function extractSetorPPDateTime(text = '') {
  const source = normalizeSpaces(stripSquareBrackets(text));
  const setorMatch = source.match(/\bsetor\s*pp\s+tgl\s+(\d{1,2})\s+jam\s+(\d{1,2})[.:](\d{2})\b/i) ||
                      source.match(/\bsetor\s*pp\s+(\d{1,2})\s+jam\s+(\d{1,2})[.:](\d{2})\b/i);
  
  if (!setorMatch) return null;

  let day, hour, minute;
  if (setorMatch[0].includes('tgl')) {
    day = Number(setorMatch[1]);
    hour = Number(setorMatch[2]);
    minute = Number(setorMatch[3]);
  } else {
    day = Number(setorMatch[1]);
    hour = Number(setorMatch[2]);
    minute = Number(setorMatch[3]);
  }
  
  if (Number.isNaN(day) || Number.isNaN(hour) || Number.isNaN(minute)) return null;
  if (day < 1 || day > 31 || hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;

  return {
    day,
    hour,
    minute,
    totalMinutes: (hour * 60) + minute,
    isAfterNoon: (hour * 60) + minute >= (12 * 60) + 30,
    raw: setorMatch[0]
  };
}

function determinePJDivisionAdvanced(orderDT, setorDT) {
  if (!orderDT || !setorDT) return null;

  const orderIsBeforeNoon = orderDT.hour < 12;
  const setorTotalMin = setorDT.totalMinutes;
  const thresholdMin = (12 * 60) + 30;
  const setorIsAfterThreshold = setorTotalMin > thresholdMin;
  const isNextDay = setorDT.day > orderDT.day;
  const isSameDay = setorDT.day === orderDT.day;

  let division = null;
  let trigger = null;

  // Rule 1: Order SEBELUM jam 12:00
  if (orderIsBeforeNoon) {
    // Setor PP HARUS hari yang sama
    if (!isSameDay) {
      return {
        division: 'Finishing',
        trigger: `⚠️ anomali: order pagi tapi setor tgl berikutnya → Finishing (default)`,
        orderDateTime: orderDT,
        setorDateTime: setorDT,
        isAnomalousCase: true
      };
    }
    
    // Setor hari sama, lihat jamnya
    if (setorIsAfterThreshold) {
      division = 'SMB';
      trigger = `order pagi tgl ${orderDT.day}, setor hari sama jam ${setorDT.hour}:${String(setorDT.minute).padStart(2, '0')} > 12:30 → SMB`;
    } else {
      division = 'Finishing';
      trigger = `order pagi tgl ${orderDT.day}, setor hari sama jam ${setorDT.hour}:${String(setorDT.minute).padStart(2, '0')} ≤ 12:30 → Finishing`;
    }
  }
  
  // Rule 2: Order SETELAH jam 12:00
  else {
    // Setor PP HARUS hari berikutnya
    if (isSameDay) {
      return {
        division: 'Finishing',
        trigger: `⚠️ anomali: order sore tapi setor hari sama tgl ${setorDT.day} jam ${setorDT.hour}:${String(setorDT.minute).padStart(2, '0')} → Finishing (special case)`,
        orderDateTime: orderDT,
        setorDateTime: setorDT,
        isAnomalousCase: true
      };
    }
    
    if (!isNextDay) {
      return {
        division: 'Finishing',
        trigger: `⚠️ error: order tgl ${orderDT.day}, setor tgl ${setorDT.day} (tidak sesuai aturan) → Finishing`,
        orderDateTime: orderDT,
        setorDateTime: setorDT,
        isAnomalousCase: true
      };
    }
    
    // Setor hari besok, lihat jamnya
    if (setorIsAfterThreshold) {
      division = 'SMB';
      trigger = `order sore tgl ${orderDT.day}, setor besok tgl ${setorDT.day} jam ${setorDT.hour}:${String(setorDT.minute).padStart(2, '0')} > 12:30 → SMB`;
    } else {
      division = 'Finishing';
      trigger = `order sore tgl ${orderDT.day}, setor besok tgl ${setorDT.day} jam ${setorDT.hour}:${String(setorDT.minute).padStart(2, '0')} ≤ 12:30 → Finishing`;
    }
  }

  return {
    division,
    trigger,
    orderDateTime: orderDT,
    setorDateTime: setorDT,
    isAnomalousCase: false
  };
}

function computeConfidence(parsed) {
  let score = 0;

  if (parsed.type === 'custom' && parsed.kode_job_resi) score += 25;
  if (parsed.type === 'ready' && parsed.ready_stock) score += 25;
  if (parsed.produk) score += parsed.produk.split(' ').length >= 2 ? 30 : 18;
  if (parsed.pj_divisi) score += 25;
  if (parsed.meta?.hasSlash) score += 10;
  if (parsed.meta?.shippingCutFound) score += 10;

  return score;
}

function parseCustomLine(line, rules) {
  const original = normalizeSpaces(cleanLinePrefix(line));
  const head = original.match(/^([A-Z]{2,3}\s\d{1,5})\b\s*(.+)$/i);
  if (!head) return null;

  const kodeJob = upperCode(head[1]);
  let rest = head[2];

  // Coba ekstrak order time dan setor PP time untuk logic keputusan advanced
  const orderDT = extractOrderDateTime(original);
  const setorDT = extractSetorPPDateTime(original);
  
  // Jika ada order time dan setor PP time, gunakan logic advanced
  let divisionInfo = null;
  if (orderDT && setorDT) {
    const advancedPJ = determinePJDivisionAdvanced(orderDT, setorDT);
    if (advancedPJ) {
      divisionInfo = {
        division: advancedPJ.division,
        trigger: advancedPJ.trigger
      };
    }
  }

  // Jika belum ada divisionInfo, gunakan logic standar
  if (!divisionInfo) {
    divisionInfo = detectDivision(rest, rules.divisionTriggers);
  }

  if (!divisionInfo) {
    return {
      error: 'Trigger divisi tidak ditemukan.',
      raw_text: original,
      type: 'custom'
    };
  }

  const hasSlash = rest.includes('/');
  const prepared = prepareBodySegment(rest, rules);
  const produk = extractProductFromSegment(prepared.body);

  const parsed = {
    type: 'custom',
    tanggal: getTimestamp(),
    kode_job_resi: kodeJob,
    ready_stock: '',
    produk,
    pj_divisi: divisionInfo.division,
    banding: '',
    raw_text: original,
    meta: {
      matchedTrigger: divisionInfo.trigger,
      hasSlash,
      shippingCutFound: prepared.shippingCutFound,
      orderDateTime: orderDT,
      setorDateTime: setorDT,
      usesAdvancedLogic: !!(orderDT && setorDT)
    }
  };

  parsed.confidence = computeConfidence(parsed);

  if (!parsed.produk) {
    return {
      error: 'Produk tidak berhasil diekstrak.',
      raw_text: original,
      type: 'custom',
      meta: parsed.meta
    };
  }

  if (parsed.confidence < rules.minConfidence) {
    return {
      error: `Confidence terlalu rendah (${parsed.confidence}).`,
      raw_text: original,
      type: 'custom',
      meta: parsed.meta
    };
  }

  return parsed;
}

function parseReadyLine(line, rules) {
  const original = normalizeSpaces(cleanLinePrefix(line));
  const readyCandidate = normalizeReadyStockCandidate(original);
  if (!readyCandidate) return null;

  const readyCode = readyCandidate.code;
  let rest = readyCandidate.rest;

  // Coba ekstrak order time dan setor PP time untuk logic keputusan advanced
  const orderDT = extractOrderDateTime(original);
  const setorDT = extractSetorPPDateTime(original);
  
  // Jika ada order time dan setor PP time, gunakan logic advanced
  let divisionInfo = null;
  if (orderDT && setorDT) {
    const advancedPJ = determinePJDivisionAdvanced(orderDT, setorDT);
    if (advancedPJ) {
      divisionInfo = {
        division: advancedPJ.division,
        trigger: advancedPJ.trigger
      };
    }
  }

  // Jika belum ada divisionInfo, gunakan logic standar
  if (!divisionInfo) {
    divisionInfo = detectDivision(rest, rules.divisionTriggers);
  }

  if (!divisionInfo) {
    return {
      error: 'Trigger divisi tidak ditemukan pada ready stock.',
      raw_text: original,
      type: 'ready'
    };
  }

  const hasSlash = rest.includes('/');
  const prepared = prepareBodySegment(rest, rules);
  const produk = prepared.body;

  const parsed = {
    type: 'ready',
    tanggal: getTimestamp(),
    kode_job_resi: '',
    ready_stock: readyCode,
    produk,
    pj_divisi: divisionInfo.division,
    banding: '',
    raw_text: original,
    meta: {
      matchedTrigger: divisionInfo.trigger,
      hasSlash,
      shippingCutFound: prepared.shippingCutFound,
      orderDateTime: orderDT,
      setorDateTime: setorDT,
      usesAdvancedLogic: !!(orderDT && setorDT)
    }
  };

  parsed.confidence = computeConfidence(parsed);

  if (!parsed.produk) {
    return {
      error: 'Produk ready stock kosong.',
      raw_text: original,
      type: 'ready',
      meta: parsed.meta
    };
  }

  if (parsed.confidence < rules.minConfidence) {
    return {
      error: `Confidence ready stock terlalu rendah (${parsed.confidence}).`,
      raw_text: original,
      type: 'ready',
      meta: parsed.meta
    };
  }

  return parsed;
}

function isCompletedHandledLine(line, rules = {}) {
  if (rules.ignoreCompletedLateness === false) return false;

  const source = String(line || '');
  if (!source) return false;

  const completedMarkers = rules.completedMarkers || ['✅', '☑️', '✔️', '✔'];
  if (!hasAnyMarker(source, completedMarkers)) return false;

  const cleaned = normalizeSpaces(cleanLinePrefix(source));
  if (!looksLikeOperasionalLine(cleaned)) return false;

  return Boolean(detectDivision(cleaned, rules.divisionTriggers));
}

function parseLine(line, rules) {
  const cleaned = normalizeSpaces(cleanLinePrefix(line));
  if (!cleaned) return null;

  if (isHeaderLine(cleaned)) {
    return null;
  }

  if (isCompletedHandledLine(line, rules)) {
    return null;
  }

  if (hasLineNumberPrefix(line) && !looksLikeOperasionalLine(cleaned)) {
    return null;
  }

  if (isCustomCodeStart(cleaned)) {
    return parseCustomLine(cleaned, rules);
  }

  if (normalizeReadyStockCandidate(cleaned)) {
    return parseReadyLine(cleaned, rules);
  }

  return null;
}

async function safeReact(sock, jid, key, emoji) {
  try {
    await new Promise(resolve => setTimeout(resolve, 1200));
    await sock.sendMessage(jid, { react: { text: emoji, key } });
  } catch (error) {
    console.error(`⚠️ Gagal react ${emoji}:`, error.message);
  }
}

function ensureDirForFile(filePath) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function isWebhookLikeReason(reason = '') {
  return /Webhook|Respons JSON|Unauthorized|HTTP/i.test(String(reason || ''));
}

function buildFailedLinesReply(failedLines = []) {
  const preview = failedLines.slice(0, 8);
  if (!preview.length) return '';

  const errorMessages = Array.from(new Set(preview.map(x => x.reason)));

  if (errorMessages.length === 1 && isWebhookLikeReason(errorMessages[0])) {
    return buildGroupWebhookErrorMessage(errorMessages[0]);
  }

  return [
    'Baris gagal diproses:',
    '',
    ...preview.map((x, i) => `${i + 1}. ${x.line} -> ${x.reason}`),
    preview.length < failedLines.length ? `...dan ${failedLines.length - preview.length} baris lainnya` : ''
  ].filter(Boolean).join('\n');
}

function writeLocalLog(logPath, record) {
  try {
    ensureDirForFile(logPath);
    fs.appendFileSync(logPath, JSON.stringify(record) + '\n', 'utf8');
  } catch (error) {
    console.error('⚠️ Gagal menulis local log:', error.message);
  }
}

async function sendLogToWebhook(record, rules) {
  if (!rules.sendLogsToSheet) return;

  try {
    await fetch(rules.webhook, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'appendLog',
        token: rules.token,
        spreadsheetId: rules.spreadsheetId,
        logSuccessSheetName: rules.logSuccessSheetName,
        logErrorSheetName: rules.logErrorSheetName,
        record
      })
    });
  } catch (error) {
    console.error('⚠️ Gagal kirim log ke Apps Script:', error.message);
  }
}

function createWebhookError(message, options = {}) {
  const error = new Error(message);
  error.safeMessage = message;
  error.retryable = Boolean(options.retryable);
  error.statusCode = options.statusCode || 0;
  error.kind = options.kind || 'unknown';
  error.raw = options.raw || '';
  return error;
}

function isRetryableStatus(statusCode = 0) {
  return statusCode === 408 || statusCode === 425 || statusCode === 429 || statusCode >= 500;
}

function isRetryableMessage(message = '') {
  return /timeout|temporar|service unavailable|coba lagi|rate limit/i.test(String(message || ''));
}

function getSafeWebhookReason(error) {
  if (error?.safeMessage) return error.safeMessage;
  return summarizeWebhookError(error?.message || String(error), error?.statusCode || 0);
}

function shouldRetryWebhook(error) {
  return Boolean(error?.retryable);
}

async function sendDataToWebhook(payload, rules) {
  const requestPayload = {
    action: 'appendData',
    token: rules.token,
    spreadsheetId: rules.spreadsheetId,
    sheetName: payload.sheetName || getCurrentSheetName(rules),
    autoCreateSheet: rules.autoCreateMonthlySheet !== false,
    sheetTemplateName: rules.monthlySheetTemplateName || '',
    columns: rules.columns,
    ...payload
  };

  let res;
  try {
    res = await fetch(rules.webhook, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(requestPayload)
    });
  } catch (error) {
    throw createWebhookError('Webhook tidak bisa dihubungi.', {
      retryable: true,
      kind: 'network',
      raw: String(error.message || error)
    });
  }

  const raw = await res.text();
  const contentType = (res.headers.get('content-type') || '').toLowerCase();

  let data = null;

  if (contentType.includes('application/json')) {
    try {
      data = JSON.parse(raw);
    } catch {
      throw createWebhookError(`Respons JSON tidak valid dari webhook (HTTP ${res.status})`, {
        statusCode: res.status,
        retryable: isRetryableStatus(res.status),
        kind: 'invalid_json',
        raw
      });
    }
  } else {
    try {
      data = JSON.parse(raw);
    } catch {
      data = null;
    }
  }

  if (!res.ok) {
    throw createWebhookError(summarizeWebhookError(raw, res.status), {
      statusCode: res.status,
      retryable: isRetryableStatus(res.status),
      kind: 'http',
      raw
    });
  }

  if (!data) {
    throw createWebhookError(summarizeWebhookError(raw, res.status), {
      statusCode: res.status,
      retryable: false,
      kind: 'empty_response',
      raw
    });
  }

  if (data.success === false) {
    const message = summarizeWebhookError(data.message || raw, res.status);
    throw createWebhookError(message, {
      statusCode: res.status,
      retryable: isRetryableStatus(res.status) || isRetryableMessage(message),
      kind: 'app_error',
      raw: data.message || raw
    });
  }

  return data;
}

function enqueueRetryItem(rules, item) {
  updateRuntimeState(rules, state => {
    const exists = state.retryQueue.some(queueItem => queueItem.dedupKey && queueItem.dedupKey === item.dedupKey);
    if (!exists) {
      state.retryQueue.push(item);
    }
  });
}

function removeRetryItem(rules, itemId) {
  updateRuntimeState(rules, state => {
    state.retryQueue = state.retryQueue.filter(item => item.id !== itemId);
  });
}

async function processRetryQueue(rules) {
  if (retryQueueInProgress) return;

  retryQueueInProgress = true;
  try {
    const dueItems = getRuntimeState(rules).retryQueue
      .filter(item => Number(item.nextAttemptAt || 0) <= Date.now())
      .sort((a, b) => Number(a.nextAttemptAt || 0) - Number(b.nextAttemptAt || 0));

    for (const item of dueItems) {
      try {
        await sendDataToWebhook(item.payload, rules);

        incrementDivisionSuccess(rules, item.dayKey, item.parsed?.pj_divisi);
        markDedupEntry(rules, item.dedupKey, 'success', { itemId: item.id });
        removeRetryItem(rules, item.id);

        const retrySuccessRecord = createLogRecord(
          'SUCCESS_RETRY',
          'Retry webhook berhasil.',
          item.context,
          item.parsed,
          {
            cleanedLine: item.context.cleanedLine,
            dedupKey: item.dedupKey,
            sheetName: item.payload.sheetName
          }
        );

        await writeAndSendLog(retrySuccessRecord, rules);
      } catch (error) {
        const safeReason = getSafeWebhookReason(error);
        const retryable = shouldRetryWebhook(error);

        const exhausted = updateRuntimeState(rules, state => {
          const queueItem = state.retryQueue.find(entry => entry.id === item.id);
          if (!queueItem) return true;

          queueItem.attemptCount = Number(queueItem.attemptCount || 1) + 1;
          queueItem.lastError = safeReason;
          queueItem.lastAttemptAt = new Date().toISOString();

          if (!retryable || queueItem.attemptCount >= getRetryMaxAttempts(rules)) {
            state.retryQueue = state.retryQueue.filter(entry => entry.id !== item.id);
            return true;
          }

          queueItem.nextAttemptAt = Date.now() + getRetryDelayMs(rules);
          return false;
        });

        if (exhausted) {
          clearDedupEntry(rules, item.dedupKey);

          const exhaustedRecord = createLogRecord(
            'RETRY_EXHAUSTED',
            safeReason,
            item.context,
            item.parsed,
            {
              cleanedLine: item.context.cleanedLine,
              dedupKey: item.dedupKey,
              raw_error: String(error.stack || error.message || '').slice(0, 4000),
              sheetName: item.payload.sheetName
            }
          );

          await writeAndSendLog(exhaustedRecord, rules);
          await sendReportGroupLog(activeSock, rules, item.context, [], [
            {
              line: item.context.cleanedLine || item.context.line || '-',
              reason: safeReason
            }
          ]);
        }
      }
    }
  } finally {
    retryQueueInProgress = false;
  }
}

function startBackgroundWorkers(rules) {
  if (!retryQueueTimer) {
    retryQueueTimer = setInterval(() => {
      processRetryQueue(rules).catch(error => {
        console.error('⚠️ Retry queue worker error:', error.message);
      });
    }, getRetryWorkerIntervalMs(rules));
  }

  if (!dailySummaryTimer) {
    dailySummaryTimer = setInterval(() => {
      maybeSendDailySummary(activeSock, rules).catch(error => {
        console.error('?????? Daily summary worker error:', error.message);
      });
      maybeSendLatenessSummary(activeSock, rules).catch(error => {
        console.error('Lateness summary worker error:', error.message);
      });
    }, 60000);
  }

  processRetryQueue(rules).catch(error => {
    console.error('⚠️ Retry queue worker error:', error.message);
  });

  maybeSendDailySummary(activeSock, rules).catch(error => {
    console.error('?????? Daily summary worker error:', error.message);
  });

  maybeSendLatenessSummary(activeSock, rules).catch(error => {
    console.error('Lateness summary worker error:', error.message);
  });
}

async function connectToWhatsApp() {
  startWatchdog();
  const rules = appConfig.operasional;
  startBackgroundWorkers(rules);

  const {
    default: makeWASocket,
    useMultiFileAuthState,
    DisconnectReason,
    fetchLatestBaileysVersion
  } = await import('@whiskeysockets/baileys');

  const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');
  const { version, isLatest } = await fetchLatestBaileysVersion();

  console.log(`🔄 Menggunakan WA v${version.join('.')}, isLatest: ${isLatest}`);

  const sock = makeWASocket({
    version,
    auth: state,
    printQRInTerminal: false,
    logger: pino({ level: 'silent' }),
    browser: ['OperasionalBot', 'Chrome', '3.0.0'],
    keepAliveIntervalMs: 10000,
    markOnlineOnConnect: true,
    connectTimeoutMs: 60000,
    getMessage: async key => messageCache.get(key.id) || undefined
  });

  sock.ev.on('connection.update', update => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      console.log('📲 QR Code muncul, silakan scan.');
      qrcode.generate(qr, { small: true });
      stopWatchdog();
    }

    if (connection === 'close') {
      if (activeSock === sock) {
        activeSock = null;
      }

      const shouldReconnect =
        (lastDisconnect?.error instanceof Boom)?.output?.statusCode !== DisconnectReason.loggedOut;

      console.log('⚠️ Koneksi terputus. Reconnect:', shouldReconnect);

      if (shouldReconnect) {
        startWatchdog();
        connectToWhatsApp();
      } else {
        console.log('❌ Sesi logout. Hapus folder auth_info_baileys lalu scan ulang.');
        process.exit(1);
      }
    } else if (connection === 'open') {
      activeSock = sock;
      stopWatchdog();
      console.log('✅ Bot operasional siap menerima pesan.');
    }
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('messages.upsert', async event => {
    if (event.type !== 'notify') return;

    const msg = event.messages[0];
    if (!msg?.message || msg.key?.fromMe) return;

    if (msg.key?.id) {
      messageCache.set(msg.key.id, msg.message);
      if (messageCache.size > 1000) {
        messageCache.delete(messageCache.keys().next().value);
      }
    }

    const text =
      msg.message?.conversation ||
      msg.message?.extendedTextMessage?.text ||
      msg.message?.imageMessage?.caption ||
      msg.message?.videoMessage?.caption ||
      msg.message?.documentMessage?.caption ||
      '';

    if (!text) return;

    const from = msg.key.remoteJid;
    const isGroup = from.endsWith('@g.us');
    if (!isGroup) return;

    const reply = async teks => {
      await sock.sendMessage(from, { text: teks }, { quoted: msg });
    };

    let groupName = '';
    if (groupNameCache.has(from)) {
      groupName = groupNameCache.get(from);
    } else {
      try {
        const meta = await sock.groupMetadata(from);
        groupName = String(meta?.subject || '').toLowerCase();
        groupNameCache.set(from, groupName);
      } catch (error) {
        console.warn('⚠️ Gagal memuat metadata grup:', error.message);
        return;
      }
    }

    const allowed = (rules.groupKeywords || []).some(keyword =>
      groupName.includes(String(keyword).toLowerCase())
    );

    if (!allowed) return;
    rememberKnownGroup(rules, from, groupName);

    const trimmed = text.trim();
    const notificationConfig = getNotificationConfig(rules);

    if (trimmed === '!ping') {
      return reply('? Bot aktif.');
    }

    if (trimmed === '!status') {
      const reportGroupStatus = notificationConfig.reportGroupJid ? 'set' : 'belum diset';
      const latenessTimes = normalizeScheduleTimes(getLatenessSummaryConfig(rules).times, ['06:00', '16:30']).join(', ');
      return reply(
        `? Bot aktif.
?? Server: ${getTimestamp()}
?? Mode: Operasional Parser
??? Sheet: ${getCurrentSheetName(rules)}
?? Retry Queue: ${getRetryQueueLength(rules)}
?? Grup operasional: ${notificationConfig.operationalGroupMode || 'reply'}
?? Report group: ${reportGroupStatus}
?? Rekap keterlambatan: ${latenessTimes} WIB`
      );
    }

    if (trimmed === '!groupid') {
      return reply(`?? Nama grup: ${groupName}
?? JID: ${from}`);
    }

    if (isLikelyLatenessReportText(text, rules)) {
      const parsedReport = parseLatenessReport(text, rules);
      const summaryMessage = buildLatenessSummaryMessage(parsedReport);
      const latenessContext = {
        groupJid: from,
        groupName,
        sender: msg.pushName || msg.key.participant || from,
        messageId: msg.key?.id || ''
      };

      rememberLatenessReportSnapshot(rules, parsedReport, latenessContext);

      const reportRecord = createLogRecord(
        'LATENESS_REPORT',
        `stores=${parsedReport.totals.stores}, items=${parsedReport.totals.items}, incomplete=${parsedReport.totals.status.incomplete}`,
        {
          groupName: latenessContext.groupName,
          sender: latenessContext.sender,
          messageId: latenessContext.messageId,
          line: '[message lateness report]',
          cleanedLine: summaryMessage
        },
        {
          type: 'lateness_report',
          raw_text: text,
          meta: {
            reportTotals: parsedReport.totals,
            formatFindings: parsedReport.formatFindings
          }
        },
        {
          cleanedLine: summaryMessage
        }
      );

      await writeAndSendLog(reportRecord, rules);
      try {
        await sendLatenessReportToWebhook(parsedReport, latenessContext, rules);
      } catch (error) {
        console.error('Gagal kirim lateness report ke sheet:', error.message);
      }
      return;
    }

    const sender = msg.pushName || msg.key.participant || from;
    const senderPrivateJid = getSenderPrivateJid(msg);
    const messageId = msg.key?.id || '';
    const lines = text.split('\n').map(x => x.trim()).filter(Boolean);
    const dayKey = getDateKey(rules.timeZone || BOT_TIMEZONE);

    let successCount = 0;
    const parseErrorsForSender = [];
    const reportParseErrors = [];
    const reportWebhookErrors = [];

    for (const line of lines) {
      const cleanedLine = normalizeSpaces(cleanLinePrefix(line));
      const lineContext = {
        groupName,
        sender,
        messageId,
        line,
        cleanedLine
      };

      if (!cleanedLine) continue;
      if (isHeaderLine(cleanedLine)) continue;

      const parsed = parseLine(line, rules);
      if (!parsed) continue;

      if (parsed.error) {
        incrementStat(rules, dayKey, 'parseErrorCount');

        const errorRecord = createLogRecord(
          'PARSE_ERROR',
          parsed.error,
          lineContext,
          parsed,
          { cleanedLine }
        );

        await writeAndSendLog(errorRecord, rules);

        const parseErrorItem = {
          line: cleanedLine,
          reason: parsed.error
        };

        parseErrorsForSender.push(parseErrorItem);
        reportParseErrors.push(parseErrorItem);

        continue;
      }

      const dedupKey = buildDedupKey(parsed, from);
      if (isDuplicatePayload(rules, dedupKey)) {
        incrementStat(rules, dayKey, 'duplicateCount');

        const duplicateRecord = createLogRecord(
          'DUPLICATE_SKIPPED',
          'Duplicate ditolak.',
          lineContext,
          parsed,
          {
            cleanedLine: parsed.raw_text,
            dedupKey
          }
        );

        await writeAndSendLog(duplicateRecord, rules);
        continue;
      }

      const webhookPayload = buildWebhookPayload(parsed, rules);
      markDedupEntry(rules, dedupKey, 'pending', {
        messageId,
        sheetName: webhookPayload.sheetName
      });

      try {
        await sendDataToWebhook(webhookPayload, rules);
        incrementDivisionSuccess(rules, dayKey, parsed.pj_divisi);
        markDedupEntry(rules, dedupKey, 'success', {
          messageId,
          sheetName: webhookPayload.sheetName
        });

        const successRecord = createLogRecord(
          'SUCCESS',
          'OK',
          lineContext,
          parsed,
          {
            cleanedLine: parsed.raw_text,
            dedupKey,
            sheetName: webhookPayload.sheetName
          }
        );

        await writeAndSendLog(successRecord, rules);
        successCount += 1;
      } catch (error) {
        const safeReason = getSafeWebhookReason(error);
        const retryable = shouldRetryWebhook(error);
        const reasonForUser = retryable ? `${safeReason} (masuk antrean retry)` : safeReason;

        incrementStat(rules, dayKey, 'webhookErrorCount');

        const webhookErrorRecord = createLogRecord(
          'WEBHOOK_ERROR',
          reasonForUser,
          lineContext,
          parsed,
          {
            cleanedLine: parsed.raw_text,
            dedupKey,
            raw_error: String(error.stack || error.message || '').slice(0, 4000),
            sheetName: webhookPayload.sheetName
          }
        );

        await writeAndSendLog(webhookErrorRecord, rules);

        if (retryable) {
          const retryItem = {
            id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            dedupKey,
            dayKey,
            payload: webhookPayload,
            parsed,
            context: {
              ...lineContext,
              cleanedLine: parsed.raw_text
            },
            attemptCount: 1,
            nextAttemptAt: Date.now() + getRetryDelayMs(rules),
            createdAt: new Date().toISOString(),
            lastError: safeReason
          };

          enqueueRetryItem(rules, retryItem);
          markDedupEntry(rules, dedupKey, 'pending', {
            itemId: retryItem.id,
            sheetName: webhookPayload.sheetName
          });
        } else {
          clearDedupEntry(rules, dedupKey);
        }

        reportWebhookErrors.push({
          line: cleanedLine,
          reason: reasonForUser
        });
      }
    }

    if (successCount > 0) {
      await safeReact(sock, from, msg.key, '✅');
    }

    const notificationContext = {
      groupName,
      sender,
      messageId
    };

    await sendParseErrorsToPrivate(sock, rules, senderPrivateJid, parseErrorsForSender);
    await sendReportGroupLog(sock, rules, notificationContext, reportParseErrors, reportWebhookErrors);

    const shouldReplyInOperationalGroup =
      notificationConfig.operationalGroupMode !== 'silent' &&
      rules.replyOnError &&
      (reportParseErrors.length > 0 || reportWebhookErrors.length > 0);

    if (shouldReplyInOperationalGroup) {
      await reply(buildFailedLinesReply([...reportParseErrors, ...reportWebhookErrors]));
    }
  });
}

if (require.main === module) {
  connectToWhatsApp();
}

module.exports = {
  appConfig,
  buildAggregatedLatenessReport,
  buildDailySummaryMessage,
  buildDedupKey,
  detectDivision,
  extractProductFromSegment,
  getCurrentSheetName,
  parseCustomLine,
  parseLatenessReport,
  parseLine,
  parseReadyLine,
  buildLatenessSummaryMessage,
  rememberLatenessReportSnapshot,
  summarizeWebhookError
};
