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

// ---------- helpers ----------
const isCard = (i) => ['sticky', 'image', 'text', 'web'].includes(i.type);
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
  { name: 'get_board', description: 'Read everything on a board: stickies, text, sections, ropes (links), link cards, stamps, comments. Coordinates are board pixels; a sticky is 200×200. A card\'s "section" is the id of the section it belongs to.', inputSchema: { type: 'object', properties: { board: boardArg } } },
  {
    name: 'add_items',
    description: 'Add items to a board in one go. Types: sticky (text, color), text (text, style h1|h2|p|s), section (title, color; give other items "section": its ref to put them inside — the section grows to fit), link (a rope from "from" to "to", optional label and color), web (url: a link card with preview; YouTube shows the video thumbnail). Leave x/y out to let the board lay items out in a tidy grid (inside their section if given). Use "ref" to name a new item so links and "section" can point at it in the same call; existing ids work too.',
    inputSchema: {
      type: 'object', required: ['items'],
      properties: {
        board: boardArg,
        items: {
          type: 'array', minItems: 1, maxItems: 200,
          items: {
            type: 'object', required: ['type'],
            properties: {
              type: { type: 'string', enum: ['sticky', 'text', 'section', 'link', 'web'] },
              ref: { type: 'string', description: 'Your temporary name for this item, used by other items in this call.' },
              text: { type: 'string' }, title: { type: 'string', description: 'Section title.' },
              style: { type: 'string', enum: TEXT_STYLES, description: 'Text style: h1 heading, h2 subheading, p body, s small.' },
              color: { type: 'string', description: `Sticky/section: ${STICKY_COLORS.join(', ')} (or yellow, orange, blue, green). Rope: ${ROPE_COLORS.join(', ')}.` },
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
    description: 'Change existing items: text, title, color, style, label, position (x, y), size (w, h), section (id, or "" to take a card out of its section). Only the fields you pass change.',
    inputSchema: { type: 'object', required: ['changes'], properties: { board: boardArg, changes: { type: 'array', minItems: 1, maxItems: 200, items: { type: 'object', required: ['id'], properties: { id: { type: 'string' }, text: { type: 'string' }, title: { type: 'string' }, color: { type: 'string' }, style: { type: 'string', enum: TEXT_STYLES }, label: { type: 'string' }, section: { type: 'string' }, x: { type: 'number' }, y: { type: 'number' }, w: { type: 'number' }, h: { type: 'number' } } } } } },
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
      } else if (t === 'sticky' || t === 'text' || t === 'web') {
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
