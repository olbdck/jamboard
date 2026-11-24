# JamBoard

Спільна дошка для команди: стікери, секції, текст, мотузки між картками, штампи, коментарі, картки-посилання з превʼю.
Один файл `index.html`, без збірки.

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
