# JamBoard

Спільна дошка для команди: стікери, секції, текст, мотузки між картками, штампи, коментарі, картки-посилання з превʼю.
Один файл `index.html`, без збірки.

## Запуск на GitHub Pages + Supabase

1. **Supabase.** Створіть проєкт на https://supabase.com (безкоштовний план).
   - Відкрийте SQL Editor і виконайте `supabase/schema.sql`. Це створить таблицю дошок, увімкне realtime і створить сховище картинок.
2. **Ключі.** У Project Settings → API скопіюйте `Project URL` і публічний `anon` ключ. Вставте їх у `config.js` (зразок у `config.example.js`):
   ```js
   window.JAMBOARD_CONFIG = { supabaseUrl: 'https://xxxx.supabase.co', supabaseAnonKey: '...', bucket: 'jamboard' };
   ```
   `anon` ключ публічний, його можна комітити. **Ніколи не вставляйте сюди `service_role` ключ.**
3. **GitHub Pages.** Settings → Pages → Deploy from a branch → `main` / root. Дошка буде за адресою `https://<user>.github.io/<repo>/`.
   Поділитися конкретною дошкою: кнопка «Поділитися» дає посилання з `#b=<id>`.

Без `config.js` (або з `null`) дошка працює лише локально в браузері.

## Безпека прототипу

Дошка відкрита: будь-хто з посиланням може читати й змінювати всі дошки в цьому проєкті Supabase. Для внутрішнього тесту цього досить. Перед ширшим запуском потрібна авторизація або секретні посилання на дошки.
