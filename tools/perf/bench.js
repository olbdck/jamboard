// usage: node bench.js <siteDir> <label> [scale]
const { chromium } = require('playwright');
const http = require('http'), fs = require('fs'), path = require('path');
const gen = require('./gen.js');
const dir = process.argv[2], label = process.argv[3] || 'run', scale = +(process.argv[4] || 1);
const BID = 'BenchBoardAAAAAAAAAAAAAA';
const MOCK = fs.readFileSync(path.join(__dirname, 'mock.js'), 'utf8');
const srv = http.createServer((q, s) => {
  let p = decodeURIComponent(q.url.split('?')[0].split('#')[0]); if (p === '/') p = '/index.html';
  const f = path.join(dir, p); if (!fs.existsSync(f)) { s.writeHead(404); return s.end(); }
  s.writeHead(200, { 'content-type': p.endsWith('.html') ? 'text/html' : p.endsWith('.js') ? 'text/javascript' : 'application/octet-stream' }); s.end(fs.readFileSync(f));
});
(async () => {
  await new Promise((r) => srv.listen(0, r)); const port = srv.address().port;
  const G = gen(BID, { stickies: 1500 * scale, nodes: 150 * scale, wires: 200 * scale, ropes: 150 * scale, texts: 150 * scale, sections: 20 });
  const browser = await chromium.launch({ args: ['--enable-precise-memory-info', '--js-flags=--expose-gc'] });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.on('pageerror', (e) => console.error('PAGEERR', e.message));
  await page.route(/cdn\.jsdelivr|supabase\.co|fonts\.g/, (r) => r.abort());
  await page.addInitScript(`window.__SEED = ${JSON.stringify(G.rows)};` + MOCK + `
    window.__frames = []; (function loop(t){ window.__frames.push(t); requestAnimationFrame(loop); })(performance.now());`);
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Performance.enable');
  const metrics = async () => Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map((m) => [m.name, m.value]));
  const res = {};
  async function measure(name, fn) {
    await page.evaluate(() => { window.__frames = [performance.now()]; });
    const a = await metrics(); const t0 = Date.now();
    await fn();
    const b = await metrics(); const wall = (Date.now() - t0) / 1000;
    const fr = await page.evaluate(() => window.__frames);
    const d = []; for (let i = 1; i < fr.length; i++) d.push(fr[i] - fr[i - 1]); d.sort((x, y) => x - y);
    const q = (p) => d.length ? +d[Math.min(d.length - 1, Math.floor(d.length * p))].toFixed(1) : 0;
    const r = {
      cpuPerSec_ms: +(((b.TaskDuration - a.TaskDuration) * 1000) / wall).toFixed(1),
      script_ms: +((b.ScriptDuration - a.ScriptDuration) * 1000).toFixed(0),
      layout_ms: +((b.LayoutDuration - a.LayoutDuration) * 1000).toFixed(0),
      style_ms: +((b.RecalcStyleDuration - a.RecalcStyleDuration) * 1000).toFixed(0),
      layouts: b.LayoutCount - a.LayoutCount, frames: d.length, p50: q(0.5), p95: q(0.95), max: q(1), janky: d.filter((x) => x > 25).length,
    };
    res[name] = r; console.log(label, name, JSON.stringify(r));
  }
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: +(process.env.THR || 1) });
  const t0 = Date.now();
  await page.goto(`http://localhost:${port}/#b=${BID}`);
  await page.waitForFunction((n) => document.querySelectorAll('.item').length >= n, G.rows.length - 1 - 350 * scale, { timeout: 120000 });
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  res.load_s = (Date.now() - t0) / 1000; console.log(label, 'load_s', res.load_s);
  await page.waitForTimeout(1500);
  await page.keyboard.press('Escape');
  // whole board in view
  await page.mouse.move(5, 450);
  await page.keyboard.press('Shift+Digit1'); await page.waitForTimeout(900);
  await measure('idle_fitAll_3s', () => page.waitForTimeout(3000));
  await measure('pan_fitAll', async () => { for (let i = 0; i < 90; i++) { await page.mouse.wheel(i < 45 ? 6 : -6, 3); await page.waitForTimeout(16); } });
  // zoom into the diagram part
  await page.evaluate(() => { const v = { x: 100, y: -7000 + 100, z: 1 }; for (const k of Object.keys(localStorage)) if (k.includes('view')) localStorage.setItem(k, JSON.stringify(v)); });
  await page.reload();
  await page.waitForFunction((n) => document.querySelectorAll('.item').length >= n, G.rows.length - 1 - 350 * scale, { timeout: 120000 });
  await page.waitForTimeout(2000);
  await page.mouse.move(5, 450);
  await measure('idle_zoom1_3s', () => page.waitForTimeout(3000));
  await measure('pan_zoom1', async () => { for (let i = 0; i < 90; i++) { await page.mouse.wheel(i < 45 ? 12 : -12, 6); await page.waitForTimeout(16); } });
  await measure('zoom_pinch', async () => { await page.mouse.move(700, 450); await page.keyboard.down('Control'); for (let i = 0; i < 40; i++) { await page.mouse.wheel(0, i < 20 ? 12 : -12); await page.waitForTimeout(16); } await page.keyboard.up('Control'); });
  // remote edits from someone else: 30 sticky text changes
  await measure('remote_edits_x30', async () => {
    for (let i = 0; i < 30; i++) {
      await page.evaluate(([bid, k, i]) => { const p = 'boards/' + bid + '/items/' + k; const d = { ...window.__mock.rows.get(p), text: 'змінено ' + i, rev: Date.now() + i }; window.__mock.remote(p, d); }, [BID, G.st[i * 11], i]);
      await page.waitForTimeout(50);
    }
  });
  // a peer drags 6 diagram blocks around for 2 s (presence at ~30 Hz)
  await measure('peer_drag_2s', async () => {
    for (let i = 0; i < 60; i++) {
      await page.evaluate(([bid, ids, i]) => window.__mock.peer(bid, { peer: 'pX', s: { name: 'Кіт', emoji: '🐱', color: '#2f7de1', board: bid, drag: { ids, dx: Math.sin(i / 8) * 200, dy: i * 3 }, cur: { x: 300 + i * 4, y: 7200 } } }), [BID, G.nd.slice(0, 6), i]);
      await page.waitForTimeout(33);
    }
  });
  // drag one block myself
  const box = await page.evaluate((id) => { const r = document.querySelector(`.item[data-id="${id}"]`).getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; }, G.nd[16]);
  await measure('local_drag', async () => {
    await page.mouse.move(box.x, box.y); await page.mouse.down();
    for (let i = 0; i < 60; i++) { await page.mouse.move(box.x + i * 4, box.y + Math.sin(i / 6) * 60); await page.waitForTimeout(16); }
    await page.mouse.up(); await page.waitForTimeout(300);
  });
  await page.evaluate(() => window.gc && window.gc());
  const m = await metrics();
  res.heapMB = +(m.JSHeapUsedSize / 1048576).toFixed(1); res.nodes = m.Nodes; res.layers = m.LayoutObjects;
  console.log(label, 'heapMB', res.heapMB, 'domNodes', res.nodes);
  fs.writeFileSync(path.join(__dirname, `res-${label}.json`), JSON.stringify(res, null, 1));
  await browser.close(); srv.close();
})().catch((e) => { console.error(e); process.exit(1); });
