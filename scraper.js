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

  // Eğer ilk tarih mart içindeyse nisana atla
  if (first.getMonth() === 2) {
    first.setFullYear(first.getFullYear(), 3, 15);
  }

  const dates = [];
  // İlk tarih: ayın 15'i
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

async function scrapePageOnce(browser, url, checkIn) {
  const page = await browser.newPage();
  await page.setDefaultNavigationTimeout(60000);
  try {
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 60000 });
    await page.waitForSelector('li.s8.i_t1', { timeout: 30000 });

    const results = await page.evaluate((PENINSULA_ID, RIVALS) => {
      const rows = document.querySelectorAll('li.s8.i_t1');
      const found = { peninsula: false, rivals: [] };

      rows.forEach(row => {
        const urrAttr = row.getAttribute('urr') || '';
        const match = urrAttr.match(/id=(\d+)/);
        if (!match) return;
        const opId = match[1];

        if (opId === PENINSULA_ID) {
          found.peninsula = true;
        } else {
          for (const [name, id] of Object.entries(RIVALS)) {
            if (opId === id) {
              found.rivals.push(name);
            }
          }
        }
      });

      return found;
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
  const result = await scrapePageOnce(browser, url, checkIn);

  if (result !== null) return { result, usedCheckIn: checkIn, usedUrl: url };

  // Boş geldi — 5 gün kaydır
  const [d, m, y] = checkIn.split('.');
  const date = new Date(y, m - 1, d);
  date.setDate(date.getDate() + 5);
  const nd = String(date.getDate()).padStart(2, '0');
  const nm = String(date.getMonth() + 1).padStart(2, '0');
  const newCheckIn = `${nd}.${nm}.${date.getFullYear()}`;
  const newUrl = buildUrl(hotelId, newCheckIn);

  const result2 = await scrapePageOnce(browser, newUrl, newCheckIn);
  return {
    result: result2,
    usedCheckIn: newCheckIn,
    usedUrl: newUrl,
    originalCheckIn: checkIn
  };
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

async function sendTelegramSplit(alerts) {
  if (alerts.length === 0) return;

  const now = new Date();
  const ts = `${String(now.getDate()).padStart(2,'0')}.${String(now.getMonth()+1).padStart(2,'0')}.${now.getFullYear()} ${String(now.getHours()).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')}:${String(now.getSeconds()).padStart(2,'0')}`;

  // Otele göre grupla
  const byHotel = {};
  for (const a of alerts) {
    if (!byHotel[a.hotelId]) byHotel[a.hotelId] = [];
    byHotel[a.hotelId].push(a);
  }

  let msg = '🚨 <b>Tekel İhlali Raporu</b>\n\n';
  for (const hotelId of Object.keys(byHotel)) {
    const hotelAlerts = byHotel[hotelId];
    msg += `🏨 Otel ID: ${hotelId}\n`;
    for (const a of hotelAlerts) {
      msg += `  📅 ${a.checkIn} — ${a.rival} açtı\n`;
    }
    msg += '─────────────────\n';
  }
  msg += `\n🕐 ${ts}`;

  // Telegram 4096 karakter limiti
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
  const newState = { ...prevState };

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

  const alerts = [];
  const emptyUrls = [];
  let completed = 0;

  for (let i = 0; i < tasks.length; i += CONCURRENCY) {
    const batch = tasks.slice(i, i + CONCURRENCY);
    const results = await Promise.all(
      batch.map(({ hotelId, checkIn }) =>
        scrapeWithDateShift(browser, hotelId, checkIn)
          .then(r => ({ ...r, hotelId, originalCheckIn: r.originalCheckIn || checkIn }))
      )
    );

    for (const { result, usedCheckIn, usedUrl, hotelId, originalCheckIn } of results) {
      if (result === null) {
        emptyUrls.push({ url: usedUrl, checkIn: usedCheckIn, originalCheckIn: usedCheckIn !== originalCheckIn ? originalCheckIn : null });
      } else {
        // State kontrolü
        for (const rival of result.rivals) {
          const key = `${hotelId}_${originalCheckIn}_${rival}`;
          if (!prevState[key]) {
            // Yeni rakip girdi
            alerts.push({ hotelId, checkIn: usedCheckIn, rival });
            newState[key] = 'detected';
          }
          // Zaten bilinen → sessiz
        }
        // Peninsula yoksa bile state güncelleme (normal)
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

  if (alerts.length > 0) {
    console.log(`${alerts.length} tekel ihlali bildirimi gonderiliyor...`);
    await sendTelegramSplit(alerts);
    console.log('Telegram bildirimi gonderildi.');
  } else {
    console.log('Tekel ihlali yok.');
  }
}

main().catch(console.error);
