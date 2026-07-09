const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT_DIR = __dirname;
const ENV_FILE = path.join(ROOT_DIR, 'auto-push.env');
const STATUS_FILE = path.join(ROOT_DIR, 'sync-status.json');
const UPDATE_SCRIPT = path.join(ROOT_DIR, 'update-price.js');
const TRACKED_FILES = ['cached_prices.json', 'farid_gold.xml'];

loadEnvFile(ENV_FILE);

const PUSH_REMOTE = process.env.PUSH_REMOTE || 'origin';
const PUSH_BRANCH = process.env.PUSH_BRANCH || 'master';
const PUSH_RETRIES = parsePositiveInt(process.env.PUSH_RETRIES, 5);
const FETCH_RETRIES = parsePositiveInt(process.env.FETCH_RETRIES, 3);
const RETRY_DELAY_SECONDS = parsePositiveInt(process.env.RETRY_DELAY_SECONDS, 15);
const FAILURE_REMINDER_MINUTES = parsePositiveInt(process.env.TELEGRAM_FAILURE_REMINDER_MINUTES, 180);
const TELEGRAM_NOTIFY_SUCCESS = /^(1|true|yes)$/i.test(process.env.TELEGRAM_NOTIFY_SUCCESS || '');

main().catch(async (err) => {
  console.error('[sync] Fatal error:', err.message);
  await handleFailure('fatal', err.message);
  process.exit(1);
});

async function main() {
  const startedAt = new Date().toISOString();
  const status = readStatus();
  writeStatus({
    ...status,
    lastAttemptAt: startedAt,
    lastOutcome: 'running',
    lastError: null,
  });

  ensureRequiredEnv(['FTP_HOST', 'FTP_USER', 'FTP_PASS']);
  ensureCurrentBranch();
  ensureCleanWorktree();

  runNodeScript(UPDATE_SCRIPT);

  runGit(['add', ...TRACKED_FILES], 'git add failed');

  const hasStagedPriceChanges = !isGitQuiet(['diff', '--cached', '--quiet']);
  let createdCommit = false;

  if (hasStagedPriceChanges) {
    runGit(['commit', '-m', 'server farid_gf price updated'], 'git commit failed');
    createdCommit = true;
  } else {
    console.log('[sync] No file changes after price update.');
  }

  const syncResult = syncWithRemote();

  const cacheStat = fs.statSync(path.join(ROOT_DIR, 'cached_prices.json'));
  const newStatus = {
    ...readStatus(),
    lastAttemptAt: startedAt,
    lastSuccessAt: new Date().toISOString(),
    lastOutcome: 'success',
    lastError: null,
    lastPriceFileMtime: cacheStat.mtime.toISOString(),
    lastPriceFileSize: cacheStat.size,
    lastCommittedUpdateAt: createdCommit ? new Date().toISOString() : status.lastCommittedUpdateAt || null,
    lastPushAt: syncResult.pushedAt,
    lastPushCommit: syncResult.headCommit,
  };

  writeStatus(newStatus);
  await maybeSendRecoveryOrSuccess(status, newStatus, createdCommit, syncResult);
}

function loadEnvFile(filePath) {
  if (!fs.existsSync(filePath)) {
    return;
  }

  const lines = fs.readFileSync(filePath, 'utf8').split(/\r?\n/);
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) {
      continue;
    }
    const eqIndex = line.indexOf('=');
    if (eqIndex === -1) {
      continue;
    }
    const key = line.slice(0, eqIndex).trim();
    const value = line.slice(eqIndex + 1).trim();
    if (key && !process.env[key]) {
      process.env[key] = value;
    }
  }
}

function parsePositiveInt(value, fallback) {
  const parsed = Number.parseInt(value || '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function ensureRequiredEnv(keys) {
  for (const key of keys) {
    if (!process.env[key]) {
      throw new Error(`ENV ${key} is not set`);
    }
  }
}

function ensureCurrentBranch() {
  const branch = runGitCapture(['rev-parse', '--abbrev-ref', 'HEAD'], 'failed to detect current git branch');
  if (branch !== PUSH_BRANCH) {
    throw new Error(`current branch is ${branch}, expected ${PUSH_BRANCH}`);
  }
}

function ensureCleanWorktree() {
  if (!isGitQuiet(['diff', '--quiet'])) {
    throw new Error('working tree has unstaged changes; aborting auto sync');
  }
  if (!isGitQuiet(['diff', '--cached', '--quiet'])) {
    throw new Error('working tree has staged changes; aborting auto sync');
  }
}

function runNodeScript(scriptPath) {
  const result = spawnSync(process.execPath, [scriptPath], {
    cwd: ROOT_DIR,
    stdio: 'inherit',
    env: process.env,
  });

  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(`${path.basename(scriptPath)} failed with exit code ${result.status}`);
  }
}

function syncWithRemote() {
  retryOperation('git fetch', FETCH_RETRIES, () => runGit(['fetch', PUSH_REMOTE, PUSH_BRANCH], 'git fetch failed'));
  retryOperation('git pull --rebase', FETCH_RETRIES, () => runGit(['pull', '--rebase', PUSH_REMOTE, PUSH_BRANCH], 'git pull --rebase failed'));

  const aheadBeforePush = getAheadCount();
  if (aheadBeforePush === 0) {
    console.log('[sync] Nothing to push after sync.');
    return {
      pushedAt: new Date().toISOString(),
      headCommit: runGitCapture(['rev-parse', 'HEAD'], 'failed to read HEAD commit'),
    };
  }

  retryOperation('git push', PUSH_RETRIES, () => {
    console.log(`[sync] Push attempt in progress to ${PUSH_REMOTE}/${PUSH_BRANCH}`);
    runGit(['push', PUSH_REMOTE, PUSH_BRANCH], 'git push failed');
  }, true);

  return {
    pushedAt: new Date().toISOString(),
    headCommit: runGitCapture(['rev-parse', 'HEAD'], 'failed to read HEAD commit'),
  };
}

function getAheadCount() {
  const counts = runGitCapture(['rev-list', '--left-right', '--count', `${PUSH_REMOTE}/${PUSH_BRANCH}...HEAD`], 'failed to compare local and remote history');
  const parts = counts.split(/\s+/).map((item) => Number.parseInt(item, 10));
  return Number.isFinite(parts[1]) ? parts[1] : 0;
}

function retryOperation(label, attempts, fn, refreshBeforeRetry = false) {
  let lastError = null;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      if (attempt > 1 && refreshBeforeRetry) {
        runGit(['fetch', PUSH_REMOTE, PUSH_BRANCH], `git fetch failed before retrying ${label}`);
        runGit(['pull', '--rebase', PUSH_REMOTE, PUSH_BRANCH], `git pull --rebase failed before retrying ${label}`);
      }

      fn();
      return;
    } catch (err) {
      lastError = err;
      if (attempt === attempts) {
        break;
      }
      console.log(`[sync] WARN: ${label} failed on attempt ${attempt}/${attempts}. Retrying in ${RETRY_DELAY_SECONDS}s.`);
      sleep(RETRY_DELAY_SECONDS * 1000);
    }
  }

  throw lastError;
}

function runGit(args, errorMessage) {
  const result = spawnSync('git', args, {
    cwd: ROOT_DIR,
    stdio: 'inherit',
    env: process.env,
  });

  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(errorMessage);
  }
}

function runGitCapture(args, errorMessage) {
  const result = spawnSync('git', args, {
    cwd: ROOT_DIR,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: process.env,
  });

  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    const stderr = (result.stderr || '').trim();
    throw new Error(stderr || errorMessage);
  }

  return (result.stdout || '').trim();
}

function isGitQuiet(args) {
  const result = spawnSync('git', args, {
    cwd: ROOT_DIR,
    stdio: 'ignore',
    env: process.env,
  });
  return result.status === 0;
}

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function readStatus() {
  if (!fs.existsSync(STATUS_FILE)) {
    return {};
  }
  try {
    return JSON.parse(fs.readFileSync(STATUS_FILE, 'utf8'));
  } catch (_) {
    return {};
  }
}

function writeStatus(status) {
  fs.writeFileSync(STATUS_FILE, `${JSON.stringify(status, null, 2)}\n`, 'utf8');
}

async function handleFailure(stage, message) {
  const status = readStatus();
  const now = new Date();
  const failureFingerprint = `${stage}:${message}`;
  const nextStatus = {
    ...status,
    lastAttemptAt: now.toISOString(),
    lastOutcome: 'failure',
    lastError: { stage, message, at: now.toISOString() },
    lastFailureAt: now.toISOString(),
  };
  writeStatus(nextStatus);

  await maybeSendFailureAlert(status, nextStatus, failureFingerprint);
}

async function maybeSendFailureAlert(previousStatus, nextStatus, fingerprint) {
  if (!hasTelegramConfig()) {
    return;
  }

  const previousFingerprint = previousStatus.lastFailureFingerprint || null;
  const lastAlertAt = previousStatus.lastFailureAlertAt ? new Date(previousStatus.lastFailureAlertAt) : null;
  const now = new Date(nextStatus.lastFailureAt);
  const reminderDue = !lastAlertAt || (now - lastAlertAt) / 60000 >= FAILURE_REMINDER_MINUTES;
  const isNewFailure = previousStatus.lastOutcome !== 'failure' || previousFingerprint !== fingerprint;

  if (!isNewFailure && !reminderDue) {
    writeStatus({
      ...nextStatus,
      lastFailureFingerprint: fingerprint,
      lastFailureAlertAt: previousStatus.lastFailureAlertAt || null,
    });
    return;
  }

  const text = [
    'GFCC price sync FAILED',
    `Time: ${formatTimestamp(now)}`,
    `Stage: ${nextStatus.lastError.stage}`,
    `Error: ${nextStatus.lastError.message}`,
    `Project: ${ROOT_DIR}`,
  ].join('\n');

  const sent = await sendTelegramMessage(text);
  writeStatus({
    ...nextStatus,
    lastFailureFingerprint: fingerprint,
    lastFailureAlertAt: sent ? now.toISOString() : previousStatus.lastFailureAlertAt || null,
  });
}

async function maybeSendRecoveryOrSuccess(previousStatus, currentStatus, createdCommit, syncResult) {
  if (!hasTelegramConfig()) {
    return;
  }

  const now = new Date(currentStatus.lastSuccessAt);
  const shouldNotifyRecovery = previousStatus.lastOutcome === 'failure';
  const shouldNotifySuccess = TELEGRAM_NOTIFY_SUCCESS;

  if (!shouldNotifyRecovery && !shouldNotifySuccess) {
    return;
  }

  const messageLines = [
    shouldNotifyRecovery ? 'GFCC price sync RECOVERED' : 'GFCC price sync OK',
    `Time: ${formatTimestamp(now)}`,
    `Commit: ${syncResult.headCommit}`,
    `Price file time: ${currentStatus.lastPriceFileMtime}`,
    createdCommit ? 'Result: new price data committed and pushed' : 'Result: no new price changes, remote is in sync',
  ];

  const sent = await sendTelegramMessage(messageLines.join('\n'));
  if (sent) {
    writeStatus({
      ...currentStatus,
      lastRecoveryAlertAt: shouldNotifyRecovery ? now.toISOString() : previousStatus.lastRecoveryAlertAt || null,
      lastFailureFingerprint: null,
      lastFailureAlertAt: previousStatus.lastFailureAlertAt || null,
    });
  }
}

function hasTelegramConfig() {
  return Boolean(process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID);
}

async function sendTelegramMessage(text) {
  const url = `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`;

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: process.env.TELEGRAM_CHAT_ID,
        text,
      }),
    });

    if (!response.ok) {
      const body = await response.text();
      console.error('[telegram] Failed to send message:', response.status, body);
      return false;
    }

    console.log('[telegram] Notification sent.');
    return true;
  } catch (err) {
    console.error('[telegram] Failed to send message:', err.message);
    return false;
  }
}

function formatTimestamp(date) {
  return date.toISOString().replace('T', ' ').replace('.000Z', ' UTC');
}
