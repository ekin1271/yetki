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
  { pattern: '103810219',   name: 'PENINSULA' }, // Antalya
  { pattern: '103810221461', name: 'PENINSULA' }, // Bodrum
  { pattern: '103810221462', name: 'PENINSULA' }, // Bodrum
  { pattern: '103816',      name: 'AKAY' },
];

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ─── Puppeteer ile sayfa çek ve parse et ─────────────────────────────────────
async function fetchAndParse(browser, url, checkIn, hotelId) {
  const page = await browser.newPage();
  await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
  await page.setViewport({ width: 1920, height: 1080 });

  try { await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 }); } catch(e) {}
  try { await page.waitForSelector('div.b-pr', { timeout: 30000 }); } catch(e) {}
  await sleep(2000);

  const agencyRulesStr = JSON.stringify(AGENCY_RULES);

  const offers = await page.evaluate((agencyRulesStr, targetDate, expectedHotelId) => {
    const agencyRules = JSON.parse(agencyRulesStr);

    function identifyAgency(urr) {
      for (const rule of agencyRules) {
        if (urr.includes(rule.pattern)) return rule.name;
      }
      return null;
    }

    const offers = [];

    // Sadece ilk div.b-pr — komşu otelleri atla
    const block = document.querySelector('div.b-pr');
    if (!block) return offers;

    // data-hid kontrolü: sayfadaki otel ID'si beklenenle eşleşmiyorsa geç
    if (expectedHotelId) {
      const nameDiv = block.querySelector('div.name[data-hid]');
      if (nameDiv) {
        const dataHid = nameDiv.getAttribute('data-hid');
        if (dataHid && dataHid !== expectedHotelId) return offers;
      }
    }

    // Otel adı: b-pr içindeki ilk "code=" içeren linkin text'i
    let hotelName = '';
    const hotelLink = block.querySelector('a[href*="code="]');
    if (hotelLink) hotelName = hotelLink.textContent.trim();

    const allRows = block.querySelectorAll('tr');

    for (const tr of allRows) {
      const allLis = tr.querySelectorAll('li.s8.i_t1');
      if (allLis.length === 0) continue;

      let chosenLi = allLis[0];
      if (targetDate) {
        for (const li of allLis) {
          if ((li.getAttribute('urr') || '').includes(targetDate)) {
            chosenLi = li;
            break;
          }
        }
      }

      const urr = chosenLi.getAttribute('urr') || '';
      const agency = identifyAgency(urr);
      if (!agency) continue;

      let price = null;
      const priceLink = tr.querySelector('td.c_pe a[href*="x="]');
      if (priceLink) {
        const m = (priceLink.getAttribute('href') || '').match(/[?&]x=(\d+)/);
        if (m) price = parseInt(m[1], 10) || null;
      }
      if (!price) continue;

      const roomTd = tr.querySelector('td.c_ns');
      const roomType = roomTd ? roomTd.textContent.trim().split('\n')[0].trim() : 'UNKNOWN';

      offers.push({ agency, hotelName, roomType, price });
    }

    return offers;
  }, agencyRulesStr, checkIn, hotelId);

  await page.close();
  return offers;
}

// ─── Date shift wrapper ──────────────────────────────────────────────────────
async function fetchAndParseWithDateShift(browser, url, checkIn, hotelId) {
  const offers = await fetchAndParse(browser, url, checkIn, hotelId);
  if (offers.length > 0) return { offers, usedCheckIn: checkIn };

  // Boş sayfa — +5 gün dene
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

// ─── Otel listesi & URL üretimi ──────────────────────────────────────────────
function loadHotels() {
  return JSON.parse(fs.readFileSync(HOTELS_FILE, 'utf8'));
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

    const fmt = (n) => String(n).padStart(2, '0');
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

// ─── Telegram ────────────────────────────────────────────────────────────────
async function sendTelegram(text) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) { console.log('[TEL]', text.slice(0, 100)); return; }
  const targets = [TELEGRAM_CHAT_ID];
  if (TELEGRAM_GROUP_ID) targets.push(TELEGRAM_GROUP_ID);

  for (const chatId of targets) {
    const body = JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML', disable_web_page_preview: true });
    const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
    await new Promise((resolve, reject) => {
      const req = https.request(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      }, (res) => { res.resume(); res.on('end', resolve); });
      req.on('error', reject);
      req.write(body);
      req.end();
    });
  }
}

async function sendTelegramSplit(newAlerts, closedAlerts) {
  const allAlerts = [
    ...newAlerts.map(a => ({ ...a, type: 'new' })),
    ...closedAlerts.map(a => ({ ...a, type: 'closed' })),
  ];
  if (allAlerts.length === 0) return;

  const groups = {};
  for (const a of allAlerts) {
    const key = `${a.hotel}__${a.room}`;
    if (!groups[key]) groups[key] = { hotel: a.hotel, room: a.room, entries: [] };
    groups[key].entries.push(a);
  }
  for (const g of Object.values(groups)) {
    g.entries.sort((a, b) => {
      const toMs = s => { const [d, m, y] = s.split('.'); return new Date(y, m - 1, d).getTime(); };
      return toMs(a.checkIn) - toMs(b.checkIn);
    });
  }

  const time = `\n🕐 ${new Date().toLocaleString('tr-TR', { timeZone: 'Europe/Istanbul' })}`;
  let current = '🔍 <b>Tek Yetkili İhlal Raporu</b>\n\n';

  for (const g of Object.values(groups)) {
    let block = `🏨 <b>${g.hotel}</b>\n🛏 ${g.room}\n`;
    for (const a of g.entries) {
      if (a.type === 'closed') {
        block += `  📅 ${a.checkIn} ✅ AKAY kapandı\n`;
      } else if (a.akayPrice < a.peninsulaPrice) {
        const fark = a.peninsulaPrice - a.akayPrice;
        block += `  📅 ${a.checkIn} 🚨 AKAY girdi (gerideyiz)\n`;
        block += `     📌 Peninsula: ${a.peninsulaPrice} EUR\n`;
        block += `     ⚠️ AKAY: ${a.akayPrice} EUR (Fark: ${fark} EUR)\n`;
      } else if (a.akayPrice === a.peninsulaPrice) {
        block += `  📅 ${a.checkIn} 🟡 AKAY girdi (fiyatlar eşit)\n`;
        block += `     📌 Peninsula = AKAY: ${a.peninsulaPrice} EUR\n`;
      } else {
        block += `  📅 ${a.checkIn} 🆕 AKAY girdi (öndeyiz)\n`;
        block += `     📌 Peninsula: ${a.peninsulaPrice} EUR\n`;
        block += `     ⚠️ AKAY: ${a.akayPrice} EUR\n`;
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

// ─── Analiz ──────────────────────────────────────────────────────────────────
function analyzeOffers(checkIn, offers, prevState, newState) {
  const newAlerts = [], closedAlerts = [];
  const groups = {};

  for (const o of offers) {
    const key = `${checkIn}__${o.hotelName}__${o.roomType}`;
    if (!groups[key]) groups[key] = { hotelName: o.hotelName, roomType: o.roomType, peninsula: null, akay: null };
    if (o.agency === 'PENINSULA') {
      if (!groups[key].peninsula || o.price < groups[key].peninsula) groups[key].peninsula = o.price;
    } else if (o.agency === 'AKAY') {
      if (!groups[key].akay || o.price < groups[key].akay) groups[key].akay = o.price;
    }
  }

  for (const [key, data] of Object.entries(groups)) {
    if (!data.peninsula) continue;
    const prev = prevState[key];

    if (!data.akay) {
      newState[key] = 'absent';
      if (prev === 'present') {
        closedAlerts.push({ checkIn, hotel: data.hotelName, room: data.roomType });
      }
    } else {
      newState[key] = 'present';
      if (prev !== 'present') {
        newAlerts.push({
          checkIn,
          hotel: data.hotelName,
          room: data.roomType,
          peninsulaPrice: data.peninsula,
          akayPrice: data.akay,
        });
      }
    }
  }

  return { newAlerts, closedAlerts };
}

// ─── Concurrency helper ──────────────────────────────────────────────────────
async function runConcurrent(tasks, concurrency) {
  for (let i = 0; i < tasks.length; i += concurrency) {
    const batch = tasks.slice(i, i + concurrency);
    await Promise.all(batch.map(t => t()));
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
  const newState  = { ...prevState };
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
        const { offers, usedCheckIn } = await fetchAndParseWithDateShift(browser, task.url, task.checkIn, task.hotel.id);
        for (const o of offers) {
          if (!offersByDate[usedCheckIn]) offersByDate[usedCheckIn] = [];
          offersByDate[usedCheckIn].push(o);
        }
      } catch (e) {
        errors++;
        console.log(`  [HATA] ${task.hotel.id} ${task.checkIn}: ${e.message}`);
      }
      done++;
      if (done % 50 === 0 || done === tasks.length) {
        console.log(`  ${done}/${tasks.length} tamamlandi (${errors} hata)`);
      }
    }), CONCURRENCY);

    for (const [checkIn, offers] of Object.entries(offersByDate)) {
      console.log(`  [${checkIn}] ${offers.length} teklif`);
      const { newAlerts, closedAlerts } = analyzeOffers(checkIn, offers, prevState, newState);
      allNew.push(...newAlerts);
      allClosed.push(...closedAlerts);
    }

  } finally {
    await browser.close();
  }

  saveState(newState);
  console.log('State kaydedildi.');

  if (allNew.length > 0 || allClosed.length > 0) {
    console.log(`${allNew.length} yeni, ${allClosed.length} kapanan. Bildirim gonderiliyor...`);
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
