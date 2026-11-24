# JamBoard: notes for Claude

- Communicate with Oleh in Ukrainian. Original design (no FigJam copies); Orbit Pro look, raspberry accent (#c2185b / #ff6b9d), WCAG AA text, light/dark/auto themes. Top quality goal: maximum smoothness of animation, actions and controls.
- Everything is one file, `index.html` (vanilla JS, no build). `config.js` holds the Supabase URL + publishable key (safe to commit; never a secret/service_role key).
- Hosting: GitHub Pages from `main` root (https://olbdck.github.io/jamboard/). The claude.ai artifact copy is frozen at v10; don't update it.
- Data: Supabase table `docs(path, coll, data jsonb)` — a tiny document store. Board items live at `items/<id>` (main board) or `boards/<bid>/items/<id>`; board meta at `board/meta` and `boards/<bid>`. Every write carries `rev`; older revs are ignored. New item types/fields need **no** database change; only auth, access rules or limits do (then add SQL to `supabase/schema.sql` and ask Oleh to run it).
- `startSupabase()` in index.html shims the claude.ai `db`/`room`/`assets` API on Supabase: REST load first, realtime `postgres_changes` for live updates, 2 s polling if realtime fails; presence via a broadcast channel `room`. Without config it runs local-only.
- Item types: sticky, image, section, stamp, comment, text, link (rope: a, b, label, color, flow), web (link card: url, yt, title, desc, site, img, icon). Values from others are set via textContent; only https:// links.
- The cloud container can't reach supabase.co or cdn.jsdelivr.net: test with Playwright and a mocked `window.supabase`, and say real-backend checks need Oleh's browser.
- Sections: cards remember their section in `sec` (set on drop, wrap, section draw/resize); overlapping sections never take each other's cards. Stamps/pins and legacy cards fall back to geometry (smallest containing section).
- Shared timer per board: doc `board/timer` or `boards/<bid>/timer/state` = { dur, run, end } | { dur, left } | { dur } (epoch ms).
- MCP server: `supabase/functions/jamboard-mcp/index.ts` (Supabase Edge Function, no deps, stateless JSON-RPC; also runs under Node for tests). Auth: `?key=` = secret `JAMBOARD_MCP_KEY`; DB key from `JAMBOARD_DB_KEY` or the default service-role env. Keep its item shapes in sync with index.html when adding item types.

