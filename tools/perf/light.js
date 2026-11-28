// Lighting kit check: desk in cm, devices, a power strip counting its sockets, cables with lengths that follow their devices.
// node tools/perf/light.js <site dir> [shots dir]
const { chromium } = require('playwright');
const http = require('http'), fs = require('fs'), path = require('path');
const dir = process.argv[2] || '.', shots = process.argv[3]; const BID = 'LightBoardAAAAAAAAAAAAAA';
const MOCK = fs.readFileSync(path.join(__dirname, 'mock.js'), 'utf8');
const srv = http.createServer((q, s) => { let p = q.url.split('?')[0].split('#')[0]; if (p === '/') p = '/index.html'; const f = path.join(dir, p); if (!fs.existsSync(f)) { s.writeHead(404); return s.end(); } s.writeHead(200, { 'content-type': p.endsWith('.html') ? 'text/html' : p.endsWith('.woff2') ? 'font/woff2' : 'text/javascript' }); s.end(fs.readFileSync(f)); });
const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) process.exitCode = 1; };
(async () => {
  await new Promise((r) => srv.listen(0, r));
  const rows = [['boards/' + BID, { title: 'Світло', at: 1, by: 'x' }]];
  const browser = await chromium.launch();
  for (const theme of ['light', 'dark']) {
    const page = await browser.newPage({ viewport: { width: 1400, height: 860 }, deviceScaleFactor: shots ? 2 : 1, colorScheme: theme });
    const errs = []; page.on('pageerror', (e) => errs.push(e.message));
    await page.route(/cdn\.jsdelivr|supabase\.co|fonts\.g/, (r) => r.abort());
    await page.addInitScript(`window.__SEED = ${JSON.stringify(rows)};localStorage.setItem('jamboard:hints','0');` + MOCK + `localStorage.setItem('jamboard:view:${BID}', JSON.stringify({x:0,y:0,z:1}));`);
    await page.goto(`http://localhost:${srv.address().port}/#b=${BID}`);
    await page.waitForTimeout(1200);
    const docs = () => page.evaluate(() => [...window.__mock.rows].filter(([p]) => p.includes('/items/')).map(([p, d]) => ({ id: p.split('/').pop(), ...d })));
    const pick = async (i) => { await page.keyboard.press('w'); await page.waitForTimeout(150); await page.click(`#palette .nd-btn:nth-of-type(${i + 1})`); await page.waitForTimeout(120); };
    // desk: drag 160 × 80 cm (800 × 400 px at zoom 1)
    await pick(6);
    await page.mouse.move(200, 200); await page.mouse.down(); for (let i = 1; i <= 12; i++) { await page.mouse.move(200 + i * 67, 200 + i * 33.5); await page.waitForTimeout(12); } await page.mouse.move(1002, 603); await page.mouse.up(); await page.waitForTimeout(500);
    let d = await docs(); const desk = d.find((i) => i.type === 'section' && i.desk);
    ok(desk && desk.w % 5 === 0 && desk.h % 5 === 0, 'desk saved in whole cm (' + (desk && desk.w / 5) + ' × ' + (desk && desk.h / 5) + ' cm)');
    ok(await page.evaluate(() => /см/.test(document.querySelector('.section.desk .dk-size').textContent)), 'desk shows its size');
    await page.keyboard.press('Escape');
    // a power strip and three devices on the desk
    await pick(5); await page.mouse.click(820, 470); await page.keyboard.press('Escape'); await page.waitForTimeout(200);
    await pick(0); await page.mouse.click(330, 300); await page.keyboard.press('Escape'); await page.waitForTimeout(200);
    await pick(1); await page.mouse.click(620, 290); await page.keyboard.press('Escape'); await page.waitForTimeout(200);
    await pick(2); await page.mouse.click(420, 470); await page.keyboard.press('Escape'); await page.waitForTimeout(200);
    d = await docs();
    const plug = d.find((i) => i.icon === 'plug'), lamp = d.find((i) => i.icon === 'lamp'), strip = d.find((i) => i.icon === 'strip'), psu = d.find((i) => i.icon === 'psu');
    ok(plug && plug.sock === 6 && lamp && strip && psu, 'devices and a 6-socket strip made');
    // a cable from the lamp along the desk to the strip
    await pick(7);
    const c = (it) => [it.x + it.w / 2, it.y + it.h / 2];
    await page.mouse.click(...c(lamp)); await page.waitForTimeout(80);
    await page.mouse.click(c(lamp)[0], 560); await page.waitForTimeout(80);
    await page.mouse.click(c(plug)[0] - 60, 562); await page.waitForTimeout(80);
    await page.mouse.move(c(plug)[0] - 40, c(plug)[1]); await page.waitForTimeout(80);
    await page.mouse.click(c(plug)[0] - 40, c(plug)[1]); await page.waitForTimeout(400);
    d = await docs(); let cab = d.find((i) => i.type === 'cable');
    ok(cab && cab.a === lamp.id && cab.b === plug.id && cab.pts.length === 4, 'cable plugged from lamp into strip (' + (cab && cab.pts.length) + ' points)');
    ok(cab && cab.pts[1][0] === cab.pts[0][0] && cab.pts[2][1] === cab.pts[1][1], 'near-straight runs snap straight');
    ok(await page.evaluate(() => /\d/.test(document.querySelector('.cable .cb-len').textContent)), 'cable shows its length: ' + await page.evaluate(() => document.querySelector('.cable .cb-len').textContent));
    // a rope from the PSU into the strip counts too
    await page.evaluate(([a, b]) => window.__mock.remote(`boards/LightBoardAAAAAAAAAAAAAA/items/rp1`, { type: 'link', a, b, z: 99, rev: Date.now() + 1000 }), [psu.id, plug.id]);
    await page.waitForTimeout(400);
    const sockTxt = await page.evaluate((id) => document.querySelector(`.item[data-id="${id}"] .nsock b`).textContent, plug.id);
    ok(sockTxt.startsWith('2/6'), 'strip counts what is plugged in: ' + sockTxt);
    // watts on the lamp show on the strip
    await page.evaluate((p) => window.__mock.remote(p, { ...window.__mock.rows.get(p), watt: 12, rev: Date.now() + 2000 }), `boards/${BID}/items/${lamp.id}`); await page.waitForTimeout(400);
    ok((await page.evaluate((id) => document.querySelector(`.item[data-id="${id}"] .nsock b`).textContent, plug.id)).includes('12 Вт'), 'strip sums the watts');
    // drag the lamp: the cable end follows
    await page.keyboard.press('Escape'); await page.keyboard.press('v');
    const l2 = (await docs()).find((i) => i.id === lamp.id);
    await page.mouse.move(c(l2)[0] + 20, c(l2)[1] - 10); await page.mouse.down(); for (let i = 1; i <= 8; i++) { await page.mouse.move(c(l2)[0] + 20 - i * 5, c(l2)[1] - 10 - i * 5); await page.waitForTimeout(16); } await page.mouse.up(); await page.waitForTimeout(500);
    cab = (await docs()).find((i) => i.type === 'cable');
    const end = [cab.x + cab.pts[0][0], cab.y + cab.pts[0][1]], l3 = (await docs()).find((i) => i.id === lamp.id);
    ok(end[0] - c(lamp)[0] === l3.x - lamp.x && end[1] - c(lamp)[1] === l3.y - lamp.y && l3.x !== lamp.x, 'cable end follows the lamp (' + end + ')');
    // select the cable: context bar shows kind, colour, length
    const mid = [cab.x + (cab.pts[1][0] + cab.pts[2][0]) / 2, cab.y + (cab.pts[1][1] + cab.pts[2][1]) / 2];
    await page.mouse.click(...mid); await page.waitForTimeout(300);
    ok(await page.evaluate(() => !document.querySelector('#ctxElec').hidden && /м|см/.test(document.querySelector('#ctxElec').textContent)), 'cable context bar: ' + await page.evaluate(() => document.querySelector('#ctxElec').textContent));
    if (shots) { fs.mkdirSync(shots, { recursive: true }); await page.screenshot({ path: path.join(shots, `cable-${theme}.png`) }); }
    // drag a cable point
    const v = await page.evaluate(() => { const r = document.querySelector('.cable.sel .cv[data-i="2"]').getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2]; });
    await page.mouse.move(...v); await page.mouse.down(); for (let i = 1; i <= 6; i++) { await page.mouse.move(v[0], v[1] - i * 10); await page.waitForTimeout(16); } await page.mouse.up(); await page.waitForTimeout(400);
    const cab2 = (await docs()).find((i) => i.type === 'cable');
    ok(cableLen(cab2) !== cableLen(cab), 'dragging a point changes the length');
    // strip: + socket
    await page.mouse.click(c(plug)[0] + 80, c(plug)[1] - 30); await page.waitForTimeout(300);
    await page.click('#ctxElec button[aria-label="Більше розеток"]'); await page.waitForTimeout(300);
    ok((await docs()).find((i) => i.id === plug.id).sock === 7, 'strip socket count goes up');
    if (shots) await page.screenshot({ path: path.join(shots, `plug-${theme}.png`) });
    // desk size from the context bar
    await page.mouse.click(260, 590); await page.waitForTimeout(300);
    const inp = page.locator('#ctxElec input').first(); await inp.fill('180'); await inp.press('Enter'); await page.waitForTimeout(400);
    ok((await docs()).find((i) => i.desk).w === 900, 'desk width typed in cm');
    if (shots) await page.screenshot({ path: path.join(shots, `desk-${theme}.png`) });
    // undo all the way keeps the page healthy
    for (let i = 0; i < 3; i++) await page.keyboard.press('Control+z');
    await page.waitForTimeout(300);
    ok(!errs.length, theme + ': no page errors ' + errs.join(' | '));
    await page.close();
  }
  await browser.close(); srv.close();
})();
function cableLen(c) { let s = 0; for (let k = 1; k < c.pts.length; k++) s += Math.hypot(c.pts[k][0] - c.pts[k - 1][0], c.pts[k][1] - c.pts[k - 1][1]); return s; }
