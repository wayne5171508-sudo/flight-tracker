// Daily Google Flights price check for flight-tracker. Writes/updates today's row in prices.json.
import { chromium } from 'playwright';
import fs from 'node:fs';

const S = {
  tw: 'https://www.google.com/travel/flights/search?tfs=CBwQAhojEgoyMDI3LTA1LTEwagwIAhIIL20vMGZ0a3hyBwgBEgNMSFIaIxIKMjAyNy0wNS0yM2oHCAESA0NER3IMCAISCC9tLzBmdGt4QAFIAXABggELCP___________wGYAQM&hl=en&curr=TWD&gl=TW',
  gfA: 'https://www.google.com/travel/flights/search?tfs=CBwQAhoeEgoyMDI3LTA1LTEwagcIARIDWVlacgcIARIDTEhSGh4SCjIwMjctMDUtMjNqBwgBEgNDREdyBwgBEgNZWVpAAUgBcAGCAQsI____________AZgBAw&hl=en&curr=CAD&gl=CA',
  gfBout: 'https://www.google.com/travel/flights?q=Flights%20to%20LHR%20from%20YYZ%20on%202027-05-10%20oneway&curr=CAD&hl=en&gl=CA',
  gfBret: 'https://www.google.com/travel/flights?q=Flights%20to%20TPE%20from%20CDG%20on%202027-05-23%20oneway&curr=TWD&hl=en&gl=TW',
};

const num = (s) => Number(String(s).replace(/[^\d]/g, ''));

async function results(page, url) {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  // Cookie consent (choose the privacy-preserving option if shown)
  for (const label of ['Reject all', 'Reject All']) {
    const b = page.getByRole('button', { name: label });
    if (await b.count()) { await b.first().click().catch(() => {}); break; }
  }
  // Google's results page enforces Trusted Types, so poll with evaluate() instead of waitForFunction().
  const ready = () => page.evaluate(() => /(NT|CA)\$[\d,]+/.test(document.body.innerText) && /\d+ hr/.test(document.body.innerText)).catch(() => false);
  const t0 = Date.now();
  while (!(await ready())) {
    if (Date.now() - t0 > 45000) throw new Error('timeout waiting for prices');
    await page.waitForTimeout(1500);
  }
  await page.waitForTimeout(3000);
  const items = await page.$$eval('li', (lis) => lis.map((li) => {
    const lab = [...li.querySelectorAll('[aria-label]')].map((e) => e.getAttribute('aria-label')).find((a) => /flight with /.test(a)) || '';
    return { t: li.innerText, lab };
  }).filter(({ t }) => /(NT|CA)\$[\d,]+/.test(t) && /\d+ hr/.test(t)));
  return items.map(({ t, lab }) => {
    const lines = t.split('\n').map((x) => x.trim()).filter(Boolean);
    const dash = lines.findIndex((x) => x === '–' || x === '-');
    const m = lab.match(/flight with (.+?)\./);
    const airline = m ? m[1].replace(/ and /g, ', ') : (dash >= 0 ? (lines[dash + 2] || '') : '');
    const price = num((t.match(/(?:NT|CA)\$[\d,]+/) || ['0'])[0]);
    return { text: t, airline, price, etihadAuh: /Etihad/.test(t) && /AUH/.test(t) };
  }).filter((r) => r.price > 0);
}
// Google Flights 偶爾載入失敗(10/19、10/21 都有一半查詢逾時)。每組最多試 3 次,每次換新分頁、間隔拉長。
async function resultsRetry(ctx, url, label) {
  let lastErr;
  for (let attempt = 1; attempt <= 3; attempt++) {
    const pg = await ctx.newPage();
    try {
      const r = await results(pg, url);
      if (r.length) return r;
      lastErr = new Error('no rows');
    } catch (err) {
      lastErr = err;
      console.error(label, 'attempt', attempt, err.message);
    } finally {
      await pg.close().catch(() => {});
    }
    await new Promise((res) => setTimeout(res, 5000 * attempt));
  }
  throw lastErr;
}
const cheapest = (rs) => rs.reduce((m, r) => (!m || r.price < m.price ? r : m), null);

const today = new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10);
const browser = await chromium.launch();
const ctx = await browser.newContext({ locale: 'en-US', userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36' });
const row = { date: today, note: 'GitHub 自動查價' };
const notes = [];

try {
  const r = await resultsRetry(ctx, S.tw, 'tw');
  const e = cheapest(r.filter((x) => x.etihadAuh));
  const c = cheapest(r);
  if (e) row.etihad = e.price; else notes.push('台灣組找不到阿提哈德');
  if (c) { row.cheapest = c.price; row.cheapest_airline = c.airline; }
} catch (err) { notes.push('台灣組查詢失敗'); console.error('tw', err.message); }

for (const [key, url, field, airField, etihadOnly] of [
  ['gfA', S.gfA, 'gf_a', 'gf_a_airline', false],
  ['gfBout', S.gfBout, 'gf_b_out', 'gf_b_out_airline', false],
  ['gfBret', S.gfBret, 'gf_b_ret', null, true],
]) {
  try {
    const r = await resultsRetry(ctx, url, key);
    let pick = etihadOnly ? cheapest(r.filter((x) => x.etihadAuh)) : null;
    if (!pick) { pick = cheapest(r); if (etihadOnly && pick) notes.push('回程找不到阿提哈德，記最低價'); }
    if (pick) { row[field] = pick.price; if (airField) row[airField] = pick.airline; }
  } catch (err) { notes.push(key + ' 查詢失敗'); console.error(key, err.message); }
}
await browser.close();
if (notes.length) row.note += '；' + notes.join('；');
console.log(JSON.stringify(row));

if (!row.etihad && !row.cheapest && !row.gf_a && !row.gf_b_out && !row.gf_b_ret) {
  console.error('No prices found; not writing.');
  process.exit(1);
}
const file = 'prices.json';
const data = JSON.parse(fs.readFileSync(file, 'utf8'));
const i = data.findIndex((r) => String(r.date).slice(0, 10) === today);
if (i >= 0) {
  // 同一天跑第二次(手動補跑):這次失敗的組別保留稍早成功的價格,備註也不要寫成「查詢失敗」
  const prev = data[i];
  const kept = [];
  for (const [f, label] of [['etihad', '台灣組'], ['gf_a', 'gfA'], ['gf_b_out', 'gfBout'], ['gf_b_ret', 'gfBret']]) {
    if (row[f] == null && prev[f] != null) kept.push(label);
  }
  data[i] = { ...prev, ...row };
  if (kept.length) {
    let note = row.note;
    for (const k of kept) note = note.replace('；' + (k === '台灣組' ? '台灣組查詢失敗' : k + ' 查詢失敗'), '');
    data[i].note = note + '；' + kept.join('、') + '沿用今天稍早的價格';
  }
} else data.push(row);
data.sort((a, b) => (a.date < b.date ? -1 : 1));
fs.writeFileSync(file, JSON.stringify(data, null, 0) + '\n');
