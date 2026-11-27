// in-memory stand-in for supabase-js: jb_* RPCs over a Map, one fake channel per board
(() => {
  const rows = new Map(window.__SEED || []);
  const chans = new Map();
  const parent = (p) => p.slice(0, p.lastIndexOf('/'));
  function bc(topic, ev, payload) { const c = chans.get(topic); if (c) (c.h['broadcast:' + ev] || []).forEach((f) => f({ payload })); }
  const boardOf = (p) => (/^boards\/([A-Za-z0-9_-]+)/.exec(p) || [])[1];
  // version history as in supabase/history.sql: one log row per item change, quick edits by the same person folded
  const log = []; let logId = 0;
  const ITEM = /^boards\/([A-Za-z0-9_-]{20,64})\/items\/[A-Za-z0-9_-]+$/;
  const strip = (d, keys) => { const o = { ...d }; keys.forEach((k) => delete o[k]); return JSON.stringify(Object.keys(o).filter((k) => o[k] !== null).sort().map((k) => [k, o[k]])); };
  function logWrite(path, data, who, at) {
    const m = ITEM.exec(path); if (!m) return;
    const k = who ? (who.v || who.n || '') + (who.r ? '/' + who.r : '') : '';
    const now = at || Date.now();
    if (data) {
      let last = null; for (let i = log.length - 1; i >= 0; i--) if (log[i].path === path) { last = log[i]; break; }
      if (last && last.data && strip(last.data, ['rev']) === strip(data, ['rev'])) return;
      if (last && last.data && last.wk === k && k && last.at > now - 120000) { last.data = data; last.who = who || last.who; last.at = now; return; }
    }
    log.push({ id: ++logId, bid: m[1], path, data: data || null, who: who || null, wk: k, at: now });
  }
  for (const [p, d] of rows) logWrite(p, d, { seed: true }, Date.now() - 86400000);
  const MOVE = ['x', 'y', 'z', 'rev', 'sec', 'grid', 'cell'];
  function history(bid, before, limit) {
    const out = [];
    for (let i = log.length - 1; i >= 0 && out.length < Math.min(limit || 200, 500); i--) {
      const l = log[i]; if (l.bid !== bid || (before && l.id >= before)) continue;
      let p = null; for (let j = i - 1; j >= 0; j--) if (log[j].path === l.path) { p = log[j]; break; }
      const d = l.data || (p && p.data), op = !l.data ? 'del' : !p || !p.data ? 'add' : strip(l.data, MOVE) === strip(p.data, MOVE) ? 'move' : 'edit';
      out.push({ id: l.id, path: l.path, at: new Date(l.at).toISOString(), who: l.who, op, type: d && d.type, label: d && !d.hid ? String(d.text || d.title || d.label || d.emoji || '').slice(0, 80) || null : null });
    }
    return out;
  }
  function at(bid, id) {
    const last = new Map();
    for (const l of log) if (l.bid === bid && l.id <= id) last.set(l.path, l.data);
    return [...last].filter(([, d]) => d).map(([path, data]) => ({ path, data }));
  }
  window.__mock = {
    rows, log,
    noHistory: false, // true: act like a database where supabase/history.sql was not run yet
    // someone else's edit, with who made it and (optionally) when
    edit(path, data, who, when) { if (data) rows.set(path, data); else rows.delete(path); logWrite(path, data, who, when); bc('jb:' + boardOf(path), 'row', data ? { path, data } : { path, gone: true }); },
    remote(path, data) { rows.set(path, data); bc('jb:' + boardOf(path), 'row', { path, data }); },
    gone(path) { rows.delete(path); bc('jb:' + boardOf(path), 'row', { path, gone: true }); },
    peer(bid, payload) { bc('jb:' + bid, 'p', payload); },
  };
  window.supabase = { createClient() {
    return {
      rpc(name, a) {
        let data = null;
        const M = window.__mock;
        if (M.noHistory && (a.p_who || name === 'jb_history' || name === 'jb_at')) return Promise.resolve({ data: null, error: { code: 'PGRST202', message: 'Could not find the function public.' + name } });
        if (name === 'jb_history') return Promise.resolve({ data: history(a.p_bid, a.p_before, a.p_limit), error: null });
        if (name === 'jb_at') return Promise.resolve({ data: at(a.p_bid, a.p_id), error: null });
        if (name === 'jb_put') logWrite(a.p_path, a.p_data, a.p_who);
        else if (name === 'jb_del' && rows.has(a.p_path)) logWrite(a.p_path, null, a.p_who);
        if (name === 'jb_get') data = rows.has(a.p_path) ? [{ path: a.p_path, data: rows.get(a.p_path) }] : [];
        else if (name === 'jb_list') data = [...rows].filter(([p]) => parent(p) === a.p_coll).map(([path, data]) => ({ path, data }));
        else if (name === 'jb_put') { rows.set(a.p_path, a.p_data); }
        else if (name === 'jb_del') { rows.delete(a.p_path); }
        return Promise.resolve({ data, error: null });
      },
      channel(topic) {
        const c = { h: {}, on(type, f, cb) { (c.h[type + ':' + f.event] ||= []).push(cb); return c; },
          subscribe(cb) { setTimeout(() => cb('SUBSCRIBED'), 0); return c; },
          send() { return Promise.resolve(); }, track() { return Promise.resolve(); }, untrack() {}, presenceState() { return {}; } };
        chans.set(topic, c); return c;
      },
      removeChannel(c) {},
      storage: { from: () => ({ upload: async () => ({}), getPublicUrl: () => ({ data: { publicUrl: '' } }) }) },
    };
  } };
})();
