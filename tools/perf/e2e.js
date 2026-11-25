const { chromium } = require('playwright');
const http = require('http'), fs = require('fs'), path = require('path');
const dir = process.argv[2]; const BID = 'E2eBoardAAAAAAAAAAAAAAAA';
const MOCK = fs.readFileSync(path.join(__dirname, 'mock.js'), 'utf8');
const srv = http.createServer((q, s) => { let p = q.url.split('?')[0].split('#')[0]; if (p === '/') p = '/index.html'; const f = path.join(dir, p); if (!fs.existsSync(f)) { s.writeHead(404); return s.end(); } s.writeHead(200, { 'content-type': p.endsWith('.html') ? 'text/html' : 'text/javascript' }); s.end(fs.readFileSync(f)); });
const P = (id) => `boards/${BID}/items/${id}`;
const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) process.exitCode = 1; };
(async () => {
  await new Promise((r) => srv.listen(0, r));
  const rows = [['boards/' + BID, { title: 'E2E', at: 1, by: 'x' }],
    [P('s1'), { type: 'sticky', x: 100, y: 100, w: 180, h: 180, text: 'Один', color: 'pink', z: 1, rev: 1 }],
    [P('s2'), { type: 'sticky', x: 500, y: 120, w: 180, h: 180, text: 'Два', color: 'green', z: 2, rev: 1 }],
    [P('t1'), { type: 'text', x: 100, y: 400, w: 300, h: 40, text: 'Заголовок', ts: 'h2', z: 3, rev: 1 }],
    [P('n1'), { type: 'node', x: 100, y: 520, w: 180, h: 80, text: 'API', shape: 'round', icon: 'api', color: 'blue', z: 4, rev: 1 }],
    [P('n2'), { type: 'node', x: 520, y: 520, w: 180, h: 80, text: 'DB', shape: 'cyl', icon: 'db', color: 'green', z: 5, rev: 1 }],
    [P('l1'), { type: 'link', a: 'n1', b: 'n2', z: 6, rev: 1 }]];
  const browser = await chromium.launch(); const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const errs = []; page.on('pageerror', (e) => errs.push(e.message));
  await page.route(/cdn\.jsdelivr|supabase\.co|fonts\.g/, (r) => r.abort());
  await page.addInitScript(`window.__SEED = ${JSON.stringify(rows)};localStorage.setItem('jamboard:hints','0');` + MOCK + `localStorage.setItem('jamboard:view:${BID}', JSON.stringify({x:0,y:0,z:1}));`);
  await page.goto(`http://localhost:${srv.address().port}/#b=${BID}`);
  await page.waitForFunction(() => document.querySelectorAll('.item').length >= 5);
  await page.waitForTimeout(800);
  const q = (sel) => page.evaluate((s) => document.querySelectorAll(s).length, sel);
  const txt = (id) => page.evaluate((id) => document.querySelector(`.item[data-id="${id}"] .txt`).textContent, id);
  ok((await q('.port')) === 0, 'no ports before hover');
  // hover → ports
  await page.mouse.move(190, 190); await page.waitForTimeout(300);
  ok((await q('.item[data-id="s1"] > .port')) === 4, 'ports on hover');
  const portOp = await page.evaluate(() => getComputedStyle(document.querySelector('.item[data-id="s1"] > .port.r')).opacity);
  ok(portOp === '1', 'port visible on hover (' + portOp + ')');
  // drag port r of s1 to s2 → new rope
  await page.mouse.move(280, 190); await page.mouse.down(); for (let i = 1; i <= 10; i++) { await page.mouse.move(280 + i * 30, 200); await page.waitForTimeout(16); } await page.mouse.up(); await page.waitForTimeout(400);
  ok((await q('#links g[data-link]')) === 2, 'rope made from a port');
  // undo removes it
  await page.keyboard.press('Control+z'); await page.waitForTimeout(400);
  ok((await q('#links g[data-link]:not(.gone)')) === 1, 'undo removes the rope');
  // drag s2
  await page.mouse.move(590, 210); await page.mouse.down(); for (let i = 1; i <= 10; i++) { await page.mouse.move(590 + i * 10, 210 + i * 5); await page.waitForTimeout(16); } await page.mouse.up(); await page.waitForTimeout(400);
  const s2 = await page.evaluate((p) => window.__mock.rows.get(p), P('s2'));
  ok(s2.x === 600 && s2.y === 170, 'drag saved (' + s2.x + ',' + s2.y + ')');
  // new sticky by double click on empty space, type
  await page.mouse.dblclick(900, 600); await page.waitForTimeout(300); await page.keyboard.type('Нова'); await page.keyboard.press('Escape'); await page.waitForTimeout(600);
  ok((await q('.item.sticky')) === 3, 'double click makes a sticky');
  // remote edit: only that card changes
  await page.evaluate((p) => window.__mock.remote(p, { ...window.__mock.rows.get(p), text: 'Змінено ззовні', rev: Date.now() + 5000 }), P('s1')); await page.waitForTimeout(300);
  ok((await txt('s1')) === 'Змінено ззовні', 'remote edit shows');
  await page.evaluate((p) => window.__mock.remote(p, { ...window.__mock.rows.get(p), x: 300, rev: Date.now() + 6000 }), P('t1')); await page.waitForTimeout(400);
  ok(await page.evaluate(() => document.querySelector('.item[data-id="t1"]').style.translate.startsWith('300px')), 'remote move shows');
  await page.evaluate((p) => window.__mock.remote(p, { ...window.__mock.rows.get(p), color: 'pink', rev: Date.now() + 7000 }), P('l1')); await page.waitForTimeout(300);
  ok(await page.evaluate(() => document.querySelector('#links g[data-link="l1"]').style.getPropertyValue('--rc').includes('accent')), 'remote rope colour shows');
  await page.evaluate((p) => window.__mock.remote(p, { type: 'sticky', x: 900, y: 100, w: 180, h: 180, text: 'Ззовні', color: 'blue', z: 50, rev: Date.now() }), P('s9')); await page.waitForTimeout(400);
  ok((await q('.item[data-id="s9"]')) === 1, 'remote new card shows');
  await page.evaluate((p) => window.__mock.gone(p), P('s9')); await page.waitForTimeout(500);
  ok((await q('.item[data-id="s9"]')) === 0, 'remote delete removes the card');
  // peer selects s1 → frame, no full redraw needed
  await page.evaluate((bid) => window.__mock.peer(bid, { peer: 'pZ', s: { name: 'Лис', emoji: '🦊', color: '#2f7de1', board: bid, sel: ['s1'] } }), BID); await page.waitForTimeout(300);
  ok((await q('.peer-box')) === 1, 'peer selection frame');
  // zoom: --z only via the small style sheet
  await page.mouse.move(640, 400); await page.keyboard.down('Control'); for (let i = 0; i < 6; i++) { await page.mouse.wheel(0, -10); await page.waitForTimeout(30); } await page.keyboard.up('Control'); await page.waitForTimeout(400);
  const zs = await page.evaluate(() => { const st = [...document.querySelectorAll('style')].find((s) => s.textContent.startsWith('#world .sel')); return st && st.textContent.slice(-30); });
  ok(!!zs && !zs.includes('--z: 1;'), 'zoom sheet updated: ' + zs);
  const pb = await page.evaluate(() => getComputedStyle(document.querySelector('.peer-box')).borderTopWidth);
  ok(parseFloat(pb) < 2, 'peer frame line stays thin when zoomed in (' + pb + ')');
  // theme switch with pulses running
  await page.click('#themeBtn'); await page.waitForTimeout(300); await page.click('#themeBtn'); await page.waitForTimeout(300);
  ok(!(await page.evaluate(() => document.querySelector('#pulses').hidden)), 'pulse canvas on');
  ok(errs.length === 0, 'no page errors ' + errs.join(' | '));
  await browser.close(); srv.close();
})();
