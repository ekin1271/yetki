const puppeteer = require('puppeteer');
const fs = require('fs');

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

const STATE_FILE = 'tekel_state.json';
const HOTELS_FILE = 'hotels.json';

const AGENCY_RULES = [
{ pattern: '103810219', name: 'PENINSULA' },
{ pattern: '103816', name: 'AKAY' },
];

function loadHotels() {
if (fs.existsSync(HOTELS_FILE)) {
return JSON.parse(fs.readFileSync(HOTELS_FILE, 'utf8'));
}
return [];
}

function generateDates() {
const dates = [];
const now = new Date();

const firstDate = new Date(now);
firstDate.setDate(firstDate.getDate() + 5);

if (firstDate.getMonth() === 2) {
firstDate.setMonth(3);
firstDate.setDate(15);
}

for (let m = 0; m < 3; m++) {

```
const d =
  m === 0
    ? new Date(firstDate)
    : new Date(firstDate.getFullYear(), firstDate.getMonth() + m, 15);

const day = String(d.getDate()).padStart(2, '0');
const month = String(d.getMonth() + 1).padStart(2, '0');
const year = d.getFullYear();

const checkIn = `${day}.${month}.${year}`;

const outDate = new Date(d);
outDate.setDate(outDate.getDate() + 7);

const outDay = String(outDate.getDate()).padStart(2, '0');
const outMonth = String(outDate.getMonth() + 1).padStart(2, '0');

const checkOut = `${outDay}.${outMonth}.${outDate.getFullYear()}`;

dates.push({ checkIn, checkOut });
```

}

return dates;
}

function generateUrls() {

const hotels = loadHotels();
const dates = generateDates();
const urls = [];

for (const { checkIn, checkOut } of dates) {

```
for (const hotel of hotels) {

  const url =
    `https://www.bgoperator.ru/price.shtml?action=price&tid=211&idt=&flt2=100510000863&id_price=121110211811&data=${checkIn}&d2=${checkOut}&f7=7&f3=&f8=&ho=0&F4=${hotel.id}&ins=0-40000-EUR&flt=100411293179&p=${hotel.p}`;

  urls.push({
    url,
    checkIn,
    hotelId: hotel.id
  });
}
```

}

return urls;
}

async function sendTelegram(text) {

if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
console.log(text);
return;
}

const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;

const resp = await fetch(url, {
method: 'POST',
headers: { 'Content-Type': 'application/json' },
body: JSON.stringify({
chat_id: TELEGRAM_CHAT_ID,
text,
parse_mode: 'HTML',
disable_web_page_preview: true
}),
});

if (!resp.ok) {
console.error('Telegram hatasi:', resp.status, await resp.text());
}
}

async function scrapePageOnce(browser, targetUrl, checkIn, hotelId) {

const page = await browser.newPage();

await page.setUserAgent(
'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36'
);

await page.setViewport({ width: 1920, height: 1080 });

try {
await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
} catch {}

try {
await page.waitForSelector('li.s8.i_t1', { timeout: 30000 });
} catch {}

await new Promise(r => setTimeout(r, 2000));

const urlDateMatch = targetUrl.match(/data=(\d{2}.\d{2}.\d{4})/);
const targetDate = urlDateMatch ? urlDateMatch[1] : null;

const agencyRulesStr = JSON.stringify(AGENCY_RULES);

const results = await page.evaluate(
(agencyRulesStr, targetDate, hotelId) => {

```
  const agencyRules = JSON.parse(agencyRulesStr);

  function identifyAgency(id) {
    for (const rule of agencyRules) {
      if (id.includes(rule.pattern)) return rule.name;
    }
    return 'BILINMEYEN';
  }

  const offers = [];

  const allRows = document.querySelectorAll('table tr');

  let currentHotel = '';
  let pageHotelId = null;

  for (const tr of allRows) {

    const hotelLink = tr.querySelector('a[href*="action=shw"]');

    if (hotelLink) {

      currentHotel = hotelLink.textContent.trim();

      const href = hotelLink.getAttribute('href') || '';

      const match = href.match(/F4=(\d+)/);

      if (match) pageHotelId = match[1];
    }

    if (pageHotelId && pageHotelId !== hotelId) continue;

    const agencyLis = tr.querySelectorAll('li.s8.i_t1');

    if (agencyLis.length === 0) continue;

    let matchedLi = null;

    for (const li of agencyLis) {

      const urr = li.getAttribute('urr') || '';

      if (targetDate && urr.includes(targetDate)) {
        matchedLi = li;
        break;
      }
    }

    if (!matchedLi) matchedLi = agencyLis[0];

    const urr = matchedLi.getAttribute('urr') || '';

    const idMatch = urr.match(/id=(\d+)/);

    if (!idMatch) continue;

    const agency = identifyAgency(idMatch[1]);

    if (agency === 'BILINMEYEN') continue;

    let priceRub = null;

    const priceEl = tr.querySelector('td.c_pe b');

    if (priceEl) {
      priceRub = parseInt(priceEl.textContent.replace(/\D/g, ''), 10);
    }

    let roomType = 'UNKNOWN';

    const roomEl = tr.querySelector('td.c_ns');

    if (roomEl) {
      roomType = roomEl.textContent.trim().split('\n')[0].trim();
    }

    if (priceRub && currentHotel) {

      offers.push({
        agency,
        hotelName: currentHotel,
        roomType,
        priceRub
      });
    }
  }

  return offers;

},
agencyRulesStr,
targetDate,
hotelId
```

);

await page.close();

return results;
}

async function scrapePageWithDateShift(browser, targetUrl, checkIn, hotelId) {

let results = await scrapePageOnce(browser, targetUrl, checkIn, hotelId);

if (results.length > 0) {
return { results, usedUrl: targetUrl, usedCheckIn: checkIn };
}

const [d, m, y] = checkIn.split('.');

const date = new Date(y, m - 1, d);

date.setDate(date.getDate() + 5);

const nd = String(date.getDate()).padStart(2, '0');
const nm = String(date.getMonth() + 1).padStart(2, '0');
const ny = date.getFullYear();

const newCheckIn = `${nd}.${nm}.${ny}`;

const outDate = new Date(date);

outDate.setDate(outDate.getDate() + 7);

const od = String(outDate.getDate()).padStart(2, '0');
const om = String(outDate.getMonth() + 1).padStart(2, '0');
const oy = outDate.getFullYear();

const newCheckOut = `${od}.${om}.${oy}`;

const newUrl = targetUrl
.replace(/data=\d{2}.\d{2}.\d{4}/, `data=${newCheckIn}`)
.replace(/d2=\d{2}.\d{2}.\d{4}/, `d2=${newCheckOut}`);

results = await scrapePageOnce(browser, newUrl, newCheckIn, hotelId);

return {
results,
usedUrl: newUrl,
usedCheckIn: newCheckIn
};
}

async function main() {

const browser = await puppeteer.launch({
headless: 'new',
args: ['--no-sandbox', '--disable-setuid-sandbox']
});

const urls = generateUrls();

const CONCURRENCY = 10;

for (let i = 0; i < urls.length; i += CONCURRENCY) {

```
const batch = urls.slice(i, i + CONCURRENCY);

await Promise.all(
  batch.map(({ url, checkIn, hotelId }) =>
    scrapePageWithDateShift(browser, url, checkIn, hotelId)
  )
);
```

}

await browser.close();
}

main();
