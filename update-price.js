const ftp = require('basic-ftp');
const iconv = require('iconv-lite');
const xml2js = require('xml2js');
const fs = require('fs');
const path = require('path');
const nodemailer = require('nodemailer');

const LOCAL_XML_FILE = path.join(__dirname, 'farid_gold.xml');
const CACHE_FILE = path.join(__dirname, 'cached_prices.json');
const TEMP_CACHE_FILE = path.join(__dirname, 'cached_prices.tmp.json');

// ===== SMTP (НЕ КРИТИЧНО) =====
let transporter = null;
if (process.env.EMAIL_USER && process.env.EMAIL_PASS) {
  transporter = nodemailer.createTransport({
    host: 'smtp.yandex.ru',
    port: 465,
    secure: true,
    auth: {
      user: process.env.EMAIL_USER,
      pass: process.env.EMAIL_PASS
    }
  });
}

async function notifyError(subject, message) {
  if (!transporter || !process.env.EMAIL_TO) return;
  try {
    await transporter.sendMail({
      from: `"Auto FTP Sync" <${process.env.EMAIL_USER}>`,
      to: process.env.EMAIL_TO,
      subject,
      text: message
    });
  } catch (_) {}
}

// ===== MAIN =====
async function fetchAndCacheXML() {
  const requiredEnv = ['FTP_HOST', 'FTP_USER', 'FTP_PASS'];
  for (const key of requiredEnv) {
    if (!process.env[key]) {
      console.error(`ENV ${key} is not set`);
      process.exit(1);
    }
  }

  const client = new ftp.Client();
  client.ftp.verbose = false;
  client.prepareTransfer = ftp.enterPassiveModeIPv4;

  try {
    console.log('FTP connect...');
    await client.access({
      host: process.env.FTP_HOST,
      user: process.env.FTP_USER,
      password: process.env.FTP_PASS,
      port: 21,
      secure: true,
      secureOptions: {
        rejectUnauthorized: false
      }
    });

    console.log('Downloading XML...');
    await client.downloadTo(LOCAL_XML_FILE, 'farid_gold.xml');

    const buffer = fs.readFileSync(LOCAL_XML_FILE);
    const xml = iconv.decode(buffer, 'win1251');

    const parsed = await xml2js.parseStringPromise(xml, { explicitArray: false });

    let items = parsed?.PriceList?.Goods?.Item;
    if (!items) throw new Error('No items in XML');

    if (!Array.isArray(items)) items = [items];

    const normalized = items
      .map(item => ({
        id: String(item.$.ID),
        category: item.$.ParentName?.trim() || '',
        name: item.$.Name?.trim() || '',
        wholesalePrice: Number(item.$.Price?.replace(',', '.')) || 0,
        extraPrice: Number(item.$.PriceExt?.replace(',', '.')) || 0,
        retailPrice: Number(item.$.PriceRetail?.replace(',', '.')) || 0
      }))
      .sort((a, b) => a.id.localeCompare(b.id));

    fs.writeFileSync(
      TEMP_CACHE_FILE,
      JSON.stringify(normalized, null, 2),
      'utf8'
    );
    fs.renameSync(TEMP_CACHE_FILE, CACHE_FILE);

    console.log(`Price updated. Items: ${normalized.length}`);
    process.exit(0);
  } catch (err) {
    console.error('ERROR:', err.message);
    await notifyError('Price update failed', err.message);
    process.exit(1);
  } finally {
    client.close();
  }
}

fetchAndCacheXML();
