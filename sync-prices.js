const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT_DIR = __dirname;
const ENV_FILE = path.join(ROOT_DIR, 'auto-push.env');
const STATUS_FILE = path.join(ROOT_DIR, 'sync-status.json');
const UPDATE_SCRIPT = path.join(ROOT_DIR, 'update-price.js');
const TRACKED_FILES = ['cached_prices.json', 'farid_gold.xml'];
const ERROR_TYPES = {
  FTP_ERROR: 'FTP_ERROR',
  XML_PARSE_ERROR: 'XML_PARSE_ERROR',
  PRICE_STALE: 'PRICE_STALE',
  PRICE_UNCHANGED_TOO_LONG: 'PRICE_UNCHANGED_TOO_LONG',
  GIT_PUSH_ERROR: 'GIT_PUSH_ERROR',
  SERVER_ERROR: 'SERVER_ERROR',
};

loadEnvFile(ENV_FILE);

const PUSH_REMOTE = process.env.PUSH_REMOTE || 'origin';
const PUSH_BRANCH = process.env.PUSH_BRANCH || 'master';
const PUSH_RETRIES = parsePositiveInt(process.env.PUSH_RETRIES, 5);
const FETCH_RETRIES = parsePositiveInt(process.env.FETCH_RETRIES, 3);
const RETRY_DELAY_SECONDS = parsePositiveInt(process.env.RETRY_DELAY_SECONDS, 15);
const FAILURE_REMINDER_MINUTES = parsePositiveInt(process.env.TELEGRAM_FAILURE_REMINDER_MINUTES, 180);
const TELEGRAM_NOTIFY_SUCCESS = /^(1|true|yes)$/i.test(process.env.TELEGRAM_NOTIFY_SUCCESS || '');
const MAX_PRICE_AGE_MINUTES = parsePositiveInt(process.env.PRICE_CACHE_MAX_AGE_MINUTES, 70);
const UNCHANGED_STREAK_LIMIT = parsePositiveInt(process.env.PRICE_UNCHANGED_STREAK_LIMIT, 3);
const TELEGRAM_REQUEST_TIMEOUT_MS = parsePositiveInt(process.env.TELEGRAM_REQUEST_TIMEOUT_MS, 10000);
const IS_TELEGRAM_TEST_MODE = process.argv.includes('--test-telegram');

run().catch(async (err) => {
  const typedError = normalizeError(err);
  console.error(`[sync] ${typedError.type}:`, typedError.message);
  if (IS_TELEGRAM_TEST_MODE) {
    process.exit(1);
  }
  await handleFailure(typedError);
  process.exit(1);
});

async function run() {
  if (IS_TELEGRAM_TEST_MODE) {
    await runTelegramTest();
    return;
  }

  await main();
}

async function main() {
  const startedAt = new Date().toISOString();
  const status = readStatus();
  const previousSuccessAgeMinutes = getAgeMinutes(status.lastSuccessAt);
  const previousPriceFileMtime = status.lastPriceFileMtime || null;
  writeStatus({
    ...status,
    lastAttemptAt: startedAt,
    lastOutcome: 'running',
    lastError: null,
  });

  ensureRequiredEnv(['FTP_HOST', 'FTP_USER', 'FTP_PASS']);
  ensureCurrentBranch();
  ensureCleanWorktree();

  const updateOutput = runNodeScript(UPDATE_SCRIPT);
  const keptExistingCache = /Keeping existing cached_prices\.json/i.test(updateOutput);

  runGit(['add', ...TRACKED_FILES], 'git add failed', ERROR_TYPES.SERVER_ERROR);

  const hasStagedPriceChanges = !isGitQuiet(['diff', '--cached', '--quiet']);
  let createdCommit = false;
  let unchangedStreak = 0;
  const cacheStat = fs.statSync(path.join(ROOT_DIR, 'cached_prices.json'));
  const currentPriceFileMtime = cacheStat.mtime.toISOString();
  const didPriceFileTimestampChange = previousPriceFileMtime !== currentPriceFileMtime;

  if (hasStagedPriceChanges) {
    runGit(['commit', '-m', 'server farid_gf price updated'], 'git commit failed', ERROR_TYPES.SERVER_ERROR);
    createdCommit = true;
    console.log('[CHECK] Price file updated');
  } else if (keptExistingCache) {
    unchangedStreak = 0;
    console.log('[CHECK] Price-only FTP XML received; keeping existing categorized price cache');
  } else {
    unchangedStreak = (status.unchangedStreak || 0) + 1;
    console.log(`[CHECK] Price file unchanged (${unchangedStreak}/${UNCHANGED_STREAK_LIMIT})`);
  }

  const syncResult = syncWithRemote();

  if (!hasStagedPriceChanges && previousSuccessAgeMinutes !== null && previousSuccessAgeMinutes > MAX_PRICE_AGE_MINUTES) {
    throw createTypedError(
      ERROR_TYPES.PRICE_STALE,
      `Last successful sync is ${previousSuccessAgeMinutes} minutes old, above the ${MAX_PRICE_AGE_MINUTES}-minute limit.`,
      {
        currentPriceFileMtime,
        previousPriceFileMtime,
        unchangedStreak,
        previousSuccessAgeMinutes,
      }
    );
  }

  if (!hasStagedPriceChanges && unchangedStreak >= UNCHANGED_STREAK_LIMIT) {
    throw createTypedError(
      ERROR_TYPES.PRICE_UNCHANGED_TOO_LONG,
      `Price file did not change for ${unchangedStreak} consecutive runs.`,
      {
        currentPriceFileMtime,
        previousPriceFileMtime,
        unchangedStreak,
        previousSuccessAgeMinutes,
      }
    );
  }

  const successTime = new Date().toISOString();
  const newStatus = {
    ...readStatus(),
    lastAttemptAt: startedAt,
    lastSuccessAt: successTime,
    lastOutcome: 'success',
    lastError: null,
    lastErrorType: null,
    unchangedStreak,
    lastPriceFileMtime: currentPriceFileMtime,
    lastPriceFileSize: cacheStat.size,
    lastPriceFileTimestampChanged: didPriceFileTimestampChange,
    lastKeptExistingCacheAt: keptExistingCache ? successTime : status.lastKeptExistingCacheAt || null,
    lastCommittedUpdateAt: createdCommit ? successTime : status.lastCommittedUpdateAt || null,
    lastPushAt: syncResult.pushedAt,
    lastPushCommit: syncResult.headCommit,
  };

  writeStatus(newStatus);
  await maybeSendRecoveryOrSuccess(status, newStatus, createdCommit, syncResult);
}

async function runTelegramTest() {
  if (!hasTelegramConfig()) {
    throw createTypedError(ERROR_TYPES.SERVER_ERROR, 'Telegram test mode requires TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID');
  }

  const sent = await sendTelegramMessage('\u2705 \u0422\u0435\u0441\u0442 Telegram-\u0443\u0432\u0435\u0434\u043e\u043c\u043b\u0435\u043d\u0438\u0439 GFCC\n\u0421\u0435\u0440\u0432\u0435\u0440 \u0443\u0441\u043f\u0435\u0448\u043d\u043e \u043f\u043e\u0434\u043a\u043b\u044e\u0447\u0451\u043d \u043a \u0431\u043e\u0442\u0443.');
  if (!sent) {
    throw createTypedError(ERROR_TYPES.SERVER_ERROR, 'Telegram test message was not sent');
  }

  console.log('[telegram] Test notification sent successfully.');
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
      throw createTypedError(ERROR_TYPES.SERVER_ERROR, `ENV ${key} is not set`);
    }
  }
}

function ensureCurrentBranch() {
  const branch = runGitCapture(['rev-parse', '--abbrev-ref', 'HEAD'], 'failed to detect current git branch');
  if (branch !== PUSH_BRANCH) {
    throw createTypedError(ERROR_TYPES.SERVER_ERROR, `current branch is ${branch}, expected ${PUSH_BRANCH}`);
  }
}

function ensureCleanWorktree() {
  if (!isGitQuiet(['diff', '--quiet'])) {
    throw createTypedError(ERROR_TYPES.SERVER_ERROR, 'working tree has unstaged changes; aborting auto sync');
  }
  if (!isGitQuiet(['diff', '--cached', '--quiet'])) {
    throw createTypedError(ERROR_TYPES.SERVER_ERROR, 'working tree has staged changes; aborting auto sync');
  }
}

function runNodeScript(scriptPath) {
  const result = spawnSync(process.execPath, [scriptPath], {
    cwd: ROOT_DIR,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: process.env,
  });

  const stdout = result.stdout || '';
  const stderr = result.stderr || '';
  if (stdout) {
    process.stdout.write(stdout);
  }
  if (stderr) {
    process.stderr.write(stderr);
  }

  if (result.error) {
    throw createTypedError(ERROR_TYPES.SERVER_ERROR, result.error.message);
  }
  if (result.status !== 0) {
    throw classifyUpdateScriptFailure(stdout, stderr, result.status);
  }
  return `${stdout}\n${stderr}`;
}

function syncWithRemote() {
  retryOperation('git fetch', FETCH_RETRIES, () => runGit(['fetch', PUSH_REMOTE, PUSH_BRANCH], 'git fetch failed', ERROR_TYPES.GIT_PUSH_ERROR));
  retryOperation('git pull --rebase', FETCH_RETRIES, () => runGit(['pull', '--rebase', PUSH_REMOTE, PUSH_BRANCH], 'git pull --rebase failed', ERROR_TYPES.GIT_PUSH_ERROR));

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
    runGit(['push', PUSH_REMOTE, PUSH_BRANCH], 'git push failed', ERROR_TYPES.GIT_PUSH_ERROR);
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
        runGit(['fetch', PUSH_REMOTE, PUSH_BRANCH], `git fetch failed before retrying ${label}`, ERROR_TYPES.GIT_PUSH_ERROR);
        runGit(['pull', '--rebase', PUSH_REMOTE, PUSH_BRANCH], `git pull --rebase failed before retrying ${label}`, ERROR_TYPES.GIT_PUSH_ERROR);
      }

      fn();
      return;
    } catch (err) {
      lastError = normalizeError(err);
      if (attempt === attempts) {
        break;
      }
      console.log(`[sync] WARN: ${label} failed on attempt ${attempt}/${attempts}. Retrying in ${RETRY_DELAY_SECONDS}s.`);
      sleep(RETRY_DELAY_SECONDS * 1000);
    }
  }

  throw lastError;
}

function runGit(args, errorMessage, errorType = ERROR_TYPES.SERVER_ERROR) {
  const result = spawnSync('git', args, {
    cwd: ROOT_DIR,
    stdio: 'inherit',
    env: process.env,
  });

  if (result.error) {
    throw createTypedError(errorType, result.error.message);
  }
  if (result.status !== 0) {
    throw createTypedError(errorType, errorMessage);
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
    throw createTypedError(ERROR_TYPES.SERVER_ERROR, result.error.message);
  }
  if (result.status !== 0) {
    const stderr = (result.stderr || '').trim();
    throw createTypedError(ERROR_TYPES.SERVER_ERROR, stderr || errorMessage);
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

async function handleFailure(error) {
  const status = readStatus();
  const now = new Date();
  let failure = normalizeError(error);
  const previousSuccessAgeMinutes = getAgeMinutes(status.lastSuccessAt);

  if (failure.type !== ERROR_TYPES.PRICE_STALE && previousSuccessAgeMinutes !== null && previousSuccessAgeMinutes > MAX_PRICE_AGE_MINUTES) {
    failure = createTypedError(
      ERROR_TYPES.PRICE_STALE,
      `Last successful sync is ${previousSuccessAgeMinutes} minutes old, above the ${MAX_PRICE_AGE_MINUTES}-minute limit.`,
      {
        causeType: failure.type,
        causeMessage: failure.message,
      }
    );
  }

  const failureFingerprint = `${failure.type}:${failure.message}`;
  const nextStatus = {
    ...status,
    lastAttemptAt: now.toISOString(),
    lastOutcome: 'failure',
    lastError: { type: failure.type, message: failure.message, at: now.toISOString() },
    lastErrorType: failure.type,
    unchangedStreak: failure.details?.unchangedStreak ?? status.unchangedStreak ?? 0,
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
    getFailureTitle(nextStatus.lastError.type),
    `Time: ${formatTimestamp(now)}`,
    `Type: ${nextStatus.lastError.type}`,
    `Error: ${nextStatus.lastError.message}`,
    `Project: ${ROOT_DIR}`,
  ].join('\n');

  const sent = await sendTelegramMessage(text);
  if (sent) {
    console.log('[ALERT] Telegram notification sent');
  }
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
    shouldNotifyRecovery
      ? '\u2705 \u041e\u0431\u043d\u043e\u0432\u043b\u0435\u043d\u0438\u0435 \u043f\u0440\u0430\u0439\u0441-\u043b\u0438\u0441\u0442\u0430 \u0432\u043e\u0441\u0441\u0442\u0430\u043d\u043e\u0432\u043b\u0435\u043d\u043e.\n\n\u041f\u043e\u0441\u043b\u0435\u0434\u043d\u044f\u044f \u0441\u0438\u043d\u0445\u0440\u043e\u043d\u0438\u0437\u0430\u0446\u0438\u044f \u0432\u044b\u043f\u043e\u043b\u043d\u0435\u043d\u0430 \u0443\u0441\u043f\u0435\u0448\u043d\u043e.\n\u0421\u0435\u0440\u0432\u0435\u0440 \u0440\u0430\u0431\u043e\u0442\u0430\u0435\u0442 \u0432 \u0448\u0442\u0430\u0442\u043d\u043e\u043c \u0440\u0435\u0436\u0438\u043c\u0435.' : 'GFCC price sync OK',
    `Time: ${formatTimestamp(now)}`,
    `Commit: ${syncResult.headCommit}`,
    `Price file time: ${currentStatus.lastPriceFileMtime}`,
    createdCommit ? 'Result: new price data committed and pushed' : 'Result: no new price changes, remote is in sync',
  ];

  const sent = await sendTelegramMessage(messageLines.join('\n'));
  if (sent) {
    if (shouldNotifyRecovery) {
      console.log('[RECOVERY] Synchronization restored');
    }
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
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TELEGRAM_REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: controller.signal,
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
  } finally {
    clearTimeout(timeout);
  }
}

function formatTimestamp(date) {
  return date.toISOString().replace('T', ' ').replace('.000Z', ' UTC');
}

function getAgeMinutes(isoTimestamp) {
  if (!isoTimestamp) {
    return null;
  }
  const parsed = Date.parse(isoTimestamp);
  if (Number.isNaN(parsed)) {
    return null;
  }
  return Math.round((Date.now() - parsed) / 60000);
}

function classifyUpdateScriptFailure(stdout, stderr, exitCode) {
  const output = `${stdout}\n${stderr}`;
  if (/No items in XML|Failed to parse|Unexpected token|XML/i.test(output)) {
    return createTypedError(ERROR_TYPES.XML_PARSE_ERROR, `update-price.js failed with exit code ${exitCode}`);
  }
  if (/FTP connect|Downloading XML|ECONN|ETIMEDOUT|ENOTFOUND|timed out|login|socket|TLS|certificate|530|550/i.test(output)) {
    return createTypedError(ERROR_TYPES.FTP_ERROR, `update-price.js failed with exit code ${exitCode}`);
  }
  return createTypedError(ERROR_TYPES.SERVER_ERROR, `update-price.js failed with exit code ${exitCode}`);
}

function createTypedError(type, message, details = {}) {
  const error = new Error(message);
  error.type = type;
  error.details = details;
  return error;
}

function normalizeError(err) {
  if (err instanceof Error) {
    if (!err.type) {
      err.type = ERROR_TYPES.SERVER_ERROR;
    }
    return err;
  }
  if (typeof err === 'string') {
    return createTypedError(ERROR_TYPES.SERVER_ERROR, err);
  }
  if (err && typeof err === 'object' && err.type && err.message) {
    return createTypedError(err.type, err.message, err.details || {});
  }
  return createTypedError(ERROR_TYPES.SERVER_ERROR, 'Unknown synchronization error');
}

function getFailureTitle(type) {
  switch (type) {
    case ERROR_TYPES.FTP_ERROR:
      return 'GFCC price sync FAILED: FTP_ERROR';
    case ERROR_TYPES.XML_PARSE_ERROR:
      return 'GFCC price sync FAILED: XML_PARSE_ERROR';
    case ERROR_TYPES.PRICE_STALE:
      return 'GFCC price sync FAILED: PRICE_STALE';
    case ERROR_TYPES.PRICE_UNCHANGED_TOO_LONG:
      return '\u26a0\ufe0f \u041f\u0440\u0430\u0439\u0441 \u043d\u0435 \u043e\u0431\u043d\u043e\u0432\u043b\u044f\u0435\u0442\u0441\u044f \u0443\u0436\u0435 \u043d\u0435\u0441\u043a\u043e\u043b\u044c\u043a\u043e \u0446\u0438\u043a\u043b\u043e\u0432 \u043f\u043e\u0434\u0440\u044f\u0434.\n\n\u0412\u043e\u0437\u043c\u043e\u0436\u0435\u043d \u0441\u0431\u043e\u0439 FTP, \u0438\u0441\u0442\u043e\u0447\u043d\u0438\u043a\u0430 \u0434\u0430\u043d\u043d\u044b\u0445 \u0438\u043b\u0438 \u043f\u0440\u043e\u0446\u0435\u0441\u0441\u0430 \u043e\u0431\u043d\u043e\u0432\u043b\u0435\u043d\u0438\u044f.\n\n\u0422\u0440\u0435\u0431\u0443\u0435\u0442\u0441\u044f \u043f\u0440\u043e\u0432\u0435\u0440\u043a\u0430 \u0441\u0435\u0440\u0432\u0435\u0440\u0430.';
    case ERROR_TYPES.GIT_PUSH_ERROR:
      return 'GFCC price sync FAILED: GIT_PUSH_ERROR';
    default:
      return 'GFCC price sync FAILED: SERVER_ERROR';
  }
}

