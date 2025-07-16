const ftp = require('basic-ftp');
const iconv = require('iconv-lite');
const xml2js = require('xml2js');
const fs = require('fs');
const path = require('path');
const nodemailer = require('nodemailer');

const LOCAL_XML_FILE = path.join(__dirname, 'farid_gold.xml');
const CACHE_FILE = path.join(__dirname, 'cached_prices.json');

// ⚙️ Настройка отправки почты
const transporter = nodemailer.createTransport({
  service: 'gmail', // или mail.yandex.ru и т.п.
  auth: {
    user: 'your.email@gmail.com',
    pass: 'your-app-password' // ⚠️ не обычный пароль! см. ниже
  }
});

const notifyError = async (subject, message) => {
  await transporter.sendMail({
    from: '"Auto FTP Sync" <your.email@gmail.com>',
    to: 'farid@example.com', // <-- замени на свою почту
    subject,
    text: message
  });
};

async function fetchAndCacheXML() {
  const client = new ftp.Client();
  client.ftp.verbose = false;

  try {
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

    const normalized = items.map(item => ({
      id: item.$.ID,
      category: item.$.ParentName,
      name: item.$.Name,
      wholesalePrice: parseFloat(item.$.Price.replace(",", ".")) || 0,
      extraPrice: parseFloat(item.$.PriceExt.replace(",", ".")) || 0,
      retailPrice: parseFloat(item.$.PriceRetail.replace(",", ".")) || 0
    }));

    fs.writeFileSync(CACHE_FILE, JSON.stringify(normalized, null, 2), 'utf8');
    console.log(`✅ Прайс обновлён. Сохранено: ${normalized.length} позиций`);

  } catch (err) {
    const errorMessage = `❌ Ошибка при обновлении прайса:\n${err.message}`;
    console.error(errorMessage);
    await notifyError('❗️Ошибка в автообновлении прайс-листа', errorMessage);
  } finally {
    client.close();
    process.exit(0);
  }
}

fetchAndCacheXML();
