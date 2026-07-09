const express = require('express');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');

function parsePositiveInt(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

const app = express();
const PORT = process.env.PORT || 3001;
const MAX_CACHE_AGE_MINUTES = parsePositiveInt(process.env.PRICE_CACHE_MAX_AGE_MINUTES || '70', 70);
const ENFORCE_FRESH_CACHE = process.env.PRICE_CACHE_ENFORCE_FRESHNESS !== 'false';
const CACHE_FILE = process.env.PRICE_CACHE_FILE
  ? path.resolve(process.env.PRICE_CACHE_FILE)
  : path.join(__dirname, 'cached_prices.json');
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

function getCacheInfo() {
  try {
    if (!fs.existsSync(CACHE_FILE)) {
      return { hasCache: false, path: CACHE_FILE };
    }

    const stat = fs.statSync(CACHE_FILE);
    let items = null;
    let validJson = false;

    try {
      const parsed = parsePriceCache(fs.readFileSync(CACHE_FILE, 'utf8'));
      validJson = true;
      items = parsed.length;
    } catch (err) {
      console.error('[cache] Failed to parse price cache:', err.message);
    }

    return {
      hasCache: true,
      validJson,
      updatedAt: stat.mtime.toISOString(),
      ageMinutes: Math.round((Date.now() - stat.mtimeMs) / 60000),
      maxAgeMinutes: MAX_CACHE_AGE_MINUTES,
      stale: (Date.now() - stat.mtimeMs) / 60000 > MAX_CACHE_AGE_MINUTES,
      size: stat.size,
      items,
      path: CACHE_FILE,
    };
  } catch (err) {
    console.error('[cache] Failed to inspect price cache:', err.message);
    return { hasCache: false, error: err.message, path: CACHE_FILE };
  }
}

app.get('/health', (req, res) => {
  const cache = getCacheInfo();
  res.json({
    ok: cache.hasCache && cache.validJson && !cache.stale,
    uptimeSeconds: Math.round(process.uptime()),
    startedAt: SERVICE_STARTED_AT.toISOString(),
    enforceFreshCache: ENFORCE_FRESH_CACHE,
    cache,
    time: new Date().toISOString(),
  });
});

app.get('/api/prices', async (req, res) => {
  try {
    const cache = getCacheInfo();
    if (!cache.hasCache) {
      return res.status(503).json({ error: 'Price cache is not ready' });
    }

    if (!cache.validJson) {
      return res.status(500).json({ error: 'Price cache is invalid' });
    }

    if (ENFORCE_FRESH_CACHE && cache.stale) {
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('Retry-After', '300');
      return res.status(503).json({
        error: 'Price cache is stale',
        updatedAt: cache.updatedAt,
        ageMinutes: cache.ageMinutes,
        maxAgeMinutes: cache.maxAgeMinutes,
      });
    }

    const raw = await fsp.readFile(CACHE_FILE, 'utf8');
    const prices = parsePriceCache(raw);

    res.setHeader('Cache-Control', 'public, max-age=60, stale-while-revalidate=300');
    return res.json(prices);
  } catch (err) {
    const isMissingCache = err.code === 'ENOENT';
    const status = isMissingCache ? 503 : 500;

    console.error('[api/prices] Failed to serve price cache:', {
      message: err.message,
      code: err.code,
      cacheFile: CACHE_FILE,
    });

    return res.status(status).json({
      error: isMissingCache ? 'Price cache is not ready' : 'Price cache is invalid',
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
  const cache = getCacheInfo();
  console.log('[startup] Price API server started');
  console.log(`[startup] Port: ${PORT}`);
  console.log(`[startup] Node.js: ${process.version}`);
  console.log(`[startup] Working directory: ${process.cwd()}`);
  console.log(`[startup] Cache file: ${CACHE_FILE}`);
  console.log(`[startup] Cache status: ${JSON.stringify(cache)}`);
  console.log(`[startup] Cache freshness policy: maxAge=${MAX_CACHE_AGE_MINUTES}m enforce=${ENFORCE_FRESH_CACHE}`);
  console.log('[startup] FTP sync is disabled in server.js; Render serves cached_prices.json from GitHub.');
});

process.on('unhandledRejection', (err) => {
  console.error('[process] Unhandled rejection:', err);
});

process.on('uncaughtException', (err) => {
  console.error('[process] Uncaught exception:', err);
  process.exit(1);
});
