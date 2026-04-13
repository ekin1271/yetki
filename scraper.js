/**
 * monitor.js
 * Şirket PC versiyonu — pass yok, GitHub yok
 * Çalıştırma: node monitor.js
 */

const puppeteer = require('puppeteer');
const fs        = require('fs');
const https     = require('https');
const http      = require('http');
const { spawn } = require('child_process');

// ─── Ayarlar (.env yerine doğrudan ya da ortam değişkeni) ────────────────────
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID   = process.env.TELEGRAM_CHAT_ID;   // kendi chat id'n
const TELEGRAM_GROUP_ID  = process.env.GROUP_CHAT_ID;      // grup id (opsiyonel)

const STATE_FILE   = 'price_state.json';
const PENDING_FILE = 'pending_actions.json';
const USERS_FILE   = 'users.json';

function loadPending() { try { return JSON.parse(fs.readFileSync(PENDING_FILE, 'utf8')); } catch { return {}; } }
function savePending(d) { fs.writeFileSync(PENDING_FILE, JSON.stringify(d, null, 2), 'utf8'); }
function addPending(data) {
  const p = loadPending();
  const id = Date.now().toString(36); // kısa benzersiz id
  p[id] = data;
  savePending(p);
  return id;
}
const HOTELS_FILE = 'hotels.json';

const AGENCY_RULES = [
  { pattern: '103810219', name: 'PENINSULA' },
  { pattern: '103816',    name: 'AKAY(FIT)' },
  { pattern: '103810175', name: 'SUMMER' },
  { pattern: '103810222', name: 'CARTHAGE' },
  { pattern: '103825',    name: 'KILIT GLOBAL' },
];

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function fmtN(n)   { return String(n).padStart(2, '0'); }

// ─── Otel listesi ─────────────────────────────────────────────────────────────
function loadHotels() {
  if (!fs.existsSync(HOTELS_FILE)) {
    console.error('hotels.json bulunamadı!');
    process.exit(1);
  }
  return JSON.parse(fs.readFileSync(HOTELS_FILE, 'utf8'));
}

// ─── Tarih üret (bugünden +5 gün başlayarak 4 ay) ───────────────────────────
function generateDates() {
  const dates = [];
  const now   = new Date();
  const first = new Date(now);
  first.setDate(first.getDate() + 5);

  for (let m = 0; m < 4; m++) {
    const d = m === 0
      ? new Date(first)
      : new Date(first.getFullYear(), first.getMonth() + m, 15);
    const ci = `${fmtN(d.getDate())}.${fmtN(d.getMonth()+1)}.${d.getFullYear()}`;
    const out = new Date(d); out.setDate(out.getDate() + 7);
    const co  = `${fmtN(out.getDate())}.${fmtN(out.getMonth()+1)}.${out.getFullYear()}`;
    dates.push({ checkIn: ci, checkOut: co });
  }
  return dates;
}

function generateUrls(hotels) {
  const dates = generateDates();
  const urls  = [];
  for (const { checkIn, checkOut } of dates) {
    for (const hotel of hotels) {
      const hotelId = typeof hotel === 'string' ? hotel : hotel.id;
      const p       = (typeof hotel === 'object' && hotel.p)        ? hotel.p        : '0100319900.0100319900';
      const idPrice = (typeof hotel === 'object' && hotel.id_price) ? hotel.id_price : '121110211811';
      const url = `https://www.bgoperator.ru/price.shtml?action=price&tid=211&idt=&flt2=100510000863&id_price=${idPrice}&data=${checkIn}&d2=${checkOut}&f7=7&f3=&f8=&ho=0&F4=${hotelId}&ins=0-40000-EUR&flt=100411293179&p=${p}`;
      urls.push({ url, checkIn, hotelId });
    }
  }
  return urls;
}

// ─── Telegram ─────────────────────────────────────────────────────────────────
function telegramPost(chatId, body) {
  return new Promise(resolve => {
    const payload = JSON.stringify({ chat_id: chatId, parse_mode: 'HTML', disable_web_page_preview: true, ...body });
    const req = https.request(
      `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`,
      { method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } },
      res => { let s = ''; res.on('data', d => s += d); res.on('end', () => { try { const j = JSON.parse(s); if (!j.ok) console.error('[TG]', JSON.stringify(j)); } catch {} resolve(); }); }
    );
    req.on('error', e => { console.error('[TG] Hata:', e.message); resolve(); });
    req.write(payload); req.end();
  });
}

function loadUsers() {
  try { return JSON.parse(fs.readFileSync(USERS_FILE, 'utf8')); } catch { return []; }
}

async function sendAlert(text, replyMarkup) {
  const all = [...new Set([TELEGRAM_CHAT_ID, ...loadUsers()])].filter(Boolean);
  for (const id of all) {
    const body = { text };
    if (replyMarkup) body.reply_markup = replyMarkup;
    await telegramPost(id, body);
  }
  if (TELEGRAM_GROUP_ID) {
    await telegramPost(TELEGRAM_GROUP_ID, { text });
  }
}

// ─── Scrape ───────────────────────────────────────────────────────────────────
async function scrapePageOnce(browser, targetUrl, checkIn, hotelId) {
  const page = await browser.newPage();
  await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
  await page.setViewport({ width: 1920, height: 1080 });

  try { await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 60000 }); } catch {}
  try { await page.waitForSelector('div.b-pr', { timeout: 30000 }); } catch {}
  await sleep(2000);

  const rulesStr = JSON.stringify(AGENCY_RULES);
  const results  = await page.evaluate((rulesStr, targetDate, hotelId) => {
    const rules = JSON.parse(rulesStr);
    function idAgency(urr) {
      for (const r of rules) if (urr.includes(r.pattern)) return r.name;
      return null;
    }
    const offers = [];
    for (const block of document.querySelectorAll('div.b-pr')) {
      let hotelName = '';
      const hl = block.querySelector('a[href*="code="]');
      if (hl) hotelName = hl.textContent.trim();
      else { const nd = block.querySelector('div.name a'); if (nd) hotelName = nd.textContent.trim(); }

      // KRİTİK: Block gerçekten istenen otele mi ait?
      // Block içindeki herhangi bir link veya form hotelId'yi taşıyor olmalı.
      // Genelde "price.shtml?...F4=XXXXXX" veya "hotel.shtml?code=XXX" gibi linkler var.
      let blockHotelId = null;
      // 1) Block içindeki tüm linkleri tara, F4= parametresi varsa al
      for (const a of block.querySelectorAll('a[href]')) {
        const href = a.getAttribute('href') || '';
        const mF4 = href.match(/[?&]F4=(\d+)/);
        if (mF4) { blockHotelId = mF4[1]; break; }
      }
      // 2) Data attribute'ları kontrol et
      if (!blockHotelId) {
        const dm = block.getAttribute('data-modules') || '';
        const mD = dm.match(/(\d{10,})/);
        if (mD) blockHotelId = mD[1];
      }
      // Eğer block başka bir otele aitse ATLA
      if (blockHotelId && String(blockHotelId) !== String(hotelId)) {
        console.log(`[Scrape] Block atlandı: block=${blockHotelId}, target=${hotelId}, ${hotelName}`);
        continue;
      }

      let penPrice = null, penRoom = '';
      const rivals = [];

      for (const tr of block.querySelectorAll('tr')) {
        const lis = tr.querySelectorAll('li.s8.i_t1');
        if (!lis.length) continue;
        let chosen = lis[0];
        if (targetDate) for (const li of lis) if ((li.getAttribute('urr')||'').includes(targetDate)) { chosen = li; break; }
        const urr    = chosen.getAttribute('urr') || '';
        const agency = idAgency(urr);
        if (!agency) continue;
        const pl = tr.querySelector('td.c_pe a[href]');
        if (!pl) continue;
        const m = (pl.getAttribute('href')||'').match(/[?&]x=(\d+)/);
        const price = m ? parseInt(m[1], 10) : null;
        if (!price) continue;
        if (agency === 'PENINSULA') {
          const rt = tr.querySelector('td.c_ns');
          if (rt && !penRoom) penRoom = rt.textContent.trim().split('\n')[0].trim();
          if (!penPrice || price < penPrice) penPrice = price;
        } else {
          rivals.push({ agency, price });
        }
      }
      if (!penPrice || !penRoom) continue;
      offers.push({ hotelName, hotelId, roomType: penRoom, peninsulaPrice: penPrice, rivals });
    }
    return offers;
  }, rulesStr, checkIn, hotelId);

  await page.close();
  return results;
}

async function scrapeWithShift(browser, url, checkIn, hotelId) {
  let r = await scrapePageOnce(browser, url, checkIn, hotelId);
  if (r.length) return { results: r, usedCheckIn: checkIn };

  const [d, m, y] = checkIn.split('.');
  const dt = new Date(y, m-1, d); dt.setDate(dt.getDate() + 5);
  const nc = `${fmtN(dt.getDate())}.${fmtN(dt.getMonth()+1)}.${dt.getFullYear()}`;
  const ot = new Date(dt); ot.setDate(ot.getDate() + 7);
  const no = `${fmtN(ot.getDate())}.${fmtN(ot.getMonth()+1)}.${ot.getFullYear()}`;
  const nu = url.replace(/data=\d{2}\.\d{2}\.\d{4}/, `data=${nc}`).replace(/d2=\d{2}\.\d{2}\.\d{4}/, `d2=${no}`);
  r = await scrapePageOnce(browser, nu, nc, hotelId);
  return { results: r, usedCheckIn: nc };
}

// ─── Analiz ───────────────────────────────────────────────────────────────────
function analyzeOffers(checkIn, offers, prevState, newState) {
  const alerts = [];
  // Bir scraping turunda aynı otel+tarih+fiyat kombosunu bir kez alertle
  const seenInThisRun = new Set();
  for (const o of offers) {
    const key    = `${checkIn}__${o.hotelName}__${o.roomType}`;
    const prevSt = prevState[key];
    if (!o.rivals.length) { newState[key] = 'alone'; continue; }

    const cheapest   = o.rivals.reduce((a, b) => a.price < b.price ? a : b);
    const rivalAhead = cheapest.price < o.peninsulaPrice;
    const isEqual    = cheapest.price === o.peninsulaPrice;
    const isNew      = prevSt === undefined || prevSt === 'alone';

    if (rivalAhead)       newState[key] = 'ahead';
    else if (isEqual)     newState[key] = 'equal';
    else                  newState[key] = prevSt === 'priced' ? 'priced' : 'behind';

    // Dedup anahtarı: aynı hotel + checkIn + peninsula + rival kombosu için tek alert
    const dedupKey = `${o.hotelName}__${checkIn}__${o.peninsulaPrice}__${cheapest.price}`;
    if (seenInThisRun.has(dedupKey)) {
      console.log(`[Monitor] Dedup: ${o.hotelName} ${checkIn} zaten alert atılmış bu turda`);
      continue;
    }

    const base = {
      checkIn, hotel: o.hotelName, hotelId: o.hotelId, room: o.roomType,
      peninsulaPrice: o.peninsulaPrice,
      cheapestAgency: cheapest.agency, cheapestPrice: cheapest.price, rivalAhead,
    };

    let added = false;
    if (isNew) {
      if (rivalAhead)       { alerts.push({ ...base, type: 'ahead',   diff: o.peninsulaPrice - cheapest.price, newRival: true }); added = true; }
      else if (isEqual)     { alerts.push({ ...base, type: 'equal',   diff: 0, newRival: true }); added = true; }
      else                  { alerts.push({ ...base, type: 'we_lead', diff: 0, newRival: true }); added = true; }
    } else if (rivalAhead && prevSt !== 'ahead') {
      alerts.push({ ...base, type: 'ahead', diff: o.peninsulaPrice - cheapest.price, newRival: false }); added = true;
    } else if (isEqual && prevSt !== 'equal') {
      alerts.push({ ...base, type: 'equal', diff: 0, newRival: false }); added = true;
    }
    if (added) seenInThisRun.add(dedupKey);
  }
  return alerts;
}

// ─── State ────────────────────────────────────────────────────────────────────
function loadState()   { return fs.existsSync(STATE_FILE) ? JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) : {}; }
function saveState(st) { fs.writeFileSync(STATE_FILE, JSON.stringify(st, null, 2), 'utf8'); }

// ─── MAIN ─────────────────────────────────────────────────────────────────────
async function main() {
  console.log('=== Monitor başlıyor ===', new Date().toLocaleString('tr-TR'));

  if (!TELEGRAM_BOT_TOKEN) { console.error('TELEGRAM_BOT_TOKEN eksik!'); process.exit(1); }

  const hotels = loadHotels();
  const dates  = generateDates();
  console.log(`Otel: ${hotels.length} | Tarihler: ${dates.map(d => d.checkIn).join(', ')}`);

  const prevState = loadState();
  const newState  = { ...prevState };
  const allAlerts = [];

  const browser = await puppeteer.launch({
    headless: false,
    executablePath: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
  });

  try {
    const urls = generateUrls(hotels);
    console.log(`Toplam URL: ${urls.length}`);
    const CONCURRENCY = 10;
    const byDate = {};
    let done = 0;

    for (let i = 0; i < urls.length; i += CONCURRENCY) {
      const batch = urls.slice(i, i + CONCURRENCY);
      const res   = await Promise.all(batch.map(({ url, checkIn, hotelId }) =>
        scrapeWithShift(browser, url, checkIn, hotelId)));
      for (const { results, usedCheckIn } of res) {
        if (results.length) {
          if (!byDate[usedCheckIn]) byDate[usedCheckIn] = [];
          byDate[usedCheckIn].push(...results);
        }
      }
      done += batch.length;
      if (done % 50 === 0 || done === urls.length) console.log(`  ${done}/${urls.length}`);
    }

    for (const [ci, offers] of Object.entries(byDate)) {
      console.log(`  [${ci}] ${offers.length} blok`);
      allAlerts.push(...analyzeOffers(ci, offers, prevState, newState));
    }
  } finally {
    await browser.close();
  }

  saveState(newState);
  console.log(`State kaydedildi. ${allAlerts.length} uyarı.`);

  for (const alert of allAlerts) {
    const diff = alert.rivalAhead ? (alert.peninsulaPrice - alert.cheapestPrice) : 0;
    const ts   = new Date().toLocaleString('tr-TR', { timeZone: 'Europe/Istanbul' });
    let text   = `🏨 <b>${alert.hotel}</b>\n🛏 ${alert.room}\n📅 ${alert.checkIn}\n`;

    if (alert.type === 'equal') {
      text += `🟡 Fiyatlar eşit\n📌 Peninsula = ${alert.cheapestAgency}: ${alert.peninsulaPrice} EUR`;
    } else if (alert.type === 'we_lead') {
      text += `🆕 Rakip girdi — biz öndeyiz\n📌 Peninsula: ${alert.peninsulaPrice} EUR\n🏆 ${alert.cheapestAgency}: ${alert.cheapestPrice} EUR`;
    } else {
      const emoji = alert.newRival ? '🆕 Rakip girdi (gerideyiz)' : '🚨 Rakip öne geçti';
      text += `${emoji}\n📌 Peninsula: ${alert.peninsulaPrice} EUR\n⚠️ ${alert.cheapestAgency}: ${alert.cheapestPrice} EUR (Fark: ${diff} EUR)`;
    }
    text += `\n🕐 ${ts}`;

    let replyMarkup = null;
    // Buton 2 durum için aktif:
    //  1. Gerideyiz (rivalAhead && diff > 0)
    //  2. Eşitiz (equal) → tie bizim için kayıp, yine öne geçmek isteriz
    const needsButton =
      (alert.type === 'ahead' && diff > 0) ||
      alert.type === 'equal';

    if (needsButton) {
      const pid = addPending({
        hotelId: alert.hotelId, hotel: alert.hotel, checkIn: alert.checkIn,
        room: alert.room, peninsulaPrice: alert.peninsulaPrice,
        cheapestPrice: alert.cheapestPrice,
        cheapestAgency: alert.cheapestAgency,
        situation: alert.type,
      });

      const btnLabel = alert.type === 'equal'
        ? `✅ Öne Geç (Eşitiz)`
        : `✅ Öne Geç (Fark: ${diff} EUR)`;

      replyMarkup = {
        inline_keyboard: [[
          { text: btnLabel,         callback_data: `ap__${pid}` },
          { text: '❌ Öne Geçme',   callback_data: `bl__${pid}` },
        ]],
      };
    }

    await sendAlert(text, replyMarkup);
    await sleep(400);
  }

  const ts = new Date().toLocaleString('tr-TR', { timeZone: 'Europe/Istanbul' });
  if (allAlerts.length === 0) {
    await sendAlert(`✅ <b>Monitor tamamlandı</b>\nDeğişiklik yok.\n🕐 ${ts}`);
  } else {
    await sendAlert(
      `📊 <b>Monitor tamamlandı</b>\n${allAlerts.length} uyarı gönderildi.\nPricer hazır — butonlara basabilirsin.\n🕐 ${ts}`,
      { inline_keyboard: [[{ text: '🛑 Pricer\'ı Kapat', callback_data: 'shutdown_pricer' }]] }
    );
  }

  // ── Pricer durumu kontrol ───────────────────────────────────────────────
  // Monitor pricer'ı SPAWN ETMİYOR — pricer ayrı bir bat (start-pricer.bat)
  // ile elle başlatılır ve sürekli açık kalır. Bu mimari kritik:
  //  1. Pricer warmup'ı sadece bir kez yapılır (bot detection'ı tetiklemez)
  //  2. Monitor her yarım saatte çalışır ama browser açıp kapatmaz
  //  3. Monitor child process spawn ederken Windows'ta yaşanan sorunlar yok
  const pricerAlreadyRunning = await new Promise(resolve => {
    const req = http.get('http://localhost:9222/json/version', { timeout: 2000 }, res => {
      resolve(res.statusCode === 200);
      res.resume();
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });

  if (pricerAlreadyRunning) {
    console.log('✅ Pricer açık, port 9222 aktif. Telegram butonlarını dinliyor.');
  } else {
    console.warn('⚠️ Pricer KAPALI! start-pricer.bat dosyasını çalıştır.');
    await sendAlert(
      `⚠️ <b>Pricer kapalı!</b>\n` +
      `Telegram butonları çalışmayacak.\n` +
      `Lütfen <code>start-pricer.bat</code> dosyasını çalıştır.`
    );
  }

  console.log('=== Monitor tamamlandı, çıkılıyor ===');
  process.exit(0);
}

main().catch(async err => {
  console.error('Kritik hata:', err.message);
  if (TELEGRAM_BOT_TOKEN && TELEGRAM_CHAT_ID) {
    const payload = JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text: `❌ <b>Monitor Hatası</b>\n${err.message}`, parse_mode: 'HTML' });
    const req = https.request(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`,
      { method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } });
    req.write(payload); req.end();
    await new Promise(r => setTimeout(r, 2000));
  }
  process.exit(1);
});
