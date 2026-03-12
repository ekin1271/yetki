const puppeteer = require('puppeteer');
const fs = require('fs');

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const STATE_FILE = 'tekel_state.json';       // FARK 1
const HOTELS_FILE = 'hotels.json';

// FARK 2: Sadece Peninsula ve AKAY
const AGENCY_RULES = [
  { pattern: '103810219', name: 'PENINSULA' },
  { pattern: '103816', name: 'AKAY' },
];

function loadHotelIds() {
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

  // FARK 3: 3 ay
  for (let m = 0; m < 3; m++) {
    const d = m === 0
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
  }
  return dates;
}

function generateUrls() {
  const hotelIds = loadHotelIds();
  const dates = generateDates();
  const urls = [];

  for (const { checkIn, checkOut } of dates) {
    for (const hotelId of hotelIds) {
      const url = `https://www.bgoperator.ru/price.shtml?action=price&tid=211&idt=&flt2=100510000863&id_price=121110211811&data=${checkIn}&d2=${checkOut}&f7=7&f3=&f8=&ho=0&F4=${hotelId}&ins=0-40000-EUR&flt=100411293179&p=0100319900.0100319900`;
      urls.push({ url, checkIn, hotelId });
    }
  }
  return urls;
}

async function sendTelegram(text) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) { console.log(text); return; }
  const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text, parse_mode: 'HTML', disable_web_page_preview: true }),
  });
  if (!resp.ok) console.error('Telegram hatasi:', resp.status, await resp.text());
  else console.log('Telegram bildirimi gonderildi.');
}

// FARK 4: Tekel raporu formatı
async function sendTelegramSplit(newAlerts, closedAlerts) {
  const time = `\n🕐 ${new Date().toLocaleString('tr-TR', { timeZone: 'Europe/Istanbul' })}`;
  const allAlerts = [
    ...newAlerts.map(a => ({ ...a, type: 'new' })),
    ...closedAlerts.map(a => ({ ...a, type: 'closed' })),
  ];

  if (allAlerts.length === 0) return;

  const hotelGroups = {};
  for (const a of allAlerts) {
    const key = `${a.hotel}__${a.room}`;
    if (!hotelGroups[key]) hotelGroups[key] = { hotel: a.hotel, room: a.room, entries: [] };
    hotelGroups[key].entries.push(a);
  }

  for (const group of Object.values(hotelGroups)) {
    group.entries.sort((a, b) => {
      const toDate = s => { const [d,m,y] = s.split('.'); return new Date(y,m-1,d); };
      return toDate(a.checkIn) - toDate(b.checkIn);
    });
  }

  let current = '🔍 <b>Tekel İhlali Raporu</b>\n\n';
  for (const group of Object.values(hotelGroups)) {
    let block = `🏨 <b>${group.hotel}</b>\n🛏 ${group.room}\n`;
    for (const a of group.entries) {
      if (a.type === 'closed') {
        block += `  📅 ${a.checkIn} ✅ AKAY kapandı\n`;
      } else if (!a.peninsulaPrice) {
        block += `  📅 ${a.checkIn} 🚨 AKAY girdi\n`;
        block += `     ⚠️ AKAY: ${a.akayPrice.toLocaleString('tr-TR')} RUB\n`;
      } else if (a.akayPrice < a.peninsulaPrice) {
        block += `  📅 ${a.checkIn} 🚨 AKAY öne geçti\n`;
        block += `     📌 Peninsula: ${a.peninsulaPrice.toLocaleString('tr-TR')} RUB\n`;
        block += `     ⚠️ AKAY: ${a.akayPrice.toLocaleString('tr-TR')} RUB (Fark: ${(a.peninsulaPrice - a.akayPrice).toLocaleString('tr-TR')} RUB)\n`;
      } else if (a.akayPrice === a.peninsulaPrice) {
        block += `  📅 ${a.checkIn} 🟡 Fiyatlar eşit\n`;
        block += `     📌 Peninsula = AKAY: ${a.peninsulaPrice.toLocaleString('tr-TR')} RUB\n`;
      } else {
        block += `  📅 ${a.checkIn} 🆕 Rakip girdi (biz öndeyiz)\n`;
        block += `     📌 Peninsula: ${a.peninsulaPrice.toLocaleString('tr-TR')} RUB\n`;
        block += `     ⚠️ AKAY: ${a.akayPrice.toLocaleString('tr-TR')} RUB\n`;
      }
    }
    block += `─────────────────\n`;

    if ((current + block).length > 3500) {
      await sendTelegram(current);
      current = '🔍 <b>Tekel İhlali Raporu (devam)</b>\n\n' + block;
    } else {
      current += block;
    }
  }
  await sendTelegram(current + time);
}

// === AŞAĞISI FİYAT ANALİZİ İLE BİREBİR AYNI ===

async function scrapePageOnce(browser, targetUrl, checkIn) {
  const page = await browser.newPage();
  await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
  await page.setViewport({ width: 1920, height: 1080 });

  try {
    await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
  } catch(e) {}

  try {
    await page.waitForSelector('li.s8.i_t1', { timeout: 30000 });
  } catch(e) {}

  await new Promise(r => setTimeout(r, 2000));

  const urlDateMatch = targetUrl.match(/data=(\d{2}\.\d{2}\.\d{4})/);
  const targetDate = urlDateMatch ? urlDateMatch[1] : null;
  const agencyRulesStr = JSON.stringify(AGENCY_RULES);

  const results = await page.evaluate((agencyRulesStr, targetDate) => {
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

    for (const tr of allRows) {
      const hotelLink = tr.querySelector('a[href*="action=shw"]');
      if (hotelLink) currentHotel = hotelLink.textContent.trim();

      const agencyLis = tr.querySelectorAll('li.s8.i_t1');
      if (agencyLis.length === 0) continue;

      let matchedLi = null;
      for (const li of agencyLis) {
        const urr = li.getAttribute('urr') || '';
        if (targetDate && urr.includes(targetDate)) { matchedLi = li; break; }
      }
      if (!matchedLi) matchedLi = agencyLis[0];

      const urr = matchedLi.getAttribute('urr') || '';
      const idMatch = urr.match(/id=(\d+)/);
      if (!idMatch) continue;

      const agency = identifyAgency(idMatch[1]);
      let priceRub = null;
      const priceEl = tr.querySelector('td.c_pe b');
      if (priceEl) priceRub = parseInt(priceEl.textContent.replace(/\D/g, ''), 10);

      let roomType = 'UNKNOWN';
      const roomEl = tr.querySelector('td.c_ns');
      if (roomEl) roomType = roomEl.textContent.trim().split('\n')[0].trim();

      if (priceRub && currentHotel) offers.push({ agency, hotelName: currentHotel, roomType, priceRub });
    }
    return offers;
  }, agencyRulesStr, targetDate);

  await page.close();
  return results;
}


// FARK 4: present/absent mantığı
function analyzeOffers(checkIn, offers, prevState, newState) {
  const newAlerts = [];
  const closedAlerts = [];
  const groups = {};

  for (const offer of offers) {
    const key = `${checkIn}__${offer.hotelName}__${offer.roomType}`;
    if (!groups[key]) groups[key] = { hotelName: offer.hotelName, roomType: offer.roomType, peninsula: null, akay: null };
    if (offer.agency === 'PENINSULA') {
      if (!groups[key].peninsula || offer.priceRub < groups[key].peninsula)
        groups[key].peninsula = offer.priceRub;
    } else if (offer.agency === 'AKAY') {
      if (!groups[key].akay || offer.priceRub < groups[key].akay)
        groups[key].akay = offer.priceRub;
    }
  }

  for (const [key, data] of Object.entries(groups)) {
    if (!data.peninsula) continue;

    const prevStatus = prevState[key];

    if (!data.akay) {
      newState[key] = 'absent';
      if (prevStatus === 'present') {
        closedAlerts.push({ checkIn, hotel: data.hotelName, room: data.roomType });
      }
    } else {
      newState[key] = 'present';
      if (prevStatus !== 'present') {
        newAlerts.push({ checkIn, hotel: data.hotelName, room: data.roomType, peninsulaPrice: data.peninsula, akayPrice: data.akay });
      }
    }
  }

  return { newAlerts, closedAlerts };
}

function loadState() {
  if (fs.existsSync(STATE_FILE)) return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  return {};
}

function saveState(state) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), 'utf8');
}

async function main() {
  console.log('Tarama basliyor...');
  const dates = generateDates();
  console.log('Taranan aylar:', dates.map(d => d.checkIn).join(', '));

  const hotelIds = loadHotelIds();
  console.log(`Otel sayisi: ${hotelIds.length}`);

  const prevState = loadState();
  const newState = { ...prevState };
  const allNewAlerts = [];
  const allClosedAlerts = [];

  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
  });

  try {
    const urls = generateUrls();
    console.log(`Toplam URL: ${urls.length}`);

    const offersByDate = {};
    const emptyUrls = [];
    let completed = 0;
    const CONCURRENCY = 10;

    for (let i = 0; i < urls.length; i += CONCURRENCY) {
      const batch = urls.slice(i, i + CONCURRENCY);
      const results = await Promise.all(
        batch.map(({ url, checkIn }) => scrapePageOnce(browser, url, checkIn).then(results => ({ results, url, usedCheckIn: checkIn })))
      );
      for (const { results: offers, url: batchUrl, usedCheckIn } of results) {
        if (offers.length > 0) {
          if (!offersByDate[usedCheckIn]) offersByDate[usedCheckIn] = [];
          offersByDate[usedCheckIn].push(...offers);
        } else {
          emptyUrls.push({ url: batchUrl, checkIn: usedCheckIn });
        }
      }
      completed += batch.length;
      if (completed % 100 === 0 || completed === urls.length) console.log(`  ${completed}/${urls.length} tamamlandi`);
    }

    if (emptyUrls.length > 0) {
      console.log(`\n--- BOŞ GELEN URL'LER (${emptyUrls.length} adet) ---`);
      for (const { url, checkIn } of emptyUrls) {
        console.log(`  [BOŞ] ${checkIn} - ${url}`);
      }
      console.log('---');
    }

    for (const [checkIn, offers] of Object.entries(offersByDate)) {
      const { newAlerts, closedAlerts } = analyzeOffers(checkIn, offers, prevState, newState);
      allNewAlerts.push(...newAlerts);
      allClosedAlerts.push(...closedAlerts);
    }
  } finally {
    await browser.close();
  }

  saveState(newState);
  console.log('State kaydedildi.');

  if (allNewAlerts.length > 0 || allClosedAlerts.length > 0) {
    console.log(`${allNewAlerts.length} yeni AKAY, ${allClosedAlerts.length} kapanan AKAY. Bildirim gonderiliyor...`);
    await sendTelegramSplit(allNewAlerts, allClosedAlerts);
  } else {
    console.log('Uyari yok.');
  }
}

main().catch(async err => {
  console.error('Hata:', err.message);
  await sendTelegram(`❌ <b>Tekel Monitor Hatasi</b>\n\n${err.message}`).catch(() => {});
  process.exit(1);
});
