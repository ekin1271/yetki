const fs = require('fs');
const https = require('https');
const puppeteer = require('puppeteer');

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const TELEGRAM_GROUP_ID = process.env.GROUP_CHAT_ID;

const STATE_FILE = 'tekel_state.json';
const HOTELS_FILE = 'hotels.json';
const CONCURRENCY = 8;

const AGENCY_RULES = [
  { pattern: '103810219',    name: 'PENINSULA' },
  { pattern: '103810221461', name: 'PENINSULA' },
  { pattern: '103810221462', name: 'PENINSULA' },
  { pattern: '103816',       name: 'AKAY' },
];

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function fetchAndParse(browser, url, checkIn, hotelId) {
  const page = await browser.newPage();

  await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64)');
  await page.setViewport({ width: 1920, height: 1080 });

  try { await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 }); } catch(e) {}

  // ✅ DAHA GÜÇLÜ BEKLEME
  try {
    await page.waitForSelector('div.b-pr', { timeout: 30000 });
    await page.waitForSelector('td.c_pe a', { timeout: 30000 });
  } catch(e) {}

  await sleep(3000);

  const agencyRulesStr = JSON.stringify(AGENCY_RULES);

  const offers = await page.evaluate((agencyRulesStr, targetDate, fallbackHotelId) => {
    const agencyRules = JSON.parse(agencyRulesStr);

    function identifyAgency(urr) {
      if (!urr) return null;
      for (const rule of agencyRules) {
        if (urr.includes(rule.pattern)) return rule.name;
      }
      return null;
    }

    function extractEurPrice(tr) {
      const priceTd = tr.querySelector('td.c_pe');
      if (!priceTd) return null;

      const links = priceTd.querySelectorAll('a[href]');
      for (const a of links) {
        const href = a.getAttribute('href') || '';
        const mX = href.match(/[?&]x=(\d+)/);
        if (mX) return parseInt(mX[1], 10);

        const title = a.getAttribute('title') || '';
        const mT = title.match(/(\d+)\s*EUR/i);
        if (mT) return parseInt(mT[1], 10);
      }
      return null;
    }

    const offers = [];

    const blocks = document.querySelectorAll('div.b-pr');

    for (const block of blocks) {

      let hotelName = '';
      const nameLink = block.querySelector('a[href*="action=shw"]');
      if (nameLink) hotelName = nameLink.textContent.trim();
      if (!hotelName) hotelName = `hotel_${fallbackHotelId}`;

      const rows = block.querySelectorAll('tr');

      for (const tr of rows) {

        const lis = Array.from(tr.querySelectorAll('li')).filter(li =>
          li.classList.contains('s8') && li.classList.contains('i_t1')
        );

        if (lis.length === 0) continue;

        let chosenLi = lis[0];

        if (targetDate) {
          for (const li of lis) {
            const urr = li.getAttribute('urr') || '';
            if (urr.includes(`data=${targetDate}`)) {
              chosenLi = li;
              break;
            }
          }
        }

        const urr = chosenLi.getAttribute('urr') || '';
        const agency = identifyAgency(urr);
        if (!agency) continue;

        const price = extractEurPrice(tr);
        if (!price) continue;

        let roomType = 'UNKNOWN';
        const roomTd = tr.querySelector('td.c_ns');
        if (roomTd) {
          const span = roomTd.querySelector('span');
          if (span) roomType = span.textContent.trim();
        }

        offers.push({ agency, hotelName, roomType, price });
      }
    }

    return offers;

  }, agencyRulesStr, checkIn, hotelId);

  await page.close();
  return offers;
}

// GERİSİ AYNEN SENİN KODUN 👇

async function fetchAndParseWithDateShift(browser, url, checkIn, hotelId) {
  const offers = await fetchAndParse(browser, url, checkIn, hotelId);
  if (offers.length > 0) return { offers, usedCheckIn: checkIn };

  const [d, m, y] = checkIn.split('.');
  const date = new Date(y, m - 1, d);
  date.setDate(date.getDate() + 5);

  const fmt = n => String(n).padStart(2, '0');
  const newCheckIn  = `${fmt(date.getDate())}.${fmt(date.getMonth()+1)}.${date.getFullYear()}`;

  const out = new Date(date);
  out.setDate(out.getDate() + 7);
  const newCheckOut = `${fmt(out.getDate())}.${fmt(out.getMonth()+1)}.${out.getFullYear()}`;

  const newUrl = url
    .replace(/data=\d{2}\.\d{2}\.\d{4}/, `data=${newCheckIn}`)
    .replace(/d2=\d{2}\.\d{2}\.\d{4}/,   `d2=${newCheckOut}`);

  const offers2 = await fetchAndParse(browser, newUrl, newCheckIn, hotelId);
  return { offers: offers2, usedCheckIn: newCheckIn };
}

function loadHotels() {
  return JSON.parse(fs.readFileSync(HOTELS_FILE, 'utf8'));
}

function loadState() {
  if (fs.existsSync(STATE_FILE)) return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  return {};
}

function saveState(state) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), 'utf8');
}

async function sendTelegram(text) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
    console.log('[TEL]', text.slice(0, 200));
    return;
  }

  const body = JSON.stringify({
    chat_id: TELEGRAM_CHAT_ID,
    text,
    parse_mode: 'HTML'
  });

  const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;

  await new Promise((resolve) => {
    const req = https.request(url, { method: 'POST', headers: { 'Content-Type': 'application/json' } }, res => {
      res.on('data', () => {});
      res.on('end', resolve);
    });
    req.write(body);
    req.end();
  });
}

async function main() {
  console.log('Tarama başlıyor...');

  const hotels = loadHotels();
  const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox'] });

  try {
    for (const hotel of hotels) {
      const url = hotel.url;

      const { offers } = await fetchAndParseWithDateShift(browser, url, hotel.checkIn, hotel.id);

      if (offers.length > 0) {
        await sendTelegram(`✅ ${hotel.name} → ${offers.length} teklif bulundu`);
      }
    }
  } finally {
    await browser.close();
  }
}

main();
