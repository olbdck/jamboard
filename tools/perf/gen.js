// a big board: sections, stickies, text, nodes with wires, ropes between stickies
module.exports = function gen(bid, { stickies = 1500, nodes = 150, wires = 200, ropes = 150, texts = 150, sections = 20 } = {}) {
  const out = []; let n = 0; const id = () => 'i' + (n++).toString(36).padStart(6, '0');
  const P = (x) => 'boards/' + bid + '/items/' + x;
  const COL = ['caution', 'pink', 'green', 'blue', 'orange', 'purple'];
  let rng = 1; const R = () => (rng = (rng * 16807) % 2147483647) / 2147483647;
  out.push(['boards/' + bid, { title: 'Bench', at: 1, by: 'b' }]);
  for (let s = 0; s < sections; s++) out.push([P(id()), { type: 'section', x: (s % 5) * 2400, y: Math.floor(s / 5) * 2000, w: 2200, h: 1800, title: 'Секція ' + s, color: 'gray', z: s, rev: 1 }]);
  const st = [];
  for (let i = 0; i < stickies; i++) { const k = id(); st.push(k); out.push([P(k), { type: 'sticky', x: (i % 60) * 200, y: Math.floor(i / 60) * 220, w: 180, h: 180, text: 'Ідея номер ' + i + ' трохи тексту', color: COL[i % 6], by: 'Олег', z: 100 + i, rev: 1 }]); }
  for (let i = 0; i < texts; i++) out.push([P(id()), { type: 'text', x: (i % 30) * 400, y: 6000 + Math.floor(i / 30) * 120, w: 300, h: 40, text: 'Заголовок ' + i, ts: 'h2', z: 3000 + i, rev: 1 }]);
  const nd = [];
  for (let i = 0; i < nodes; i++) { const k = id(); nd.push(k); out.push([P(k), { type: 'node', x: (i % 15) * 320, y: 7000 + Math.floor(i / 15) * 220, w: 180, h: 80, text: 'Сервіс ' + i, shape: ['rect', 'round', 'pill', 'cyl'][i % 4], icon: 'service', color: 'blue', z: 4000 + i, rev: 1 }]); }
  for (let i = 0; i < wires; i++) { const a = nd[i % nd.length], b = nd[(i * 7 + 1 + Math.floor(R() * 3)) % nd.length]; if (a !== b) out.push([P(id()), { type: 'link', a, b, z: 5000 + i, rev: 1 }]); }
  for (let i = 0; i < ropes; i++) out.push([P(id()), { type: 'link', a: st[i * 3], b: st[i * 3 + 1], z: 6000 + i, rev: 1 }]);
  return { rows: out, st, nd };
};
