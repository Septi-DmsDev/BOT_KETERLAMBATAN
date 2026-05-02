#!/usr/bin/env bash
set -u

echo "===== BOT DIAGNOSE START ====="
echo "TIME_UTC=$(date -u '+%Y-%m-%d %H:%M:%S UTC')"
echo "TIME_LOCAL=$(date '+%Y-%m-%d %H:%M:%S %Z')"
echo "HOSTNAME=$(hostname)"
echo "PWD=$(pwd)"
echo

echo "===== OS ====="
uname -a || true
if command -v lsb_release >/dev/null 2>&1; then
  lsb_release -a || true
fi
echo

echo "===== NODE ====="
node -v || true
npm -v || true
echo

echo "===== PROCESS ====="
ps -ef | grep -E "node|pm2|bot_KETERLAMBATAN|index.js" | grep -v grep || true
echo

echo "===== PM2 ====="
if command -v pm2 >/dev/null 2>&1; then
  pm2 list || true
  echo
  pm2 logs --lines 80 --nostream || true
else
  echo "pm2 not installed"
fi
echo

echo "===== SYSTEMD ====="
systemctl --type=service --state=running | grep -i -E "bot|node|pm2" || true
echo

echo "===== MEMORY DISK ====="
free -h || true
df -h || true
echo

echo "===== NETWORK BASIC ====="
ip addr || true
ip route || true
echo

echo "===== DNS ====="
getent hosts web.whatsapp.com || true
getent hosts google.com || true
echo

echo "===== HTTP CHECK ====="
curl -I -m 15 https://www.google.com 2>&1 | sed -n '1,12p' || true
curl -I -m 15 https://web.whatsapp.com 2>&1 | sed -n '1,12p' || true
echo

echo "===== PROJECT FILES ====="
ls -lah || true
echo

echo "===== AUTH FOLDER ====="
if [ -d "auth_info_baileys" ]; then
  ls -lah auth_info_baileys || true
  echo
  find auth_info_baileys -maxdepth 1 -type f | sort | sed -n '1,40p' || true
else
  echo "auth_info_baileys folder not found"
fi
echo

echo "===== RECENT LOG FILES ====="
if [ -d "logs" ]; then
  find logs -maxdepth 1 -type f -printf "%TY-%Tm-%Td %TH:%TM:%TS %p\n" 2>/dev/null | sort -r | sed -n '1,20p' || true
  echo
  for f in logs/*.jsonl logs/*.log logs/*.txt; do
    [ -f "$f" ] || continue
    echo "--- TAIL: $f ---"
    tail -n 40 "$f" || true
    echo
  done
else
  echo "logs folder not found"
fi
echo

echo "===== SESSION HEALTH ====="
if [ -f "logs/session-health.json" ]; then
  cat logs/session-health.json || true
else
  echo "logs/session-health.json not found"
fi
echo

echo "===== CONFIG SANITY ====="
if [ -f "sheets-config.json" ]; then
  node - <<'NODE'
const fs = require('fs');
try {
  const cfg = JSON.parse(fs.readFileSync('sheets-config.json', 'utf8'));
  const op = cfg.operasional || {};
  const summary = op.dailySummary || {};
  const latenessSummary = op.latenessSummary || {};
  const notifications = op.notifications || {};
  const result = {
    webhookHost: String(op.webhook || '').slice(0, 60),
    timeZone: op.timeZone || '',
    sheetMode: op.sheetMode || '',
    authDir: op.authDir || '',
    healthFile: op.healthFile || '',
    stateFile: op.stateFile || '',
    localLogFile: op.localLogFile || '',
    maxDisconnectsBeforeRestart: op.maxDisconnectsBeforeRestart,
    sendLogsToSheet: Boolean(op.sendLogsToSheet),
    retryWorkerIntervalMs: op.retryWorkerIntervalMs,
    retryDelayMs: op.retryDelayMs,
    retryMaxAttempts: op.retryMaxAttempts,
    dailySummaryEnabled: summary.enabled,
    dailySummaryTime: summary.time,
    latenessSummaryEnabled: latenessSummary.enabled,
    latenessSummaryTimes: latenessSummary.times,
    reportGroupSet: Boolean(notifications.reportGroupJid),
    completedMarkers: op.completedMarkers,
    incompleteMarkers: op.incompleteMarkers
  };
  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  console.error('CONFIG_READ_ERROR', error.message);
  process.exitCode = 1;
}
NODE
else
  echo "sheets-config.json not found"
fi
echo

echo "===== LAST 120 INDEX.JS CONNECTION LINES ====="
grep -n -E "Koneksi terputus|Sesi logout|QR Code muncul|Bot operasional siap|WATCHDOG|Reconnect|Daily summary worker error|Lateness summary worker error" index.js 2>/dev/null || true
echo

echo "===== BOT DIAGNOSE END ====="
