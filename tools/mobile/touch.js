const { chromium, devices } = require('playwright');
const http = require('http'), fs = require('fs'), path = require('path');
const dir = process.argv[2] || '.', out = process.argv[3] || require('os').tmpdir() + '/jb-mobile'; const BID = 'E2eBoardAAAAAAAAAAAAAAAA';
const MOCK = fs.readFileSync(path.join(__dirname, '../perf/mock.js'), 'utf8');
const srv = http.createServer((q, s) => { let p = q.url.split('?')[0].split('#')[0]; if (p === '/') p = '/index.html'; const f = path.join(dir, p); if (!fs.existsSync(f)) { s.writeHead(404); return s.end(); } s.writeHead(200, { 'content-type': p.endsWith('.html') ? 'text/html' : 'text/javascript' }); s.end(fs.readFileSync(f)); });
const P = (id) => `boards/${BID}/items/${id}`;
const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) process.exitCode = 1; };
(async () => {
  await new Promise((r) => srv.listen(0, r));
  const rows = [['boards/' + BID, { title: 'Мобільна дошка', at: 1, by: 'x' }],
    [P('s1'), { type: 'sticky', x: 20, y: 140, w: 160, h: 160, text: 'Один', color: 'pink', z: 1, rev: 1 }],
    [P('s2'), { type: 'sticky', x: 210, y: 160, w: 160, h: 160, text: 'Два', color: 'green', z: 2, rev: 1 }],
    [P('n1'), { type: 'node', x: 20, y: 400, w: 180, h: 80, text: 'API', shape: 'round', icon: 'api', color: 'blue', z: 4, rev: 1 }]];
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ ...devices['iPhone 13'] }); const page = await ctx.newPage();
  page.on('pageerror', (e) => console.log('ERR', e.message));
  await page.route(/cdn\.jsdelivr|supabase\.co|fonts\.g/, (r) => r.abort());
  await page.addInitScript(`window.__SEED = ${JSON.stringify(rows)};` + MOCK + `localStorage.setItem('jamboard:view:${BID}', JSON.stringify({x:0,y:0,z:1}));`);
  await page.goto(`http://localhost:${srv.address().port}/#b=${BID}`);
  await page.waitForFunction(() => document.querySelectorAll('.item').length >= 3); await page.waitForTimeout(900);
  const cdp = await ctx.newCDPSession(page);
  const T = (type, pts) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: pts.map(([x, y], i) => ({ x, y, id: i })) });
  const tf = () => page.evaluate(() => document.getElementById('world').style.transform);
  const W = (ms) => page.waitForTimeout(ms);
  async function drag(pts1, steps = 12, dt = 16, hold = 0) { await T('touchStart', [pts1[0]]); if (hold) await W(hold); for (let i = 1; i <= steps; i++) { const k = i / steps; await T('touchMove', [[pts1[0][0] + (pts1[1][0] - pts1[0][0]) * k, pts1[0][1] + (pts1[1][1] - pts1[0][1]) * k]]); await W(dt); } await T('touchEnd', []); }
    // 1. one finger on empty canvas pans
  const t0 = await tf(); await drag([[300, 540], [200, 460]]); await W(500);
  const t1 = await tf(); ok(t0 !== t1 && /translate\(-\d/.test(t1), 'one-finger pan: ' + t1);
  ok(await page.evaluate(() => document.querySelectorAll('.item.sel').length === 0), 'pan selects nothing');
  // reset view
  await page.evaluate((b) => { localStorage.setItem('jamboard:view:' + b, '{"x":0,"y":0,"z":1}'); }, BID); await page.reload(); await page.waitForFunction(() => document.querySelectorAll('.item').length >= 3); await W(900);
  // 2. long press then drag draws a selection frame around both stickies
  await drag([[10, 120], [380, 330]], 14, 20, 600); await W(300);
  ok(await page.evaluate(() => document.querySelectorAll('.item.sel').length) === 2, 'long-press frame selects 2');
  ok((await tf()).startsWith('translate(0px, 0px)'), 'frame did not pan');
  await page.screenshot({ path: out + '-sel.png' });
  // 3. tap on empty clears
  await page.touchscreen.tap(300, 560); await W(300);
  ok(await page.evaluate(() => document.querySelectorAll('.item.sel').length) === 0, 'tap on empty deselects');
  // 4. drag a sticky with one finger moves it
  await drag([[100, 220], [140, 260]]); await W(600);
  let s1 = await page.evaluate((p) => window.__mock.rows.get(p), P('s1')); ok(s1.x === 60 && s1.y === 180, 'touch drag moves card (' + s1.x + ',' + s1.y + ')');
  // 5. pinch: start dragging the card, then second finger -> card goes back, board zooms
  await T('touchStart', [[100, 260]]); await T('touchMove', [[110, 270]]); await W(30); await T('touchMove', [[120, 280]]); await W(30);
  await T('touchStart', [[120, 280], [300, 500]]);
  for (let i = 1; i <= 10; i++) { await T('touchMove', [[120 - i * 6, 280 - i * 6], [300 + i * 6, 500 + i * 6]]); await W(16); }
  await T('touchEnd', [[60, 220]]); // one finger lifted: the other pans on
  for (let i = 1; i <= 5; i++) { await T('touchMove', [[60 + i * 4, 220]]); await W(16); }
  await T('touchEnd', []); await W(600);
  s1 = await page.evaluate((p) => window.__mock.rows.get(p), P('s1'));
  const z = await tf(); ok(/scale\(1\.[2-9]/.test(z), 'pinch zoomed: ' + z);
  ok(s1.x === 60 && s1.y === 180, 'card returned when pinch began (' + s1.x + ',' + s1.y + ')');
  ok(await page.evaluate(() => !document.querySelector('.item.dragging')), 'no card left lifted');
  // 6. layout checks
  const over = await page.evaluate(() => [...document.querySelectorAll('.rail, .board-pill, .top-right, .br-dock')].map((e) => { const r = e.getBoundingClientRect(); return [e.className, Math.round(r.left), Math.round(r.right)]; }));
  console.log(JSON.stringify(over));
  ok(over.every(([, l, r]) => l >= 0 && r <= 390), 'chrome stays on screen');
  await page.screenshot({ path: out + '-board.png' });
  // tap a sticky: ports + ctx visible
  await page.touchscreen.tap(400 - 300, 260); await W(400);
  await page.screenshot({ path: out + '-ctx.png' });
  const ctxR = await page.evaluate(() => { const r = document.getElementById('ctx').getBoundingClientRect(); return [r.left, r.right, document.getElementById('ctx').hidden]; });
  ok(!ctxR[2] && ctxR[0] >= 0 && ctxR[1] <= 390, 'context bar on screen ' + ctxR);
  // panels
  for (const [btn, name] of [['#planBtn', 'plan'], ['#boardsBtn', 'gallery'], ['#histBtn', 'hist'], ['#timerPill', 'timer']]) {
    await page.evaluate(() => document.querySelector('.rail').scrollLeft = 1000);
    await page.locator(btn).click(); await W(700); await page.screenshot({ path: `${out}-${name}.png` });
    await page.keyboard.press('Escape'); await page.touchscreen.tap(250, 540); await W(400);
  }
  // 7. port drag links two cards on touch
  await page.evaluate((b) => { localStorage.setItem('jamboard:view:' + b, '{"x":0,"y":0,"z":1}'); }, BID); await page.reload(); await page.waitForFunction(() => document.querySelectorAll('.item').length >= 3); await W(900);
  await page.touchscreen.tap(100, 220); await W(400);
  const port = await page.evaluate(() => { const r = document.querySelector('.item[data-id="s1"] > .port.b').getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2, getComputedStyle(document.querySelector('.item[data-id="s1"] > .port.b')).opacity]; });
  ok(port[2] === '1', 'ports shown on a selected card (touch)');
  await drag([[port[0], port[1] + 6], [110, 440]], 14, 20); await W(500);
  ok(await page.evaluate(() => [...window.__mock.rows.values()].some((r) => r.type === 'link')), 'rope from a port by finger');
  // 8. double tap on empty makes a sticky in edit mode
  await page.touchscreen.tap(300, 520); await W(120); await page.touchscreen.tap(300, 520); await W(500);
  ok(await page.evaluate(() => !!document.querySelector('.item.sticky.editing')), 'double tap makes a sticky to type in');
  await page.keyboard.type('Тач'); await page.touchscreen.tap(330, 120); await W(500);
  // 9. landscape + dark
  await page.setViewportSize({ width: 844, height: 390 }); await W(500); await page.screenshot({ path: out + '-land.png' });
  await page.emulateMedia({ colorScheme: 'dark' }); await page.setViewportSize({ width: 390, height: 664 }); await page.locator('#boardsBtn').click(); await W(700); await page.screenshot({ path: out + '-gallery-dark.png' });
  await browser.close(); srv.close();
})();
