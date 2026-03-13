const fs = require('fs');
const https = require('https');
const { parse } = require('node-html-parser');

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const STATE_FILE = 'tekel_state.json';
const HOTELS_FILE = 'hotels.json';
const CONCURRENCY = 8;
const RETRY_COUNT = 3;
const RETRY_DELAY_MS = 3000;

const AGENCY_RULES = [
  { pattern: '103810219', name: 'PENINSULA' },
  { pattern: '103816',    name: 'AKAY' },
];

// ─── HTTP GET ────────────────────────────────────────────────────────────────
function httpGet(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'ru-RU,ru;q=0.9,en;q=0.8',
      },
      timeout: 30000,
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return httpGet(res.headers.location).then(resolve).catch(reject);
      }
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
  });
}

// ─── Retry wrapper ───────────────────────────────────────────────────────────
async function fetchWithRetry(url, retries = RETRY_COUNT) {
  for (let i = 0; i < retries; i++) {
    try {
      return await httpGet(url);
    } catch (e) {
      if (i < retries - 1) {
        console.log(`  [RETRY ${i+1}] ${e.message}`);
        await sleep(RETRY_DELAY_MS);
      } else {
        throw e;
      }
    }
  }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ─── Agency tanımlama ────────────────────────────────────────────────────────
function identifyAgency(urrValue) {
  if (!urrValue) return null;
  for (const rule of AGENCY_RULES) {
    if (urrValue.includes(rule.pattern)) return rule.name;
  }
  return null;
}

// ─── HTML parse ──────────────────────────────────────────────────────────────
// Orijinal C# / HtmlAgilityPack mantığı:
//   //div[@class='b-pr']          → otel blokları
//   .//li[@class='s8 i_t1']       → ajans linkleri; urr attribute içinde agency ID var
//   .//td[@class='c_pe']          → fiyat hücresi
//   &data=([^&]*)                 → urr'den checkIn tarihi
//   103810219 → PENINSULA, 103816 → AKAY
function parseOffers(html) {
  const offers = [];
  const root = parse(html);

  // Her otel bloğu: div.b-pr
  const hotelBlocks = root.querySelectorAll('div.b-pr');

  for (const block of hotelBlocks) {
    // Otel adı: ilk anlamlı link ya da başlık
    let hotelName = '';
    const nameEl = block.querySelector('.b-h') || block.querySelector('h2') || block.querySelector('h3');
    if (nameEl) hotelName = nameEl.text.trim();
    if (!hotelName) {
      const anchor = block.querySelector('a');
      if (anchor) hotelName = anchor.text.trim();
    }
    if (!hotelName) continue;

    // Ajans satırları: li.s8.i_t1
    const liElements = block.querySelectorAll('li.s8.i_t1');

    for (const li of liElements) {
      // urr attribute'undan agency ID ve tarih çek
      const urrValue = li.getAttribute('urr') || '';
      const agency = identifyAgency(urrValue);
      if (!agency) continue;

      // Fiyat: td.c_pe içindeki <b>
      const priceTd = li.querySelector('td.c_pe');
      if (!priceTd) continue;
      const priceText = priceTd.querySelector('b')?.text || priceTd.text;
      const priceRub = parseInt(priceText.replace(/\D/g, ''), 10);
      if (!priceRub || isNaN(priceRub)) continue;

      // Oda tipi: td.c_ns
      const roomTd = li.querySelector('td.c_ns');
      const roomType = roomTd ? roomTd.text.trim().split('\n')[0].trim() : 'UNKNOWN';

      // urr içinden checkIn: &data=DD.MM.YYYY
      const dateMatch = urrValue.match(/[&?]data=([^&]+)/);
      const checkInFromUrr = dateMatch ? decodeURIComponent(dateMatch[1]) : null;

      offers.push({ agency, hotelName, roomType, priceRub, checkInFromUrr });
    }
  }

  return offers;
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

  // Mart'taysa Nisan'a atla
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
  return `https://www.bgoperator.ru/price.shtml?action=price&tid=211&idt=&flt2=100510000863&id_price=121110211811&data=${checkIn}&d2=${checkOut}&f7=7&f3=&f8=&ho=0&F4=${hotel.id}&ins=0-40000-EUR&flt=100411293179&p=${hotel.p}`;
}

// ─── Telegram ────────────────────────────────────────────────────────────────
async function sendTelegram(text) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) { console.log('[TEL]', text.slice(0, 100)); return; }
  const body = JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text, parse_mode: 'HTML', disable_web_page_preview: true });
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
  let current = '🔍 <b>Tekel İhlali Raporu</b>\n\n';

  for (const g of Object.values(groups)) {
    let block = `🏨 <b>${g.hotel}</b>\n🛏 ${g.room}\n`;
    for (const a of g.entries) {
      if (a.type === 'closed') {
        block += `  📅 ${a.checkIn} ✅ AKAY kapandı\n`;
      } else if (!a.peninsulaPrice) {
        block += `  📅 ${a.checkIn} 🚨 AKAY girdi\n     ⚠️ AKAY: ${a.akayPrice.toLocaleString('tr-TR')} RUB\n`;
      } else if (a.akayPrice < a.peninsulaPrice) {
        const fark = (a.peninsulaPrice - a.akayPrice).toLocaleString('tr-TR');
        block += `  📅 ${a.checkIn} 🚨 AKAY öne geçti\n     📌 Peninsula: ${a.peninsulaPrice.toLocaleString('tr-TR')} RUB\n     ⚠️ AKAY: ${a.akayPrice.toLocaleString('tr-TR')} RUB (Fark: ${fark} RUB)\n`;
      } else if (a.akayPrice === a.peninsulaPrice) {
        block += `  📅 ${a.checkIn} 🟡 Fiyatlar eşit\n     📌 Peninsula = AKAY: ${a.peninsulaPrice.toLocaleString('tr-TR')} RUB\n`;
      } else {
        block += `  📅 ${a.checkIn} 🆕 Rakip girdi (biz öndeyiz)\n     📌 Peninsula: ${a.peninsulaPrice.toLocaleString('tr-TR')} RUB\n     ⚠️ AKAY: ${a.akayPrice.toLocaleString('tr-TR')} RUB\n`;
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
      if (!groups[key].peninsula || o.priceRub < groups[key].peninsula) groups[key].peninsula = o.priceRub;
    } else if (o.agency === 'AKAY') {
      if (!groups[key].akay || o.priceRub < groups[key].akay) groups[key].akay = o.priceRub;
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
      const html = await fetchWithRetry(task.url);
      const offers = parseOffers(html);

      for (const o of offers) {
        const dateKey = o.checkInFromUrr || task.checkIn;
        if (!offersByDate[dateKey]) offersByDate[dateKey] = [];
        offersByDate[dateKey].push(o);
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
  await sendTelegram(`❌ <b>Tekel Monitor Hatası</b>\n\n${err.message}`).catch(() => {});
  process.exit(1);
});
