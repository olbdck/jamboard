# JamBoard

Спільна дошка для команди: стікери, секції, текст, мотузки між картками, штампи, коментарі, картки-посилання з превʼю.
Один файл `index.html`, без збірки.

## Локальний запуск

1. У папці проєкту запустіть простий вебсервер:
   ```sh
   cd jamboard
   python3 -m http.server 8000
   ```
   і відкрийте http://localhost:8000/ (можна й `npx serve .`). Збірка не потрібна. Відкривати `index.html` подвійним кліком не варто: через `file://` браузер може не завантажити шрифти й `config.js`.
2. **Дані.** `config.js` уже вказує на робочий проєкт Supabase, тож локальна копія показує ті самі дошки, що й https://olbdck.github.io/jamboard/, і всі зміни одразу видно іншим. Потрібен інтернет (supabase.co і бібліотека supabase-js з cdn.jsdelivr.net).
   - Окремий тестовий проєкт: створіть новий проєкт Supabase, виконайте `supabase/schema.sql` і `supabase/security.sql`, вставте його URL і publishable/anon-ключ у `config.js`.
   - Повністю офлайн: поставте `window.JAMBOARD_CONFIG = null;` у `config.js` (як у `config.example.js`). Тоді дошка зберігається лише в цьому браузері.
3. **MCP-функція локально** (необовʼязково): `supabase functions serve jamboard-mcp --env-file .env` через [Supabase CLI](https://supabase.com/docs/guides/cli), де `.env` містить `JAMBOARD_MCP_KEY=...`. Розгорнути в хмару: `supabase functions deploy jamboard-mcp --project-ref <ref>` (налаштування `verify_jwt = false` уже в `supabase/config.toml`). Секрети (`JAMBOARD_MCP_KEY`, `service_role`) задаються лише в Supabase → Edge Functions → Secrets або в локальному `.env`, ніколи не в git.

## Запуск на GitHub Pages + Supabase

1. **Supabase.** Створіть проєкт на https://supabase.com (безкоштовний план).
   - Відкрийте SQL Editor і виконайте `supabase/schema.sql`. Це створить таблицю дошок, увімкне realtime і створить сховище картинок.
   - Потім виконайте `supabase/security.sql`: обмеження на масове видалення чи перезапис, кошик видалених записів (`docs_trash`, з нього можна все відновити), ліміти розміру.
2. **Ключі.** У Project Settings → API скопіюйте `Project URL` і публічний `anon` ключ. Вставте їх у `config.js` (зразок у `config.example.js`):
   ```js
   window.JAMBOARD_CONFIG = { supabaseUrl: 'https://xxxx.supabase.co', supabaseAnonKey: '...', bucket: 'jamboard' };
   ```
   `anon` ключ публічний, його можна комітити. **Ніколи не вставляйте сюди `service_role` ключ.**
3. **GitHub Pages.** Settings → Pages → Deploy from a branch → `main` / root. Дошка буде за адресою `https://<user>.github.io/<repo>/`.
   Поділитися конкретною дошкою: кнопка «Поділитися» дає посилання з `#b=<id>`.

Без `config.js` (або з `null`) дошка працює лише локально в браузері.

## Керування дошкою з Claude (MCP)

`supabase/functions/jamboard-mcp/index.ts` — MCP-сервер: Claude читає дошки, додає стікери, секції, текст, мотузки й картки-посилання, змінює й видаляє їх, керує таймером.

1. Supabase → Edge Functions → **Deploy a new function → Via Editor**. Назва `jamboard-mcp`, вставте вміст `index.ts`, Deploy.
2. У налаштуваннях функції вимкніть **Verify JWT** (Enforce JWT verification).
3. Edge Functions → **Secrets** → додайте `JAMBOARD_MCP_KEY` = довгий випадковий рядок (це пароль до MCP).
4. Claude → Settings → Connectors → **Add custom connector**, URL:
   `https://<project>.supabase.co/functions/v1/jamboard-mcp?key=<JAMBOARD_MCP_KEY>`

Інструменти: `list_boards`, `get_board`, `add_items` (стікери, текст, секції, мотузки, картки-посилання, штампи, коментарі), `update_items`, `delete_items`, `create_board`, `timer`.
У новому проєкті Supabase таблиці треба явно дати доступ ролям (див. `grant` у `schema.sql`), зокрема `service_role` для MCP.
Зміни з’являються на відкритих дошках одразу.

## Безпека прототипу

Дошка відкрита: будь-хто з посиланням може читати й змінювати всі дошки в цьому проєкті Supabase. Для внутрішнього тесту цього досить. Перед ширшим запуском потрібна авторизація або секретні посилання на дошки.
