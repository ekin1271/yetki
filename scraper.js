const fs = require('fs');
const https = require('https');
const puppeteer = require('puppeteer');

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const TELEGRAM_GROUP_ID = process.env.GROUP_CHAT_ID;
const STATE_FILE = 'tekel_state.json';
const HOTELS_FILE = 'hotels.json';
const CONCURRENCY = 5;

const PENINSULA_PATTERN = '103810219'; // Exe'deki ile aynı

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ─── URL üretimi ─────────────────────────────────────────────────────────────
function loadHotels() {
  return JSON.parse(fs.readFileSync(HOTELS_FILE, 'utf8'));
}

function generateDates() {
  const dates = [];
  const now = new Date();
  const firstDate = new Date(now);
  firstDate.setDate(firstDate.getDate() + 5);

  if (firstDate.getMonth() === 2) { // Mart ise Nisan 15'e atla
    firstDate.setMonth(3);
    firstDate.setDate(15);
  }

  for (let m = 0; m < 3; m++) {
    const d = m === 0
      ? new Date(firstDate)
      : new Date(firstDate.getFullYear(), firstDate.getMonth() + m, 15);
    const fmt = n => String(n).padStart(2, '0');
    const checkIn  = `${fmt(d.getDate())}.${fmt(d.getMonth()+1)}.${d.getFullYear()}`;
    const out = new Date(d);
    out.setDate(out.getDate() + 7);
    const checkOut = `${fmt(out.getDate())}.${fmt(out.getMonth()+1)}.${out.getFullYear()}`;
    dates.push({ checkIn, checkOut });
  }
  return dates;
}

function buildUrl(hotel, checkIn, checkOut) {
  const idPrice = hotel.id_price || '121110211811';
  return `https://www.bgoperator.ru/price.shtml?action=price&tid=211&idt=&flt2=100510000863&id_price=${idPrice}&data=${checkIn}&d2=${checkOut}&f7=7&f3=&f8=&ho=0&F4=${hotel.id}&ins=0-40000-EUR&flt=100411293179&p=${hotel.p}`;
}

// ─── Sayfa parse ─────────────────────────────────────────────────────────────
// Exe mantığı:
//   XPath: //div[@class='b-pr'] → //li[@class='s8 i_t1'] → urr attribute
//   urr içinde '103810219' varsa Peninsula, yoksa rakip
//   Fiyat: //td[@class='c_pe'] içinden EUR değeri
async function scrapePage(browser, url, checkIn) {
  const page = await browser.newPage();
  await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
  await page.setViewport({ width: 1920, height: 1080 });

  try { await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 }); } catch(e) {}
  try { await page.waitForSelector('div.b-pr', { timeout: 30000 }); } catch(e) {}
  await sleep(3000);

  const offers = await page.evaluate((checkIn, PENINSULA_PATTERN) => {
    const results = [];

    // Exe: //div[@class='b-pr'] — sadece ilk blok (tek otel URL'si)
    const bpr = document.querySelector('div.b-pr');
    if (!bpr) return results;

    // Otel adı: closest table > header row > a link
    let hotelName = '';
    const parentTable = bpr.closest('table');
    if (parentTable) {
      const a = parentTable.querySelector('a[href*="action=shw"]') ||
                parentTable.querySelector('div.name a') ||
                parentTable.querySelector('a[href*="code="]');
      if (a) hotelName = a.textContent.trim();
    }
    if (!hotelName) {
      const a = document.querySelector('a[href*="action=shw"]') ||
                document.querySelector('a[href*="code="]');
      if (a) hotelName = a.textContent.trim();
    }

    // Exe: //li[@class='s8 i_t1'] — her tr içinde
    const rows = bpr.querySelectorAll('tr');
    for (const tr of rows) {
      // SADECE class'ı tam olarak 's8 i_t1' olan li'ler (exe ile aynı XPath)
      const liList = Array.from(tr.querySelectorAll('li'))
        .filter(li => li.className.trim() === 's8 i_t1');
      if (liList.length === 0) continue;

      // Tarihe uyan li'yi seç
      let chosenLi = liList[0];
      for (const li of liList) {
        if ((li.getAttribute('urr') || '').includes(checkIn)) {
          chosenLi = li;
          break;
        }
      }

      const urr = chosenLi.getAttribute('urr') || '';
      const isPeninsula = urr.includes(PENINSULA_PATTERN);

      // Exe: //td[@class='c_pe'] içinden EUR fiyatı
      // Yeni site: <a title="1591 EUR"> formatında
      const cpeTd = tr.querySelector('td.c_pe');
      if (!cpeTd) continue;

      let price = 0;
      // Yöntem 1: a[title] içinde "XXXX EUR"
      for (const a of cpeTd.querySelectorAll('a[title]')) {
        const m = (a.getAttribute('title') || '').match(/(\d+)\s*EUR/i);
        if (m) { price = parseInt(m[1], 10); break; }
      }
      // Yöntem 2: eski href x= parametresi (fallback)
      if (!price) {
        for (const a of cpeTd.querySelectorAll('a[href*="x="]')) {
          const m = (a.getAttribute('href') || '').match(/[?&]x=(\d+)/);
          if (m) { price = parseInt(m[1], 10); break; }
        }
      }
      if (!price) continue;

      // Oda tipi
      const roomTd = tr.querySelector('td.c_ns');
      const roomType = roomTd
        ? roomTd.textContent.trim().split('\n')[0].trim()
        : 'UNKNOWN';

      results.push({ isPeninsula, hotelName, roomType, price });
    }

    return results;
  }, checkIn, PENINSULA_PATTERN);

  await page.close();
  return offers;
}

async function scrapeWithDateShift(browser, url, checkIn) {
  let offers = await scrapePage(browser, url, checkIn);
  if (offers.length > 0) return { offers, usedCheckIn: checkIn };

  // +5 gün dene
  const [d, m, y] = checkIn.split('.');
  const date = new Date(y, m - 1, d);
  date.setDate(date.getDate() + 5);
  const fmt = n => String(n).padStart(2, '0');
  const newCheckIn = `${fmt(date.getDate())}.${fmt(date.getMonth()+1)}.${date.getFullYear()}`;
  const out = new Date(date);
  out.setDate(out.getDate() + 7);
  const newCheckOut = `${fmt(out.getDate())}.${fmt(out.getMonth()+1)}.${out.getFullYear()}`;
  const newUrl = url
    .replace(/data=\d{2}\.\d{2}\.\d{4}/, `data=${newCheckIn}`)
    .replace(/d2=\d{2}\.\d{2}\.\d{4}/, `d2=${newCheckOut}`);

  offers = await scrapePage(browser, newUrl, newCheckIn);
  return { offers, usedCheckIn: newCheckIn };
}

// ─── Analiz ──────────────────────────────────────────────────────────────────
// Exe mantığı: Peninsula olan şirketi SKIP listesine al,
// başka şirket görünürse = rakip var = ihlal
function analyzeOffers(checkIn, offers, prevState, newState) {
  const newAlerts = [], closedAlerts = [];
  const groups = {};

  for (const o of offers) {
    const key = `${checkIn}__${o.hotelName}__${o.roomType}`;
    if (!groups[key]) groups[key] = { hotelName: o.hotelName, roomType: o.roomType, peninsula: null, rival: null };
    if (o.isPeninsula) {
      if (!groups[key].peninsula || o.price < groups[key].peninsula)
        groups[key].peninsula = o.price;
    } else {
      // Herhangi bir rakip acente
      if (!groups[key].rival || o.price < groups[key].rival)
        groups[key].rival = o.price;
    }
  }

  for (const [key, data] of Object.entries(groups)) {
    const prev = prevState[key];

    if (!data.rival) {
      newState[key] = 'absent';
      if (prev === 'present') {
        closedAlerts.push({
          checkIn,
          hotel: data.hotelName,
          room: data.roomType,
        });
      }
    } else {
      newState[key] = 'present';
      if (prev !== 'present') {
        newAlerts.push({
          checkIn,
          hotel: data.hotelName,
          room: data.roomType,
          peninsulaPrice: data.peninsula,
          rivalPrice: data.rival,
        });
      }
    }
  }

  return { newAlerts, closedAlerts };
}

// ─── Telegram ────────────────────────────────────────────────────────────────
async function sendTelegram(text) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) { console.log('[TEL]', text.slice(0, 120)); return; }
  const targets = [TELEGRAM_CHAT_ID];
  if (TELEGRAM_GROUP_ID) targets.push(TELEGRAM_GROUP_ID);
  for (const chatId of targets) {
    const body = JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML', disable_web_page_preview: true });
    const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
    await new Promise((resolve, reject) => {
      const req = https.request(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      }, res => { res.resume(); res.on('end', resolve); });
      req.on('error', reject);
      req.write(body);
      req.end();
    });
  }
}

async function sendTelegramSplit(newAlerts, closedAlerts) {
  const all = [
    ...newAlerts.map(a => ({ ...a, type: 'new' })),
    ...closedAlerts.map(a => ({ ...a, type: 'closed' })),
  ];
  if (all.length === 0) return;

  // Otel+oda bazında grupla
  const groups = {};
  for (const a of all) {
    const key = `${a.hotel}__${a.room}`;
    if (!groups[key]) groups[key] = { hotel: a.hotel, room: a.room, entries: [] };
    groups[key].entries.push(a);
  }
  for (const g of Object.values(groups)) {
    g.entries.sort((a, b) => {
      const ms = s => { const [d,m,y] = s.split('.'); return new Date(y,m-1,d).getTime(); };
      return ms(a.checkIn) - ms(b.checkIn);
    });
  }

  const time = `\n🕐 ${new Date().toLocaleString('tr-TR', { timeZone: 'Europe/Istanbul' })}`;
  let current = '🔍 <b>Tek Yetkili İhlal Raporu</b>\n\n';

  for (const g of Object.values(groups)) {
    let block = `🏨 <b>${g.hotel}</b>\n🛏 ${g.room}\n`;
    for (const a of g.entries) {
      if (a.type === 'closed') {
        block += `  📅 ${a.checkIn} ✅ Rakip kapandı\n`;
      } else if (a.peninsulaPrice && a.rivalPrice) {
        if (a.rivalPrice < a.peninsulaPrice) {
          block += `  📅 ${a.checkIn} 🚨 Rakip girdi (gerideyiz)\n`;
          block += `     📌 Peninsula: ${a.peninsulaPrice} EUR\n`;
          block += `     ⚠️ Rakip: ${a.rivalPrice} EUR (Fark: ${a.peninsulaPrice - a.rivalPrice} EUR)\n`;
        } else if (a.rivalPrice === a.peninsulaPrice) {
          block += `  📅 ${a.checkIn} 🟡 Rakip girdi (eşit fiyat)\n`;
          block += `     📌 Peninsula = Rakip: ${a.peninsulaPrice} EUR\n`;
        } else {
          block += `  📅 ${a.checkIn} 🆕 Rakip girdi (öndeyiz)\n`;
          block += `     📌 Peninsula: ${a.peninsulaPrice} EUR\n`;
          block += `     ⚠️ Rakip: ${a.rivalPrice} EUR\n`;
        }
      } else {
        block += `  📅 ${a.checkIn} ⚠️ Rakip girdi\n`;
        block += `     ⚠️ Rakip: ${a.rivalPrice} EUR\n`;
      }
    }
    block += `─────────────────\n`;

    if ((current + block).length > 3500) {
      await sendTelegram(current);
      current = '🔍 <b>Tek Yetkili İhlal Raporu (devam)</b>\n\n' + block;
    } else {
      current += block;
    }
  }
  await sendTelegram(current + time);
}

// ─── State ───────────────────────────────────────────────────────────────────
function loadState() {
  if (fs.existsSync(STATE_FILE)) return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  return {};
}
function saveState(state) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), 'utf8');
}

// ─── Concurrency ─────────────────────────────────────────────────────────────
async function runConcurrent(tasks, concurrency) {
  for (let i = 0; i < tasks.length; i += concurrency) {
    await Promise.all(tasks.slice(i, i + concurrency).map(t => t()));
    if (i + concurrency < tasks.length) await sleep(500);
  }
}

// ─── MAIN ────────────────────────────────────────────────────────────────────
async function main() {
  console.log('Tarama basliyor...');
  const hotels = loadHotels();
  const dates  = generateDates();
  console.log(`Otel: ${hotels.length} | Tarihler: ${dates.map(d => d.checkIn).join(', ')}`);

  const prevState = loadState();
  const newState  = { ...prevState }; // Onceki state'i koru, sadece guncelle
  const allNew = [], allClosed = [];

  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
  });

  try {
    const tasks = [];
    for (const { checkIn, checkOut } of dates) {
      for (const hotel of hotels) {
        tasks.push({ url: buildUrl(hotel, checkIn, checkOut), checkIn, hotel });
      }
    }
    console.log(`Toplam istek: ${tasks.length}`);

    let done = 0, errors = 0;
    const offersByDate = {};

    await runConcurrent(tasks.map(task => async () => {
      try {
        const { offers, usedCheckIn } = await scrapeWithDateShift(browser, task.url, task.checkIn, task.hotel.id);
        if (offers.length > 0) {
          if (!offersByDate[usedCheckIn]) offersByDate[usedCheckIn] = [];
          offersByDate[usedCheckIn].push(...offers);
        }
      } catch (e) {
        errors++;
        console.log(`  [HATA] ${task.hotel.id} ${task.checkIn}: ${e.message}`);
      }
      done++;
      if (done % 20 === 0 || done === tasks.length)
        console.log(`  ${done}/${tasks.length} tamamlandi (${errors} hata)`);
    }), CONCURRENCY);

    for (const [checkIn, offers] of Object.entries(offersByDate)) {
      const pen = offers.filter(o => o.isPeninsula).length;
      const rival = offers.filter(o => !o.isPeninsula).length;
      console.log(`  [${checkIn}] ${offers.length} satir — Peninsula: ${pen}, Rakip: ${rival}`);
      const { newAlerts, closedAlerts } = analyzeOffers(checkIn, offers, prevState, newState);
      allNew.push(...newAlerts);
      allClosed.push(...closedAlerts);
    }

  } finally {
    await browser.close();
  }

  saveState(newState);
  console.log(`State kaydedildi (${Object.keys(newState).length} kayit).`);

  if (allNew.length > 0 || allClosed.length > 0) {
    console.log(`${allNew.length} yeni ihlal, ${allClosed.length} kapanan. Gonderiliyor...`);
    await sendTelegramSplit(allNew, allClosed);
  } else {
    console.log('Degisiklik yok.');
  }
}

main().catch(async err => {
  console.error('Kritik hata:', err.message);
  await sendTelegram(`❌ <b>Tek Yetkili Monitor Hatası</b>\n\n${err.message}`).catch(() => {});
  process.exit(1);
});
