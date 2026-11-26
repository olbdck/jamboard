// JamBoard MCP server: lets Claude read and edit boards.
// Runs as a Supabase Edge Function (Deno), speaks MCP over Streamable HTTP (stateless JSON responses).
// Connector URL: https://<project>.supabase.co/functions/v1/jamboard-mcp?key=<JAMBOARD_MCP_KEY> (admin: every board)
//            or …/jamboard-mcp?token=jbt_… (a personal token from «Налаштування» in the app: only its own boards,
//            see supabase/mcp-tokens.sql)
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
// Boards open only by their link, so a board id is a long random secret (same format as index.html).
const secretId = () => {
  const abc = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789', out = [];
  while (out.length < 24) for (const x of crypto.getRandomValues(new Uint8Array(32))) { if (x < 248 && out.length < 24) out.push(abc[x % 62]); }
  return out.join('');
};
const itemsColl = (b) => (b === 'main' ? 'items' : `boards/${b}/items`);
const timerPath = (b) => (b === 'main' ? 'board/timer' : `boards/${b}/timer/state`);
const bdoc = (b, rest) => (b === 'main' ? 'board/' : `boards/${b}/`) + rest; // retro docs: mode/hide, mode/vote, votes/<voter>
const APP_URL = 'https://olbdck.github.io/jamboard/';
const uid = () => Date.now().toString(36).slice(-6) + Math.random().toString(36).slice(2, 10);
let lastRev = 0;
const rev = () => (lastRev = Math.max(Date.now(), lastRev + 1));

async function loadItems(board) {
  const rows = (await listColl(itemsColl(board))) || [];
  return rows.map((r) => ({ ...r.data, id: r.path.slice(r.path.lastIndexOf('/') + 1) }));
}
const strip = (it) => { const o = { ...it }; delete o.id; return o; };
// The board's cover (thumbnail in «Мої дошки») is drawn by browsers; after an edit here we only mark it stale,
// and the next browser that lists the board rebuilds it from the items.
const coverStale = (board) => (board === 'main' ? null : putDocs([{ path: `boards/${board}/cover/v1`, data: { v: 0, stale: true, at: Date.now() } }]).catch(() => null));
const save = async (board, list) => { await putDocs(list.map((it) => ({ path: itemsColl(board) + '/' + it.id, data: { ...strip(it), rev: rev() } }))); if (list.length) await coverStale(board); };

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
        e.label = cleanText(e.label.replace(/^\s*"([\s\S]*)"\s*$/, '$1')).replace(/\n/g, ' ').slice(0, 60); // |"quoted"| labels lose their quotes
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

// <plan> shared by index.html and the MCP server: keep both copies identical
// Planning pieces that need no DOM: timeline and table geometry, templates, sorting by votes, markdown export, task sources.
const Plan = (() => {
  const TOP = 60, SIDE = 168, PAD = 16, DAY = 864e5;
  const UNITS = ['day', 'week', 'sprint', 'month'];
  const STATUSES = ['todo', 'doing', 'review', 'done'];
  const STATUS_NAMES = { todo: 'До роботи', doing: 'У роботі', review: 'На перевірці', done: 'Готово' };
  const MON = ['січ.', 'лют.', 'бер.', 'квіт.', 'трав.', 'черв.', 'лип.', 'серп.', 'вер.', 'жовт.', 'лист.', 'груд.'];
  const MONTHS = ['Січень', 'Лютий', 'Березень', 'Квітень', 'Травень', 'Червень', 'Липень', 'Серпень', 'Вересень', 'Жовтень', 'Листопад', 'Грудень'];
  const WD = ['нд', 'пн', 'вт', 'ср', 'чт', 'пт', 'сб'];
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const isGrid = (i) => !!i && (i.type === 'timeline' || i.type === 'table');

  // ---------- dates: whole days since 1970-01-01, so a time zone never moves a column ----------
  const dayOf = (s) => { const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s || ''); return m ? Math.floor(Date.UTC(+m[1], +m[2] - 1, +m[3]) / DAY) : null; };
  const isoOf = (d) => new Date(d * DAY).toISOString().slice(0, 10);
  const localDay = (ms) => { const t = new Date(ms); return Math.floor(Date.UTC(t.getFullYear(), t.getMonth(), t.getDate()) / DAY); };
  const monday = (d) => d - ((new Date(d * DAY).getUTCDay() + 6) % 7);
  const isoWeek = (d) => { const th = monday(d) + 3, y = new Date(th * DAY).getUTCFullYear(); return 1 + Math.floor((th - (monday(Math.floor(Date.UTC(y, 0, 4) / DAY)) + 3)) / 7); };
  const fmtD = (d) => { const t = new Date(d * DAY); return t.getUTCDate() + ' ' + MON[t.getUTCMonth()]; };
  const range = (a, b) => { const A = new Date(a * DAY), B = new Date(b * DAY); return A.getUTCMonth() === B.getUTCMonth() && A.getUTCFullYear() === B.getUTCFullYear() ? A.getUTCDate() + '–' + B.getUTCDate() + ' ' + MON[B.getUTCMonth()] : fmtD(a) + ' – ' + fmtD(b); };
  const thisMonday = (ms) => isoOf(monday(localDay(ms)));

  // ---------- geometry: a header band on top, lane names on the left (when there are any), equal cells ----------
  function dims(g) {
    const tl = g.type === 'timeline', rows = (tl ? g.lanes : g.rows) || [];
    const nc = tl ? clamp(Math.round(g.n) || 1, 1, 60) : Math.max(1, (g.cols || []).length);
    const nr = Math.max(1, rows.length), side = rows.length ? SIDE : 0;
    return { nc, nr, side, top: TOP, rows, cw: Math.max(1, (g.w - side) / nc), lh: Math.max(1, (g.h - TOP) / nr) };
  }
  const sizeFor = (g, cw, lh) => { const d = dims(g); return { w: Math.round(d.side + d.nc * cw), h: Math.round(TOP + d.nr * lh) }; };
  function column(g, i) { // what a column header says: { t: title, d: dates or '', from, to } (from/to in days, timeline only)
    if (g.type !== 'timeline') return { t: String((g.cols || [])[i] || '') };
    const s = dayOf(g.start) ?? monday(localDay(Date.now()));
    let from, to, t, d = '';
    if (g.unit === 'day') { from = to = s + i; t = WD[new Date(from * DAY).getUTCDay()] + ', ' + fmtD(from); }
    else if (g.unit === 'month') {
      const a = new Date(s * DAY), y = a.getUTCFullYear(), m = a.getUTCMonth() + i;
      from = Math.floor(Date.UTC(y, m, 1) / DAY); to = Math.floor(Date.UTC(y, m + 1, 1) / DAY) - 1;
      const M = new Date(from * DAY); t = MONTHS[M.getUTCMonth()]; d = String(M.getUTCFullYear());
    } else if (g.unit === 'sprint') {
      const L = clamp(Math.round(g.len) || 14, 1, 70); from = s + L * i; to = from + L - 1;
      t = 'Спринт ' + ((Number.isFinite(g.k) ? g.k : 1) + i); d = range(from, to);
    } else { from = s + 7 * i; to = from + 6; t = 'Тиждень ' + isoWeek(from); d = range(from, to); }
    const own = g.names && typeof g.names[i] === 'string' && g.names[i].trim();
    if (own) { if (t && g.unit !== 'day') d = d ? t + ' · ' + d : t; t = own; }
    return { t, d, from, to };
  }
  function nowAt(g, ms) { // where today is on a timeline: { i: column, f: 0..1 across it } or null
    if (g.type !== 'timeline') return null;
    const t = new Date(ms), today = localDay(ms) + (t.getHours() * 60 + t.getMinutes()) / 1440, n = dims(g).nc;
    const a = column(g, 0), b = column(g, n - 1);
    if (today < a.from || today >= b.to + 1) return null;
    for (let i = 0; i < n; i++) { const c = column(g, i); if (today >= c.from && today < c.to + 1) return { i, f: (today - c.from) / (c.to + 1 - c.from) }; }
    return null;
  }
  const rowName = (g, r) => String((dims(g).rows || [])[r] || '');
  function cellRect(g, c, r) { const d = dims(g); return { x: g.x + d.side + c * d.cw, y: g.y + d.top + r * d.lh, w: d.cw, h: d.lh }; }
  function cellAt(g, x, y) {
    const d = dims(g), lx = x - g.x - d.side, ly = y - g.y - d.top;
    if (lx < 0 || ly < 0 || lx >= g.w - d.side || ly >= g.h - d.top) return null;
    return [clamp(Math.floor(lx / d.cw), 0, d.nc - 1), clamp(Math.floor(ly / d.lh), 0, d.nr - 1)];
  }
  const cellOf = (g, it) => { const d = dims(g), c = Array.isArray(it.cell) ? it.cell : [0, 0]; return [clamp(c[0] | 0, 0, d.nc - 1), clamp(c[1] | 0, 0, d.nr - 1)]; };
  // A card dropped into a cell sticks to it: on a timeline or table it lines up in the column, in a matrix it stays where it was put.
  function snap(g, it, cell) {
    const R = cellRect(g, cell[0], cell[1]), w = it.w || 200, h = it.h || 120;
    const fitY = (y) => (h > R.h - PAD * 2 ? R.y + PAD : clamp(y, R.y + PAD, R.y + R.h - h - PAD));
    const fitX = (x) => (w > R.w - PAD * 2 ? R.x + PAD : clamp(x, R.x + PAD, R.x + R.w - w - PAD));
    const x = g.kind === 'matrix' ? fitX(it.x) : w <= R.w - PAD * 2 ? R.x + (R.w - w) / 2 : R.x + PAD;
    return { x: Math.round(x), y: Math.round(fitY(it.y)) };
  }
  // the next free spot in a cell: after the cards already there (in a matrix, under them)
  function slotIn(g, cell, w, h, members) {
    const R = cellRect(g, cell[0], cell[1]);
    const here = members.filter((m) => !isBar(m) && Array.isArray(m.cell) && m.cell[0] === cell[0] && m.cell[1] === cell[1]);
    if (g.kind !== 'matrix') { const ps = flow(g, cell, here.sort(readOrder).concat([{ w, h }]), cellTop(g, cell[1], members)); const p = ps[ps.length - 1]; return { x: p.x, y: p.y }; }
    const y = here.length ? Math.max(...here.map((m) => m.y + (m.h || 0))) + 20 : R.y + PAD;
    return snap(g, { w, h, x: R.x + PAD, y }, cell);
  }

  // ---------- cards in a cell line up in rows: as many side by side as the column fits, then the next row ----------
  const GAP = 16, BAR_H = 36, TRACK = 46;
  const isBar = (i) => !!i && i.type === 'bar';
  const readOrder = (a, b) => a.y - b.y || a.x - b.x;
  // where cards (in this order) go in a cell: left to right, wrapping; the widest row is centred in the column.
  // Returns [{ m, x, y, row, col }]; `top` is where the first row starts (under the task bars of a timeline lane).
  function flow(g, cell, list, top) {
    const R = cellRect(g, cell[0], cell[1]), inner = R.w - PAD * 2, rows = [];
    let row = null;
    for (const m of list) {
      const w = m.w || 200;
      if (!row || (row.items.length && row.w + GAP + w > inner)) { row = { items: [], w: -GAP, h: 0 }; rows.push(row); }
      row.items.push(m); row.w += GAP + w; row.h = Math.max(row.h, m.h || 120);
    }
    const span = rows.reduce((a, r) => Math.max(a, r.w), 0), x0 = R.x + PAD + Math.max(0, (inner - span) / 2), out = [];
    let y = top != null ? top : R.y + PAD;
    rows.forEach((r, ri) => { let x = x0; r.items.forEach((m, ci) => { out.push({ m, x: Math.round(x), y: Math.round(y), row: ri, col: ci }); x += (m.w || 200) + GAP; }); y += r.h + GAP; });
    return out;
  }
  // the top of a cell's cards: on a timeline, under the lane's task bars
  function cellTop(g, r, all) {
    let y = cellRect(g, 0, r).y + PAD;
    if (g.type === 'timeline') for (const b of all) if (isBar(b) && b.grid === g.id && cellOf(g, b)[1] === r) y = Math.max(y, b.y + BAR_H + GAP + 4);
    return y;
  }
  // every card of a table or timeline in its place, cell by cell (only `cells`, a Set of "c,r", when given).
  // Returns [{ m, x, y, row, col }] for all the cards laid out; a matrix keeps cards where they were put.
  function reflow(g, all, cells) {
    if (g.kind === 'matrix') return [];
    const by = new Map(), out = [];
    for (const m of all) {
      if (m.grid !== g.id || !CARD.includes(m.type) || isBar(m)) continue;
      const k = cellOf(g, m).join(',');
      if (cells && !cells.has(k)) continue;
      if (!by.has(k)) by.set(k, []); by.get(k).push(m);
    }
    for (const [k, list] of by) { const cell = k.split(',').map(Number); out.push(...flow(g, cell, list.sort(readOrder), cellTop(g, cell[1], all))); }
    return out;
  }

  // ---------- task bars on a timeline (Gantt): start and due dates give x and width, a lane and track give y ----------
  function xOfDay(g, day) { // board x of the start of a day (fractions too); before or after the columns it goes on at the edge column's pace
    const d = dims(g), n = d.nc, at = (i, c) => g.x + d.side + (i + (day - c.from) / (c.to + 1 - c.from)) * d.cw;
    const c0 = column(g, 0); if (day < c0.from) return at(0, c0);
    for (let i = 0; i < n; i++) { const c = column(g, i); if (day < c.to + 1) return at(i, c); }
    return at(n - 1, column(g, n - 1));
  }
  function dayAtX(g, x) {
    const d = dims(g), u = (x - g.x - d.side) / d.cw, i = clamp(Math.floor(u), 0, d.nc - 1), c = column(g, i);
    return c.from + (u - i) * (c.to + 1 - c.from);
  }
  const barSpan = (b) => { const s = dayOf(b.start), e = dayOf(b.due); return s == null ? null : [s, e == null || e < s ? s : e]; };
  function barBox(g, b) { // { x, w } of a bar on its timeline; a milestone is a diamond on its day
    const sp = barSpan(b); if (!sp) return null;
    if (b.ms) { const cx = xOfDay(g, sp[1] + 0.5); return { x: Math.round(cx - BAR_H / 2), w: BAR_H }; }
    const x0 = xOfDay(g, sp[0]), x1 = xOfDay(g, sp[1] + 1);
    return { x: Math.round(x0), w: Math.max(14, Math.round(x1 - x0)) };
  }
  // the whole days a bar covers once it is put down at x (keeping its length) or stretched to x…x+w
  function barDates(g, b, x, w, keepLen) {
    const sp = barSpan(b) || [0, 0];
    if (b.ms) { const d = Math.floor(dayAtX(g, x + (w || BAR_H) / 2)); return { start: isoOf(d), due: isoOf(d) }; }
    const s = Math.round(dayAtX(g, x)), e = keepLen ? s + sp[1] - sp[0] : Math.max(s, Math.round(dayAtX(g, x + w)) - 1);
    return { start: isoOf(s), due: isoOf(e) };
  }
  const laneY = (g, r) => cellRect(g, 0, r).y + PAD;
  const trackOf = (g, b) => Math.max(0, Math.round((b.y - laneY(g, cellOf(g, b)[1])) / TRACK));
  const barY = (g, r, k) => Math.round(laneY(g, r) + k * TRACK);
  function nextTrack(g, r, all) { // a new bar in a lane goes on the row under the lowest bar there
    let k = -1; for (const b of all) if (isBar(b) && b.grid === g.id && cellOf(g, b)[1] === r) k = Math.max(k, trackOf(g, b));
    return k + 1;
  }
  const colOfDay = (g, day) => { const n = dims(g).nc; for (let i = 0; i < n; i++) if (day <= column(g, i).to) return i; return n - 1; };
  // a bar put on a timeline: its dates decide x and width, its lane and track decide y
  function placeBar(g, b, lane, track) {
    const r = clamp(lane | 0, 0, dims(g).nr - 1), box = barBox(g, b), sp = barSpan(b);
    if (!box) return b;
    b.grid = g.id; b.cell = [sp ? colOfDay(g, sp[0]) : 0, r]; b.x = box.x; b.w = box.w; b.h = BAR_H; b.y = barY(g, r, Math.max(0, track | 0));
    return b;
  }
  const workdays = (s, e) => { let n = 0; for (let d = s; d <= e; d++) { const w = new Date(d * DAY).getUTCDay(); if (w && w !== 6) n++; } return n; };

  // ---------- templates ----------
  const RETRO = {
    ssc: ['Ретро · Start / Stop / Continue', [['🟢 Почати', 'ok'], ['🔴 Припинити', 'pink'], ['🔵 Продовжити', 'info']]],
    msg: ['Ретро · Mad / Sad / Glad', [['😠 Злить', 'warn'], ['😢 Засмучує', 'purple'], ['😊 Радує', 'ok']]],
    '4l': ['Ретро · 4L', [['💚 Сподобалось', 'ok'], ['📚 Навчились', 'info'], ['🕳️ Бракувало', 'warn'], ['✨ Хотілося б', 'purple']]],
    sail: ['Ретро · Вітрильник', [['🌬️ Вітер: що нас рухає', 'teal'], ['⚓ Якір: що гальмує', 'gray'], ['🪨 Скелі: ризики попереду', 'warn'], ['🏝️ Острів: наша мета', 'ok']]],
  };
  const TEMPLATES = [
    ['sprints', 'Таймлайн спринтів', 'Спринти по 2 тижні з доріжками команд'],
    ['weeks', 'Таймлайн тижнів', 'Шість тижнів від поточного'],
    ['gantt', 'Діаграма Ганта', 'Задачі-смуги з прогресом і залежностями'],
    ['roadmap', 'Роадмап', 'Зараз · Далі · Потім'],
    ['matrix', 'Матриця Impact / Effort', 'Пріоритети: вплив проти зусиль'],
    ['table', 'Таблиця', 'Колонки й рядки, картки прилипають до клітинок'],
    ['sprint', 'Спринт-планінг', 'Ціль, беклог і що беремо в спринт'],
    ['ssc', 'Start / Stop / Continue', 'Ретро на три колонки'],
    ['msg', 'Mad / Sad / Glad', 'Ретро про емоції команди'],
    ['4l', '4L', 'Liked · Learned · Lacked · Longed for'],
    ['sail', 'Вітрильник', 'Вітер, якір, скелі й острів'],
  ];
  function template(key, ox, oy, makeId, by, nowMs) {
    const out = [], mk = (o) => { const it = { id: makeId(), by, ...o }; out.push(it); return it; };
    const table = (o, cw, lh) => { const t = { type: 'table', x: ox, y: oy, color: 'gray', ...o }; Object.assign(t, sizeFor({ ...t, w: 0, h: 0 }, cw, lh)); return mk(t); };
    const tl = (o, cw, lh) => { const t = { type: 'timeline', x: ox, y: oy, color: 'gray', start: thisMonday(nowMs || Date.now()), ...o }; Object.assign(t, sizeFor({ ...t, w: 0, h: 0 }, cw, lh)); return mk(t); };
    if (key === 'sprints') tl({ title: 'Спринти', unit: 'sprint', len: 14, k: 1, n: 4, lanes: ['Дизайн', 'Фронтенд', 'Бекенд'] }, 340, 250);
    else if (key === 'weeks') tl({ title: 'План на шість тижнів', unit: 'week', n: 6, lanes: [] }, 300, 420);
    else if (key === 'gantt') {
      const g = tl({ title: 'План проєкту', unit: 'week', n: 6, lanes: ['Дизайн', 'Розробка', 'Запуск'] }, 240, 0), s0 = dayOf(g.start);
      const lh = [PAD * 2 + 2 * TRACK, PAD * 2 + 3 * TRACK, PAD * 2 + 2 * TRACK].map((v) => v + 40);
      Object.assign(g, sizeFor(g, 240, Math.max(...lh)));
      const bar = (text, lane, track, a, len, pct, color, extra) => { const b = mk({ type: 'bar', text, start: isoOf(s0 + a), due: isoOf(s0 + a + len - 1), pct, color, ...extra }); placeBar(g, b, lane, track); return b; };
      const dep = (a, b) => out.push({ id: makeId(), type: 'link', a: a.id, b: b.id, by });
      const res = bar('Дослідження', 0, 0, 0, 5, 100, 'purple'), ui = bar('Макети', 0, 1, 5, 9, 60, 'purple');
      const api = bar('API', 1, 0, 3, 8, 40, 'info'), app = bar('Застосунок', 1, 1, 14, 11, 10, 'info'), qa = bar('Тестування', 1, 2, 25, 6, 0, 'teal');
      const beta = bar('Бета', 2, 0, 32, 1, 0, 'pink', { ms: true }), launch = bar('Запуск', 2, 1, 34, 6, 0, 'ok');
      dep(res, ui); dep(ui, app); dep(api, app); dep(app, qa); dep(qa, beta); dep(beta, launch);
    }
    else if (key === 'roadmap') table({ title: 'Роадмап', cols: ['Зараз', 'Далі', 'Потім'], rows: ['Продукт', 'Дизайн', 'Розробка'], tint: ['ok', 'info', 'purple'] }, 380, 260);
    else if (key === 'matrix') table({ title: 'Пріоритети · Impact / Effort', kind: 'matrix', cols: ['Мало зусиль', 'Багато зусиль'], rows: ['Великий вплив', 'Малий вплив'], cells: ['Швидкі перемоги', 'Великі проєкти', 'Дрібниці', 'Не варто зусиль'], ax: ['Зусилля', 'Вплив'], tint: ['ok', 'warn'] }, 480, 380);
    else if (key === 'table') table({ title: 'Таблиця', cols: ['Колонка 1', 'Колонка 2', 'Колонка 3'], rows: ['Рядок 1', 'Рядок 2'] }, 320, 260);
    else if (key === 'sprint') {
      mk({ type: 'sticky', x: ox, y: oy, w: 300, h: 220, color: 'pink', text: '🎯 Ціль спринту\n\nЗа що ми хочемо, щоб нас похвалили наприкінці?' });
      mk({ type: 'sticky', x: ox, y: oy + 250, w: 300, h: 160, color: 'caution', text: '👥 Ємність команди\n\n… сторіпоінтів' });
      table({ title: 'Спринт-планінг', x: ox + 340, cols: ['📥 Беклог', '✅ Беремо в спринт', '🚧 Ризики й залежності'], rows: [], tint: ['gray', 'ok', 'warn'] }, 360, 640);
    } else if (RETRO[key]) {
      const [title, cols] = RETRO[key];
      table({ title, cols: cols.map((c) => c[0]), rows: [], tint: cols.map((c) => c[1]) }, cols.length > 3 ? 330 : 380, 620);
    } else throw new Error('Unknown template: ' + key);
    return out;
  }

  // ---------- membership helpers (both sides store it the same way: card.grid = container id, card.cell = [column, row]) ----------
  function secOf(i, all) {
    if ('sec' in i) return all.find((s) => s.type === 'section' && s.id === i.sec) || null;
    let best = null; const cx = i.x + (i.w || 0) / 2, cy = i.y + (i.h || 0) / 2;
    for (const s of all) if (s.type === 'section' && cx >= s.x && cx <= s.x + s.w && cy >= s.y && cy <= s.y + s.h && (!best || s.w * s.h < best.w * best.h)) best = s;
    return best;
  }
  const CARD = ['sticky', 'image', 'text', 'web', 'node', 'board', 'task', 'bar'];
  const isCardT = (i) => CARD.includes(i.type);
  const gridOf = (i, byId) => { const g = i.grid && byId.get(i.grid); return isGrid(g) ? g : null; };

  // ---------- after a vote: the most voted cards move to the top of their cell or section ----------
  function sortByVotes(all, votes) {
    const byId = new Map(all.map((i) => [i.id, i])), groups = new Map(), out = [];
    for (const i of all) {
      if (!isCardT(i) || isBar(i)) continue;
      const g = gridOf(i, byId), s = g ? null : secOf(i, all);
      const key = g ? g.id + ':' + cellOf(g, i).join(',') : s ? s.id : null;
      if (!key) continue;
      if (!groups.has(key)) groups.set(key, { g, list: [] });
      groups.get(key).list.push(i);
    }
    const v = (i) => votes[i.id] || 0;
    for (const { g, list } of groups.values()) {
      if (list.length < 2 || !list.some((i) => v(i) > 0)) continue;
      const read = [...list].sort((a, b) => Math.round(a.y / 40) - Math.round(b.y / 40) || a.x - b.x);
      const ranked = [...read].sort((a, b) => v(b) - v(a) || read.indexOf(a) - read.indexOf(b));
      if (g && g.kind !== 'matrix') { // the cell's cards in rows again, best first
        const c = cellOf(g, list[0]);
        for (const p of flow(g, c, ranked, cellTop(g, c[1], all))) if (p.x !== p.m.x || p.y !== p.m.y) out.push({ id: p.m.id, x: p.x, y: p.y });
      } else if (g) { // a matrix cell: stack them, best on top
        let y = Math.min(...list.map((i) => i.y));
        for (const i of ranked) { if (i.y !== y) out.push({ id: i.id, x: i.x, y }); y += (i.h || 120) + 20; }
      } else ranked.forEach((i, k) => { const s = read[k]; if (s.x !== i.x || s.y !== i.y) out.push({ id: i.id, x: s.x, y: s.y }); });
    }
    return out;
  }

  // ---------- markdown export ----------
  // o: { title, plain(it) → text, hidden(it) → bool, votes: { id: n }, boardUrl(bid) → url }
  function markdown(all, o) {
    o = o || {};
    const plain = o.plain || ((i) => String(i.text || '').replace(/<[^>]*>/g, ''));
    const votes = o.votes || {}, hidden = o.hidden || (() => false);
    const byId = new Map(all.map((i) => [i.id, i])), L = [];
    const one = (s) => String(s || '').replace(/\s*\n+\s*/g, ' · ').trim();
    const read = (a, b) => Math.round(a.y / 40) - Math.round(b.y / 40) || a.x - b.x;
    const vs = (i) => (votes[i.id] ? ` · 🗳 ${votes[i.id]}` : '');
    const ranked = (list) => [...list].sort((a, b) => (votes[b.id] || 0) - (votes[a.id] || 0) || read(a, b));
    const line = (i) => {
      if (hidden(i)) return '- _(прихована картка)_';
      if (i.type === 'task') {
        const s = i.src && i.src.key ? (i.src.url ? `[${i.src.key}](${i.src.url})` : i.src.key) : '';
        const bits = [STATUS_NAMES[i.status] || STATUS_NAMES.todo, i.who && '👤 ' + i.who, i.est && '⏱ ' + i.est, i.due && '📅 ' + i.due, ...(i.tags || []).map((t) => '#' + String(t).replace(/\s+/g, '-')), s].filter(Boolean);
        return `- [${i.status === 'done' ? 'x' : ' '}] **${one(i.text) || 'Задача'}** · ${bits.join(' · ')}${vs(i)}`;
      }
      if (i.type === 'web') return `- [${one(i.title) || i.url}](${i.url})${vs(i)}`;
      if (i.type === 'board') return `- [${one(i.title) || 'Дошка JamBoard'}](${o.boardUrl ? o.boardUrl(i.bid) : '#b=' + i.bid})${vs(i)}`;
      if (i.type === 'image') return `- 🖼 Зображення${/^https:\/\//.test(i.url || '') ? ` (${i.url})` : ''}${vs(i)}`;
      if (i.type === 'text') {
        const t = plain(i).trim(); if (!t) return '';
        return (i.ts === 'h1' ? '### ' : i.ts === 'h2' ? '#### ' : '') + (i.ts === 'h1' || i.ts === 'h2' ? one(t) : t) + vs(i);
      }
      const t = plain(i).trim();
      return t.includes('\n') ? '- ' + t.split('\n').map((l, k) => (k ? '  ' + l : l)).join('\n') + vs(i) : '- ' + (t || '_(порожній стікер)_') + vs(i);
    };
    const put = (list) => ranked(list).forEach((i) => { const s = line(i); if (s) L.push(s); });
    const barLines = (list) => [...list].sort((a, b) => (dayOf(a.start) || 0) - (dayOf(b.start) || 0) || read(a, b)).forEach((i) => {
      if (hidden(i)) { L.push('- _(прихована картка)_'); return; }
      const sp = barSpan(i), after = all.filter((l) => l.type === 'link' && l.b === i.id && isBar(byId.get(l.a))).map((l) => one(byId.get(l.a).text) || 'задача');
      const when = sp ? (i.ms ? fmtD(sp[1]) : range(sp[0], sp[1])) : '';
      const bits = [i.ms ? '◆ віха' : '', when && '📅 ' + when, !i.ms && Number.isFinite(i.pct) ? i.pct + '%' : '', i.who && '👤 ' + i.who, after.length ? 'після: ' + after.join(', ') : ''].filter(Boolean);
      L.push(`- [${i.pct >= 100 ? 'x' : ' '}] **${one(i.text) || 'Задача'}**${bits.length ? ' · ' + bits.join(' · ') : ''}${vs(i)}`);
    });
    L.push('# ' + (one(o.title) || 'Дошка JamBoard'), '');
    const nodes = all.filter((i) => i.type === 'node');
    const cards = all.filter((i) => isCardT(i) && i.type !== 'node' && !isBar(i));
    const bars = all.filter(isBar);
    const homes = new Map(); // container id → cards
    const loose = [];
    for (const i of cards) {
      const g = gridOf(i, byId), s = g ? null : secOf(i, all), k = g ? g.id : s ? s.id : null;
      if (!k) { loose.push(i); continue; }
      if (!homes.has(k)) homes.set(k, []); homes.get(k).push(i);
    }
    const boxes = all.filter((i) => isGrid(i) || i.type === 'section').sort(read);
    for (const b of boxes) {
      const list = homes.get(b.id) || [];
      if (b.type === 'section') { if (!list.length) continue; L.push('## ' + (one(b.title) || 'Секція'), ''); put(list); L.push(''); continue; }
      const d = dims(b), named = d.rows.length > 0;
      L.push('## ' + (one(b.title) || (b.type === 'timeline' ? 'Таймлайн' : 'Таблиця')), '');
      const mine = bars.filter((i) => i.grid === b.id);
      if (mine.length) { L.push('### Задачі', ''); barLines(mine); L.push(''); }
      const inCell = (c, r) => list.filter((i) => { const q = cellOf(b, i); return q[0] === c && q[1] === r; });
      if (b.kind === 'matrix') {
        for (let r = 0; r < d.nr; r++) for (let c = 0; c < d.nc; c++) {
          const nm = (b.cells || [])[r * d.nc + c], ax = [column(b, c).t, rowName(b, r)].filter(Boolean).join(' · ');
          L.push('### ' + (one(nm) || ax || `Клітинка ${c + 1}.${r + 1}`) + (nm && ax ? ` (${ax})` : ''), ''); put(inCell(c, r)); L.push('');
        }
        continue;
      }
      for (let c = 0; c < d.nc; c++) {
        const h = column(b, c);
        L.push('### ' + (one(h.t) || `Колонка ${c + 1}`) + (h.d ? ' · ' + h.d : ''), '');
        for (let r = 0; r < d.nr; r++) {
          const here = inCell(c, r); if (!here.length) continue;
          if (named) L.push(`**${one(rowName(b, r)) || 'Рядок ' + (r + 1)}**`, '');
          put(here); L.push('');
        }
      }
    }
    const looseBars = bars.filter((i) => !gridOf(i, byId));
    if (looseBars.length) { L.push('## Задачі', ''); barLines(looseBars); L.push(''); }
    if (loose.length) { if (boxes.length || nodes.length) L.push('## Інше на дошці', ''); put(loose); L.push(''); }
    if (nodes.length) {
      const nid = new Map(nodes.map((n, k) => [n.id, 'n' + (k + 1)]));
      const q = (s) => '"' + (one(s) || ' ').replace(/"/g, '#quot;') + '"';
      const wrap = { rect: ['[', ']'], round: ['(', ')'], pill: ['([', '])'], circle: ['((', '))'], diamond: ['{', '}'], cyl: ['[(', ')]'], hex: ['{{', '}}'] };
      const bx = Math.max(...nodes.map((n) => n.x)) - Math.min(...nodes.map((n) => n.x)), by = Math.max(...nodes.map((n) => n.y)) - Math.min(...nodes.map((n) => n.y));
      L.push('## Схема', '', '```mermaid', 'flowchart ' + (bx >= by ? 'LR' : 'TD'));
      for (const n of nodes) { const [a, b] = wrap[n.shape] || wrap.rect; L.push(`  ${nid.get(n.id)}${a}${q(n.text)}${b}`); }
      for (const l of all) {
        if (l.type !== 'link' || !nid.has(l.a) || !nid.has(l.b)) continue;
        const op = l.thick ? (l.flow === false ? '===' : '==>') : l.dash ? (l.flow === false ? '-.-' : '-.->') : l.flow === false ? '---' : '-->';
        L.push(`  ${nid.get(l.a)} ${op}${l.label ? '|' + q(l.label) + '|' : ''} ${nid.get(l.b)}`);
      }
      L.push('```', '');
    }
    const name = (i) => (!i ? '?' : hidden(i) ? 'прихована картка' : i.type === 'section' || isGrid(i) ? one(i.title) : one(i.type === 'task' || i.type === 'node' ? i.text : i.type === 'web' || i.type === 'board' ? i.title : plain(i)).slice(0, 60) || i.type);
    const ropes = all.filter((l) => l.type === 'link' && byId.has(l.a) && byId.has(l.b) && !(byId.get(l.a).type === 'node' && byId.get(l.b).type === 'node') && !(isBar(byId.get(l.a)) && isBar(byId.get(l.b))));
    if (ropes.length) { L.push('## Зв’язки', ''); ropes.forEach((l) => L.push(`- ${name(byId.get(l.a))} → ${name(byId.get(l.b))}${l.label ? ' (' + one(l.label) + ')' : ''}`)); L.push(''); }
    const notes = all.filter((i) => i.type === 'comment' && Array.isArray(i.msgs) && i.msgs.length);
    if (notes.length) {
      L.push('## Коментарі', '');
      for (const c of notes) { c.msgs.forEach((m) => L.push(`> **${one(m.n) || 'Гість'}**: ${one(m.t)}`)); L.push(''); }
    }
    return L.join('\n').replace(/\n{3,}/g, '\n\n').trim() + '\n';
  }

  // ---------- task cards: where a task came from (Jira, Linear, GitHub) ----------
  // A source turns a pasted issue link into { p, key, url }. One that can be read without a sign-in also has
  // api(m) → JSON url and read(json) → task fields; the others are filled in later through the MCP server.
  const SOURCES = {
    github: {
      name: 'GitHub',
      match: (u) => { const m = /^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/(issues|pull)\/(\d+)/.exec(u); return m && { p: 'github', key: `${m[1]}/${m[2]}#${m[4]}`, url: m[0], api: `https://api.github.com/repos/${m[1]}/${m[2]}/issues/${m[4]}` }; },
      read: (j) => j && typeof j.title === 'string' ? { text: j.title.slice(0, 400), status: j.state === 'closed' ? 'done' : j.pull_request ? 'review' : (j.assignee ? 'doing' : 'todo'), who: j.assignee && j.assignee.login ? String(j.assignee.login).slice(0, 40) : undefined, tags: Array.isArray(j.labels) ? j.labels.map((l) => String(l && l.name || '').slice(0, 24)).filter(Boolean).slice(0, 8) : undefined } : null,
    },
    jira: { name: 'Jira', match: (u) => { const m = /^https:\/\/[\w-]+\.atlassian\.net\/(?:browse\/|.*[?&]selectedIssue=)([A-Z][A-Z0-9_]+-\d+)/.exec(u); return m && { p: 'jira', key: m[1], url: u.split('#')[0].slice(0, 500) }; } },
    linear: { name: 'Linear', match: (u) => { const m = /^https:\/\/linear\.app\/[\w-]+\/issue\/([A-Z][A-Z0-9]*-\d+)/.exec(u); return m && { p: 'linear', key: m[1], url: m[0] }; } },
  };
  const source = (u) => { for (const k in SOURCES) { const m = SOURCES[k].match(String(u || '')); if (m) return m; } return null; };

  return { TOP, SIDE, PAD, GAP, BAR_H, TRACK, UNITS, STATUSES, STATUS_NAMES, TEMPLATES, SOURCES, isGrid, isBar, dayOf, isoOf, localDay, thisMonday, fmtD, range, dims, sizeFor, column, nowAt, rowName, cellRect, cellAt, cellOf, snap, slotIn, readOrder, flow, cellTop, reflow, xOfDay, dayAtX, barSpan, barBox, barDates, laneY, trackOf, barY, nextTrack, colOfDay, placeBar, workdays, template, sortByVotes, markdown, source };
})();
// </plan>

// ---------- helpers ----------
const isCard = (i) => ['sticky', 'image', 'text', 'web', 'node', 'board', 'task', 'bar'].includes(i.type);
const isBar = Plan.isBar;
const isGrid = Plan.isGrid;
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
// https://…/jamboard/#b=<id> (any host serving JamBoard) → the board id
const boardOfUrl = (u) => { try { const x = new URL(u); if (!/\/jamboard\/?(index\.html)?$/.test(x.pathname) && !/github\.io$/.test(x.hostname)) return null; const m = /(?:^#|[#&?])b=([A-Za-z0-9_-]{20,64})(?:&|$)/.exec(x.hash + '&' + x.search.replace(/^\?/, '&')); return m ? m[1] : null; } catch { return null; } };
function safeHttps(u) { try { const x = new URL(String(u).replace(/^http:/i, 'https:')); return x.protocol === 'https:' ? x.href : null; } catch { return null; } }
const strs = (a, n, len) => (Array.isArray(a) ? a.slice(0, n).map((v) => (typeof v === 'string' ? v.slice(0, len) : String(v ?? '').slice(0, len))) : undefined);
const clampN = (v, a, b, d) => { const n = Math.round(Number(v)); return isFinite(n) ? Math.max(a, Math.min(b, n)) : d; };

// ---------- timelines and tables ----------
const gridLabel = (g) => (g.type === 'timeline' ? 'timeline' : g.kind === 'matrix' ? 'matrix' : 'table');
// a column given as a 1-based number, a header name, or (timeline) a YYYY-MM-DD date inside it → 0-based index
function colIndex(g, v) {
  const d = Plan.dims(g);
  if (v == null || v === '') return 0;
  if (typeof v === 'number') return Math.max(0, Math.min(d.nc - 1, Math.round(v) - 1));
  const s = String(v).trim(), day = Plan.dayOf(s);
  if (day != null && g.type === 'timeline') { for (let i = 0; i < d.nc; i++) { const c = Plan.column(g, i); if (day >= c.from && day <= c.to) return i; } throw new Error(`Date ${s} is outside the timeline "${g.title || g.id}"`); }
  if (/^\d+$/.test(s)) return Math.max(0, Math.min(d.nc - 1, +s - 1));
  const low = s.toLowerCase();
  for (let i = 0; i < d.nc; i++) { const c = Plan.column(g, i); if (String(c.t).toLowerCase() === low || (g.names && String(g.names[i] || '').toLowerCase() === low)) return i; }
  for (let i = 0; i < d.nc; i++) if (String(Plan.column(g, i).t).toLowerCase().includes(low)) return i;
  throw new Error(`No column "${s}" in "${g.title || g.id}"`);
}
function rowIndex(g, v) {
  const d = Plan.dims(g);
  if (v == null || v === '') return 0;
  if (typeof v === 'number') return Math.max(0, Math.min(d.nr - 1, Math.round(v) - 1));
  const s = String(v).trim(); if (/^\d+$/.test(s)) return Math.max(0, Math.min(d.nr - 1, +s - 1));
  const low = s.toLowerCase(), i = d.rows.findIndex((r) => String(r).toLowerCase() === low);
  if (i >= 0) return i;
  const j = d.rows.findIndex((r) => String(r).toLowerCase().includes(low)); if (j >= 0) return j;
  throw new Error(`No ${g.type === 'timeline' ? 'lane' : 'row'} "${s}" in "${g.title || g.id}"`);
}
// in a matrix a cell can also be named by its label ("Швидкі перемоги")
function matrixCell(g, v) {
  if (g.kind !== 'matrix' || typeof v !== 'string') return null;
  const d = Plan.dims(g), k = (g.cells || []).findIndex((c) => String(c).toLowerCase() === v.trim().toLowerCase());
  return k >= 0 ? [k % d.nc, Math.floor(k / d.nc)] : null;
}
const cellName = (g, c) => {
  if (g.kind === 'matrix' && g.cells && g.cells[c[1] * Plan.dims(g).nc + c[0]]) return g.cells[c[1] * Plan.dims(g).nc + c[0]];
  const h = Plan.column(g, c[0]), r = Plan.rowName(g, c[1]);
  return [h.t + (h.d ? ' (' + h.d + ')' : ''), r].filter(Boolean).join(' / ');
};
const gridMembers = (g, all) => all.filter((i) => isCard(i) && i.grid === g.id);
// cards keep their cell when the grid changes shape and line up in rows again (a matrix keeps their spot,
// a task bar its lane and track; its dates give its x and width) — the same rules as the board
function memberOffsets(g, all) {
  return gridMembers(g, all).map((m) => { const c = Plan.cellOf(g, m), R = Plan.cellRect(g, c[0], c[1]); return { m, c, fx: (m.x - R.x) / R.w, fy: (m.y - R.y) / R.h, k: isBar(m) ? Plan.trackOf(g, m) : 0 }; });
}
function resnap(g, offs, all) {
  const d = Plan.dims(g);
  for (const o of offs) {
    const c = [Math.min(o.c[0], d.nc - 1), Math.min(o.c[1], d.nr - 1)];
    if (isBar(o.m)) { if (g.type === 'timeline') Plan.placeBar(g, o.m, c[1], o.k); continue; }
    o.m.cell = c;
    if (g.kind !== 'matrix') continue;
    const R = Plan.cellRect(g, c[0], c[1]), q = Plan.snap(g, { ...o.m, x: R.x + o.fx * R.w, y: R.y + o.fy * R.h }, c); o.m.x = q.x; o.m.y = q.y;
  }
  return relayout(g, all || offs.map((o) => o.m));
}
// the cards of a table or timeline in rows, cell by cell; lanes grow so bars and cards fit. Returns what moved.
function relayout(g, all) {
  const moved = new Set();
  for (const p of Plan.reflow(g, all)) if (p.m.x !== p.x || p.m.y !== p.y) { p.m.x = p.x; p.m.y = p.y; moved.add(p.m); }
  const d = Plan.dims(g); let need = 0;
  for (const m of gridMembers(g, all)) { const top = Plan.cellRect(g, 0, Plan.cellOf(g, m)[1]).y; need = Math.max(need, m.y + (m.h || 0) + Plan.PAD - top); }
  if (need > d.lh + 0.5) {
    const offs = memberOffsets(g, all); g.h = Math.round(Plan.TOP + d.nr * Math.ceil(need)); moved.add(g);
    offs.forEach((o) => moved.add(o.m)); resnap(g, offs, all);
  }
  return moved;
}
function barFields(it, spec) { // a task bar on a timeline: name, dates, progress, owner, milestone
  if (spec.text != null) it.text = String(spec.text).replace(/\s+/g, ' ').trim().slice(0, 200);
  for (const k of ['start', 'due']) if (spec[k] != null) { if (Plan.dayOf(spec[k]) == null) throw new Error(k + ': a YYYY-MM-DD date'); it[k] = spec[k]; }
  if (spec.days != null && spec.due == null) it.due = Plan.isoOf(Plan.dayOf(it.start) + clampN(spec.days, 1, 3660, 5) - 1);
  if (spec.milestone === true) { it.ms = true; if (spec.start == null && spec.due != null) it.start = it.due; else it.due = it.start; }
  else if (spec.milestone === false) delete it.ms;
  if (Plan.dayOf(it.due) < Plan.dayOf(it.start)) it.due = it.start;
  if (spec.progress != null) it.pct = clampN(spec.progress, 0, 100, 0);
  for (const k of ['who', 'assignee']) if (spec[k] != null) { const v = String(spec[k]).trim().slice(0, 40); if (v) it.who = v; else delete it.who; }
}
function gridFields(it, spec) { // timeline / table fields from a tool call, normalised like the board does
  if (spec.title != null) it.title = String(spec.title).slice(0, 120);
  if (it.type === 'timeline') {
    if (spec.unit != null) { if (!Plan.UNITS.includes(spec.unit)) throw new Error('unit: day, week, sprint or month'); it.unit = spec.unit; }
    if (spec.start != null) { if (Plan.dayOf(spec.start) == null) throw new Error('start: a YYYY-MM-DD date'); it.start = spec.start; }
    if (spec.columns != null) { if (Array.isArray(spec.columns)) { it.n = clampN(spec.columns.length, 1, 60, 4); it.names = strs(spec.columns, 60, 40); } else it.n = clampN(spec.columns, 1, 60, 4); }
    if (spec.column_names != null) it.names = strs(spec.column_names, 60, 40) || [];
    if (spec.sprint_days != null) it.len = clampN(spec.sprint_days, 1, 70, 14);
    if (spec.first_sprint != null) it.k = clampN(spec.first_sprint, 0, 9999, 1);
    if (spec.lanes != null) it.lanes = strs(spec.lanes, 12, 60) || [];
  } else {
    if (spec.columns != null) { const c = strs(spec.columns, 20, 60); if (!c || !c.length) throw new Error('columns: a list of column names'); it.cols = c; }
    if (spec.rows != null) it.rows = strs(spec.rows, 20, 60) || [];
    if (spec.cells != null) it.cells = strs(spec.cells, 400, 60) || [];
    if (spec.axes != null) it.ax = strs(spec.axes, 2, 40) || [];
    if (spec.matrix === true) it.kind = 'matrix'; else if (spec.matrix === false) delete it.kind;
    if (spec.tints != null) it.tint = (Array.isArray(spec.tints) ? spec.tints : []).slice(0, 20).map((c) => stickyColor(c) || '');
  }
}
function taskFields(it, spec) {
  if (spec.text != null) it.text = String(spec.text).slice(0, 400);
  if (spec.status != null) { if (!Plan.STATUSES.includes(spec.status)) throw new Error('status: ' + Plan.STATUSES.join(', ')); it.status = spec.status; }
  for (const [k, f, n] of [['who', 'who', 40], ['assignee', 'who', 40], ['estimate', 'est', 16]]) if (spec[k] != null) { const v = String(spec[k]).trim().slice(0, n); if (v) it[f] = v; else delete it[f]; }
  if (spec.due != null) { if (spec.due === '') delete it.due; else if (Plan.dayOf(spec.due) == null) throw new Error('due: a YYYY-MM-DD date'); else it.due = spec.due; }
  if (spec.tags != null) { const t = (strs(spec.tags, 8, 24) || []).map((x) => x.trim()).filter(Boolean); if (t.length) it.tags = t; else delete it.tags; }
  if (spec.url != null) {
    if (spec.url === '') delete it.src;
    else { const m = Plan.source(safeHttps(spec.url) || ''); if (!m) throw new Error('url: a Jira, Linear or GitHub issue link'); it.src = { p: m.p, key: m.key, url: m.url, at: Date.now() }; }
  }
}
async function pullTask(it) { // fills a task from its tracker when that needs no sign-in (GitHub); others are filled by the agent via update_items
  const src = it.src && Plan.SOURCES[it.src.p]; if (!src || !src.read) return false;
  const m = src.match(it.src.url); if (!m || !m.api) return false;
  try {
    const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 6000);
    const r = await fetch(m.api, { signal: ctl.signal, headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'jamboard-mcp' } }); clearTimeout(t);
    if (!r.ok) return false;
    const f = src.read(await r.json()); if (!f) return false;
    for (const k in f) if (f[k] !== undefined) it[k] = f[k];
    if (!it.tags || !it.tags.length) delete it.tags;
    it.src.at = Date.now(); return true;
  } catch { return false; }
}
// retro state of a board (hidden writing and dot voting)
async function retroState(board) {
  const [hide, vote, rows] = await Promise.all([getDoc(bdoc(board, 'mode/hide')), getDoc(bdoc(board, 'mode/vote')), listColl(bdoc(board, 'votes'))]);
  const h = hide && hide.on === true && typeof hide.s === 'string' ? { on: true, s: hide.s, by: hide.by } : { on: false, s: hide && hide.s };
  const v = vote && ['live', 'results'].includes(vote.st) && typeof vote.s === 'string' ? { st: vote.st, s: vote.s, n: clampN(vote.n, 1, 20, 3), show: vote.show === true, by: vote.by } : { st: 'idle' };
  const tally = {}, voters = [];
  if (v.st !== 'idle') for (const r of rows || []) {
    const d = r.data; if (!d || d.s !== v.s || !d.v || typeof d.v !== 'object') continue;
    let used = 0; for (const id in d.v) { const n = Math.min(20, Math.max(0, Math.round(+d.v[id]) || 0)); if (n) { tally[id] = (tally[id] || 0) + n; used += n; } }
    if (used) voters.push({ name: String(d.n || 'Гість').slice(0, 32), used });
  }
  return { hide: h, vote: v, tally, voters };
}
const isHidden = (i, r) => !!(r && r.hide.on && i.hid && i.hid === r.hide.s);

function summary(i, all, retro) {
  const o = { id: i.id, type: i.type, x: i.x, y: i.y, w: i.w, h: i.h };
  if (i.type === 'sticky' || i.type === 'text') o.text = i.text || '';
  if (i.type === 'text') o.style = i.ts || 'p';
  if (i.type === 'section') { o.title = i.title || ''; o.autofit = i.autofit !== false; }
  if (i.type === 'link') { o.from = i.a; o.to = i.b; if (i.label) o.label = i.label; delete o.x; delete o.y; delete o.w; delete o.h; }
  if (i.type === 'web') { o.url = i.url; if (i.title) o.title = i.title; }
  if (i.type === 'board') { o.board = i.bid; if (i.title) o.title = i.title; }
  if (i.type === 'stamp') o.emoji = i.emoji;
  if (i.type === 'node') { o.text = i.text || ''; o.shape = i.shape || 'rect'; o.icon = i.icon || 'none'; }
  if (i.type === 'link') { if (i.flow === false) o.arrow = false; if (i.dash) o.dash = true; if (i.thick) o.thick = true; }
  if (i.type === 'comment') o.messages = (i.msgs || []).map((m) => `${m.n || '?'}: ${m.t || ''}`);
  if (i.type === 'timeline') {
    o.title = i.title || ''; o.unit = i.unit || 'week'; o.start = i.start; if (i.unit === 'sprint') { o.sprint_days = i.len || 14; o.first_sprint = i.k ?? 1; }
    o.columns = Array.from({ length: Plan.dims(i).nc }, (_, k) => { const c = Plan.column(i, k); return c.d ? `${c.t} (${c.d})` : c.t; });
    o.lanes = i.lanes || [];
  }
  if (i.type === 'table') { o.title = i.title || ''; if (i.kind === 'matrix') { o.matrix = true; o.cells = i.cells || []; if (i.ax && i.ax.length) o.axes = i.ax; } o.columns = i.cols || []; o.rows = i.rows || []; }
  if (i.type === 'bar') {
    o.text = i.text || ''; o.start = i.start; o.due = i.due; o.progress = i.pct || 0; if (i.ms) o.milestone = true; if (i.who) o.who = i.who;
    if (all) { const after = all.filter((l) => l.type === 'link' && l.b === i.id && all.some((q) => q.id === l.a && isBar(q))).map((l) => l.a); if (after.length) o.after = after; }
  }
  if (i.type === 'task') { o.text = i.text || ''; o.status = i.status || 'todo'; for (const [k, f] of [['who', 'who'], ['estimate', 'est'], ['due', 'due'], ['tags', 'tags']]) if (i[f]) o[k] = i[f]; if (i.src) o.source = { tracker: i.src.p, key: i.src.key, url: i.src.url }; }
  if (all && i.grid) { const g = all.find((q) => q.id === i.grid); if (g && isGrid(g)) { o.grid = g.id; if (isBar(i)) o.lane = Plan.rowName(g, Plan.cellOf(g, i)[1]) || 1; else o.cell = cellName(g, Plan.cellOf(g, i)); } }
  if (retro && isHidden(i, retro)) { o.hidden = true; if (o.text != null) o.text = '(hidden until revealed)'; }
  if (retro && retro.tally[i.id]) o.votes = retro.tally[i.id];
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

// width × height of a PNG, JPEG, GIF or WebP from its first bytes (so image cards keep their shape)
async function imageSize(url) {
  try {
    const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 6000);
    const r = await fetch(url, { signal: ctl.signal, headers: { Range: 'bytes=0-65535' } });
    if (!r.ok || !r.body) { clearTimeout(t); return null; }
    const rd = r.body.getReader(), parts = []; let n = 0;
    while (n < 65536) { const { done, value } = await rd.read(); if (done) break; parts.push(value); n += value.length; }
    rd.cancel().catch(() => {}); clearTimeout(t);
    const b = new Uint8Array(n); let o = 0; for (const p of parts) { b.set(p.subarray(0, Math.min(p.length, n - o)), o); o += p.length; if (o >= n) break; }
    return sniffSize(b);
  } catch { return null; }
}
function sniffSize(b) {
  const u16 = (i) => (b[i] << 8) | b[i + 1], l16 = (i) => b[i] | (b[i + 1] << 8), u32 = (i) => u16(i) * 65536 + u16(i + 2);
  if (b.length > 24 && b[0] === 0x89 && b[1] === 0x50) return { w: u32(16), h: u32(20) };
  if (b.length > 10 && b[0] === 0x47 && b[1] === 0x49) return { w: l16(6), h: l16(8) };
  if (b.length > 30 && b[0] === 0x52 && b[8] === 0x57) { // RIFF…WEBP
    const k = String.fromCharCode(b[12], b[13], b[14], b[15]);
    if (k === 'VP8 ') return { w: l16(26) & 0x3fff, h: l16(28) & 0x3fff };
    if (k === 'VP8L') { const v = b[21] | (b[22] << 8) | (b[23] << 16) | (b[24] << 24); return { w: (v & 0x3fff) + 1, h: ((v >> 14) & 0x3fff) + 1 }; }
    if (k === 'VP8X') return { w: 1 + (b[24] | (b[25] << 8) | (b[26] << 16)), h: 1 + (b[27] | (b[28] << 8) | (b[29] << 16)) };
  }
  if (b[0] === 0xff && b[1] === 0xd8) {
    for (let i = 2; i + 9 < b.length;) {
      if (b[i] !== 0xff) { i++; continue; }
      const m = b[i + 1];
      if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return { w: u16(i + 7), h: u16(i + 5) };
      i += 2 + u16(i + 2);
    }
  }
  return null;
}

// ---------- personal tokens (supabase/mcp-tokens.sql): a token reaches only its own boards ----------
const TOKEN_RE = /^jbt_[A-Za-z0-9]{40}$/;
const TOKEN_DAYS = 90; // unused and not refreshed for this long: the token stops working
async function sha256hex(s) {
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)));
  return [...d].map((x) => x.toString(16).padStart(2, '0')).join('');
}
async function tokenScope(token) {
  const hash = await sha256hex(token);
  const rows = await rest(`mcp_tokens?select=hash,boards,updated_at,used_at&hash=eq.${hash}`);
  const t = rows && rows[0]; if (!t) return null;
  const last = Math.max(Date.parse(t.updated_at) || 0, Date.parse(t.used_at) || 0);
  if (Date.now() - last > TOKEN_DAYS * 864e5) return null;
  if (Date.now() - (Date.parse(t.used_at) || 0) > 600000) // remember the last use, at most every 10 minutes
    rest(`mcp_tokens?hash=eq.${hash}`, { method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ used_at: new Date().toISOString() }) }).catch(() => null);
  return { hash, boards: new Set(t.boards || []) };
}
// tools (and actions) that only read; everything else changes the board
const readsOnly = (name, a) => name === 'get_board' || name === 'export_markdown'
  || (name === 'timer' && (a.action === 'status' || !a.action))
  || (name === 'hidden_writing' && a.action !== 'on' && a.action !== 'off')
  || (name === 'voting' && !['start', 'stop', 'clear', 'sort'].includes(a.action));

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
const boardArg = { type: 'string', description: 'Board id from list_boards (the part after #b= in a board link).' };
const TOOLS = [
  { name: 'list_boards', description: 'List the JamBoard boards (id and title).', inputSchema: { type: 'object', properties: {} } },
  { name: 'get_board', description: 'Read everything on a board: stickies, text, sections, timelines, tables and 2×2 matrices, task cards, Gantt bars (start, due, progress, after = the bars they wait for), diagram nodes, ropes (links), link cards, stamps, comments, plus the retro state (hidden writing, dot voting with vote counts). Coordinates are board pixels; a sticky is 200×200. A card\'s "section" is the id of the section it belongs to; "grid" and "cell" say which timeline/table cell it sits in.', inputSchema: { type: 'object', properties: { board: boardArg } } },
  {
    name: 'add_items',
    description: 'Add items to a board in one go. Planning types: timeline (title, unit day|week|sprint|month, start YYYY-MM-DD, columns: a count or a list of names, sprint_days, first_sprint, lanes: team or stream names), table (title, columns, rows; matrix: true with cells: the 4 quadrant names and axes [x, y] makes a 2×2 prioritisation matrix), task (text, status todo|doing|review|done, who, estimate, due YYYY-MM-DD, tags, url: a Jira/Linear/GitHub issue link; GitHub issues fill themselves in), bar (a Gantt task bar on a timeline: text, grid: the timeline, lane, start and due YYYY-MM-DD (or days), progress 0–100, who, milestone, after: bars it depends on; x and width follow the dates). Cards in a table or timeline cell line up in rows, side by side as far as the column is wide. Put any card into a timeline or table cell with grid (ref or id) plus column (1-based number, header name, or a YYYY-MM-DD date on a timeline) and lane/row (number or name); in a matrix, cell can be the quadrant name. Other types: node (a diagram block for flows and architecture: text, shape rect|round|pill|circle|diamond|cyl|hex, icon service|db|cache|queue|api|user|web|mobile|cloud|storage|fn|lock|mail|none; ropes between two nodes are drawn straight with an arrow), stamp (emoji, on: a card to stamp, size), comment (text: a comment pin, on: a card), sticky (text, color), text (text, style h1|h2|p|s), section (title, color; give other items "section": its ref to put them inside — the section grows to fit), link (a rope from "from" to "to", optional label and color), web (url: a link card with preview; YouTube shows the video thumbnail), image (url: an https picture, e.g. a screenshot or reference found with another tool; w sets its width, the height follows the picture). Leave x/y out to let the board lay items out in a tidy grid (inside their section if given). Use "ref" to name a new item so links and "section" can point at it in the same call; existing ids work too.',
    inputSchema: {
      type: 'object', required: ['items'],
      properties: {
        board: boardArg,
        items: {
          type: 'array', minItems: 1, maxItems: 200,
          items: {
            type: 'object', required: ['type'],
            properties: {
              type: { type: 'string', enum: ['sticky', 'text', 'section', 'link', 'web', 'image', 'stamp', 'comment', 'node', 'timeline', 'table', 'task', 'bar'] },
              progress: { type: 'number', description: 'Bar: percent done, 0–100.' },
              days: { type: 'number', description: 'Bar: length in days when due is left out (default 5).' },
              milestone: { type: 'boolean', description: 'Bar: a milestone, one date shown as a diamond.' },
              after: { type: 'array', items: { type: 'string' }, description: 'Bar: refs or ids of the bars it depends on (drawn as arrows from their end to its start).' },
              track: { type: 'number', description: 'Bar: row inside its lane, 1-based (default: under the bars already there).' },
              unit: { type: 'string', enum: ['day', 'week', 'sprint', 'month'], description: 'Timeline: what one column is (default week).' },
              start: { type: 'string', description: 'Timeline: first day, YYYY-MM-DD (default: this Monday). Bar: its first day.' },
              columns: { description: 'Timeline: number of columns, or a list of custom column names. Table: list of column names.', anyOf: [{ type: 'number' }, { type: 'array', items: { type: 'string' } }] },
              sprint_days: { type: 'number', description: 'Timeline with unit sprint: sprint length in days (default 14).' },
              first_sprint: { type: 'number', description: 'Timeline with unit sprint: number of the first sprint (default 1).' },
              lanes: { type: 'array', items: { type: 'string' }, description: 'Timeline: swimlanes (teams, streams). Empty = one lane.' },
              rows: { type: 'array', items: { type: 'string' }, description: 'Table: row names (empty = one row).' },
              matrix: { type: 'boolean', description: 'Table: a 2×2 (or larger) matrix where cards stay where they are put.' },
              cells: { type: 'array', items: { type: 'string' }, description: 'Matrix: cell names, row by row (e.g. Quick wins, Big bets, Fill-ins, Time sinks).' },
              axes: { type: 'array', items: { type: 'string' }, description: 'Matrix: axis names [x, y].' },
              tints: { type: 'array', items: { type: 'string' }, description: 'Table: a colour per column header.' },
              status: { type: 'string', enum: ['todo', 'doing', 'review', 'done'], description: 'Task status.' },
              who: { type: 'string', description: 'Task assignee.' }, estimate: { type: 'string', description: 'Task estimate, e.g. "3 SP" or "2d".' },
              due: { type: 'string', description: 'Task due date YYYY-MM-DD. Bar: its last day (inclusive).' }, tags: { type: 'array', items: { type: 'string' }, description: 'Task tags (up to 8).' },
              grid: { type: 'string', description: 'Ref or id of a timeline or table to put this card into.' },
              column: { description: 'With grid: column as a 1-based number, its name, or (timeline) a YYYY-MM-DD date.', anyOf: [{ type: 'number' }, { type: 'string' }] },
              lane: { description: 'With grid: timeline lane or table row, 1-based number or name.', anyOf: [{ type: 'number' }, { type: 'string' }] },
              row: { description: 'Same as lane (for tables).', anyOf: [{ type: 'number' }, { type: 'string' }] },
              cell: { type: 'string', description: 'With grid on a matrix: the cell name, e.g. "Швидкі перемоги".' },
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
              url: { type: 'string', description: 'For web cards: an https link. A JamBoard board link (…/jamboard/#b=<id>) becomes a board card with its cover and a preview. For tasks: the issue link in Jira, Linear or GitHub.' },
              x: { type: 'number' }, y: { type: 'number' }, w: { type: 'number' }, h: { type: 'number' },
            },
          },
        },
      },
    },
  },
  {
    name: 'update_items',
    description: 'Change existing items: text, title, color, style, label, node shape and icon, link arrow/dash/thick, position (x, y), size (w, h), section (id, or "" to take a card out of its section). Tasks: status, who, estimate, due, tags, url. Bars: text, start, due, progress, who, milestone, lane, track (dependencies are links: add_items link from → to, or delete them). Timelines/tables: title, unit, start, columns, sprint_days, first_sprint, lanes, rows, cells, axes, tints (cards keep their cells; moving one moves its cards). Move a card into a cell with grid + column + lane/row (or cell on a matrix), or grid "" to take it out. Only the fields you pass change.',
    inputSchema: { type: 'object', required: ['changes'], properties: { board: boardArg, changes: { type: 'array', minItems: 1, maxItems: 200, items: { type: 'object', required: ['id'], properties: { id: { type: 'string' }, text: { type: 'string' },
      status: { type: 'string', enum: ['todo', 'doing', 'review', 'done'] }, who: { type: 'string' }, progress: { type: 'number' }, milestone: { type: 'boolean' }, days: { type: 'number' }, track: { type: 'number' }, estimate: { type: 'string' }, due: { type: 'string', description: 'YYYY-MM-DD, or "" to clear.' }, tags: { type: 'array', items: { type: 'string' } }, url: { type: 'string', description: 'Task: tracker issue link, or "" to unlink.' },
      unit: { type: 'string', enum: ['day', 'week', 'sprint', 'month'] }, start: { type: 'string' }, columns: { anyOf: [{ type: 'number' }, { type: 'array', items: { type: 'string' } }] }, sprint_days: { type: 'number' }, first_sprint: { type: 'number' }, lanes: { type: 'array', items: { type: 'string' } }, rows: { type: 'array', items: { type: 'string' } }, cells: { type: 'array', items: { type: 'string' } }, axes: { type: 'array', items: { type: 'string' } }, tints: { type: 'array', items: { type: 'string' } }, matrix: { type: 'boolean' },
      grid: { type: 'string', description: 'Timeline/table id to move the card into, or "" to take it out.' }, column: { anyOf: [{ type: 'number' }, { type: 'string' }] }, lane: { anyOf: [{ type: 'number' }, { type: 'string' }] }, row: { anyOf: [{ type: 'number' }, { type: 'string' }] }, cell: { type: 'string' }, shape: { type: 'string', enum: Flow.SHAPES }, icon: { type: 'string', enum: Flow.ICONS }, arrow: { type: 'boolean' }, dash: { type: 'boolean' }, thick: { type: 'boolean' }, title: { type: 'string' }, color: { type: 'string' }, style: { type: 'string', enum: TEXT_STYLES }, label: { type: 'string' }, section: { type: 'string' }, x: { type: 'number' }, y: { type: 'number' }, w: { type: 'number' }, h: { type: 'number' } } } } } },
  },
  {
    name: 'add_mermaid',
    description: 'Draw a Mermaid flowchart (flowchart/graph TD|LR|BT|RL) on the board as real, editable diagram nodes, sections (from subgraphs) and arrows, laid out automatically. Supports [rect], (round), ([pill]), ((circle)), {diamond}, [(database)], {{hex}}, A@{ shape: cyl, label: "x", icon: queue }, -->, ---, -.->, ==>, |labels| and -- labels -->, A & B --> C. Icons are guessed from node text (Postgres → db, Redis → cache, Kafka → queue, API → api, User → user…). Placed to the right of existing content unless x/y are given.',
    inputSchema: { type: 'object', required: ['code'], properties: { board: boardArg, code: { type: 'string', description: 'Mermaid flowchart text.' }, x: { type: 'number', description: 'Top-left x (optional).' }, y: { type: 'number', description: 'Top-left y (optional).' } } },
  },
  { name: 'delete_items', description: 'Delete items by id. Ropes attached to deleted cards go too. Deleting a section keeps its cards.', inputSchema: { type: 'object', required: ['ids'], properties: { board: boardArg, ids: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 500 } } } },
  { name: 'create_board', description: 'Create a new empty board and return its id.', inputSchema: { type: 'object', required: ['title'], properties: { title: { type: 'string' } } } },
  {
    name: 'add_template',
    description: 'Put a ready-made planning or retro template on the board (placed to the right of existing content unless x/y are given): sprints (timeline of 2-week sprints with team lanes), weeks (6-week timeline), roadmap (Now/Next/Later table), matrix (Impact/Effort 2×2), table (3×2), sprint (sprint goal + backlog/commit/risks), gantt (a project timeline with Gantt bars, progress and dependencies), ssc (Start/Stop/Continue retro), msg (Mad/Sad/Glad), 4l (Liked/Learned/Lacked/Longed for), sail (sailboat retro). Returns the ids; fill it with add_items using grid + column/lane.',
    inputSchema: { type: 'object', required: ['template'], properties: { board: boardArg, template: { type: 'string', enum: Plan.TEMPLATES.map((t) => t[0]) }, title: { type: 'string', description: 'Optional title for the main timeline/table.' }, x: { type: 'number' }, y: { type: 'number' } } },
  },
  {
    name: 'voting',
    description: 'Run dot voting for everyone on the board. start (votes per person 1–20, show_others: see others\' dots live), stop (end it and show results to all), status (counts so far, ranked cards), sort (after voting: move the most voted cards to the top of their cell or section), clear (remove the results). People vote by clicking cards in the app.',
    inputSchema: { type: 'object', required: ['action'], properties: { board: boardArg, action: { type: 'string', enum: ['start', 'stop', 'status', 'sort', 'clear'] }, votes_per_person: { type: 'number', description: 'For start: 1–20 (default 3).' }, show_others: { type: 'boolean', description: 'For start: show everyone\'s dots while voting (default false: only after the vote).' } } },
  },
  {
    name: 'hidden_writing',
    description: 'Silent brainstorming: while on, new stickies, text and tasks are visible only to their author (others see "… пише"), so nobody anchors on others\' ideas. on starts it, off reveals every card to everyone, status tells whether it is on and how many cards are hidden. get_board hides their text too while it is on.',
    inputSchema: { type: 'object', required: ['action'], properties: { board: boardArg, action: { type: 'string', enum: ['on', 'off', 'status'] } } },
  },
  {
    name: 'export_markdown',
    description: 'The board as Markdown: sections, timelines by column and lane, tables and matrices by cell, task checklists with status/assignee/estimate, diagrams as a mermaid block, ropes and comments. Vote counts are included after a vote; hidden cards stay hidden. Pass ids to export only those items (containers bring their cards).',
    inputSchema: { type: 'object', properties: { board: boardArg, ids: { type: 'array', items: { type: 'string' } } } },
  },
  {
    name: 'sync_tasks',
    description: 'Refresh task cards from their tracker. GitHub issues and PRs are read directly (title, open/closed, assignee, labels). Jira and Linear need a sign-in, so they are listed under needs_agent: read them with your Jira/Linear tools and write the fields back with update_items (text, status, who, estimate, due, tags).',
    inputSchema: { type: 'object', properties: { board: boardArg, ids: { type: 'array', items: { type: 'string' }, description: 'Task ids (default: every task with a link).' } } },
  },
  { name: 'timer', description: 'Control the board\'s shared timer that everyone sees: start (with minutes), pause, resume, reset, or status.', inputSchema: { type: 'object', required: ['action'], properties: { board: boardArg, action: { type: 'string', enum: ['start', 'pause', 'resume', 'reset', 'status'] }, minutes: { type: 'number', description: 'For start: 0.1 to 120.' } } } },
];

async function callTool(name, a, scope) {
  if (name === 'list_boards' && scope) { // a personal token: only the boards it was given
    const ids = [...scope.boards].filter(validBoard);
    const rows = ids.length ? (await rest(`docs?select=path,data&path=in.(${ids.map((b) => '"boards/' + b + '"').join(',')})`)) || [] : [];
    return rows.map((r) => ({ id: r.path.slice(7), title: r.data && r.data.title || 'Без назви', link: '#b=' + r.path.slice(7), view_only: r.data && r.data.ro === true || undefined }));
  }
  if (name === 'list_boards') {
    const rows = (await listColl('boards')) || [];
    return rows.map((r) => ({ id: r.path.slice(7), title: r.data && r.data.title || 'Без назви', link: '#b=' + r.path.slice(7) }));
  }
  if (name === 'create_board') {
    const id = secretId();
    await putDocs([{ path: 'boards/' + id, data: { title: String(a.title || 'Нова дошка').slice(0, 120), at: Date.now(), by: BY } }]);
    if (scope) { // the new board joins this token, so the same Claude can keep working on it
      scope.boards.add(id);
      await rest(`mcp_tokens?hash=eq.${scope.hash}`, { method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ boards: [...scope.boards].slice(-300), updated_at: new Date().toISOString() }) });
    }
    return { id, note: 'Boards are private: open it by adding #b=' + id + ' to the JamBoard address and share that link. It is not listed anywhere else.' };
  }
  const board = a.board;
  if (!validBoard(board)) throw new Error('Pass board: an id from list_boards');
  if (scope) {
    if (!scope.boards.has(board)) throw new Error('This board is not open to this token. In JamBoard open «Налаштування» → Claude and tick the board (or open the board once in that browser).');
    if (!readsOnly(name, a)) { const meta = await getDoc('boards/' + board); if (meta && meta.ro === true) throw new Error('This board is view-only.'); }
  }
  if (name === 'get_board') {
    const [all, r] = await Promise.all([loadItems(board), retroState(board)]);
    const back = (i) => (i.type === 'section' || isGrid(i) ? -1 : 0);
    const out = { board, count: all.length, items: all.sort((p, q) => back(p) - back(q) || p.y - q.y || p.x - q.x).map((i) => summary(i, all, r)) };
    if (r.hide.on || r.vote.st !== 'idle') out.retro = { hidden_writing: r.hide.on, voting: r.vote.st, votes_per_person: r.vote.n, voters: r.voters };
    return out;
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
  const plain = (i) => (typeof i.text === 'string' && i.text ? i.text : String(i.html || '').replace(/<(br|\/div|\/h[126])\b[^>]*>/gi, '\n').replace(/<[^>]*>/g, '').replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').trim());
  const label = (i, r) => (isHidden(i, r) ? '(hidden card)' : (i.type === 'web' || i.type === 'board' || i.type === 'section' || isGrid(i) ? i.title || i.url : plain(i)) || i.type).replace(/\s+/g, ' ').slice(0, 100);
  // the section a card is in by geometry (used for cards put into a timeline that sits in a section)
  const geoSec = (i, list) => { const { sec, ...rest } = i; return ownerOf(rest, list); };

  if (name === 'add_template') {
    const key = String(a.template || '');
    if (!Plan.TEMPLATES.some((t) => t[0] === key)) throw new Error('template: ' + Plan.TEMPLATES.map((t) => t[0]).join(', '));
    const list = Plan.template(key, 0, 0, uid, BY, Date.now());
    const main = list.find(isGrid); if (main && typeof a.title === 'string' && a.title.trim()) main.title = a.title.trim().slice(0, 120);
    const nb = bbox(list.filter((i) => i.type !== 'link')), b0 = bbox(all.filter((i) => i.type !== 'link' && i.type !== 'comment'));
    const ox = num(a.x) ?? (b0 ? b0.x2 + 200 : 0), oy = num(a.y) ?? (b0 ? b0.y1 + 60 : 0);
    for (const it of list) { if (it.type !== 'link') { it.x += ox - nb.x1; it.y += oy - nb.y1; } it.z = ++z; }
    await save(board, list);
    return { added: list.map((i) => summary(i, list)), hint: 'Add cards into it with add_items: { type: "sticky" | "task", text, grid: "<id>", column: <number, name or date>, lane: <number or name> }. On a timeline, add Gantt bars with { type: "bar", text, grid, lane, start, due, progress, after: [refs or ids] }.' };
  }

  if (name === 'hidden_writing') {
    const r = await retroState(board);
    if (a.action === 'on') {
      if (r.hide.on) return { hidden_writing: true, note: 'Already on' };
      await putDocs([{ path: bdoc(board, 'mode/hide'), data: { on: true, s: uid(), by: BY, at: Date.now() } }]);
      return { hidden_writing: true, note: 'New stickies, text and tasks are now visible only to their authors until revealed.' };
    }
    if (a.action === 'off') {
      const n = all.filter((i) => isHidden(i, r)).length;
      await putDocs([{ path: bdoc(board, 'mode/hide'), data: { on: false, s: r.hide.s || '', by: BY, at: Date.now() } }]);
      return { hidden_writing: false, revealed: n };
    }
    return { hidden_writing: r.hide.on, hidden_cards: all.filter((i) => isHidden(i, r)).length, started_by: r.hide.on ? r.hide.by : undefined };
  }

  if (name === 'voting') {
    let r = await retroState(board);
    const put = (d) => putDocs([{ path: bdoc(board, 'mode/vote'), data: { ...d, by: BY, at: Date.now() } }]);
    if (a.action === 'start') {
      const n = clampN(a.votes_per_person, 1, 20, 3);
      await put({ st: 'live', s: uid(), n, show: a.show_others === true });
      return { voting: 'live', votes_per_person: n, note: `Everyone on the board now has ${n} votes: a click on a card adds one. Call voting stop to show the results.` };
    }
    if (a.action === 'clear') { await put({ st: 'idle' }); return { voting: 'idle' }; }
    if (a.action === 'stop') {
      if (r.vote.st !== 'live') throw new Error('No vote is running');
      const { st, ...rest } = r.vote; await put({ ...rest, st: 'results' }); r = { ...r, vote: { ...r.vote, st: 'results' } };
    }
    if (a.action === 'sort') {
      if (r.vote.st === 'idle') throw new Error('No vote results to sort by');
      const moves = Plan.sortByVotes(all, r.tally), moved = [];
      for (const m of moves) { const it = byId.get(m.id); if (it) { it.x = m.x; it.y = m.y; moved.push(it); } }
      await save(board, moved);
      return { moved: moved.length };
    }
    const ranked = Object.entries(r.tally).filter(([id]) => byId.has(id)).sort((p, q) => q[1] - p[1]).slice(0, 40).map(([id, n]) => ({ id, votes: n, type: byId.get(id).type, text: label(byId.get(id), r) }));
    return { voting: r.vote.st, votes_per_person: r.vote.n, voters: r.voters, ranked };
  }

  if (name === 'export_markdown') {
    const [r, meta] = await Promise.all([retroState(board), getDoc(board === 'main' ? 'board/meta' : 'boards/' + board)]);
    let list = all;
    if (Array.isArray(a.ids) && a.ids.length) {
      const ids = new Set(a.ids.map(String));
      for (const i of all) if (ids.has(i.id)) { if (isGrid(i)) gridMembers(i, all).forEach((m) => ids.add(m.id)); if (i.type === 'section') all.filter((m) => ownerOf(m, all) === i).forEach((m) => ids.add(m.id)); }
      list = all.filter((i) => ids.has(i.id) || (i.type === 'link' && ids.has(i.a) && ids.has(i.b)));
    }
    return { markdown: Plan.markdown(list, { title: meta && meta.title, plain, hidden: (i) => isHidden(i, r), votes: r.vote.st !== 'idle' ? r.tally : {}, boardUrl: (bid) => APP_URL + '#b=' + bid }) };
  }

  if (name === 'sync_tasks') {
    const want = Array.isArray(a.ids) && a.ids.length ? new Set(a.ids.map(String)) : null;
    const tasks = all.filter((i) => i.type === 'task' && i.src && (!want || want.has(i.id)));
    const updated = [], needs_agent = [], failed = [];
    for (const t of tasks) {
      if (Plan.SOURCES[t.src.p] && Plan.SOURCES[t.src.p].read) { if (await pullTask(t)) updated.push(t); else failed.push({ id: t.id, url: t.src.url }); }
      else needs_agent.push({ id: t.id, tracker: t.src.p, key: t.src.key, url: t.src.url });
    }
    await save(board, updated);
    return { updated: updated.map((i) => summary(i, all)), needs_agent, failed };
  }

  if (name === 'add_items') {
    const list = Array.isArray(a.items) ? a.items.slice(0, 200) : [];
    const refs = new Map(), made = [], touched = new Set(), touchedGrids = new Set(), deps = [];
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
    const rank = (t) => (t === 'section' || t === 'timeline' || t === 'table' ? 0 : t === 'link' ? 2 : t === 'bar' ? 0.5 : 1);
    const order = [...list].sort((p, q) => rank(p.type) - rank(q.type));
    for (const spec of order) {
      const t = spec.type; let it;
      if (t === 'section') {
        it = { id: uid(), type: 'section', x: num(spec.x) ?? 0, y: num(spec.y) ?? 0, w: num(spec.w) ?? 640, h: num(spec.h) ?? 420, color: stickyColor(spec.color) || 'gray', title: str(spec.title ?? spec.text, 120) || 'Нова секція', z: ++z, by: BY };
        if (spec.x == null || spec.y == null) { const p = slot(it.w, it.h); it.x = p.x; it.y = p.y; }
        if (spec.w != null || spec.h != null) it.autofit = false;
      } else if (t === 'timeline' || t === 'table') {
        it = { id: uid(), type: t, x: 0, y: 0, w: 0, h: 0, color: stickyColor(spec.color) || 'gray', title: t === 'timeline' ? 'Таймлайн' : 'Таблиця', z: ++z, by: BY };
        if (t === 'timeline') Object.assign(it, { start: Plan.thisMonday(Date.now()), unit: 'week', n: 6, len: 14, k: 1, lanes: [], names: [] });
        else Object.assign(it, { cols: ['Колонка 1', 'Колонка 2', 'Колонка 3'], rows: [], cells: [] });
        if (t === 'timeline' && spec.unit === 'sprint' && spec.columns == null) it.n = 4;
        gridFields(it, spec);
        const d = Plan.dims(it), cw = t === 'timeline' ? (it.unit === 'day' ? 220 : 300) : it.kind === 'matrix' ? 480 : 320;
        const lh = it.kind === 'matrix' ? 380 : d.rows.length ? 250 : 560;
        Object.assign(it, Plan.sizeFor(it, cw, lh));
        if (num(spec.w) != null) it.w = Math.max(num(spec.w), d.side + d.nc * 80);
        if (num(spec.h) != null) it.h = Math.max(num(spec.h), Plan.TOP + d.nr * 80);
        if (spec.x != null && spec.y != null) { it.x = num(spec.x); it.y = num(spec.y); } else { const p = slot(it.w, it.h + 50); it.x = p.x; it.y = p.y + 50; }
      } else if (t === 'bar') { // a task bar: on a timeline its dates give x and width, its lane and track give y
        it = { id: uid(), type: 'bar', text: '', start: Plan.isoOf(Plan.localDay(Date.now())), due: Plan.isoOf(Plan.localDay(Date.now()) + 4), pct: 0, color: stickyColor(spec.color) || 'pink', w: 160, h: Plan.BAR_H, z: ++z, by: BY };
        barFields(it, spec);
        const g = spec.grid != null ? resolve(spec.grid) : null;
        if (spec.grid != null && (!g || g.type !== 'timeline')) throw new Error(`No timeline "${spec.grid}" for the bar`);
        if (g) {
          if (spec.start == null && spec.column != null) { const c = Plan.column(g, colIndex(g, spec.column)); const n = Plan.dayOf(it.due) - Plan.dayOf(it.start); it.start = Plan.isoOf(c.from); it.due = Plan.isoOf(c.from + n); }
          const lane = rowIndex(g, spec.lane ?? spec.row), track = num(spec.track) != null ? Math.max(0, num(spec.track) - 1) : Plan.nextTrack(g, lane, gridMembers(g, all.concat(made)));
          Plan.placeBar(g, it, lane, track); touchedGrids.add(g);
          const home = geoSec(it, all.concat(made)); it.sec = home ? home.id : null;
        } else {
          it.w = Math.max(40, (Plan.dayOf(it.due) - Plan.dayOf(it.start) + 1) * 24);
          if (spec.x != null && spec.y != null) { it.x = num(spec.x); it.y = num(spec.y); } else { const p = slot(it.w, it.h); it.x = p.x; it.y = p.y; }
        }
        for (const dep of Array.isArray(spec.after) ? spec.after.slice(0, 20) : []) deps.push([dep, it]);
      } else if (t === 'link') {
        const A = resolve(spec.from), B = resolve(spec.to);
        if (!A || !B || !isCard(A) || !isCard(B) || A === B) throw new Error(`Link needs "from" and "to" pointing at two different cards (got ${spec.from} → ${spec.to})`);
        it = { id: uid(), type: 'link', a: A.id, b: B.id, z: ++z, by: BY };
        const lab = str(spec.label, 60); if (lab && lab.trim()) it.label = lab.trim();
        if (ROPE_COLORS.includes(spec.color) && spec.color !== 'gray') it.color = spec.color;
        if (spec.arrow === false) it.flow = false;
        if (spec.dash === true) it.dash = true;
        if (spec.thick === true) it.thick = true;
      } else if (t === 'sticky' || t === 'text' || t === 'web' || t === 'image' || t === 'node' || t === 'task') {
        if (t === 'task') {
          it = { id: uid(), type: 'task', w: num(spec.w) ?? 280, h: 120, text: '', status: 'todo' };
          taskFields(it, spec);
          if (it.src && (await pullTask(it))) taskFields(it, { ...spec, url: undefined }); // what the caller passed wins over the tracker
        }
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
          const linked = boardOfUrl(url);
          if (linked) { // a link to another JamBoard board becomes a board card (cover and preview in the app)
            const meta = await getDoc('boards/' + linked);
            it = { id: uid(), type: 'board', bid: linked, w: num(spec.w) ?? 300, h: 250 };
            if (meta && typeof meta.title === 'string') it.title = meta.title.slice(0, 120);
          }
        }
        if (t === 'image') {
          const url = safeHttps(spec.url); if (!url) throw new Error('image needs an https url');
          const sz = await imageSize(url), ar = sz && sz.w > 0 && sz.h > 0 ? sz.h / sz.w : 0.75;
          const w = clampN(spec.w, 60, 2000, sz ? Math.min(360, sz.w) : 320);
          it = { id: uid(), type: 'image', url, w, h: num(spec.h) ?? Math.round(w * ar) };
        }
        if (t === 'web' && !it) {
          const url = safeHttps(spec.url);
          const ym = YT_RE.exec(url);
          it = { id: uid(), type: 'web', url, w: num(spec.w) ?? (ym ? 360 : 320), h: ym ? 290 : 260 };
          if (ym) it.yt = ym[1];
          const meta = await webMeta(url, !!ym); for (const k in meta) if (meta[k] !== undefined) it[k] = meta[k];
        }
        it.z = ++z; it.by = BY;
        const g = spec.grid != null ? resolve(spec.grid) : null;
        if (spec.grid != null && (!g || !isGrid(g))) throw new Error(`No timeline or table "${spec.grid}"`);
        const sec = !g && spec.section != null ? resolve(spec.section) : null;
        if (!g && spec.section != null && (!sec || sec.type !== 'section')) throw new Error(`No section "${spec.section}"`);
        if (g) { // into a timeline or table cell, under the cards already there
          const cell = matrixCell(g, spec.cell) || [colIndex(g, spec.column), rowIndex(g, spec.lane ?? spec.row)];
          const q = spec.x != null && spec.y != null ? Plan.snap(g, { ...it, x: num(spec.x), y: num(spec.y) }, cell) : Plan.slotIn(g, cell, it.w, it.h, gridMembers(g, all.concat(made)));
          it.x = q.x; it.y = q.y; it.grid = g.id; it.cell = cell; touchedGrids.add(g);
          const home = geoSec(it, all.concat(made)); it.sec = home ? home.id : null;
        } else {
          if (spec.x != null && spec.y != null) { it.x = num(spec.x); it.y = num(spec.y); }
          else { const p = sec ? secSlot(sec, it.w, it.h) : slot(it.w, it.h); it.x = p.x; it.y = p.y; }
          it.sec = sec ? sec.id : null;
          if (sec) touched.add(sec);
        }
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
    for (const [dep, it] of deps) { // "after": the bars this one waits for, as links between the two bars
      const A = resolve(dep); if (!A || !isBar(A) || A === it) throw new Error(`after: "${dep}" is not another bar`);
      const l = { id: uid(), type: 'link', a: A.id, b: it.id, z: ++z, by: BY }; made.push(l);
    }
    const everything = all.concat(made), extra = [];
    for (const g of touchedGrids) for (const m of relayout(g, everything)) if (!made.includes(m) && !extra.includes(m)) extra.push(m);
    for (const sec of touched) if (refit(sec, everything) && !made.includes(sec)) extra.push(sec);
    for (const sec of made.filter((i) => i.type === 'section')) refit(sec, everything);
    await save(board, made.concat(extra));
    return { added: made.map((i) => ({ id: i.id, type: i.type, ref: [...refs].find(([, v]) => v === i)?.[0] })) };
  }

  if (name === 'update_items') {
    const changed = new Set(), touched = new Set(), grids = new Set();
    for (const c of (a.changes || []).slice(0, 200)) {
      const it = byId.get(String(c.id)); if (!it) throw new Error('No item ' + c.id);
      const was = ownerOf(it, all), ox = it.x, oy = it.y, ow = it.w, oh = it.h;
      const offs = isGrid(it) ? memberOffsets(it, all) : null, d0 = isGrid(it) ? Plan.dims(it) : null;
      if (it.type === 'task') taskFields(it, c);
      if (isBar(it)) barFields(it, c);
      if (isGrid(it)) {
        gridFields(it, c);
        if (c.w == null && c.h == null) Object.assign(it, Plan.sizeFor(it, d0.cw, d0.lh)); // cells keep their size
      }
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
      const og = it.grid && byId.get(it.grid); if (og && isGrid(og)) grids.add(og);
      if (c.grid != null && isBar(it)) {
        if (c.grid === '') { delete it.grid; delete it.cell; }
        else { const g = byId.get(String(c.grid)); if (!g || g.type !== 'timeline') throw new Error('No timeline ' + c.grid); const lane = rowIndex(g, c.lane ?? c.row); Plan.placeBar(g, it, lane, Plan.nextTrack(g, lane, gridMembers(g, all).filter((m) => m !== it))); grids.add(g); }
      } else if (isBar(it) && it.grid && (c.lane != null || c.row != null || c.track != null)) {
        const g = byId.get(it.grid); if (g && g.type === 'timeline') { const lane = c.lane != null || c.row != null ? rowIndex(g, c.lane ?? c.row) : Plan.cellOf(g, it)[1]; Plan.placeBar(g, it, lane, num(c.track) != null ? Math.max(0, num(c.track) - 1) : Plan.trackOf(g, it)); }
      } else if (c.grid != null && isCard(it)) {
        if (c.grid === '') { delete it.grid; delete it.cell; }
        else {
          const g = byId.get(String(c.grid)); if (!g || !isGrid(g)) throw new Error('No timeline or table ' + c.grid);
          const cell = matrixCell(g, c.cell) || [colIndex(g, c.column), rowIndex(g, c.lane ?? c.row)];
          const q = Plan.slotIn(g, cell, it.w, it.h, gridMembers(g, all).filter((m) => m !== it));
          it.x = q.x; it.y = q.y; it.grid = g.id; it.cell = cell; grids.add(g);
          const home = geoSec(it, all); it.sec = home ? home.id : null;
        }
      }
      if (c.label != null && it.type === 'link') { const l = String(c.label).trim().slice(0, 60); if (l) it.label = l; else delete it.label; }
      if (c.style != null && it.type === 'text' && TEXT_STYLES.includes(c.style)) it.ts = c.style;
      if (c.color != null) {
        if (it.type === 'link') { if (c.color === 'gray') delete it.color; else if (ROPE_COLORS.includes(c.color)) it.color = c.color; }
        else if (stickyColor(c.color)) it.color = stickyColor(c.color);
      }
      for (const k of ['x', 'y', 'w', 'h']) if (num(c[k]) != null && it.type !== 'link') it[k] = num(c[k]);
      if ((c.w != null || c.h != null) && it.type === 'section') it.autofit = false;
      if (isGrid(it)) {
        const d = Plan.dims(it); it.w = Math.max(it.w, d.side + d.nc * 80); it.h = Math.max(it.h, Plan.TOP + d.nr * 80);
        if (it.x !== ox || it.y !== oy || it.w !== ow || it.h !== oh || offs.some((o) => o.c[0] >= d.nc || o.c[1] >= d.nr) || c.unit != null || c.start != null || c.columns != null || c.sprint_days != null) { resnap(it, offs, all).forEach((m) => changed.add(m)); offs.forEach((o) => changed.add(o.m)); }
        grids.add(it);
      }
      if (isBar(it) && it.grid) { const g = byId.get(it.grid); if (g && g.type === 'timeline') { Plan.placeBar(g, it, Plan.cellOf(g, it)[1], Plan.trackOf(g, it)); grids.add(g); } }
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
    for (const g of grids) relayout(g, all).forEach((m) => changed.add(m));
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
    const freed = all.filter((i) => isCard(i) && !ids.has(i.id) && ((i.sec && ids.has(i.sec)) || (i.grid && ids.has(i.grid)))).map((i) => { if (i.sec && ids.has(i.sec)) i.sec = null; if (i.grid && ids.has(i.grid)) { delete i.grid; delete i.cell; } return i; });
    const owners = new Set(all.filter((i) => ids.has(i.id)).map((i) => ownerOf(i, all)).filter((s) => s && !ids.has(s.id)));
    const rest = all.filter((i) => !ids.has(i.id)), refitted = [...owners].filter((s) => refit(s, rest));
    await delDocs([...ids].map((id) => itemsColl(board) + '/' + id));
    await coverStale(board);
    if (freed.length || refitted.length) await save(board, [...new Set([...freed, ...refitted])]);
    return { deleted: [...ids] };
  }
  throw new Error('Unknown tool ' + name);
}

// ---------- MCP over HTTP (JSON-RPC 2.0) ----------
const PROTOCOLS = ['2025-06-18', '2025-03-26', '2024-11-05'];
const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'content-type, mcp-protocol-version, mcp-session-id, authorization', 'Access-Control-Allow-Methods': 'POST, GET, OPTIONS' };
const json = (body, status = 200) => new Response(body == null ? null : JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });

async function handleRpc(m, scope) {
  if (!m || m.jsonrpc !== '2.0' || typeof m.method !== 'string') return { jsonrpc: '2.0', id: m && m.id != null ? m.id : null, error: { code: -32600, message: 'Invalid request' } };
  const reply = (result) => (m.id == null ? null : { jsonrpc: '2.0', id: m.id, result });
  switch (m.method) {
    case 'initialize': {
      const want = m.params && m.params.protocolVersion;
      return reply({ protocolVersion: PROTOCOLS.includes(want) ? want : PROTOCOLS[0], capabilities: { tools: {} }, serverInfo: { name: 'jamboard', version: '1.1.0' }, instructions: 'JamBoard is a shared whiteboard. Read a board with get_board before editing it. Prefer add_items with refs to build sections, stickies and ropes in one call; leave x/y out for automatic layout. Pictures found with other tools (design references, screenshots) go on the board as image items with their https url.' + (scope ? ' This connection reaches only the boards its owner shared with it (list_boards).' : '') });
    }
    case 'ping': return reply({});
    case 'tools/list': return reply({ tools: TOOLS });
    case 'tools/call': {
      const name = m.params && m.params.name, args = (m.params && m.params.arguments) || {};
      try { const out = await callTool(name, args, scope); return reply({ content: [{ type: 'text', text: JSON.stringify(out) }] }); }
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
  const bearer = (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
  const token = url.searchParams.get('token') || (TOKEN_RE.test(bearer) ? bearer : '');
  const key = url.searchParams.get('key') || (token ? '' : bearer);
  let scope = null; // null = admin key: every board
  if (token) {
    if (!TOKEN_RE.test(token)) return json({ error: 'unauthorized' }, 401);
    try { scope = await tokenScope(token); } catch { return json({ error: 'token check failed' }, 503); }
    if (!scope) return json({ error: 'unauthorized: this token was revoked or has expired. Make a new one in JamBoard → Налаштування.' }, 401);
  } else if (!MCP_KEY || !(await eq(key, MCP_KEY))) return json({ error: 'unauthorized' }, 401);
  if (req.method !== 'POST') return new Response('Use POST', { status: 405, headers: { ...CORS, Allow: 'POST, OPTIONS' } });
  let body; try { body = await req.json(); } catch { return json({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }, 400); }
  if (Array.isArray(body)) { const out = (await Promise.all(body.map((m) => handleRpc(m, scope)))).filter(Boolean); return out.length ? json(out) : new Response(null, { status: 202, headers: CORS }); }
  const out = await handleRpc(body, scope);
  return out ? json(out) : new Response(null, { status: 202, headers: CORS });
}

if (globalThis.Deno) Deno.serve(handler);
