const express = require('express');
const ftp = require('basic-ftp');
const iconv = require('iconv-lite');
const xml2js = require('xml2js');
const cron = require('node-cron');
const fs = require('fs');
const path = require('path');
const app = express();
const PORT = process.env.PORT || 3001;
const LOCAL_XML_FILE = path.join(__dirname, 'farid_gold.xml');
const CACHE_FILE = path.join(__dirname, 'cached_prices.json');

// CORS 
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  next();
});

// Функция получения и парсинга XML 
async function fetchAndCacheXML() {
  const client = new ftp.Client();
  client.ftp.verbose = false;
  try {
    console.log('🔄 Подключение к FTP...');
    await client.access({
      host: "192.168.7.108", // ⚠️ Только для локальной разработки! 
      port: 21,
      user: "farid_gold",
      password: "FaridGold2025#",
      secure: false
    });
    console.log('📥 Скачивание XML...');
    await client.downloadTo(LOCAL_XML_FILE, "farid_gold.xml");
    const buffer = fs.readFileSync(LOCAL_XML_FILE);
    const xml = iconv.decode(buffer, "win1251");
    const parsed = await xml2js.parseStringPromise(xml, {
      explicitArray: false
    });
    const items = parsed?.PriceList?.Goods?.Item;
    if (!items || !Array.isArray(items)) throw new Error("⛔ Некорректный формат XML");
    const normalized = items.map(item => ({
      id: item.$.ID,
      category: item.$.ParentName,
      name: item.$.Name,
      wholesalePrice: parseFloat(item.$.Price.replace(",", ".")) || 0,
      extraPrice: parseFloat(item.$.PriceExt.replace(",", ".")) || 0,
      retailPrice: parseFloat(item.$.PriceRetail.replace(",", ".")) || 0
    }));
    fs.writeFileSync(CACHE_FILE, JSON.stringify(normalized, null, 2), 'utf8');
    console.log(`✅Прайс обновлён.Сохранено: ${normalized.length} позиций`);
  } catch (err) {
    console.error("❌ Ошибка при обновлении прайса:", err.message);
  } finally {
    client.close();
  }
} // Обновлять каждый час 
cron.schedule('0 * * * *', fetchAndCacheXML);
// Первичный запуск при старте сервера 
fetchAndCacheXML(); // API — получить цены 
app.get('/api/prices', (req, res) => {
  if (fs.existsSync(CACHE_FILE)) {
    res.sendFile(CACHE_FILE);
  } else {
    res.status(503).json({
      error: '⏳ Прайс ещё не готов'
    });
  }
});
// Запуск сервера 
app.listen(PORT, () => {
  console.log(`🚀Сервер API работает: http://localhost:${PORT}/api/prices`);
});