const puppeteer = require('puppeteer');
const fs = require('fs');

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const TELEGRAM_GROUP_ID = process.env.GROUP_CHAT_ID;
const STATE_FILE = 'price_state.json';
const HOTELS_FILE = 'hotels.json';

const AGENCY_RULES = [
  { pattern: '103810219', name: 'PENINSULA' },
  { pattern: '103816',    name: 'AKAY(FIT)' },
  { pattern: '103810175', name: 'SUMMER' },
  { pattern: '103810222', name: 'CARTHAGE' },
  { pattern: '103825',    name: 'KILIT GLOBAL' },
];

function loadHotelIds() {
  if (fs.existsSync(HOTELS_FILE)) return JSON.parse(fs.readFileSync(HOTELS_FILE, 'utf8'));
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

  for (let m = 0; m < 4; m++) {
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

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ─── Telegram ────────────────────────────────────────────────────────────────
async function sendTelegram(text) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) { console.log('[TEL]', text.slice(0, 120)); return; }
  const targets = [TELEGRAM_CHAT_ID];
  if (TELEGRAM_GROUP_ID) targets.push(TELEGRAM_GROUP_ID);

  for (const chatId of targets) {
    const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML', disable_web_page_preview: true }),
    });
    if (!resp.ok) console.error('Telegram hatasi:', resp.status, await resp.text());
  }
}

async function sendTelegramSplit(aheadAlerts, equalAlerts) {
  const allAlerts = [
    ...aheadAlerts.map(a => ({ ...a, type: 'ahead' })),
    ...equalAlerts.map(a => ({ ...a, type: 'equal' })),
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
      const toMs = s => { const [d,m,y] = s.split('.'); return new Date(y,m-1,d).getTime(); };
      return toMs(a.checkIn) - toMs(b.checkIn);
    });
  }

  const time = `\n🕐 ${new Date().toLocaleString('tr-TR', { timeZone: 'Europe/Istanbul' })}`;
  let current = '🏨 <b>Peninsula Fiyat Raporu</b>\n\n';

  for (const g of Object.values(groups)) {
    let block = `🏨 <b>${g.hotel}</b>\n🛏 ${g.room}\n`;
    for (const a of g.entries) {
      if (a.type === 'equal') {
        block += `  📅 ${a.checkIn} 🟡 Fiyatlar eşit\n`;
        block += `     📌 Peninsula = ${a.cheapestAgency}: ${a.peninsulaPrice} EUR\n`;
      } else if (a.newRival && !a.rivalAhead) {
        block += `  📅 ${a.checkIn} 🆕 Rakip girdi (biz öndeyiz)\n`;
        block += `     📌 Peninsula: ${a.peninsulaPrice} EUR\n`;
        block += `     🏆 ${a.cheapestAgency}: ${a.cheapestPrice} EUR\n`;
      } else if (a.newRival && a.rivalAhead) {
        block += `  📅 ${a.checkIn} 🆕 Rakip girdi (gerideyiz)\n`;
        block += `     📌 Peninsula: ${a.peninsulaPrice} EUR\n`;
        block += `     🏆 ${a.cheapestAgency}: ${a.cheapestPrice} EUR (Fark: ${a.diff} EUR)\n`;
      } else {
        block += `  📅 ${a.checkIn} 🚨 Rakip öne geçti\n`;
        block += `     📌 Peninsula: ${a.peninsulaPrice} EUR\n`;
        block += `     🏆 ${a.cheapestAgency}: ${a.cheapestPrice} EUR (Fark: ${a.diff} EUR)\n`;
      }
    }
    block += `─────────────────\n`;

    if ((current + block).length > 3500) {
      await sendTelegram(current);
      current = '🏨 <b>Peninsula Fiyat Raporu (devam)</b>\n\n' + block;
    } else {
      current += block;
    }
  }
  await sendTelegram(current + time);
}

// ─── SCRAPE ──────────────────────────────────────────────────────────────────
async function scrapePageOnce(browser, targetUrl, checkIn) {
  const page = await browser.newPage();
  await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
  await page.setViewport({ width: 1920, height: 1080 });

  try { await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 60000 }); } catch(e) {}
  try { await page.waitForSelector('div.b-pr', { timeout: 30000 }); } catch(e) {}
  await sleep(2000);

  const agencyRulesStr = JSON.stringify(AGENCY_RULES);

  const results = await page.evaluate((agencyRulesStr, targetDate) => {
    const agencyRules = JSON.parse(agencyRulesStr);

    function identifyAgency(urr) {
      for (const rule of agencyRules) {
        if (urr.includes(rule.pattern)) return rule.name;
      }
      return null;
    }

    const offers = [];
    const blocks = document.querySelectorAll('div.b-pr');

    for (const block of blocks) {
      // Otel adı: b-pr içindeki ilk "code=" içeren linkin text'i
      // <a href="/price.shtml?...&code=102610086971&...">Villa Sonata Hotel APARTMENT</a>
      let hotelName = '';
      const hotelLink = block.querySelector('a[href*="code="]');
      if (hotelLink) {
        hotelName = hotelLink.textContent.trim();
      }

      const allRows = block.querySelectorAll('tr');
      let peninsulaPrice = null;
      let peninsulaRoomName = '';
      const rivals = [];

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

        if (agency === 'PENINSULA') {
          const roomTd = tr.querySelector('td.c_ns');
          if (roomTd && !peninsulaRoomName) {
            peninsulaRoomName = roomTd.textContent.trim().split('\n')[0].trim();
          }
          if (!peninsulaPrice || price < peninsulaPrice) peninsulaPrice = price;
        } else {
          rivals.push({ agency, price });
        }
      }

      if (!peninsulaPrice || !peninsulaRoomName) continue;

      offers.push({ hotelName, roomType: peninsulaRoomName, peninsulaPrice, rivals });
    }

    return offers;
  }, agencyRulesStr, checkIn);

  await page.close();
  return results;
}

async function scrapePageWithDateShift(browser, targetUrl, checkIn) {
  let results = await scrapePageOnce(browser, targetUrl, checkIn);
  if (results.length > 0) return { results, usedCheckIn: checkIn };

  const [d, m, y] = checkIn.split('.');
  const date = new Date(y, m - 1, d);
  date.setDate(date.getDate() + 5);
  const fmt = n => String(n).padStart(2, '0');
  const newCheckIn  = `${fmt(date.getDate())}.${fmt(date.getMonth()+1)}.${date.getFullYear()}`;
  const out = new Date(date);
  out.setDate(out.getDate() + 7);
  const newCheckOut = `${fmt(out.getDate())}.${fmt(out.getMonth()+1)}.${out.getFullYear()}`;
  const newUrl = targetUrl
    .replace(/data=\d{2}\.\d{2}\.\d{4}/, `data=${newCheckIn}`)
    .replace(/d2=\d{2}\.\d{2}\.\d{4}/,   `d2=${newCheckOut}`);

  results = await scrapePageOnce(browser, newUrl, newCheckIn);
  return { results, usedCheckIn: newCheckIn };
}

// ─── Analiz ──────────────────────────────────────────────────────────────────
function analyzeOffers(checkIn, offers, prevState, newState) {
  const aheadAlerts = [];
  const equalAlerts = [];

  for (const o of offers) {
    const key = `${checkIn}__${o.hotelName}__${o.roomType}`;
    const prevStatus = prevState[key];

    if (o.rivals.length === 0) {
      newState[key] = 'alone';
      continue;
    }

    const cheapest = o.rivals.reduce((a, b) => a.price < b.price ? a : b);
    const rivalAhead = cheapest.price < o.peninsulaPrice;
    const isEqual    = cheapest.price === o.peninsulaPrice;
    const isNew      = prevStatus === 'alone' || prevStatus === undefined;

    newState[key] = rivalAhead ? 'ahead' : isEqual ? 'equal' : 'behind';

    if (isNew && rivalAhead) {
      aheadAlerts.push({
        checkIn, hotel: o.hotelName, room: o.roomType,
        peninsulaPrice: o.peninsulaPrice,
        cheapestAgency: cheapest.agency, cheapestPrice: cheapest.price,
        diff: o.peninsulaPrice - cheapest.price,
        newRival: true, rivalAhead: true,
      });
    } else if (isNew && isEqual) {
      equalAlerts.push({
        checkIn, hotel: o.hotelName, room: o.roomType,
        peninsulaPrice: o.peninsulaPrice,
        cheapestAgency: cheapest.agency, cheapestPrice: cheapest.price,
      });
    } else if (isNew && !rivalAhead && !isEqual) {
      aheadAlerts.push({
        checkIn, hotel: o.hotelName, room: o.roomType,
        peninsulaPrice: o.peninsulaPrice,
        cheapestAgency: cheapest.agency, cheapestPrice: cheapest.price,
        diff: 0, newRival: true, rivalAhead: false,
      });
    } else if (!isNew && rivalAhead && prevStatus !== 'ahead') {
      aheadAlerts.push({
        checkIn, hotel: o.hotelName, room: o.roomType,
        peninsulaPrice: o.peninsulaPrice,
        cheapestAgency: cheapest.agency, cheapestPrice: cheapest.price,
        diff: o.peninsulaPrice - cheapest.price,
        newRival: false, rivalAhead: true,
      });
    } else if (!isNew && isEqual && prevStatus !== 'equal') {
      equalAlerts.push({
        checkIn, hotel: o.hotelName, room: o.roomType,
        peninsulaPrice: o.peninsulaPrice,
        cheapestAgency: cheapest.agency, cheapestPrice: cheapest.price,
      });
    }
  }

  return { aheadAlerts, equalAlerts };
}

// ─── State ───────────────────────────────────────────────────────────────────
function loadState() {
  if (fs.existsSync(STATE_FILE)) return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  return {};
}
function saveState(state) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), 'utf8');
}

// ─── MAIN ────────────────────────────────────────────────────────────────────
async function main() {
  console.log('Tarama basliyor...');
  const dates = generateDates();
  console.log('Tarihler:', dates.map(d => d.checkIn).join(', '));

  const hotelIds = loadHotelIds();
  console.log(`Otel sayisi: ${hotelIds.length}`);

  const prevState = loadState();
  const newState  = { ...prevState };
  const allAheadAlerts = [];
  const allEqualAlerts = [];

  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
  });

  try {
    const urls = generateUrls();
    console.log(`Toplam URL: ${urls.length}`);

    const CONCURRENCY = 10;
    const offersByDate = {};
    let completed = 0;

    for (let i = 0; i < urls.length; i += CONCURRENCY) {
      const batch = urls.slice(i, i + CONCURRENCY);
      const batchResults = await Promise.all(
        batch.map(({ url, checkIn }) => scrapePageWithDateShift(browser, url, checkIn))
      );

      for (const { results, usedCheckIn } of batchResults) {
        if (results.length > 0) {
          if (!offersByDate[usedCheckIn]) offersByDate[usedCheckIn] = [];
          offersByDate[usedCheckIn].push(...results);
        }
      }

      completed += batch.length;
      if (completed % 50 === 0 || completed === urls.length) {
        console.log(`  ${completed}/${urls.length} tamamlandi`);
      }
    }

    for (const [checkIn, offers] of Object.entries(offersByDate)) {
      console.log(`  [${checkIn}] ${offers.length} otel bloğu`);
      const { aheadAlerts, equalAlerts } = analyzeOffers(checkIn, offers, prevState, newState);
      allAheadAlerts.push(...aheadAlerts);
      allEqualAlerts.push(...equalAlerts);
    }

  } finally {
    await browser.close();
  }

  saveState(newState);
  console.log('State kaydedildi.');

  if (allAheadAlerts.length > 0 || allEqualAlerts.length > 0) {
    console.log(`${allAheadAlerts.length} fiyat uyarisi, ${allEqualAlerts.length} esitlik. Gonderiliyor...`);
    await sendTelegramSplit(allAheadAlerts, allEqualAlerts);
  } else {
    console.log('Degisiklik yok.');
  }
}

main().catch(async err => {
  console.error('Kritik hata:', err.message);
  await sendTelegram(`❌ <b>Peninsula Monitor Hatasi</b>\n\n${err.message}`).catch(() => {});
  process.exit(1);
});
