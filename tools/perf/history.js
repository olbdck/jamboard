// Version history in headless Chromium against the in-memory Supabase (mock.js mirrors supabase/history.sql):
//   node tools/perf/history.js <site dir> [screens dir]
const { chromium } = require('playwright');
const http = require('http'), fs = require('fs'), path = require('path');
const dir = process.argv[2] || '.', shots = process.argv[3]; const BID = 'HistBoardAAAAAAAAAAAAAAA';
const MOCK = fs.readFileSync(path.join(__dirname, 'mock.js'), 'utf8');
const srv = http.createServer((q, s) => { let p = q.url.split('?')[0].split('#')[0]; if (p === '/') p = '/index.html'; const f = path.join(dir, p); if (!fs.existsSync(f)) { s.writeHead(404); return s.end(); } s.writeHead(200, { 'content-type': p.endsWith('.html') ? 'text/html' : p.endsWith('.woff2') ? 'font/woff2' : 'text/javascript' }); s.end(fs.readFileSync(f)); });
const P = (id) => `boards/${BID}/items/${id}`;
const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) process.exitCode = 1; };
const FOX = { n: 'Лис Микита', e: '🦊', c: '#e8590c', v: 'FoxVoterAAAAAAAA' };
async function open(browser, opts = {}) {
  const rows = [['boards/' + BID, { title: 'Історія', at: 1, by: 'x' }],
    [P('s1'), { type: 'sticky', x: 100, y: 100, w: 180, h: 180, text: 'Ідея', color: 'pink', z: 1, rev: 1 }],
    [P('s2'), { type: 'sticky', x: 340, y: 100, w: 180, h: 180, text: 'План', color: 'ok', z: 2, rev: 1 }],
    [P('n1'), { type: 'node', x: 100, y: 360, w: 180, h: 80, text: 'API', shape: 'round', icon: 'api', color: 'info', z: 3, rev: 1 }]];
  const page = await browser.newPage({ viewport: { width: 1360, height: 860 }, deviceScaleFactor: opts.dpr || 1, colorScheme: opts.dark ? 'dark' : 'light' });
  const errs = []; page.on('pageerror', (e) => errs.push(e.message));
  await page.route(/cdn\.jsdelivr|supabase\.co|fonts\.g/, (r) => r.abort());
  await page.addInitScript(`window.__SEED = ${JSON.stringify(rows)};localStorage.setItem('jamboard:hints','0');localStorage.setItem('jamboard:me', JSON.stringify({name:'Олег',emoji:'🐼',color:'#c2185b'}));` + MOCK
    + `localStorage.setItem('jamboard:view:${BID}', JSON.stringify({x:0,y:0,z:1}));` + (opts.noHistory ? 'window.__mock.noHistory = true;' : ''));
  await page.goto(`http://localhost:${srv.address().port}/#b=${BID}`);
  await page.waitForFunction(() => document.querySelectorAll('.item').length >= 3);
  await page.waitForTimeout(700);
  return { page, errs };
}
(async () => {
  await new Promise((r) => srv.listen(0, r));
  const browser = await chromium.launch();
  const { page, errs } = await open(browser);
  const q = (sel) => page.evaluate((s) => document.querySelectorAll(s).length, sel);
  // someone else worked on the board an hour ago and half an hour ago
  await page.evaluate(([p3, p1, who]) => {
    const M = window.__mock, h = Date.now() - 3600e3;
    M.edit(p3, { type: 'sticky', x: 580, y: 100, w: 180, h: 180, text: 'Ризики', color: 'warn', z: 4, rev: h }, who, h);
    M.edit(p3.replace('s3', 's4'), { type: 'sticky', x: 820, y: 100, w: 180, h: 180, text: 'Терміни', color: 'warn', z: 5, rev: h + 1 }, who, h + 1000);
    M.edit(p1, { ...M.rows.get(p1), text: 'Ідея нова', rev: h + 1800e3 }, who, h + 1800e3);
  }, [P('s3'), P('s1'), FOX]);
  await page.waitForTimeout(400);
  ok((await q('.item.sticky')) === 4, 'remote stickies arrived');
  // I move s2 and delete the node
  await page.mouse.move(430, 190); await page.mouse.down(); for (let i = 1; i <= 8; i++) { await page.mouse.move(430 + i * 5, 190 + i * 25); await page.waitForTimeout(16); } await page.mouse.up(); await page.waitForTimeout(300);
  await page.mouse.click(190, 400); await page.keyboard.press('Delete'); await page.waitForTimeout(400);
  ok(!(await page.evaluate((p) => window.__mock.rows.has(p), P('n1'))), 'node deleted');
  const mine = await page.evaluate(() => window.__mock.log.filter((l) => l.who && l.who.n === 'Олег').length);
  ok(mine === 2, 'my writes are signed (' + mine + ' log rows)');

  // open the history
  await page.click('#histBtn'); await page.waitForTimeout(700);
  ok(!(await page.evaluate(() => document.querySelector('#histPop').hidden)), 'history panel open');
  const list = await page.evaluate(() => [...document.querySelectorAll('.hs-item')].map((b) => b.querySelector('b').textContent + ' | ' + b.querySelector('small').textContent));
  console.log(list.join('\n'));
  ok(list.length === 4, 'four versions: mine, fox x2, the starting point');
  ok(/Олег \(ви\) \| Переміщено стікер «План», видалено блок «API»/.test(list[0]), 'my version says what I did');
  ok(/Лис Микита \| Змінено стікер «Ідея нова»/.test(list[1]), 'the fox edit');
  ok(/Лис Микита \| Додано 2 стікери/.test(list[2]), 'the fox additions');
  ok(/Збережений стан/.test(list[3]), 'the starting point');
  ok((await q('.hs-item .hs-now')) === 1, 'current version marked');
  ok((await q('.hs-day')) >= 2, 'day headers (' + (await q('.hs-day')) + ')');
  if (shots) await page.screenshot({ path: path.join(shots, 'hist-list-light.png') });

  // preview the fox additions: s3 and s4 ringed, s1 still old text, n1 still there
  const items = await page.$$('.hs-item'); await items[2].click(); await page.waitForTimeout(700);
  ok(await page.evaluate(() => !document.querySelector('#peek').hidden && document.querySelector('#peek').classList.contains('hist')), 'preview opens beside the list');
  const pv = await page.evaluate(() => ({ title: document.querySelector('#peekTitle').textContent, sub: document.querySelector('#peekSub').textContent, go: document.querySelector('#peekGo').textContent,
    hits: [...document.querySelectorAll('#peekWorld .hs-hit')].map((e) => e.dataset.id).sort().join(','), texts: [...document.querySelectorAll('#peekWorld .pv-sticky')].map((e) => e.textContent).sort().join(','), node: document.querySelectorAll('#peekWorld .pv-node').length }));
  console.log(JSON.stringify(pv));
  ok(/^Версія · сьогодні, \d\d:\d\d$/.test(pv.title), 'preview title');
  ok(pv.go === 'Відновити цю версію', 'restore button');
  ok(pv.hits === 's3,s4', 'changed cards ringed');
  ok(pv.texts === 'Ідея,План,Ризики,Терміни' && pv.node === 1, 'the board as it was then');
  ok(await page.evaluate(() => document.activeElement.id === 'peekGo'), 'restore button focused');
  if (shots) await page.screenshot({ path: path.join(shots, 'hist-preview-light.png') });
  // step to the older and newer one with the arrows
  await page.keyboard.press('ArrowDown'); await page.waitForTimeout(500);
  ok(/Збережений/.test(await page.textContent('#peekSub')), 'ArrowDown: older version');
  ok((await q('#peekWorld .pv-sticky')) === 2, 'older version has two stickies');
  await page.keyboard.press('ArrowUp'); await page.keyboard.press('ArrowUp'); await page.waitForTimeout(500);
  ok(/Ідея нова/.test(await page.textContent('#peekSub')), 'ArrowUp: newer version');
  await page.keyboard.press('ArrowUp'); await page.waitForTimeout(500);
  ok(await page.evaluate(() => document.querySelector('#peekGo').disabled && document.querySelector('#peekGo').textContent === 'Це поточна версія'), 'current version cannot be restored');
  await page.keyboard.press('ArrowDown'); await page.keyboard.press('ArrowDown'); await page.waitForTimeout(500);

  // restore the fox additions
  await page.click('#peekGo'); await page.waitForTimeout(900);
  const st = await page.evaluate((ps) => ps.map((p) => { const d = window.__mock.rows.get(p); return d ? d.text + '@' + d.x + ',' + d.y : '-'; }), [P('s1'), P('s2'), P('n1'), P('s3')]);
  console.log(st.join(' '));
  ok(st[0] === 'Ідея@100,100' && st[1] === 'План@340,100' && st[2] === 'API@100,360' && st[3].startsWith('Ризики'), 'board restored to that version');
  ok(await page.evaluate(() => document.querySelector('#peek').hidden || document.querySelector('#peek').classList.contains('out')), 'preview closed after restore');
  ok(/відновлено/i.test(await page.textContent('#toast')), 'toast says restored');
  await page.waitForTimeout(1600);
  const top = await page.evaluate(() => document.querySelector('.hs-item small').textContent);
  ok(/^Відновлено версію від \d+ листопада|^Відновлено версію від \d+ \S+, \d\d:\d\d/.test(top), 'restore shows as its own version: ' + top);
  // undo brings the newer state back
  await page.mouse.click(1000, 700); await page.keyboard.press('Control+z'); await page.waitForTimeout(500);
  const un = await page.evaluate((ps) => ps.map((p) => (window.__mock.rows.get(p) || {}).text || '-'), [P('s1'), P('n1')]);
  ok(un[0] === 'Ідея нова' && un[1] === '-', 'Ctrl+Z undoes the restore (' + un + ')');
  // Escape closes the list
  await page.focus('#histClose'); await page.keyboard.press('Escape'); await page.waitForTimeout(300);
  ok(await page.evaluate(() => document.querySelector('#histPop').hidden), 'Escape closes the list');
  ok(errs.length === 0, 'no page errors ' + errs.join(' | '));

  // dark theme screenshots
  if (shots) {
    const d = await open(browser, { dark: true });
    await d.page.evaluate(([p3, who]) => { const h = Date.now() - 600e3; window.__mock.edit(p3, { type: 'sticky', x: 580, y: 100, w: 180, h: 180, text: 'Ризики', color: 'warn', z: 4, rev: h }, who, h); }, [P('s3'), FOX]);
    await d.page.waitForTimeout(300); await d.page.click('#histBtn'); await d.page.waitForTimeout(600);
    await d.page.screenshot({ path: path.join(shots, 'hist-list-dark.png') });
    const its = await d.page.$$('.hs-item'); await its[0].click(); await d.page.waitForTimeout(700);
    await d.page.screenshot({ path: path.join(shots, 'hist-preview-dark.png') });
    await d.page.close();
  }

  // a database without history.sql: writes still go through, the panel says what to run
  const o = await open(browser, { noHistory: true });
  await o.page.mouse.dblclick(900, 600); await o.page.waitForTimeout(300); await o.page.keyboard.type('Без історії'); await o.page.keyboard.press('Escape'); await o.page.waitForTimeout(600);
  ok(await o.page.evaluate(() => [...window.__mock.rows.values()].some((d) => d.text === 'Без історії')), 'without history.sql writes still save');
  await o.page.click('#histBtn'); await o.page.waitForTimeout(500);
  ok(/history\.sql/.test(await o.page.textContent('#histMsg')), 'panel explains how to turn history on');
  ok(o.errs.length === 0, 'no page errors without history ' + o.errs.join(' | '));
  await browser.close(); srv.close();
})();
