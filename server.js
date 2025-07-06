const express = require('express');
const ftp = require('basic-ftp');
const iconv = require('iconv-lite');
const xml2js = require('xml2js');
const cron = require('node-cron');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = 3001;
const LOCAL_XML_FILE = './farid_gold.xml';
const CACHE_FILE = './cached_prices.json';

app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  next();
});

async function fetchAndCacheXML() {
  const client = new ftp.Client();
  try {
    await client.access({
      host: "192.168.7.108",
      port: 21,
      user: "farid_gold",
      password: "FaridGold2025#",
      secure: false
    });

    // Скачиваем XML в локальный файл
    await client.downloadTo(LOCAL_XML_FILE, "farid_gold.xml");

    // Читаем и декодируем файл
    const buffer = fs.readFileSync(LOCAL_XML_FILE);
    const xml = iconv.decode(buffer, "win1251");

    const parsed = await xml2js.parseStringPromise(xml, { explicitArray: false });
    const items = parsed.PriceList.Goods.Item;

    const normalized = items.map(item => ({
      id: item.$.ID,
      category: item.$.ParentName,
      name: item.$.Name,
      wholesalePrice: parseFloat(item.$.Price.replace(",", ".")),
      extraPrice: parseFloat(item.$.PriceExt.replace(",", ".")),
      retailPrice: parseFloat(item.$.PriceRetail.replace(",", "."))
    }));

    fs.writeFileSync(CACHE_FILE, JSON.stringify(normalized, null, 2), 'utf8');
    console.log("✅ Прайс обновлён");
  } catch (err) {
    console.error("❌ Ошибка при обновлении прайса:", err.message);
  } finally {
    client.close();
  }
}

cron.schedule('0 * * * *', fetchAndCacheXML);
fetchAndCacheXML();

app.get('/api/prices', (req, res) => {
  const fullPath = path.resolve(__dirname, CACHE_FILE);
  if (fs.existsSync(fullPath)) {
    res.sendFile(fullPath);
  } else {
    res.status(503).send({ error: 'Прайс ещё не готов' });
  }
});

app.listen(PORT, () => console.log(`🚀 API сервер запущен: http://localhost:${PORT}/api/prices`));
