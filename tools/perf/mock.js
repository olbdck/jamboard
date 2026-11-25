// in-memory stand-in for supabase-js: jb_* RPCs over a Map, one fake channel per board
(() => {
  const rows = new Map(window.__SEED || []);
  const chans = new Map();
  const parent = (p) => p.slice(0, p.lastIndexOf('/'));
  function bc(topic, ev, payload) { const c = chans.get(topic); if (c) (c.h['broadcast:' + ev] || []).forEach((f) => f({ payload })); }
  const boardOf = (p) => (/^boards\/([A-Za-z0-9_-]+)/.exec(p) || [])[1];
  window.__mock = {
    rows,
    remote(path, data) { rows.set(path, data); bc('jb:' + boardOf(path), 'row', { path, data }); },
    gone(path) { rows.delete(path); bc('jb:' + boardOf(path), 'row', { path, gone: true }); },
    peer(bid, payload) { bc('jb:' + bid, 'p', payload); },
  };
  window.supabase = { createClient() {
    return {
      rpc(name, a) {
        let data = null;
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
