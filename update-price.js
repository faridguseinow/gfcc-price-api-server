const ftp = require('basic-ftp');
const iconv = require('iconv-lite');
const xml2js = require('xml2js');
const fs = require('fs');
const path = require('path');
const nodemailer = require('nodemailer');

const LOCAL_XML_FILE = path.join(__dirname, 'farid_gold.xml');
const CACHE_FILE = path.join(__dirname, 'cached_prices.json');
const TEMP_CACHE_FILE = path.join(__dirname, 'cached_prices.tmp.json');
const REMOTE_XML_FILE = process.env.FTP_XML_FILE || 'farid_gold.xml';
const SOURCE_XML_FILE = process.env.PRICE_XML_SOURCE
  ? path.resolve(process.env.PRICE_XML_SOURCE)
  : null;

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

function scoreDecodedXML(xml) {
  const cyrillicMatches = xml.match(/[А-Яа-яЁё]/g) || [];
  const mojibakeMatches = xml.match(/[ÐÑ][\u0080-\u00BF]/g) || [];
  const replacementMatches = xml.match(/\uFFFD/g) || [];
  let score = cyrillicMatches.length - (mojibakeMatches.length * 5) - (replacementMatches.length * 20);

  if (xml.includes('<PriceList')) score += 1000;
  if (xml.includes('<Goods')) score += 500;
  if (xml.includes('<Item')) score += 250;

  return score;
}

function decodeXML(buffer) {
  const utf8 = iconv.decode(buffer, 'utf8');
  const header = utf8.slice(0, 256);

  if (
    buffer.slice(0, 3).equals(Buffer.from([0xEF, 0xBB, 0xBF])) ||
    /encoding=["']utf-?8["']/i.test(header)
  ) {
    return utf8;
  }

  if (/encoding=["']windows-1251["']|encoding=["']cp1251["']|encoding=["']win-?1251["']/i.test(header)) {
    return iconv.decode(buffer, 'win1251');
  }

  if (utf8.includes('<PriceList') && !utf8.includes('\uFFFD')) {
    return utf8;
  }

  const candidates = [
    utf8,
    iconv.decode(buffer, 'win1251')
  ];

  return candidates
    .map((xml) => ({ xml, score: scoreDecodedXML(xml) }))
    .sort((a, b) => b.score - a.score)[0].xml;
}

function stripToXMLDocument(rawXML) {
  const withoutBom = rawXML.replace(/^\uFEFF/, '');
  const firstTagIndex = withoutBom.search(/<\?xml|<PriceList/);

  if (firstTagIndex === -1) {
    const firstChar = withoutBom.trimStart().charAt(0) || '(empty)';
    throw new Error(`No XML PriceList tag found. First char: ${firstChar}`);
  }

  if (firstTagIndex > 0) {
    console.warn(`WARN: removed ${firstTagIndex} non-XML characters before PriceList tag`);
  }

  return withoutBom.slice(firstTagIndex);
}

function parsePrice(value) {
  return Number(String(value || '').replace(',', '.')) || 0;
}

function asArray(value) {
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
}

function normalizeGoodsItems(items) {
  return items
    .map((item) => {
      const attrs = item.$ || {};
      return {
        id: String(attrs.ID || ''),
        category: attrs.ParentName?.trim() || '',
        name: attrs.Name?.trim() || '',
        wholesalePrice: parsePrice(attrs.Price),
        extraPrice: parsePrice(attrs.PriceExt),
        retailPrice: parsePrice(attrs.PriceRetail)
      };
    })
    .filter((item) => item.id && item.name)
    .sort((a, b) => a.id.localeCompare(b.id));
}

function normalizePriceRows(priceRows) {
  return priceRows
    .map((item) => {
      const attrs = item.$ || {};
      const id = String(attrs.ID || attrs.НоменклатураУид || attrs.NomenclatureUid || '');
      const characteristicId = String(attrs.ХарактеристикаУид || attrs.CharacteristicUid || '');
      const price = parsePrice(attrs.Price || attrs.Цена || attrs.Value);

      return {
        id,
        characteristicId,
        category: 'Прайс',
        name: id,
        wholesalePrice: price,
        extraPrice: price,
        retailPrice: price
      };
    })
    .filter((item) => item.id && item.wholesalePrice > 0)
    .sort((a, b) => a.id.localeCompare(b.id));
}

function normalizePriceList(parsed) {
  let items = parsed?.PriceList?.Goods?.Item;
  items = asArray(items);

  if (items.length) {
    return normalizeGoodsItems(items);
  }

  const priceRows = asArray(parsed?.PriceList?.Prices?.Price);
  if (priceRows.length) {
    return normalizePriceRows(priceRows);
  }

  throw new Error('No Goods/Item or Prices/Price rows in XML');
}

// ===== MAIN =====
async function fetchAndCacheXML() {
  if (!SOURCE_XML_FILE) {
    const requiredEnv = ['FTP_HOST', 'FTP_USER', 'FTP_PASS'];
    for (const key of requiredEnv) {
      if (!process.env[key]) {
        console.error(`ENV ${key} is not set`);
        process.exit(1);
      }
    }
  }

  const client = new ftp.Client();
  client.ftp.verbose = false;
  client.prepareTransfer = ftp.enterPassiveModeIPv4;

  try {
    if (SOURCE_XML_FILE) {
      console.log(`Using local XML: ${SOURCE_XML_FILE}`);
      fs.copyFileSync(SOURCE_XML_FILE, LOCAL_XML_FILE);
    } else {
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
      await client.downloadTo(LOCAL_XML_FILE, REMOTE_XML_FILE);
    }

    const buffer = fs.readFileSync(LOCAL_XML_FILE);
    const xml = stripToXMLDocument(decodeXML(buffer));

    const parsed = await xml2js.parseStringPromise(xml, { explicitArray: false });

    const normalized = normalizePriceList(parsed);
    if (!normalized.length) throw new Error('No valid price items in XML');

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
