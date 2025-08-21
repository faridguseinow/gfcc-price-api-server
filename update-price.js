const ftp = require('basic-ftp');
const iconv = require('iconv-lite');
const xml2js = require('xml2js');
const fs = require('fs');
const path = require('path');
const nodemailer = require('nodemailer');
const mongoose = require('mongoose');

// ===== MongoDB =====
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

// ===== FTP / FILES =====
const LOCAL_XML_FILE = path.join(__dirname, 'farid_gold.xml');

// ===== SMTP =====
const transporter = nodemailer.createTransport({
  host: 'smtp.yandex.ru',
  port: 465,
  secure: true,
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS
  }
});

const notifyError = async (subject, message) => {
  try {
    await transporter.sendMail({
      from: `"Auto FTP Sync" <${process.env.EMAIL_USER}>`,
      to: process.env.EMAIL_TO,
      subject,
      text: message
    });
  } catch (err) {
    console.error("❌ Ошибка при отправке email:", err.message);
  }
};

// ===== MAIN LOGIC =====
async function fetchAndUpdateDB() {
  const client = new ftp.Client();
  client.ftp.verbose = false;

  try {
    console.log('🔄 Подключение к MongoDB...');
    await mongoose.connect(process.env.MONGO_URI);

    console.log('🔄 Подключение к FTP...');
    await client.access({
      host: "192.168.7.108",
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

    console.log(`📊 Найдено товаров: ${items.length}`);

    // Приведение к JSON
    const normalized = items.map(item => ({
      id: item.$.ID,
      category: item.$.ParentName,
      name: item.$.Name,
      wholesalePrice: parseFloat(item.$.Price.replace(",", ".")) || 0,
      extraPrice: parseFloat(item.$.PriceExt.replace(",", ".")) || 0,
      retailPrice: parseFloat(item.$.PriceRetail.replace(",", ".")) || 0,
      updatedAt: new Date()
    }));

    // Обновление в MongoDB
    let updated = 0;
    for (const product of normalized) {
      await Product.updateOne(
        { id: product.id },
        { $set: product },
        { upsert: true }
      );
      updated++;
    }

    console.log(`✅ Прайс обновлён. Сохранено/обновлено: ${updated} позиций`);

  } catch (err) {
    const errorMessage = `❌ Ошибка при обновлении прайса:\n${err.message}`;
    console.error(errorMessage);
    await notifyError('❗️Ошибка в автообновлении прайс-листа', errorMessage);
  } finally {
    client.close();
    await mongoose.disconnect();
    process.exit(0);
  }
}

fetchAndUpdateDB();
