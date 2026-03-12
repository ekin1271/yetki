const puppeteer = require('puppeteer');
const fs = require('fs');

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const STATE_FILE = 'tekel_state.json';
const HOTELS_FILE = 'hotels.json';

const AKAY_PATTERN = '103816';
const PENINSULA_PATTERN = '103810219';

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

function buildUrl(hotelId, p, checkIn, checkOut) {
  return `https://www.bgoperator.ru/price.shtml?action=price&tid=211&idt=&flt2=100510000863&id_price=121110211811&data=${checkIn}&d2=${checkOut}&f7=7&f3=&f8=&ho=0&F4=${hotelId}&ins=0-40000-EUR&flt=100411293179&p=${p}`;
}

function generateUrls() {
  const hotels = loadHotels();
  const dates = generateDates();
  const urls = [];
  for (const { checkIn, checkOut } of dates) {
    for (const hotel of hotels) {
      const url = buildUrl(hotel.id, hotel.p, checkIn, checkOut);
      urls.push({ url, checkIn, checkOut, hotelId: hotel.id, p: hotel.p });
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

async function scrapePageOnce(browser, targetUrl, checkIn) {
  const page = await browser.newPage();
  await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
  await page.setViewport({ width: 1920, height: 1080 });
  try { await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 60000 }); } catch(e) {}
  try { await page.waitForSelector('li.s8.i_t1', { timeout: 30000 }); } catch(e) {}
  await new Promise(r => setTimeout(r, 2000));

  const urlDateMatch = targetUrl.match(/data=(\d{2}\.\d{2}\.\d{4})/);
  const targetDate = urlDateMatch ? urlDateMatch[1] : null;

  const results = await page.evaluate((targetDate, AKAY_PATTERN, PENINSULA_PATTERN) => {
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
      const agencyId = idMatch[1];
      let agency = null;
      if (agencyId.includes(AKAY_PATTERN)) agency = 'AKAY';
      else if (agencyId.includes(PENINSULA_PATTERN)) agency = 'PENINSULA';
      if (!agency) continue;
      let priceRub = null;
      const priceEl = tr.querySelector('td.c_pe b');
      if (priceEl) priceRub = parseInt(priceEl.textContent.replace(/\D/g, ''), 10);
      let roomType = 'UNKNOWN';
      const roomEl = tr.querySelector('td.c_ns');
      if (roomEl) roomType = roomEl.textContent.trim().split('\n')[0].trim();
      if (priceRub && currentHotel) offers.push({ agency, hotelName: currentHotel, roomType, priceRub });
    }
    return offers;
  }, targetDate, AKAY_PATTERN, PENINSULA_PATTERN);

  await page.close();
  return results;
}

async function scrapePageWithDateShift(browser, targetUrl, checkIn, checkOut, p, hotelId) {
  let results = await scrapePageOnce(browser, targetUrl, checkIn);
  if (results.length > 0) return { results, usedUrl: targetUrl, usedCheckIn: checkIn };

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
  const newUrl = buildUrl(hotelId, p, newCheckIn, newCheckOut);

  results = await scrapePageOnce(browser, newUrl, newCheckIn);
  return { results, usedUrl: newUrl, usedCheckIn: newCheckIn, shifted: true, originalCheckIn: checkIn };
}

function analyzeOffers(checkIn, offers, prevState, newState) {
  const newAlerts = [];
  const closedAlerts = [];

  const groups = {};
  for (const offer of offers) {
    const key = `${offer.hotelName}__${offer.roomType}`;
    if (!groups[key]) groups[key] = { hotelName: offer.hotelName, roomType: offer.roomType, hasAkay: false, akayPrice: null, hasPeninsula: false, peninsulaPrice: null };
    if (offer.agency === 'AKAY') {
      groups[key].hasAkay = true;
      if (!groups[key].akayPrice || offer.priceRub < groups[key].akayPrice)
        groups[key].akayPrice = offer.priceRub;
    }
    if (offer.agency === 'PENINSULA') {
      groups[key].hasPeninsula = true;
      if (!groups[key].peninsulaPrice || offer.priceRub < groups[key].peninsulaPrice)
        groups[key].peninsulaPrice = offer.priceRub;
    }
  }

  for (const [key, data] of Object.entries(groups)) {
    const stateKey = `${checkIn}__${data.hotelName}__${data.roomType}`;
    const prevStatus = prevState[stateKey];

    if (data.hasAkay) {
      newState[stateKey] = 'present';
      if (prevStatus !== 'present') {
        newAlerts.push({ checkIn, hotel: data.hotelName, room: data.roomType, akayPrice: data.akayPrice, peninsulaPrice: data.peninsulaPrice });
      }
    } else if (data.hasPeninsula) {
      newState[stateKey] = 'absent';
      if (prevStatus === 'present') {
        closedAlerts.push({ checkIn, hotel: data.hotelName, room: data.roomType });
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

async function sendReport(newAlerts, closedAlerts) {
  const time = `\n🕐 ${new Date().toLocaleString('tr-TR', { timeZone: 'Europe/Istanbul' })}`;
  if (newAlerts.length === 0 && closedAlerts.length === 0) return;

  let msg = `🔍 <b>Tekel İhlali Raporu</b>\n\n`;

  if (newAlerts.length > 0) {
    msg += `🚨 <b>AKAY Açık (${newAlerts.length} kayıt)</b>\n`;
    msg += `─────────────────\n`;
    const byHotel = {};
    for (const a of newAlerts) {
      if (!byHotel[a.hotel]) byHotel[a.hotel] = [];
      byHotel[a.hotel].push(a);
    }
    for (const [hotel, entries] of Object.entries(byHotel)) {
      msg += `🏨 <b>${hotel}</b>\n`;
      for (const a of entries) {
        msg += `  📅 ${a.checkIn}  🛏 ${a.room}\n`;
        if (a.peninsulaPrice) {
          const diff = a.peninsulaPrice - a.akayPrice;
          const diffStr = diff > 0 ? ` (Peninsula ${diff.toLocaleString('tr-TR')} RUB pahalı)` :
                          diff < 0 ? ` (AKAY ${Math.abs(diff).toLocaleString('tr-TR')} RUB pahalı)` : ` (eşit fiyat)`;
          msg += `     Peninsula: ${a.peninsulaPrice.toLocaleString('tr-TR')} RUB\n`;
          msg += `     AKAY: ${a.akayPrice.toLocaleString('tr-TR')} RUB${diffStr}\n`;
        } else {
          msg += `     AKAY: ${a.akayPrice.toLocaleString('tr-TR')} RUB\n`;
        }
      }
      msg += `─────────────────\n`;
      if (msg.length > 3500) {
        await sendTelegram(msg);
        msg = `🔍 <b>Tekel İhlali Raporu (devam)</b>\n\n`;
      }
    }
  }

  if (closedAlerts.length > 0) {
    msg += `\n✅ <b>AKAY Kapandı (${closedAlerts.length} kayıt)</b>\n`;
    msg += `─────────────────\n`;
    const byHotel = {};
    for (const a of closedAlerts) {
      if (!byHotel[a.hotel]) byHotel[a.hotel] = [];
      byHotel[a.hotel].push(a);
    }
    for (const [hotel, entries] of Object.entries(byHotel)) {
      msg += `🏨 <b>${hotel}</b>\n`;
      for (const a of entries) {
        msg += `  📅 ${a.checkIn}  🛏 ${a.room}\n`;
      }
    }
  }

  await sendTelegram(msg + time);
}

async function main() {
  console.log('Tarama basliyor...');
  const dates = generateDates();
  console.log('Taranan aylar:', dates.map(d => d.checkIn).join(', '));
  const hotels = loadHotels();
  console.log(`Otel sayisi: ${hotels.length}`);

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
        batch.map(({ url, checkIn, checkOut, hotelId, p }) =>
          scrapePageWithDateShift(browser, url, checkIn, checkOut, p, hotelId)
        )
      );
      for (const { results: offers, usedUrl, usedCheckIn, shifted, originalCheckIn } of results) {
        if (offers.length > 0) {
          if (!offersByDate[usedCheckIn]) offersByDate[usedCheckIn] = [];
          offersByDate[usedCheckIn].push(...offers);
        } else {
          emptyUrls.push({ url: usedUrl, checkIn: usedCheckIn, originalCheckIn: shifted ? originalCheckIn : null });
        }
      }
      completed += batch.length;
      if (completed % 100 === 0 || completed === urls.length) console.log(`  ${completed}/${urls.length} tamamlandi`);
    }

    if (emptyUrls.length > 0) {
      console.log(`\n--- BOŞ GELEN URL'LER (${emptyUrls.length} adet) ---`);
      for (const { url, checkIn, originalCheckIn } of emptyUrls) {
        const dateInfo = originalCheckIn ? `${originalCheckIn} → ${checkIn} (kaydırıldı)` : checkIn;
        console.log(`  [BOŞ] ${dateInfo} - ${url}`);
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
    console.log(`${allNewAlerts.length} yeni AKAY, ${allClosedAlerts.length} kapanan AKAY bildirimi gonderiliyor...`);
    await sendReport(allNewAlerts, allClosedAlerts);
  } else {
    console.log('Uyari yok.');
  }
}

main().catch(async err => {
  console.error('Hata:', err.message);
  await sendTelegram(`❌ <b>Tekel Monitor Hatasi</b>\n\n${err.message}`).catch(() => {});
  process.exit(1);
});
