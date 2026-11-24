// JamBoard MCP server: lets Claude read and edit boards.
// Runs as a Supabase Edge Function (Deno), speaks MCP over Streamable HTTP (stateless JSON responses).
// Connector URL: https://<project>.supabase.co/functions/v1/jamboard-mcp?key=<JAMBOARD_MCP_KEY>
// Needs: function secret JAMBOARD_MCP_KEY, and "Verify JWT" turned off for this function.
// Plain JS syntax on purpose (no type annotations), so the same file also runs under Node for tests.

const env = (k) => (globalThis.Deno ? Deno.env.get(k) : globalThis.process?.env?.[k]) || '';
const DB_URL = env('SUPABASE_URL');
const DB_KEY = env('JAMBOARD_DB_KEY') || env('SUPABASE_SERVICE_ROLE_KEY') || env('SUPABASE_ANON_KEY');
const MCP_KEY = env('JAMBOARD_MCP_KEY');
const BY = 'Claude';

const STICKY_COLORS = ['caution', 'warn', 'pink', 'purple', 'info', 'ok', 'teal', 'gray'];
const COLOR_ALIASES = { yellow: 'caution', orange: 'warn', pink: 'pink', purple: 'purple', lilac: 'purple', blue: 'info', green: 'ok', teal: 'teal', gray: 'gray', grey: 'gray', white: 'gray' };
const ROPE_COLORS = ['gray', 'pink', 'green', 'blue', 'orange', 'purple'];
const TEXT_STYLES = ['h1', 'h2', 'p', 's'];
const YT_RE = /(?:youtube\.com\/(?:watch\?(?:.*&)?v=|shorts\/|embed\/|live\/)|youtu\.be\/)([\w-]{11})/;

// ---------- tiny document store client (the same `docs` table the board uses) ----------
function headers(extra) {
  const h = { apikey: DB_KEY, 'Content-Type': 'application/json', ...extra };
  if (DB_KEY.startsWith('eyJ')) h.Authorization = 'Bearer ' + DB_KEY; // legacy JWT keys also go in Authorization
  return h;
}
async function rest(path, init) {
  const r = await fetch(DB_URL + '/rest/v1/' + path, { ...init, headers: headers(init && init.headers) });
  if (!r.ok) throw new Error(`database ${r.status}: ${(await r.text()).slice(0, 300)}`);
  const t = await r.text();
  return t ? JSON.parse(t) : null;
}
const enc = encodeURIComponent;
const listColl = (coll) => rest(`docs?select=path,data&coll=eq.${enc(coll)}`);
const getDoc = async (path) => { const rows = await rest(`docs?select=path,data&path=eq.${enc(path)}`); return rows && rows[0] ? rows[0].data : null; };
const putDocs = (rows) => rows.length ? rest('docs?on_conflict=path', { method: 'POST', headers: { Prefer: 'resolution=merge-duplicates,return=minimal' }, body: JSON.stringify(rows.map((r) => ({ path: r.path, coll: r.path.slice(0, r.path.lastIndexOf('/')), data: r.data }))) }) : null;
const delDocs = (paths) => paths.length ? rest(`docs?path=in.(${paths.map((p) => '"' + p.replace(/"/g, '') + '"').join(',')})`, { method: 'DELETE' }) : null;

const validBoard = (b) => typeof b === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(b);
const itemsColl = (b) => (b === 'main' ? 'items' : `boards/${b}/items`);
const timerPath = (b) => (b === 'main' ? 'board/timer' : `boards/${b}/timer/state`);
const uid = () => Date.now().toString(36).slice(-6) + Math.random().toString(36).slice(2, 10);
let lastRev = 0;
const rev = () => (lastRev = Math.max(Date.now(), lastRev + 1));

async function loadItems(board) {
  const rows = (await listColl(itemsColl(board))) || [];
  return rows.map((r) => ({ ...r.data, id: r.path.slice(r.path.lastIndexOf('/') + 1) }));
}
const strip = (it) => { const o = { ...it }; delete o.id; return o; };
const save = (board, list) => putDocs(list.map((it) => ({ path: itemsColl(board) + '/' + it.id, data: { ...strip(it), rev: rev() } })));

// <flow> shared by index.html and the MCP server: keep both copies identical
const Flow = (() => {
  const SHAPES = ['rect', 'round', 'pill', 'circle', 'diamond', 'cyl', 'hex'];
  const ICONS = ['service', 'db', 'cache', 'queue', 'api', 'user', 'web', 'mobile', 'cloud', 'storage', 'fn', 'lock', 'mail', 'none'];
  // default tint per icon, from the sticky palette
  const ICON_COLOR = { service: 'ok', db: 'info', cache: 'warn', queue: 'purple', api: 'teal', user: 'pink', web: 'info', mobile: 'pink', cloud: 'gray', storage: 'ok', fn: 'caution', lock: 'warn', mail: 'pink', none: 'gray' };
  const GUESS = [
    ['db', /\b(db|database|postgres\w*|mysql|maria\w*|sqlite|mongo\w*|dynamo\w*|clickhouse|firestore|supabase|warehouse)\b|баз[аиіу] даних|\bбд\b/i],
    ['cache', /\b(redis|cache|memcached?|valkey)\b|кеш/i],
    ['queue', /\b(queue|kafka|rabbit\w*|sqs|sns|nats|pub\/?sub|event ?bus|broker)\b|черг/i],
    ['lock', /\b(auth\w*|login|oauth|sso|jwt|keycloak|identity)\b|авториз|вхід/i],
    ['user', /\b(users?|clients?|customers?|actors?|admins?|people)\b|користувач|клієнт|адмін|людин/i],
    ['api', /\b(api|gateway|graphql|grpc|proxy|nginx|load ?balancer|ingress|router)\b|шлюз/i],
    ['web', /\b(web|frontend|front-end|browser|spa|website|site|react|next\.?js|vue)\b|сайт|фронт|браузер|веб/i],
    ['mobile', /\b(mobile|ios|android)\b|мобіл|застосун/i],
    ['storage', /\b(s3|buckets?|storage|files?|cdn|blob|uploads?)\b|сховищ|файл/i],
    ['fn', /\b(lambda|functions?|workers?|cron|jobs?|scheduler|edge)\b|функці|воркер|задач/i],
    ['mail', /\b(e-?mail|smtp|notifications?|sms|push)\b|пошт|сповіщ|лист/i],
    ['cloud', /\b(cloud|aws|gcp|azure|vercel|heroku|kubernetes|k8s)\b|хмар/i],
    ['service', /\b(service|server|backend|back-end|microservice|app|svc)\b|сервіс|сервер|бекенд/i],
  ];
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  function guessIcon(text, shape) {
    if (shape === 'cyl') return /\b(redis|cache|memcached?|valkey)\b|кеш/i.test(text || '') ? 'cache' : 'db';
    if (shape === 'diamond') return 'none';
    for (const [icon, re] of GUESS) if (re.test(text || '')) return icon;
    return 'none';
  }
  const SHAPE_ALIAS = { rect: 'rect', rectangle: 'rect', process: 'rect', proc: 'rect', square: 'rect', rounded: 'round', round: 'round', event: 'round',
    stadium: 'pill', pill: 'pill', terminal: 'pill', circle: 'circle', circ: 'circle', 'sm-circ': 'circle', 'dbl-circ': 'circle', diamond: 'diamond', diam: 'diamond', decision: 'diamond', question: 'diamond',
    cyl: 'cyl', cylinder: 'cyl', db: 'cyl', database: 'cyl', 'h-cyl': 'cyl', 'lin-cyl': 'cyl', hex: 'hex', hexagon: 'hex', prepare: 'hex' };
  function cleanText(t) {
    return String(t || '').replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]*>/g, '').replace(/#quot;/g, '"').replace(/#amp;/g, '&').replace(/#lt;/g, '<').replace(/#gt;/g, '>')
      .replace(/\*\*|__|`/g, '').replace(/\\n/g, '\n').split('\n').map((l) => l.trim()).join('\n').trim().slice(0, 200);
  }
  // split a line on `;` that are outside brackets and quotes
  function splitStatements(line) {
    const out = []; let depth = 0, q = false, cur = '';
    for (const ch of line) {
      if (ch === '"') q = !q;
      else if (!q && '[({'.includes(ch)) depth++;
      else if (!q && '])}'.includes(ch)) depth = Math.max(0, depth - 1);
      if (ch === ';' && !q && !depth) { out.push(cur); cur = ''; } else cur += ch;
    }
    out.push(cur); return out;
  }
  const OPENERS = [['(((', ')))', 'circle'], ['([', '])', 'pill'], ['[(', ')]', 'cyl'], ['((', '))', 'circle'], ['[[', ']]', 'rect'], ['{{', '}}', 'hex'], ['[/', ['/]', '\\]'], 'rect'], ['[\\', ['\\]', '/]'], 'rect'], ['>', ']', 'rect'], ['[', ']', 'rect'], ['(', ')', 'round'], ['{', '}', 'diamond']];
  const ID_RE = /^[A-Za-z0-9_À-ɏЀ-ӿ]+/;
  const INLINE_EDGE = /^(<)?(--|==|-\.)(?![-=.>])\s*(.*?)\s*(-{2,}|={2,}|\.-+)(>|o|x)?(?=[\s\w"Ѐ-ӿ]|$)/;
  const EDGE = /^(<)?(-{2,}|={2,}|-\.+-|~{3,})(>|o(?![\wЀ-ӿ])|x(?![\wЀ-ӿ]))?/;

  function parse(src) {
    src = String(src || '').replace(/\r/g, '').trim();
    src = src.replace(/^```\s*mermaid[^\n]*\n?/i, '').replace(/^```[^\n]*\n?/, '').replace(/\n?```\s*$/, '');
    src = src.replace(/^\s*---\n[\s\S]*?\n---\s*\n/, '');
    const lines = [];
    for (const raw of src.split('\n')) for (const s of splitStatements(raw.replace(/%%.*$/, ''))) { const t = s.trim(); if (t) lines.push(t); }
    if (!lines.length) throw new Error('Порожній текст');
    const head = /^(graph|flowchart)\b\s*(TB|TD|BT|LR|RL)?\s*(.*)$/i.exec(lines[0]);
    if (!head) throw new Error('Підтримуються лише схеми flowchart / graph');
    const dir = (head[2] || 'TD').toUpperCase().replace('TB', 'TD');
    if (head[3]) lines[0] = head[3]; else lines.shift();
    const nodes = new Map(), edges = [], subs = [], stack = [];
    const touch = (id) => {
      let n = nodes.get(id);
      if (!n) { n = { id, text: id, shape: 'rect', icon: null, sub: null, order: nodes.size }; nodes.set(id, n); }
      if (stack.length && n.sub == null) { n.sub = stack[stack.length - 1].id; }
      return n;
    };
    for (const line of lines) {
      let m;
      if ((m = /^subgraph\s+(.+)$/i.exec(line))) {
        let rest = m[1].trim(), id, title;
        const mm = /^([A-Za-z0-9_Ѐ-ӿ-]+)\s*\[\s*"?(.*?)"?\s*\]$/.exec(rest);
        if (mm) { id = mm[1]; title = mm[2]; } else if (/^".*"$/.test(rest)) { title = rest.slice(1, -1); id = 'sub' + subs.length; } else if (/\s/.test(rest)) { title = rest; id = 'sub' + subs.length; } else { id = rest; title = rest; }
        const sg = { id: 'sg:' + id, key: id, title: cleanText(title).replace(/\n/g, ' ') || id, parent: stack.length ? stack[stack.length - 1].id : null };
        subs.push(sg); stack.push(sg); continue;
      }
      if (/^end$/i.test(line)) { stack.pop(); continue; }
      if (/^(classDef|class|style|linkStyle|click|direction|accTitle|accDescr|title)\b/i.test(line)) continue;
      parseChain(line);
    }
    function parseChain(s) {
      let i = 0;
      const ws = () => { while (i < s.length && /\s/.test(s[i])) i++; };
      const nodeRef = () => {
        ws();
        const m = ID_RE.exec(s.slice(i)); if (!m) return null;
        const id = m[0]; i += id.length;
        const sg = subs.find((g) => g.key === id);
        let text = null, shape = null, icon = null;
        for (const [open, close, sh] of OPENERS) {
          if (!s.startsWith(open, i)) continue;
          if (open === '[' && s.startsWith('[(', i)) continue;
          let j = i + open.length, body;
          const closes = Array.isArray(close) ? close : [close];
          if (s[j] === '"') { const k = s.indexOf('"', j + 1); if (k < 0) break; body = s.slice(j + 1, k); j = k + 1; let e = -1, cl = ''; for (const c of closes) { const p = s.indexOf(c, j); if (p >= 0 && (e < 0 || p < e)) { e = p; cl = c; } } if (e < 0) break; j = e + cl.length; }
          else { let e = -1, cl = ''; for (const c of closes) { const p = s.indexOf(c, j); if (p >= 0 && (e < 0 || p < e)) { e = p; cl = c; } } if (e < 0) break; body = s.slice(j, e); j = e + cl.length; }
          text = body; shape = sh; i = j; break;
        }
        if (s.startsWith('@{', i)) { // newer syntax: A@{ shape: cyl, label: "Orders", icon: db }
          const e = s.indexOf('}', i); const body = e < 0 ? '' : s.slice(i + 2, e); i = e < 0 ? s.length : e + 1;
          for (const part of body.split(/,(?=(?:[^"]*"[^"]*")*[^"]*$)/)) {
            const kv = /^\s*(\w+)\s*:\s*"?(.*?)"?\s*$/.exec(part); if (!kv) continue;
            const k = kv[1].toLowerCase(), v = kv[2];
            if (k === 'shape' && SHAPE_ALIAS[v.toLowerCase()]) shape = SHAPE_ALIAS[v.toLowerCase()];
            else if (k === 'label') text = v;
            else if (k === 'icon') { const ic = v.toLowerCase().replace(/^.*:/, ''); icon = ICONS.includes(ic) ? ic : guessIcon(ic) !== 'none' ? guessIcon(ic) : null; }
          }
        }
        if (s.startsWith(':::', i)) { const m2 = /^:::[\w-]+/.exec(s.slice(i)); if (m2) i += m2[0].length; }
        if (sg && text == null) return { group: sg };
        const n = touch(id);
        if (text != null) n.text = cleanText(text) || id;
        if (shape) n.shape = shape;
        if (icon) n.icon = icon;
        return n;
      };
      const group = () => { const g = []; for (;;) { const n = nodeRef(); if (!n) return g.length ? g : null; g.push(n); ws(); if (s[i] === '&') { i++; continue; } return g; } };
      const edge = () => {
        ws(); const rest = s.slice(i);
        let m = INLINE_EDGE.exec(rest), e = null;
        if (m && m[3] && !/^[-=.]/.test(m[3])) { e = { label: m[3], op: m[2] + m[4], head: m[5], back: m[1] }; i += m[0].length; }
        else if ((m = EDGE.exec(rest))) { e = { label: '', op: m[2], head: m[3], back: m[1] }; i += m[0].length; }
        if (!e) return null;
        ws(); const lm = /^\|([^|]*)\|/.exec(s.slice(i)); if (lm) { e.label = lm[1]; i += lm[0].length; }
        e.label = cleanText(e.label).replace(/\n/g, ' ').slice(0, 60);
        return e;
      };
      let left = group(); if (!left) return;
      for (;;) {
        const e = edge(); if (!e) return;
        const right = group(); if (!right) return;
        if (!/^~/.test(e.op)) {
          const flat = (g) => g.flatMap((n) => (n.group ? [...nodes.values()].filter((x) => x.sub === n.group.id).slice(0, 1) : [n]));
          for (const a of flat(left)) for (const b of flat(right)) if (a !== b) edges.push({ a: a.id, b: b.id, label: e.label, arrow: !!e.head && !e.back, dash: e.op.includes('.'), thick: e.op[0] === '=' });
        }
        left = right;
      }
    }
    for (const n of nodes.values()) { if (!n.icon) n.icon = guessIcon(n.text, n.shape); }
    // a nested subgraph only keeps the nodes declared directly in it; empty ones are dropped
    const used = new Set([...nodes.values()].map((n) => n.sub).filter(Boolean));
    return { dir, nodes: [...nodes.values()], edges, subs: subs.filter((g) => used.has(g.id)) };
  }

  function sizeOf(n) {
    const icon = n.icon && n.icon !== 'none', lines = n.text.split('\n');
    const L = Math.max(1, ...lines.map((l) => l.length));
    const wrapLines = (w, pad) => lines.reduce((s, l) => s + Math.max(1, Math.ceil((l.length * 8.4) / Math.max(40, w - pad))), 0);
    if (n.shape === 'circle') { const d = clamp(L * 8 + 56, 104, 180); return [d, d]; }
    if (n.shape === 'diamond') { const w = clamp(L * 9.5 + 96, 170, 320); return [w, clamp(wrapLines(w, w * 0.5) * 20 + 84, 110, 190)]; }
    if (n.shape === 'cyl') { const w = clamp(L * 8.4 + (icon ? 64 : 44), 140, 280); return [w, clamp(wrapLines(w, icon ? 64 : 44) * 20 + 86, 112, 200)]; }
    const inner = L * 8.8 + (icon ? 44 : 0), pad = n.shape === 'pill' ? 60 : n.shape === 'round' ? 40 : 34;
    let w = n.shape === 'hex' ? (inner + 14) / 0.64 : inner + pad;
    w = clamp(w, 140, 320);
    const room = n.shape === 'hex' ? w * 0.64 - 14 : w - pad;
    return [Math.round(w), clamp(Math.ceil((L * 8.8) / Math.max(40, room - (icon ? 44 : 0))) * 20 + 52 + (lines.length - 1) * 20, 72, 200)];
  }

  // Layered layout of boxes: rank by longest path (cycles broken), order each layer by barycentre,
  // then pull boxes towards their neighbours. Returns centres.
  function layered(units, edges, dir) {
    const H = dir === 'LR' || dir === 'RL';
    const U = new Map(units.map((u) => [u.key, u]));
    // neighbour lists hold { k, o }: o is where on that neighbour the edge attaches, across the layer (subgraph boxes)
    const out = new Map(), inn = new Map(), nb = new Map(); U.forEach((_, k) => { out.set(k, []); inn.set(k, []); nb.set(k, []); });
    const state = new Map(), dag = new Set();
    const visit = (k) => { state.set(k, 1); for (const e of edges) if (e.a === k && e.a !== e.b) { const s = state.get(e.b); if (s === 1) continue; dag.add(e.a + '\n' + e.b); if (!s) visit(e.b); } state.set(k, 2); };
    const hasIn = new Set(edges.filter((e) => e.a !== e.b).map((e) => e.b));
    for (const k of U.keys()) if (!hasIn.has(k) && !state.get(k)) visit(k); // start from sources, so cycles break at their far end
    for (const k of U.keys()) if (!state.get(k)) visit(k);
    const ks = (l) => [...new Set(l.map((x) => x.k))];
    for (const e of edges) if (dag.has(e.a + '\n' + e.b)) { out.get(e.a).push({ k: e.b, o: e.bo || 0, s: e.ao || 0 }); inn.get(e.b).push({ k: e.a, o: e.ao || 0, s: e.bo || 0 }); }
    const order = [...U.keys()], rank = new Map();
    const indeg = new Map(order.map((k) => [k, ks(inn.get(k)).length])), q = order.filter((k) => !indeg.get(k));
    q.forEach((k) => rank.set(k, 0));
    while (q.length) { const k = q.shift(); for (const b of ks(out.get(k))) { rank.set(b, Math.max(rank.get(b) || 0, rank.get(k) + 1)); indeg.set(b, indeg.get(b) - 1); if (!indeg.get(b)) q.push(b); } }
    for (const k of order) if (!inn.get(k).length && out.get(k).length) rank.set(k, Math.max(0, Math.min(...out.get(k).map((b) => rank.get(b.k))) - 1));
    const R = Math.max(0, ...rank.values()) + 1;
    const layers = Array.from({ length: R }, () => []);
    order.forEach((k) => layers[rank.get(k)].push(k));
    const pos = new Map(); layers.forEach((L) => L.forEach((k, i) => pos.set(k, i)));
    const sortLayer = (L, nb) => {
      const bary = new Map(L.map((k) => { const ns = nb(k); return [k, ns.length ? ns.reduce((s, x) => s + pos.get(x.k), 0) / ns.length : pos.get(k)]; }));
      L.sort((a, b) => bary.get(a) - bary.get(b)); L.forEach((k, i) => pos.set(k, i));
    };
    for (let it = 0; it < 6; it++) {
      if (it % 2 === 0) for (let r = 1; r < R; r++) sortLayer(layers[r], (k) => inn.get(k));
      else for (let r = R - 2; r >= 0; r--) sortLayer(layers[r], (k) => out.get(k));
    }
    const cs = (k) => (H ? U.get(k).h : U.get(k).w), ms = (k) => (H ? U.get(k).w : U.get(k).h);
    const GAP = H ? 48 : 64, LGAP = H ? 130 : 120;
    const cross = new Map();
    layers.forEach((L) => { let x = 0; L.forEach((k, i) => { if (i) x += cs(L[i - 1]) / 2 + GAP + cs(k) / 2; cross.set(k, x); }); L.forEach((k) => cross.set(k, cross.get(k) - x / 2)); });
    const place = (L, want) => { // keep order and gaps, get as close as possible to the wanted centres
      const x = L.map((k) => want(k));
      for (let i = 1; i < L.length; i++) x[i] = Math.max(x[i], x[i - 1] + cs(L[i - 1]) / 2 + GAP + cs(L[i]) / 2);
      for (let i = L.length - 2; i >= 0; i--) x[i] = Math.min(x[i], x[i + 1] - cs(L[i + 1]) / 2 - GAP - cs(L[i]) / 2);
      const shift = L.reduce((s, k, i) => s + (want(k) - x[i]), 0) / Math.max(1, L.length);
      L.forEach((k, i) => cross.set(k, x[i] + shift));
    };
    // wanted centre: line up with where the edges attach on the neighbours (minus where they attach on this box)
    const avg = (l, d) => (l.length ? l.reduce((s, x) => s + cross.get(x.k) + x.o - x.s, 0) / l.length : d);
    const both = (k) => avg(inn.get(k).concat(out.get(k)), cross.get(k));
    for (let it = 0; it < 12; it++) {
      if (it >= 6 && it % 2 === 0) for (let r = 0; r < R; r++) { // re-order by real positions, which sees which box inside a subgraph an edge leaves from
        const L = layers[r], key = new Map(L.map((k) => [k, both(k)])); L.sort((a, b) => key.get(a) - key.get(b)); L.forEach((k, i) => pos.set(k, i));
      }
      if (it % 2 === 0) for (let r = 1; r < R; r++) place(layers[r], (k) => avg(inn.get(k), cross.get(k)));
      else for (let r = R - 2; r >= 0; r--) place(layers[r], (k) => avg(out.get(k), cross.get(k)));
    }
    const main = []; let m = 0;
    for (let r = 0; r < R; r++) { const t = Math.max(...layers[r].map(ms)); main.push(m + t / 2); m += t + LGAP; }
    const flip = dir === 'BT' || dir === 'RL', total = m - LGAP;
    const res = new Map();
    U.forEach((u, k) => { let mm = main[rank.get(k)]; if (flip) mm = total - mm; res.set(k, H ? { x: mm, y: cross.get(k) } : { x: cross.get(k), y: mm }); });
    return res;
  }
  // Subgraphs are laid out on their own first, then placed as one big box, so their sections never overlap.
  // Nested subgraphs fold into their outermost one.
  function layout(g, hint) {
    const PAD = 40, TITLE = 40;
    const top = new Map(g.subs.map((s) => [s.id, s])), root = (id) => { let s = top.get(id); while (s && s.parent && top.get(s.parent)) s = top.get(s.parent); return s ? s.id : null; };
    const N = g.nodes.map((n) => { const [w, h] = sizeOf(n); return { ...n, sub: n.sub ? root(n.sub) : null, w, h }; });
    const byId = new Map(N.map((n) => [n.id, n]));
    const unitOf = (n) => n.sub || n.id;
    const boxes = [], inner = new Map();
    const subIds = [...new Set(N.map((n) => n.sub).filter(Boolean))];
    for (const sid of subIds) {
      const ms = N.filter((n) => n.sub === sid), keys = new Set(ms.map((n) => n.id));
      if (hint) ms.sort((p, q) => hint.get(p.id) - hint.get(q.id));
      const c = layered(ms.map((n) => ({ key: n.id, w: n.w, h: n.h })), g.edges.filter((e) => keys.has(e.a) && keys.has(e.b)), g.dir);
      const x1 = Math.min(...ms.map((n) => c.get(n.id).x - n.w / 2)), y1 = Math.min(...ms.map((n) => c.get(n.id).y - n.h / 2));
      const x2 = Math.max(...ms.map((n) => c.get(n.id).x + n.w / 2)), y2 = Math.max(...ms.map((n) => c.get(n.id).y + n.h / 2));
      inner.set(sid, { c, x1, y1 });
      boxes.push({ key: sid, w: x2 - x1 + PAD * 2, h: y2 - y1 + PAD * 2 + TITLE, order: Math.min(...ms.map((n) => n.order)) });
    }
    N.filter((n) => !n.sub).forEach((n) => boxes.push({ key: n.id, w: n.w, h: n.h, order: n.order }));
    boxes.sort((p, q) => p.order - q.order); // keep the order things appear in the text
    const B = new Map(boxes.map((b) => [b.key, b])), H = g.dir === 'LR' || g.dir === 'RL';
    const off = (n) => { // where a node sits across the layer, relative to its subgraph box centre
      if (!n.sub) return 0;
      const inn = inner.get(n.sub), q = inn.c.get(n.id), b = B.get(n.sub);
      return H ? TITLE + PAD + q.y - inn.y1 - b.h / 2 : PAD + q.x - inn.x1 - b.w / 2;
    };
    const E = [];
    for (const e of g.edges) { const na = byId.get(e.a), nb = byId.get(e.b), a = unitOf(na), b = unitOf(nb); if (a !== b) E.push({ a, b, ao: off(na), bo: off(nb) }); }
    const C = layered(boxes, E, g.dir);
    for (const n of N) {
      if (!n.sub) { const p = C.get(n.id); n.x = p.x - n.w / 2; n.y = p.y - n.h / 2; continue; }
      const p = C.get(n.sub), b = B.get(n.sub), inn = inner.get(n.sub), q = inn.c.get(n.id);
      n.x = p.x - b.w / 2 + PAD + (q.x - n.w / 2 - inn.x1); n.y = p.y - b.h / 2 + TITLE + PAD + (q.y - n.h / 2 - inn.y1);
    }
    if (!hint && subIds.length) { // second pass: order each subgraph's boxes by where their outside neighbours ended up
      const at = new Map(N.map((n) => [n.id, H ? n.y + n.h / 2 : n.x + n.w / 2])), h2 = new Map();
      for (const n of N) {
        const ext = g.edges.filter((e) => (e.a === n.id || e.b === n.id) && byId.get(e.a).sub !== byId.get(e.b).sub).map((e) => at.get(e.a === n.id ? e.b : e.a));
        h2.set(n.id, ext.length ? ext.reduce((a, b) => a + b, 0) / ext.length : at.get(n.id));
      }
      return layout(g, h2);
    }
    const x0 = Math.min(...N.map((n) => n.x)), y0 = Math.min(...N.map((n) => n.y - (n.sub ? PAD + TITLE : 0)));
    N.forEach((n) => { n.x = Math.round(n.x - x0); n.y = Math.round(n.y - y0); });
    return { nodes: N, edges: g.edges, subs: g.subs.filter((s) => subIds.includes(s.id)) };
  }

  // nodes, sections and ropes ready for the board, top-left at (ox, oy); makeId() gives fresh ids
  function toItems(src, ox, oy, makeId, by) {
    const g = layout(parse(src)), ids = new Map(), list = [];
    const secs = new Map();
    for (const s of g.subs) {
      const ks = g.nodes.filter((n) => n.sub === s.id); if (!ks.length) continue;
      const it = { id: makeId(), type: 'section', title: s.title.slice(0, 80), color: 'gray', autofit: true, by };
      const x1 = Math.min(...ks.map((n) => n.x)), y1 = Math.min(...ks.map((n) => n.y)), x2 = Math.max(...ks.map((n) => n.x + n.w)), y2 = Math.max(...ks.map((n) => n.y + n.h));
      Object.assign(it, { x: Math.round(ox + x1 - 40), y: Math.round(oy + y1 - 40), w: Math.round(Math.max(200, x2 - x1 + 80)), h: Math.round(Math.max(140, y2 - y1 + 80)), n: ks.length });
      secs.set(s.id, it); list.push(it);
    }
    for (const n of g.nodes) {
      const it = { id: makeId(), type: 'node', x: ox + n.x, y: oy + n.y, w: Math.round(n.w), h: Math.round(n.h), text: n.text, shape: n.shape, icon: n.icon || 'none', color: ICON_COLOR[n.icon] || 'gray', sec: n.sub && secs.get(n.sub) ? secs.get(n.sub).id : null, by };
      ids.set(n.id, it.id); list.push(it);
    }
    const seen = new Set();
    for (const e of g.edges) {
      const k = e.a + '>' + e.b + '|' + e.label; if (seen.has(k)) continue; seen.add(k);
      const it = { id: makeId(), type: 'link', a: ids.get(e.a), b: ids.get(e.b), by };
      if (e.label) it.label = e.label;
      if (!e.arrow) it.flow = false;
      if (e.dash) it.dash = true;
      if (e.thick) it.thick = true;
      list.push(it);
    }
    return { items: list, nodes: g.nodes.length, links: list.filter((i) => i.type === 'link').length, sections: secs.size };
  }
  const looksLike = (t) => /^\s*(```\s*mermaid\s*\n\s*)?(%%[^\n]*\n\s*)*(graph|flowchart)\s+(TB|TD|BT|LR|RL)\b/i.test(t || '') || /^\s*(graph|flowchart)\s*\n[\s\S]*(-->|---|==>|-\.->)/i.test(t || '');
  return { SHAPES, ICONS, ICON_COLOR, guessIcon, parse, layout, toItems, looksLike, sizeOf };
})();
// </flow>

// ---------- helpers ----------
const isCard = (i) => ['sticky', 'image', 'text', 'web', 'node'].includes(i.type);
const centerIn = (i, s) => { const cx = i.x + i.w / 2, cy = i.y + i.h / 2; return cx >= s.x && cx <= s.x + s.w && cy >= s.y && cy <= s.y + s.h; };
function ownerOf(i, all) {
  if (!isCard(i)) return null;
  if ('sec' in i) return all.find((s) => s.type === 'section' && s.id === i.sec) || null;
  let best = null; for (const s of all) if (s.type === 'section' && centerIn(i, s) && (!best || s.w * s.h < best.w * best.h)) best = s;
  return best;
}
function bbox(list) {
  if (!list.length) return null;
  const x1 = Math.min(...list.map((i) => i.x)), y1 = Math.min(...list.map((i) => i.y));
  const x2 = Math.max(...list.map((i) => i.x + (i.w || 0))), y2 = Math.max(...list.map((i) => i.y + (i.h || 0)));
  return { x1, y1, x2, y2 };
}
const stickyColor = (c) => { const k = String(c || '').toLowerCase(); return STICKY_COLORS.includes(k) ? k : COLOR_ALIASES[k] || null; };
const str = (v, n) => (typeof v === 'string' ? v.slice(0, n) : undefined);
const num = (v) => (typeof v === 'number' && isFinite(v) ? Math.round(v) : undefined);
function safeHttps(u) { try { const x = new URL(String(u).replace(/^http:/i, 'https:')); return x.protocol === 'https:' ? x.href : null; } catch { return null; } }

function summary(i) {
  const o = { id: i.id, type: i.type, x: i.x, y: i.y, w: i.w, h: i.h };
  if (i.type === 'sticky' || i.type === 'text') o.text = i.text || '';
  if (i.type === 'text') o.style = i.ts || 'p';
  if (i.type === 'section') { o.title = i.title || ''; o.autofit = i.autofit !== false; }
  if (i.type === 'link') { o.from = i.a; o.to = i.b; if (i.label) o.label = i.label; delete o.x; delete o.y; delete o.w; delete o.h; }
  if (i.type === 'web') { o.url = i.url; if (i.title) o.title = i.title; }
  if (i.type === 'stamp') o.emoji = i.emoji;
  if (i.type === 'node') { o.text = i.text || ''; o.shape = i.shape || 'rect'; o.icon = i.icon || 'none'; }
  if (i.type === 'link') { if (i.flow === false) o.arrow = false; if (i.dash) o.dash = true; if (i.thick) o.thick = true; }
  if (i.type === 'comment') o.messages = (i.msgs || []).map((m) => `${m.n || '?'}: ${m.t || ''}`);
  if (i.color) o.color = i.color;
  if (i.sec) o.section = i.sec;
  if (i.by) o.by = i.by;
  return o;
}

async function webMeta(url, yt) {
  try {
    const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 6000);
    const r = await fetch((yt ? 'https://noembed.com/embed?url=' : 'https://api.microlink.io/?url=') + enc(url), { signal: ctl.signal });
    clearTimeout(t); const j = await r.json();
    if (yt) return j && !j.error ? { title: str(j.title, 160), site: str(j.author_name, 160) } : {};
    const d = j && j.status === 'success' && j.data; if (!d) return {};
    return { title: str(d.title, 160), desc: str(d.description, 300), site: str(d.publisher, 160), img: d.image && safeHttps(d.image.url) || undefined, icon: d.logo && safeHttps(d.logo.url) || undefined };
  } catch { return {}; }
}

// keeps an auto-fitting section snug around its cards (same rule as the board: 40px padding, min 200×140)
function refit(sec, all) {
  if (sec.autofit === false) return false;
  const inside = all.filter((i) => ownerOf(i, all) === sec);
  const b = bbox(inside); if (!b) return false;
  const next = { x: b.x1 - 40, y: b.y1 - 40, w: Math.max(200, b.x2 - b.x1 + 80), h: Math.max(140, b.y2 - b.y1 + 80), n: inside.length };
  const changed = ['x', 'y', 'w', 'h', 'n'].some((k) => sec[k] !== next[k]);
  Object.assign(sec, next); return changed;
}

// ---------- tools ----------
const boardArg = { type: 'string', description: 'Board id from list_boards. Default "main".' };
const TOOLS = [
  { name: 'list_boards', description: 'List the JamBoard boards (id and title).', inputSchema: { type: 'object', properties: {} } },
  { name: 'get_board', description: 'Read everything on a board: stickies, text, sections, diagram nodes, ropes (links), link cards, stamps, comments. Coordinates are board pixels; a sticky is 200×200. A card\'s "section" is the id of the section it belongs to.', inputSchema: { type: 'object', properties: { board: boardArg } } },
  {
    name: 'add_items',
    description: 'Add items to a board in one go. Types: node (a diagram block for flows and architecture: text, shape rect|round|pill|circle|diamond|cyl|hex, icon service|db|cache|queue|api|user|web|mobile|cloud|storage|fn|lock|mail|none; ropes between two nodes are drawn straight with an arrow), stamp (emoji, on: a card to stamp, size), comment (text: a comment pin, on: a card), sticky (text, color), text (text, style h1|h2|p|s), section (title, color; give other items "section": its ref to put them inside — the section grows to fit), link (a rope from "from" to "to", optional label and color), web (url: a link card with preview; YouTube shows the video thumbnail). Leave x/y out to let the board lay items out in a tidy grid (inside their section if given). Use "ref" to name a new item so links and "section" can point at it in the same call; existing ids work too.',
    inputSchema: {
      type: 'object', required: ['items'],
      properties: {
        board: boardArg,
        items: {
          type: 'array', minItems: 1, maxItems: 200,
          items: {
            type: 'object', required: ['type'],
            properties: {
              type: { type: 'string', enum: ['sticky', 'text', 'section', 'link', 'web', 'stamp', 'comment', 'node'] },
              shape: { type: 'string', enum: Flow.SHAPES, description: 'Node shape. cyl is a database, diamond a decision.' },
              icon: { type: 'string', enum: Flow.ICONS, description: 'Node icon (guessed from the text when left out).' },
              arrow: { type: 'boolean', description: 'Link: false hides the arrow and the moving dot (no direction).' },
              dash: { type: 'boolean', description: 'Link: dashed line (async, optional, events).' },
              thick: { type: 'boolean', description: 'Link: thick line (main path).' },
              emoji: { type: 'string', description: 'Stamp emoji, e.g. 👍 ❤️ 🔥 ⭐ ✅ 💡 🎉 🚀.' },
              on: { type: 'string', description: 'Stamp or comment: ref or id of the card to put it on (it then moves with the card).' },
              size: { type: 'number', description: 'Stamp size 64–128 (default 64).' },
              ref: { type: 'string', description: 'Your temporary name for this item, used by other items in this call.' },
              text: { type: 'string' }, title: { type: 'string', description: 'Section title.' },
              style: { type: 'string', enum: TEXT_STYLES, description: 'Text style: h1 heading, h2 subheading, p body, s small.' },
              color: { type: 'string', description: `Sticky/section/node: ${STICKY_COLORS.join(', ')} (or yellow, orange, blue, green). Rope: ${ROPE_COLORS.join(', ')}.` },
              section: { type: 'string', description: 'Ref or id of the section to place this card in.' },
              from: { type: 'string', description: 'Link start: ref or id.' }, to: { type: 'string', description: 'Link end: ref or id.' },
              label: { type: 'string', description: 'Link name shown on the rope.' },
              url: { type: 'string', description: 'For web cards: an https link.' },
              x: { type: 'number' }, y: { type: 'number' }, w: { type: 'number' }, h: { type: 'number' },
            },
          },
        },
      },
    },
  },
  {
    name: 'update_items',
    description: 'Change existing items: text, title, color, style, label, node shape and icon, link arrow/dash/thick, position (x, y), size (w, h), section (id, or "" to take a card out of its section). Only the fields you pass change.',
    inputSchema: { type: 'object', required: ['changes'], properties: { board: boardArg, changes: { type: 'array', minItems: 1, maxItems: 200, items: { type: 'object', required: ['id'], properties: { id: { type: 'string' }, text: { type: 'string' }, shape: { type: 'string', enum: Flow.SHAPES }, icon: { type: 'string', enum: Flow.ICONS }, arrow: { type: 'boolean' }, dash: { type: 'boolean' }, thick: { type: 'boolean' }, title: { type: 'string' }, color: { type: 'string' }, style: { type: 'string', enum: TEXT_STYLES }, label: { type: 'string' }, section: { type: 'string' }, x: { type: 'number' }, y: { type: 'number' }, w: { type: 'number' }, h: { type: 'number' } } } } } },
  },
  {
    name: 'add_mermaid',
    description: 'Draw a Mermaid flowchart (flowchart/graph TD|LR|BT|RL) on the board as real, editable diagram nodes, sections (from subgraphs) and arrows, laid out automatically. Supports [rect], (round), ([pill]), ((circle)), {diamond}, [(database)], {{hex}}, A@{ shape: cyl, label: "x", icon: queue }, -->, ---, -.->, ==>, |labels| and -- labels -->, A & B --> C. Icons are guessed from node text (Postgres → db, Redis → cache, Kafka → queue, API → api, User → user…). Placed to the right of existing content unless x/y are given.',
    inputSchema: { type: 'object', required: ['code'], properties: { board: boardArg, code: { type: 'string', description: 'Mermaid flowchart text.' }, x: { type: 'number', description: 'Top-left x (optional).' }, y: { type: 'number', description: 'Top-left y (optional).' } } },
  },
  { name: 'delete_items', description: 'Delete items by id. Ropes attached to deleted cards go too. Deleting a section keeps its cards.', inputSchema: { type: 'object', required: ['ids'], properties: { board: boardArg, ids: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 500 } } } },
  { name: 'create_board', description: 'Create a new empty board and return its id.', inputSchema: { type: 'object', required: ['title'], properties: { title: { type: 'string' } } } },
  { name: 'timer', description: 'Control the board\'s shared timer that everyone sees: start (with minutes), pause, resume, reset, or status.', inputSchema: { type: 'object', required: ['action'], properties: { board: boardArg, action: { type: 'string', enum: ['start', 'pause', 'resume', 'reset', 'status'] }, minutes: { type: 'number', description: 'For start: 0.1 to 120.' } } } },
];

async function callTool(name, a) {
  const board = a.board == null ? 'main' : a.board;
  if (!validBoard(board)) throw new Error('Unknown board id');
  if (name === 'list_boards') {
    const meta = await getDoc('board/meta');
    const rows = (await listColl('boards')) || [];
    return [{ id: 'main', title: (meta && meta.title) || 'Головна дошка' }, ...rows.map((r) => ({ id: r.path.slice(7), title: r.data && r.data.title || 'Без назви' }))];
  }
  if (name === 'create_board') {
    const id = 'b' + uid().slice(0, 10);
    await putDocs([{ path: 'boards/' + id, data: { title: String(a.title || 'Нова дошка').slice(0, 120), at: Date.now(), by: BY } }]);
    return { id, note: 'Open it from the board menu, or add #b=' + id + ' to the board link.' };
  }
  if (name === 'get_board') {
    const all = await loadItems(board);
    return { board, count: all.length, items: all.sort((p, q) => (p.type === 'section' ? -1 : 0) - (q.type === 'section' ? -1 : 0) || p.y - q.y || p.x - q.x).map(summary) };
  }
  if (name === 'timer') {
    const cur = (await getDoc(timerPath(board))) || { dur: 300000 };
    const left = cur.run ? cur.end - Date.now() : cur.left != null ? cur.left : cur.dur;
    let next = null;
    if (a.action === 'start') { const ms = Math.round(Math.min(120, Math.max(0.1, Number(a.minutes) || 5)) * 60000); next = { dur: ms, run: true, end: Date.now() + ms }; }
    else if (a.action === 'pause') { if (!cur.run) throw new Error('The timer is not running'); next = { dur: cur.dur, left: Math.max(0, left) }; }
    else if (a.action === 'resume') { if (cur.left == null) throw new Error('The timer is not paused'); next = { dur: cur.dur, run: true, end: Date.now() + cur.left }; }
    else if (a.action === 'reset') next = { dur: cur.dur };
    if (next) await putDocs([{ path: timerPath(board), data: { ...next, by: BY, at: Date.now() } }]);
    const s = next || cur, l = s.run ? s.end - Date.now() : s.left != null ? s.left : s.dur;
    return { state: s.run ? (l > 0 ? 'running' : 'finished') : s.left != null ? 'paused' : 'ready', secondsLeft: Math.max(0, Math.round(l / 1000)), minutes: s.dur / 60000 };
  }

  const all = await loadItems(board);
  const byId = new Map(all.map((i) => [i.id, i]));
  let z = all.reduce((m, i) => Math.max(m, i.z || 0), 0);

  if (name === 'add_items') {
    const list = Array.isArray(a.items) ? a.items.slice(0, 200) : [];
    const refs = new Map(), made = [], touched = new Set();
    const resolve = (k) => (k == null ? null : refs.get(String(k)) || byId.get(String(k)) || null);
    // free area for loose items: to the right of what is already there
    const b0 = bbox(all.filter((i) => i.type !== 'link' && i.type !== 'comment'));
    let freeX = b0 ? b0.x2 + 160 : 0, freeY = b0 ? b0.y1 : 0, rowH = 0, col = 0;
    const slot = (w, h) => { if (col >= 4) { col = 0; freeX = (b0 ? b0.x2 + 160 : 0); freeY += rowH + 40; rowH = 0; } const p = { x: freeX, y: freeY }; freeX += w + 40; rowH = Math.max(rowH, h); col++; return p; };
    const secSlots = new Map(); // section id -> next grid position inside it
    const secSlot = (sec, w, h) => {
      let st = secSlots.get(sec.id);
      if (!st) {
        const members = all.concat(made).filter((i) => ownerOf(i, all.concat(made)) === sec);
        const mb = bbox(members);
        st = mb ? { x0: sec.x + 40, x: mb.x1, y: mb.y2 + 40, rowH: 0, col: 0 } : { x0: sec.x + 40, x: sec.x + 40, y: sec.y + 56, rowH: 0, col: 0 };
        secSlots.set(sec.id, st);
      }
      if (st.col >= 4) { st.col = 0; st.x = st.x0; st.y += st.rowH + 40; st.rowH = 0; }
      const p = { x: st.x, y: st.y }; st.x += w + 40; st.rowH = Math.max(st.rowH, h); st.col++; return p;
    };
    // sections first, so cards can be placed inside them
    const order = [...list].sort((p, q) => (p.type === 'section' ? 0 : p.type === 'link' ? 2 : 1) - (q.type === 'section' ? 0 : q.type === 'link' ? 2 : 1));
    for (const spec of order) {
      const t = spec.type; let it;
      if (t === 'section') {
        it = { id: uid(), type: 'section', x: num(spec.x) ?? 0, y: num(spec.y) ?? 0, w: num(spec.w) ?? 640, h: num(spec.h) ?? 420, color: stickyColor(spec.color) || 'gray', title: str(spec.title ?? spec.text, 120) || 'Нова секція', z: ++z, by: BY };
        if (spec.x == null || spec.y == null) { const p = slot(it.w, it.h); it.x = p.x; it.y = p.y; }
        if (spec.w != null || spec.h != null) it.autofit = false;
      } else if (t === 'link') {
        const A = resolve(spec.from), B = resolve(spec.to);
        if (!A || !B || !isCard(A) || !isCard(B) || A === B) throw new Error(`Link needs "from" and "to" pointing at two different cards (got ${spec.from} → ${spec.to})`);
        it = { id: uid(), type: 'link', a: A.id, b: B.id, z: ++z, by: BY };
        const lab = str(spec.label, 60); if (lab && lab.trim()) it.label = lab.trim();
        if (ROPE_COLORS.includes(spec.color) && spec.color !== 'gray') it.color = spec.color;
        if (spec.arrow === false) it.flow = false;
        if (spec.dash === true) it.dash = true;
        if (spec.thick === true) it.thick = true;
      } else if (t === 'sticky' || t === 'text' || t === 'web' || t === 'node') {
        if (t === 'node') {
          const shape = Flow.SHAPES.includes(spec.shape) ? spec.shape : 'rect', text = str(spec.text, 400) || '';
          const icon = Flow.ICONS.includes(spec.icon) ? spec.icon : Flow.guessIcon(text, shape);
          const [w, h] = Flow.sizeOf({ text: text || 'Назва', shape, icon });
          it = { id: uid(), type: 'node', shape, icon, text, w: num(spec.w) ?? Math.round(w), h: num(spec.h) ?? Math.round(h), color: stickyColor(spec.color) || Flow.ICON_COLOR[icon] || 'gray' };
        }
        if (t === 'sticky') it = { id: uid(), type: 'sticky', w: num(spec.w) ?? 200, h: num(spec.h) ?? 200, color: stickyColor(spec.color) || 'caution', text: str(spec.text, 4000) || '' };
        if (t === 'text') it = { id: uid(), type: 'text', w: num(spec.w) ?? 360, h: 40, ts: TEXT_STYLES.includes(spec.style) ? spec.style : 'p', text: str(spec.text, 4000) || '' };
        if (t === 'web') {
          const url = safeHttps(spec.url); if (!url) throw new Error('web needs an https url');
          const ym = YT_RE.exec(url);
          it = { id: uid(), type: 'web', url, w: num(spec.w) ?? (ym ? 360 : 320), h: ym ? 290 : 260 };
          if (ym) it.yt = ym[1];
          const meta = await webMeta(url, !!ym); for (const k in meta) if (meta[k] !== undefined) it[k] = meta[k];
        }
        it.z = ++z; it.by = BY;
        const sec = spec.section != null ? resolve(spec.section) : null;
        if (spec.section != null && (!sec || sec.type !== 'section')) throw new Error(`No section "${spec.section}"`);
        if (spec.x != null && spec.y != null) { it.x = num(spec.x); it.y = num(spec.y); }
        else { const p = sec ? secSlot(sec, it.w, it.h) : slot(it.w, it.h); it.x = p.x; it.y = p.y; }
        it.sec = sec ? sec.id : null;
        if (sec) touched.add(sec);
      } else if (t === 'stamp' || t === 'comment') {
        const card = spec.on != null ? resolve(spec.on) : null;
        if (spec.on != null && (!card || !isCard(card))) throw new Error(`No card "${spec.on}" for the ${t}`);
        const n = made.filter((m) => m.type === t && m._on === (card && card.id)).length; // spread several on one card
        if (t === 'stamp') {
          const size = Math.max(64, Math.min(128, num(spec.size) ?? 64));
          it = { id: uid(), type: 'stamp', emoji: typeof spec.emoji === 'string' && spec.emoji.length <= 16 ? spec.emoji : '👍', w: size, h: size };
          if (card && (spec.x == null || spec.y == null)) { it.x = Math.round(card.x + card.w - size * 0.7 - n * size * 0.55); it.y = Math.round(card.y + card.h - size * 0.75); }
        } else {
          const text = str(spec.text, 1000); if (!text || !text.trim()) throw new Error('comment needs text');
          it = { id: uid(), type: 'comment', w: 36, h: 36, msgs: [{ n: BY, e: '🤖', c: '#c2185b', t: text.trim(), at: Date.now() }] };
          if (card && (spec.x == null || spec.y == null)) { it.x = Math.round(card.x + card.w - 22 - n * 30); it.y = Math.round(card.y - 14); }
        }
        if (it.x == null) { if (spec.x != null && spec.y != null) { it.x = num(spec.x); it.y = num(spec.y); } else { const p = slot(it.w, it.h); it.x = p.x; it.y = p.y; } }
        Object.defineProperty(it, '_on', { value: card && card.id, enumerable: false });
        it.z = ++z; it.by = BY;
      } else throw new Error('Unsupported type: ' + t);
      if (spec.ref) refs.set(String(spec.ref), it);
      made.push(it);
    }
    const everything = all.concat(made), extra = [];
    for (const sec of touched) if (refit(sec, everything) && !made.includes(sec)) extra.push(sec);
    for (const sec of made.filter((i) => i.type === 'section')) refit(sec, everything);
    await save(board, made.concat(extra));
    return { added: made.map((i) => ({ id: i.id, type: i.type, ref: [...refs].find(([, v]) => v === i)?.[0] })) };
  }

  if (name === 'update_items') {
    const changed = new Set(), touched = new Set();
    for (const c of (a.changes || []).slice(0, 200)) {
      const it = byId.get(String(c.id)); if (!it) throw new Error('No item ' + c.id);
      const was = ownerOf(it, all), ox = it.x, oy = it.y;
      if (c.text != null && (it.type === 'sticky' || it.type === 'text')) { it.text = String(c.text).slice(0, 4000); delete it.html; }
      if (c.text != null && it.type === 'node') it.text = String(c.text).slice(0, 400);
      if (it.type === 'node' && Flow.SHAPES.includes(c.shape)) it.shape = c.shape;
      if (it.type === 'node' && Flow.ICONS.includes(c.icon)) it.icon = c.icon;
      if (it.type === 'link') {
        if (c.arrow === false) it.flow = false; else if (c.arrow === true) delete it.flow;
        if (c.dash != null) { if (c.dash) it.dash = true; else delete it.dash; }
        if (c.thick != null) { if (c.thick) it.thick = true; else delete it.thick; }
      }
      if (c.title != null && it.type === 'section') it.title = String(c.title).slice(0, 120);
      if (c.label != null && it.type === 'link') { const l = String(c.label).trim().slice(0, 60); if (l) it.label = l; else delete it.label; }
      if (c.style != null && it.type === 'text' && TEXT_STYLES.includes(c.style)) it.ts = c.style;
      if (c.color != null) {
        if (it.type === 'link') { if (c.color === 'gray') delete it.color; else if (ROPE_COLORS.includes(c.color)) it.color = c.color; }
        else if (stickyColor(c.color)) it.color = stickyColor(c.color);
      }
      for (const k of ['x', 'y', 'w', 'h']) if (num(c[k]) != null && it.type !== 'link') it[k] = num(c[k]);
      if ((c.w != null || c.h != null) && it.type === 'section') it.autofit = false;
      if (c.section != null && isCard(it)) {
        const s = c.section === '' ? null : byId.get(String(c.section));
        if (c.section !== '' && (!s || s.type !== 'section')) throw new Error('No section ' + c.section);
        it.sec = s ? s.id : null;
        if (s && !centerIn(it, s) && c.x == null) { const b = bbox(all.filter((i) => ownerOf(i, all) === s && i !== it)); it.x = b ? b.x2 + 40 : s.x + 40; it.y = b ? b.y1 : s.y + 56; }
      }
      if (it.type === 'section' && (it.x !== ox || it.y !== oy)) { // a moved section takes its cards along
        for (const m of all) if (ownerOf(m, all) === it || (m.type !== 'link' && m.type !== 'section' && !isCard(m) && centerIn({ ...m, x: m.x, y: m.y }, { x: ox, y: oy, w: it.w, h: it.h }))) { m.x += it.x - ox; m.y += it.y - oy; changed.add(m); }
      }
      changed.add(it);
      const now = ownerOf(it, all); if (was) touched.add(was); if (now) touched.add(now);
    }
    for (const s of touched) if (refit(s, all)) changed.add(s);
    await save(board, [...changed]);
    return { updated: [...changed].map((i) => i.id) };
  }

  if (name === 'add_mermaid') {
    const code = String(a.code || '');
    const probe = Flow.toItems(code, 0, 0, uid, BY);
    const nb = bbox(probe.items.filter((i) => i.type !== 'link'));
    const b0 = bbox(all.filter((i) => i.type !== 'link' && i.type !== 'comment'));
    const ox = num(a.x) ?? (b0 ? b0.x2 + 200 : 0), oy = num(a.y) ?? (b0 ? b0.y1 : 0);
    probe.items.forEach((it) => { if (it.type !== 'link') { it.x += ox - nb.x1; it.y += oy - nb.y1; } it.z = ++z; });
    await save(board, probe.items);
    return { nodes: probe.nodes, links: probe.links, sections: probe.sections, ids: probe.items.map((i) => ({ id: i.id, type: i.type, text: i.text || i.title || i.label || undefined })) };
  }

  if (name === 'delete_items') {
    const ids = new Set((a.ids || []).map(String).filter((id) => byId.has(id)));
    for (const i of all) if (i.type === 'link' && (ids.has(i.a) || ids.has(i.b))) ids.add(i.id);
    const freed = all.filter((i) => isCard(i) && !ids.has(i.id) && i.sec && ids.has(i.sec)).map((i) => { i.sec = null; return i; });
    const owners = new Set(all.filter((i) => ids.has(i.id)).map((i) => ownerOf(i, all)).filter((s) => s && !ids.has(s.id)));
    const rest = all.filter((i) => !ids.has(i.id)), refitted = [...owners].filter((s) => refit(s, rest));
    await delDocs([...ids].map((id) => itemsColl(board) + '/' + id));
    if (freed.length || refitted.length) await save(board, [...new Set([...freed, ...refitted])]);
    return { deleted: [...ids] };
  }
  throw new Error('Unknown tool ' + name);
}

// ---------- MCP over HTTP (JSON-RPC 2.0) ----------
const PROTOCOLS = ['2025-06-18', '2025-03-26', '2024-11-05'];
const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'content-type, mcp-protocol-version, mcp-session-id, authorization', 'Access-Control-Allow-Methods': 'POST, GET, OPTIONS' };
const json = (body, status = 200) => new Response(body == null ? null : JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });

async function handleRpc(m) {
  if (!m || m.jsonrpc !== '2.0' || typeof m.method !== 'string') return { jsonrpc: '2.0', id: m && m.id != null ? m.id : null, error: { code: -32600, message: 'Invalid request' } };
  const reply = (result) => (m.id == null ? null : { jsonrpc: '2.0', id: m.id, result });
  switch (m.method) {
    case 'initialize': {
      const want = m.params && m.params.protocolVersion;
      return reply({ protocolVersion: PROTOCOLS.includes(want) ? want : PROTOCOLS[0], capabilities: { tools: {} }, serverInfo: { name: 'jamboard', version: '1.0.0' }, instructions: 'JamBoard is a shared whiteboard. Read a board with get_board before editing it. Prefer add_items with refs to build sections, stickies and ropes in one call; leave x/y out for automatic layout.' });
    }
    case 'ping': return reply({});
    case 'tools/list': return reply({ tools: TOOLS });
    case 'tools/call': {
      const name = m.params && m.params.name, args = (m.params && m.params.arguments) || {};
      try { const out = await callTool(name, args); return reply({ content: [{ type: 'text', text: JSON.stringify(out) }] }); }
      catch (e) { return reply({ content: [{ type: 'text', text: 'Error: ' + (e && e.message || e) }], isError: true }); }
    }
    default:
      if (m.method.startsWith('notifications/')) return null;
      return m.id == null ? null : { jsonrpc: '2.0', id: m.id, error: { code: -32601, message: 'Method not found: ' + m.method } };
  }
}

async function eq(a, b) { // constant-time-ish compare
  if (!a || !b || a.length !== b.length) return false;
  let d = 0; for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i); return d === 0;
}

export async function handler(req) {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  const url = new URL(req.url);
  const key = url.searchParams.get('key') || (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
  if (!MCP_KEY || !(await eq(key, MCP_KEY))) return json({ error: 'unauthorized' }, 401);
  if (req.method !== 'POST') return new Response('Use POST', { status: 405, headers: { ...CORS, Allow: 'POST, OPTIONS' } });
  let body; try { body = await req.json(); } catch { return json({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }, 400); }
  if (Array.isArray(body)) { const out = (await Promise.all(body.map(handleRpc))).filter(Boolean); return out.length ? json(out) : new Response(null, { status: 202, headers: CORS }); }
  const out = await handleRpc(body);
  return out ? json(out) : new Response(null, { status: 202, headers: CORS });
}

if (globalThis.Deno) Deno.serve(handler);
