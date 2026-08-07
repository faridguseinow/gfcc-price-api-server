const express = require('express');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { DEFAULT_PRICE_BASE, PRICE_BASES, getBaseKeys, getPriceBase } = require('./price-bases');

function parsePositiveInt(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

const app = express();
const PORT = process.env.PORT || 3001;
const MAX_CACHE_AGE_MINUTES = parsePositiveInt(process.env.PRICE_CACHE_MAX_AGE_MINUTES || '70', 70);
const ENFORCE_FRESH_CACHE = /^(1|true|yes)$/i.test(process.env.PRICE_CACHE_ENFORCE_FRESHNESS || '');
const SERVICE_STARTED_AT = new Date();

function parsePriceCache(raw) {
  const parsed = JSON.parse(raw.replace(/^\uFEFF/, ''));

  if (!Array.isArray(parsed)) {
    throw new Error('Price cache JSON root is not an array');
  }

  return parsed;
}

app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,HEAD,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization');
  res.setHeader('Access-Control-Max-Age', '86400');

  if (req.method === 'OPTIONS') {
    return res.sendStatus(204);
  }

  next();
});

function getCacheFile(base) {
  if (base.key === DEFAULT_PRICE_BASE && process.env.PRICE_CACHE_FILE) {
    return path.resolve(process.env.PRICE_CACHE_FILE);
  }

  if (base.key === DEFAULT_PRICE_BASE && !fs.existsSync(base.cacheFile) && fs.existsSync(base.legacyCacheFile)) {
    return base.legacyCacheFile;
  }

  return base.cacheFile;
}

function getCacheInfo(base) {
  const cacheFile = getCacheFile(base);

  try {
    if (!fs.existsSync(cacheFile)) {
      return { base: base.key, hasCache: false, path: cacheFile };
    }

    const stat = fs.statSync(cacheFile);
    let items = null;
    let validJson = false;

    try {
      const parsed = parsePriceCache(fs.readFileSync(cacheFile, 'utf8'));
      validJson = true;
      items = parsed.length;
    } catch (err) {
      console.error(`[cache:${base.key}] Failed to parse price cache:`, err.message);
    }

    return {
      base: base.key,
      hasCache: true,
      validJson,
      updatedAt: stat.mtime.toISOString(),
      ageMinutes: Math.round((Date.now() - stat.mtimeMs) / 60000),
      maxAgeMinutes: MAX_CACHE_AGE_MINUTES,
      stale: (Date.now() - stat.mtimeMs) / 60000 > MAX_CACHE_AGE_MINUTES,
      size: stat.size,
      items,
      path: cacheFile,
    };
  } catch (err) {
    console.error(`[cache:${base.key}] Failed to inspect price cache:`, err.message);
    return { base: base.key, hasCache: false, error: err.message, path: cacheFile };
  }
}

function getRequestedBase(req) {
  return getPriceBase(req.params.base || req.query.base || DEFAULT_PRICE_BASE);
}

function sendUnknownBase(res, value) {
  return res.status(400).json({
    error: 'Unknown price base',
    requestedBase: value || null,
    availableBases: getBaseKeys(),
  });
}

app.get('/health', (req, res) => {
  const caches = Object.fromEntries(
    Object.values(PRICE_BASES).map((base) => [base.key, getCacheInfo(base)])
  );
  const defaultCache = caches[DEFAULT_PRICE_BASE];
  res.json({
    ok: defaultCache.hasCache && defaultCache.validJson && (!ENFORCE_FRESH_CACHE || !defaultCache.stale),
    uptimeSeconds: Math.round(process.uptime()),
    startedAt: SERVICE_STARTED_AT.toISOString(),
    defaultBase: DEFAULT_PRICE_BASE,
    availableBases: getBaseKeys(),
    enforceFreshCache: ENFORCE_FRESH_CACHE,
    cache: defaultCache,
    caches,
    time: new Date().toISOString(),
  });
});

app.get(['/api/prices', '/api/prices/:base'], async (req, res) => {
  const base = getRequestedBase(req);
  if (!base) {
    return sendUnknownBase(res, req.params.base || req.query.base);
  }

  const cacheFile = getCacheFile(base);

  try {
    const cache = getCacheInfo(base);
    if (!cache.hasCache) {
      return res.status(503).json({ error: 'Price cache is not ready', base: base.key });
    }

    if (!cache.validJson) {
      return res.status(500).json({ error: 'Price cache is invalid', base: base.key });
    }

    if (ENFORCE_FRESH_CACHE && cache.stale) {
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('Retry-After', '300');
      return res.status(503).json({
        error: 'Price cache is stale',
        base: base.key,
        updatedAt: cache.updatedAt,
        ageMinutes: cache.ageMinutes,
        maxAgeMinutes: cache.maxAgeMinutes,
      });
    }

    const raw = await fsp.readFile(cacheFile, 'utf8');
    const prices = parsePriceCache(raw);

    res.setHeader('Cache-Control', 'public, max-age=60, stale-while-revalidate=300');
    return res.json(prices);
  } catch (err) {
    const isMissingCache = err.code === 'ENOENT';
    const status = isMissingCache ? 503 : 500;

    console.error(`[api/prices:${base.key}] Failed to serve price cache:`, {
      message: err.message,
      code: err.code,
      cacheFile,
    });

    return res.status(status).json({
      error: isMissingCache ? 'Price cache is not ready' : 'Price cache is invalid',
      base: base.key,
    });
  }
});

app.use((err, req, res, next) => {
  console.error('[express] Unhandled request error:', err);
  if (res.headersSent) {
    return next(err);
  }
  return res.status(500).json({ error: 'Internal server error' });
});

app.listen(PORT, () => {
  const caches = Object.fromEntries(
    Object.values(PRICE_BASES).map((base) => [base.key, getCacheInfo(base)])
  );
  console.log('[startup] Price API server started');
  console.log(`[startup] Port: ${PORT}`);
  console.log(`[startup] Node.js: ${process.version}`);
  console.log(`[startup] Working directory: ${process.cwd()}`);
  console.log(`[startup] Default base: ${DEFAULT_PRICE_BASE}`);
  console.log(`[startup] Cache status: ${JSON.stringify(caches)}`);
  console.log(`[startup] Cache freshness policy: maxAge=${MAX_CACHE_AGE_MINUTES}m enforce=${ENFORCE_FRESH_CACHE}`);
  console.log('[startup] FTP sync is disabled in server.js; Render serves cached price JSON files from GitHub.');
});

process.on('unhandledRejection', (err) => {
  console.error('[process] Unhandled rejection:', err);
});

process.on('uncaughtException', (err) => {
  console.error('[process] Uncaught exception:', err);
  process.exit(1);
});
