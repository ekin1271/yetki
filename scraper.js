const puppeteer = require('puppeteer');
const fs = require('fs');

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const STATE_FILE = 'tekel_state.json';
const HOTELS_FILE = 'hotels.json';
const CONCURRENCY = 10;

const PENINSULA_ID = '103810219';
const RIVALS = {
  'AKAY(FIT)': '103816',
  'SUMMER': '103810175',
  'CARTHAGE': '103810222',
  'KİLİT GLOBAL': '103825'
};

function generateDates() {
  const today = new Date();
  const first = new Date(today);
  first.setDate(first.getDate() + 5);
  if (first.getMonth() === 2) {
    first.setFullYear(first.getFullYear(), 3, 15);
  }
  const dates = [];
  const d1 = new Date(first.getFullYear(), first.getMonth(), 15);
  for (let i = 0; i < 3; i++) {
    const d = new Date(d1.getFullYear(), d1.getMonth() + i, 15);
    const dd = String(d.getDate()).padStart(2, '0');
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    dates.push(`${dd}.${mm}.${d.getFullYear()}`);
  }
  return dates;
}

function buildUrl(hotelId, checkIn) {
  const [d, m, y] = checkIn.split('.');
  const cin = new Date(y, m - 1, d);
  const cout = new Date(cin);
  cout.setDate(cout.getDate() + 7);
  const od = String(cout.getDate()).padStart(2, '0');
  const om = String(cout.getMonth() + 1).padStart(2, '0');
  const checkOut = `${od}.${om}.${cout.getFullYear()}`;
  return `https://www.bgoperator.ru/price.shtml?action=price&tid=211&idt=&flt2=100510000863&id_price=121110211811&data=${checkIn}&d2=${checkOut}&f7=7&f3=&f8=&ho=0&F4=${hotelId}&ins=0-40000-EUR&flt=100411293179&p=0100319900.0100319900`;
}

function parsePrice(str) {
  if (!str) return null;
  const n = parseInt(String(str).replace(/\s/g, '').replace(/[^\d]/g, ''), 10);
  return isNaN(n) ? null : n;
}

function formatPrice(n) {
  return n.toLocaleString('ru-RU') + ' RUB';
}

async function scrapePageOnce(browser, url) {
  const page = await browser.newPage();
  await page.setDefaultNavigationTimeout(60000);
  try {
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 60000 });
    await page.waitForSelector('li.s8.i_t1', { timeout: 30000 });

    const results = await page.evaluate((PENINSULA_ID, RIVALS) => {
      const rows = document.querySelectorAll('li.s8.i_t1');
      const offers = [];

      rows.forEach(row => {
        const urrAttr = row.getAttribute('urr') || '';
        const match = urrAttr.match(/id=(\d+)/);
        if (!match) return;
        const opId = match[1];

        const hotelEl = row.querySelector('a[href*="action=shw"]');
        const hotelName = hotelEl ? hotelEl.textContent.trim() : '';
        const priceEl = row.querySelector('td.c_pe b');
        const price = priceEl ? priceEl.textContent.trim() : '';
        const roomEl = row.querySelector('td.c_ht');
        const roomName = roomEl ? roomEl.textContent.trim() : '';

        if (opId === PENINSULA_ID) {
          offers.push({ type: 'peninsula', hotelName, roomName, price });
        } else {
          for (const [name, id] of Object.entries(RIVALS)) {
            if (opId === id) {
              offers.push({ type: 'rival', rivalName: name, hotelName, roomName, price });
            }
          }
        }
      });

      return offers;
    }, PENINSULA_ID, RIVALS);

    return results;
  } catch (e) {
    return null;
  } finally {
    await page.close();
  }
}

async function scrapeWithDateShift(browser, hotelId, checkIn) {
  const url = buildUrl(hotelId, checkIn);
  const result = await scrapePageOnce(browser, url);
  if (result !== null) return { result, usedCheckIn: checkIn, usedUrl: url, taskCheckIn: checkIn };

  const [d, m, y] = checkIn.split('.');
  const date = new Date(y, m - 1, d);
  date.setDate(date.getDate() + 5);
  const nd = String(date.getDate()).padStart(2, '0');
  const nm = String(date.getMonth() + 1).padStart(2, '0');
  const newCheckIn = `${nd}.${nm}.${date.getFullYear()}`;
  const newUrl = buildUrl(hotelId, newCheckIn);
  const result2 = await scrapePageOnce(browser, newUrl);
  return { result: result2, usedCheckIn: newCheckIn, usedUrl: newUrl, taskCheckIn: checkIn };
}

async function sendTelegram(message) {
  const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: TELEGRAM_CHAT_ID,
      text: message,
      parse_mode: 'HTML',
      disable_web_page_preview: true
    })
  });
  const data = await res.json();
  if (!data.ok) throw new Error(`Telegram hata: ${JSON.stringify(data)}`);
}

async function sendTelegramAlerts(openedAlerts, closedAlerts) {
  if (openedAlerts.length === 0 && closedAlerts.length === 0) return;

  const now = new Date();
  const ts = `${String(now.getDate()).padStart(2,'0')}.${String(now.getMonth()+1).padStart(2,'0')}.${now.getFullYear()} ${String(now.getHours()).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')}:${String(now.getSeconds()).padStart(2,'0')}`;

  let msg = '🔍 <b>Tekel İhlali Raporu</b>\n\n';

  if (openedAlerts.length > 0) {
    const byHotel = {};
    for (const a of openedAlerts) {
      if (!byHotel[a.hotelName]) byHotel[a.hotelName] = [];
      byHotel[a.hotelName].push(a);
    }

    for (const hotelName of Object.keys(byHotel)) {
      msg += `🏨 ${hotelName}\n`;
      const byRoom = {};
      for (const a of byHotel[hotelName]) {
        const rk = a.roomName || '-';
        if (!byRoom[rk]) byRoom[rk] = [];
        byRoom[rk].push(a);
      }
      for (const roomName of Object.keys(byRoom)) {
        if (roomName && roomName !== '-') msg += `🛏 ${roomName}\n`;
        for (const a of byRoom[roomName]) {
          if (a.penPrice !== null && a.rivalPrice !== null) {
            const diff = Math.abs(a.penPrice - a.rivalPrice);
            if (a.rivalPrice < a.penPrice) {
              msg += `  📅 ${a.checkIn} 🚨 Rakip öne geçti\n`;
              msg += `     📌 Peninsula: ${formatPrice(a.penPrice)}\n`;
              msg += `     🏆 ${a.rivalName}: ${formatPrice(a.rivalPrice)} (Fark: ${formatPrice(diff)})\n`;
            } else if (a.rivalPrice === a.penPrice) {
              msg += `  📅 ${a.checkIn} 🟡 Fiyatlar eşitleşti\n`;
              msg += `     📌 Peninsula = ${a.rivalName}: ${formatPrice(a.penPrice)}\n`;
            } else {
              msg += `  📅 ${a.checkIn} 🆕 Rakip girdi (biz öndeyiz)\n`;
              msg += `     📌 Peninsula: ${formatPrice(a.penPrice)}\n`;
              msg += `     🏆 ${a.rivalName}: ${formatPrice(a.rivalPrice)} (Fark: ${formatPrice(diff)})\n`;
            }
          } else {
            msg += `  📅 ${a.checkIn} 🆕 ${a.rivalName} girdi\n`;
          }
        }
      }
      msg += '─────────────────\n';
    }
  }

  if (closedAlerts.length > 0) {
    msg += '\n✅ <b>Kapanan Rakipler</b>\n\n';
    const byHotel = {};
    for (const a of closedAlerts) {
      if (!byHotel[a.hotelName]) byHotel[a.hotelName] = [];
      byHotel[a.hotelName].push(a);
    }
    for (const hotelName of Object.keys(byHotel)) {
      msg += `🏨 ${hotelName}\n`;
      for (const a of byHotel[hotelName]) {
        msg += `  📅 ${a.checkIn} ✅ ${a.rivalName} kapandı\n`;
      }
      msg += '─────────────────\n';
    }
  }

  msg += `\n🕐 ${ts}`;

  const chunks = [];
  while (msg.length > 4000) {
    chunks.push(msg.slice(0, 4000));
    msg = msg.slice(4000);
  }
  chunks.push(msg);
  for (const chunk of chunks) await sendTelegram(chunk);
}

async function main() {
  const hotels = JSON.parse(fs.readFileSync(HOTELS_FILE, 'utf-8'));
  const prevState = fs.existsSync(STATE_FILE)
    ? JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8'))
    : {};
  const newState = {};

  const dates = generateDates();
  const totalUrls = hotels.length * dates.length;

  console.log('Tarama basliyor...');
  console.log(`Taranan aylar: ${dates.join(', ')}`);
  console.log(`Otel sayisi: ${hotels.length}`);
  console.log(`Toplam URL: ${totalUrls}`);

  const tasks = [];
  for (const hotelId of hotels) {
    for (const checkIn of dates) {
      tasks.push({ hotelId, checkIn });
    }
  }

  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
  });

  const openedAlerts = [];
  const closedAlerts = [];
  const emptyUrls = [];
  let completed = 0;

  // Otel adlarını state'te saklamak için
  const hotelNames = {};

  for (let i = 0; i < tasks.length; i += CONCURRENCY) {
    const batch = tasks.slice(i, i + CONCURRENCY);
    const results = await Promise.all(
      batch.map(({ hotelId, checkIn }) =>
        scrapeWithDateShift(browser, hotelId, checkIn)
          .then(r => ({ ...r, hotelId, taskCheckIn: checkIn }))
      )
    );

    for (const { result, usedCheckIn, usedUrl, hotelId, taskCheckIn } of results) {
      const stateKey = (rival) => `${hotelId}_${taskCheckIn}_${rival}`;

      if (result === null) {
        emptyUrls.push({
          url: usedUrl,
          checkIn: usedCheckIn,
          originalCheckIn: usedCheckIn !== taskCheckIn ? taskCheckIn : null
        });
        // State'i koru
        for (const rival of Object.keys(RIVALS)) {
          const key = stateKey(rival);
          if (prevState[key]) newState[key] = prevState[key];
        }
        continue;
      }

      // Otel adını kaydet
      const penRow = result.find(o => o.type === 'peninsula');
      const anyRow = result.find(o => o.hotelName);
      if (anyRow) hotelNames[hotelId] = anyRow.hotelName;

      // Peninsula fiyatlarını otel+oda bazında
      const penPrices = {};
      for (const o of result) {
        if (o.type === 'peninsula') {
          const k = `${o.hotelName}||${o.roomName}`;
          const p = parsePrice(o.price);
          if (p !== null && (!penPrices[k] || p < penPrices[k].price)) {
            penPrices[k] = { hotelName: o.hotelName, roomName: o.roomName, price: p };
          }
        }
      }

      // Rakip fiyatlarını otel+oda+rakip bazında
      const rivalMap = {};
      for (const o of result) {
        if (o.type === 'rival') {
          const k = `${o.hotelName}||${o.roomName}||${o.rivalName}`;
          const p = parsePrice(o.price);
          if (p !== null && (!rivalMap[k] || p < rivalMap[k].price)) {
            rivalMap[k] = { hotelName: o.hotelName, roomName: o.roomName, price: p, rivalName: o.rivalName };
          }
        }
      }

      const activeRivals = new Set(result.filter(o => o.type === 'rival').map(o => o.rivalName));

      for (const rival of Object.keys(RIVALS)) {
        const key = stateKey(rival);
        const wasPresent = prevState[key] === 'present';
        const isPresent = activeRivals.has(rival);

        if (isPresent) {
          newState[key] = 'present';
          if (!wasPresent) {
            // En iyi eşleşmeyi bul (en düşük rakip fiyatı)
            let best = null;
            for (const [rk, rv] of Object.entries(rivalMap)) {
              if (rv.rivalName !== rival) continue;
              const pk = `${rv.hotelName}||${rv.roomName}`;
              const pp = penPrices[pk] ? penPrices[pk].price : null;
              if (!best || rv.price < best.rivalPrice) {
                best = {
                  hotelName: rv.hotelName,
                  roomName: rv.roomName,
                  rivalPrice: rv.price,
                  penPrice: pp
                };
              }
            }
            openedAlerts.push({
              hotelId,
              hotelName: best ? best.hotelName : (hotelNames[hotelId] || hotelId),
              roomName: best ? best.roomName : '',
              checkIn: usedCheckIn,
              rivalName: rival,
              penPrice: best ? best.penPrice : null,
              rivalPrice: best ? best.rivalPrice : null
            });
          }
        } else {
          newState[key] = 'absent';
          if (wasPresent) {
            closedAlerts.push({
              hotelId,
              hotelName: hotelNames[hotelId] || hotelId,
              checkIn: usedCheckIn,
              rivalName: rival
            });
          }
        }
      }
    }

    completed += batch.length;
    if (completed % 100 === 0 || completed === tasks.length) {
      console.log(`  ${completed}/${totalUrls} tamamlandi`);
    }
  }

  await browser.close();

  if (emptyUrls.length > 0) {
    console.log(`\n--- BOŞ GELEN URL'LER (${emptyUrls.length} adet) ---`);
    for (const { url, checkIn, originalCheckIn } of emptyUrls) {
      const dateInfo = originalCheckIn ? `${originalCheckIn} → ${checkIn} (kaydırıldı)` : checkIn;
      console.log(`  [BOŞ] ${dateInfo} - ${url}`);
    }
    console.log('---');
  }

  fs.writeFileSync(STATE_FILE, JSON.stringify(newState, null, 2));
  console.log('State kaydedildi.');

  const total = openedAlerts.length + closedAlerts.length;
  if (total > 0) {
    console.log(`${openedAlerts.length} açılma, ${closedAlerts.length} kapanma bildirimi gonderiliyor...`);
    await sendTelegramAlerts(openedAlerts, closedAlerts);
    console.log('Telegram bildirimi gonderildi.');
  } else {
    console.log('Tekel ihlali yok.');
  }
}

main().catch(console.error);
