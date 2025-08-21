const express = require('express');
const ftp = require('basic-ftp');
const iconv = require('iconv-lite');
const xml2js = require('xml2js');
const cron = require('node-cron');
const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3001;

const LOCAL_XML_FILE = path.join(__dirname, 'farid_gold.xml');
const CACHE_FILE = path.join(__dirname, 'cached_prices.json');

// =======================
// 📌 Подключение к MongoDB
// =======================
mongoose.connect(process.env.MONGO_URI, {
  useNewUrlParser: true,
  useUnifiedTopology: true
}).then(() => console.log("✅ Подключено к MongoDB Atlas"))
  .catch(err => console.error("❌ Ошибка подключения MongoDB:", err.message));

// =======================
// 📌 Схема товаров
// =======================
const ProductSchema = new mongoose.Schema({
  id: { type: String, unique: true },
  category: String,
  name: String,
  wholesalePrice: Number,
  extraPrice: Number,
  retailPrice: Number,
  updatedAt: { type: Date, default: Date.now }
});
const Product = mongoose.model("Product", ProductSchema);

// =======================
// 📌 Функция получения и парсинга XML
// =======================
async function fetchAndCacheXML() {
  const client = new ftp.Client();
  client.ftp.verbose = false;

  try {
    console.log('🔄 Подключение к FTP...');

    await client.access({
      host: "192.168.7.108", // ⚠️ локальный FTP
      port: 21,
      user: "farid_gold",
      password: "FaridGold2025#",
      secure: false
    });

    console.log('📥 Скачивание XML...');
    await client.downloadTo(LOCAL_XML_FILE, "farid_gold.xml");

    const buffer = fs.readFileSync(LOCAL_XML_FILE);
    const xml = iconv.decode(buffer, "win1251");

    const parsed = await xml2js.parseStringPromise(xml, { explicitArray: false });
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

    // 📌 Сохраняем JSON локально (как бэкап)
    fs.writeFileSync(CACHE_FILE, JSON.stringify(normalized, null, 2), 'utf8');
    console.log(`✅ Прайс сохранён локально: ${normalized.length} позиций`);

    // 📌 Обновляем MongoDB (upsert)
    for (const product of normalized) {
      await Product.updateOne(
        { id: product.id },
        { $set: { ...product, updatedAt: new Date() } },
        { upsert: true }
      );
    }

    console.log("✅ Прайс обновлён в MongoDB");

  } catch (err) {
    console.error("❌ Ошибка при обновлении прайса:", err.message);
  } finally {
    client.close();
  }
}

// =======================
// 📌 Cron — обновлять каждый час
// =======================
cron.schedule('0 * * * *', fetchAndCacheXML);

// Первый запуск при старте
fetchAndCacheXML();

// =======================
// 📌 API — получить цены
// =======================
app.get('/api/prices', async (req, res) => {
  try {
    const products = await Product.find();
    if (products.length > 0) {
      return res.json(products);
    }
  } catch (err) {
    console.error("❌ Ошибка чтения из MongoDB:", err.message);
  }

  // ⚠️ fallback — берём локальный JSON
  if (fs.existsSync(CACHE_FILE)) {
    return res.sendFile(CACHE_FILE);
  }

  res.status(503).json({ error: '⏳ Прайс ещё не готов' });
});

// =======================
// 📌 Запуск сервера
// =======================
app.listen(PORT, () => {
  console.log(`🚀 API работает: http://localhost:${PORT}/api/prices`);
});
