const express = require('express');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3001;
const CACHE_FILE = path.join(__dirname, 'cached_prices.json');

app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  next();
});

function getCacheInfo() {
  if (!fs.existsSync(CACHE_FILE)) {
    return { hasCache: false };
  }

  const stat = fs.statSync(CACHE_FILE);
  let items = null;

  try {
    items = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8')).length;
  } catch {
    items = null;
  }

  return {
    hasCache: true,
    updatedAt: stat.mtime.toISOString(),
    size: stat.size,
    items,
  };
}

app.get('/health', (req, res) => {
  res.json({
    ok: true,
    cache: getCacheInfo(),
    time: new Date().toISOString(),
  });
});

app.get('/api/prices', (req, res) => {
  if (!fs.existsSync(CACHE_FILE)) {
    return res.status(503).json({
      error: 'Price cache is not ready',
    });
  }

  return res.sendFile(CACHE_FILE);
});

app.listen(PORT, () => {
  console.log(`Price API is running: http://localhost:${PORT}/api/prices`);
  console.log('FTP sync is disabled in server.js; Render serves cached_prices.json from GitHub.');
});
