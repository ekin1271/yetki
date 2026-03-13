const fs = require('fs');
const https = require('https');

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

// ─── Yardımcı: HTTP GET (promise) ───────────────────────────────────────────
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
      // Redirect takip et
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

// ─── HTML parse (regex tabanlı, dependency yok) ──────────────────────────────
function identifyAgency(id) {
  for (const rule of AGENCY_RULES) {
    if (id.includes(rule.pattern)) return rule.name;
  }
  return null;
}

function parseOffers(html, targetF4, targetDate) {
  const offers = [];

  // Otel bloklarını bul: her <tr> içinde otel adı ve satırlar
  // Önce tüm TR'leri çek
  const trBlocks = html.split(/<tr[\s>]/i);

  let currentHotel = '';
  let currentHotelF4 = '';

  for (const block of trBlocks) {
    // Otel adı satırı mı?
    const hotelMatch = block.match(/action=shw[^"]*[?&]id=(\d+)[^"]*"[^>]*>([^<]+)</i);
    if (hotelMatch) {
      currentHotelF4 = hotelMatch[1];
      currentHotel = hotelMatch[2].trim();
    }

    // Sadece hedef F4 oteline ait satırları işle
    if (currentHotelF4 !== targetF4) continue;

    // li.s8.i_t1 elemanlarını bul
    const liMatches = [...block.matchAll(/class=['"]s8 i_t1['"][^>]*urr=['"]([^'"]+)['"]/gi)];
    if (liMatches.length === 0) continue;

    // Hedef tarihe göre li seç
    let selectedUrr = liMatches[0][1];
    for (const m of liMatches) {
      if (targetDate && m[1].includes(targetDate)) {
        selectedUrr = m[1];
        break;
      }
    }

    // urr'den agency id çıkar
    const idMatch = selectedUrr.match(/[?&]id=(\d+)/);
    if (!idMatch) continue;
    const agency = identifyAgency(idMatch[1]);
    if (!agency) continue;

    // Fiyat: td.c_pe içindeki <b>
    const priceMatch = block.match(/class=['"]c_pe['"][^>]*>.*?<b[^>]*>([\d\s]+)<\/b>/is);
    if (!priceMatch) continue;
    const priceRub = parseInt(priceMatch[1].replace(/\D/g, ''), 10);
    if (!priceRub) continue;

    // Oda tipi: td.c_ns
    const roomMatch = block.match(/class=['"]c_ns['"][^>]*>([\s\S]*?)<\/td>/i);
    let roomType = 'UNKNOWN';
    if (roomMatch) {
      roomType = roomMatch[1].replace(/<[^>]+>/g, '').trim().split('\n')[0].trim();
    }

    if (currentHotel) {
      offers.push({ agency, hotelName: currentHotel, roomType, priceRub });
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
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) { console.log('[TEL]', text.slice(0,100)); return; }
  const body = JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text, parse_mode: 'HTML', disable_web_page_preview: true });
  const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
  await new Promise((resolve, reject) => {
    const req = https.request(url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } }, (res) => {
      res.resume();
      res.on('end', resolve);
    });
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

  // Otel+oda bazında grupla
  const groups = {};
  for (const a of allAlerts) {
    const key = `${a.hotel}__${a.room}`;
    if (!groups[key]) groups[key] = { hotel: a.hotel, room: a.room, entries: [] };
    groups[key].entries.push(a);
  }
  for (const g of Object.values(groups)) {
    g.entries.sort((a, b) => {
      const toMs = s => { const [d,m,y] = s.split('.'); return new Date(y, m-1, d).getTime(); };
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
      if (prev === 'present') closedAlerts.push({ checkIn, hotel: data.hotelName, room: data.roomType });
    } else {
      newState[key] = 'present';
      if (prev !== 'present') newAlerts.push({ checkIn, hotel: data.hotelName, room: data.roomType, peninsulaPrice: data.peninsula, akayPrice: data.akay });
    }
  }

  return { newAlerts, closedAlerts };
}

// ─── Concurrency helper ──────────────────────────────────────────────────────
async function runConcurrent(tasks, concurrency) {
  const results = [];
  for (let i = 0; i < tasks.length; i += concurrency) {
    const batch = tasks.slice(i, i + concurrency);
    const batchResults = await Promise.all(batch.map(t => t()));
    results.push(...batchResults);
    if (i + concurrency < tasks.length) await sleep(500); // sunucuya nefes aldır
  }
  return results;
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

  // Tüm görevleri oluştur
  const tasks = [];
  for (const { checkIn, checkOut } of dates) {
    for (const hotel of hotels) {
      const url = buildUrl(hotel, checkIn, checkOut);
      tasks.push({ url, checkIn, hotel });
    }
  }
  console.log(`Toplam istek: ${tasks.length}`);

  let done = 0, errors = 0;
  const offersByDate = {};

  await runConcurrent(tasks.map(task => async () => {
    try {
      const html = await fetchWithRetry(task.url);
      const offers = parseOffers(html, task.hotel.id, task.checkIn);

      if (offers.length > 0) {
        if (!offersByDate[task.checkIn]) offersByDate[task.checkIn] = [];
        offersByDate[task.checkIn].push(...offers);
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
