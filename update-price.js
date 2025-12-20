const ftp = require('basic-ftp');
const iconv = require('iconv-lite');
const xml2js = require('xml2js');
const fs = require('fs');
const path = require('path');
const nodemailer = require('nodemailer');

const LOCAL_XML_FILE = path.join(__dirname, 'farid_gold.xml');
const CACHE_FILE = path.join(__dirname, 'cached_prices.json');
const TEMP_CACHE_FILE = path.join(__dirname, 'cached_prices.tmp.json');

const transporter = nodemailer.createTransport({
  host: 'smtp.yandex.ru',
  port: 465,
  secure: true,
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS
  }
});

async function notifyError(subject, message) {
  await transporter.sendMail({
    from: `"Auto FTP Sync" <${process.env.EMAIL_USER}>`,
    to: process.env.EMAIL_TO,
    subject,
    text: message
  });
}

async function fetchAndCacheXML() {
  const client = new ftp.Client();
  try {
    console.log('FTP connect...');
    await client.access({
      host: process.env.FTP_HOST,
      user: process.env.FTP_USER,
      password: process.env.FTP_PASS,
      port: 21,
      secure: false
    });

    console.log('Downloading XML...');
    await client.downloadTo(LOCAL_XML_FILE, "farid_gold.xml");

    const buffer = fs.readFileSync(LOCAL_XML_FILE);
    const xml = iconv.decode(buffer, "win1251");

    const parsed = await xml2js.parseStringPromise(xml, {
      explicitArray: false
    });

    const items = parsed?.PriceList?.Goods?.Item;
    if (!Array.isArray(items)) {
      throw new Error('Invalid XML structure');
    }

    const normalized = items.map(item => ({
      id: item.$.ID,
      category: item.$.ParentName,
      name: item.$.Name,
      wholesalePrice: Number(item.$.Price.replace(',', '.')) || 0,
      extraPrice: Number(item.$.PriceExt.replace(',', '.')) || 0,
      retailPrice: Number(item.$.PriceRetail.replace(',', '.')) || 0
    }));

    fs.writeFileSync(
      TEMP_CACHE_FILE,
      JSON.stringify(normalized, null, 2),
      'utf8'
    );

    fs.renameSync(TEMP_CACHE_FILE, CACHE_FILE);

    console.log(`Price updated. Items: ${normalized.length}`);
  } catch (err) {
    console.error(err);
    await notifyError(
      'Price update failed',
      err.stack || err.message
    );
    process.exitCode = 1;
  } finally {
    client.close();
  }
}

fetchAndCacheXML();
