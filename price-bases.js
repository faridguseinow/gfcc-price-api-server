const path = require('path');

const ROOT_DIR = __dirname;
const DEFAULT_PRICE_BASE = 'gold';

const PRICE_BASES = {
  gold: {
    key: 'gold',
    title: 'Gold',
    aliases: ['gold', 'farid_gold', 'голд'],
    xmlFile: path.join(ROOT_DIR, 'farid_gold.xml'),
    tempXmlFile: path.join(ROOT_DIR, 'farid_gold.tmp.xml'),
    cacheFile: path.join(ROOT_DIR, 'cached_prices.gold.json'),
    tempCacheFile: path.join(ROOT_DIR, 'cached_prices.gold.tmp.json'),
    legacyCacheFile: path.join(ROOT_DIR, 'cached_prices.json'),
    defaultRemoteXmlFile: 'farid_gold.xml',
  },
  oasis: {
    key: 'oasis',
    title: 'Oasis Flowers',
    aliases: ['oasis', 'farid_oasis', 'оазис', 'oasis flowers'],
    xmlFile: path.join(ROOT_DIR, 'farid_oasis.xml'),
    tempXmlFile: path.join(ROOT_DIR, 'farid_oasis.tmp.xml'),
    cacheFile: path.join(ROOT_DIR, 'cached_prices.oasis.json'),
    tempCacheFile: path.join(ROOT_DIR, 'cached_prices.oasis.tmp.json'),
    defaultRemoteXmlFile: 'farid_oasis.xml',
  },
};

function normalizePriceBase(value) {
  const normalized = String(value || DEFAULT_PRICE_BASE).trim().toLowerCase();

  for (const base of Object.values(PRICE_BASES)) {
    if (base.key === normalized || base.aliases.includes(normalized)) {
      return base.key;
    }
  }

  return null;
}

function getPriceBase(value) {
  const key = normalizePriceBase(value);
  return key ? PRICE_BASES[key] : null;
}

function getBaseKeys() {
  return Object.keys(PRICE_BASES);
}

module.exports = {
  DEFAULT_PRICE_BASE,
  PRICE_BASES,
  getBaseKeys,
  getPriceBase,
  normalizePriceBase,
};
