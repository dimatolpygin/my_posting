-- ─────────────────────────────────────────────────────────────────────────────
-- Этап 6. Учёт переходов по ссылкам из постов.
--
-- Зачем вообще редиректор. Kwork не отдаёт источник трафика: Метрику туда не
-- поставить, а в отзывах человек не пишет, из какой темы пришёл. Без своего
-- перехватчика мы знаем только «сколько тем опубликовано» и не знаем, какая
-- из них хоть что-то принесла, — масштабировать будет нечего.
--
-- Схема: в посте стоит `https://{домен}/k/{id поста}` → наш роут пишет факт
-- перехода и отправляет человека на профиль Kwork. Тот же механизм обслуживает
-- реф-ссылки (виртуальная карта, сервер) и короткие адреса Телеграма и MAX
-- для автоответов группы: ссылка MAX длиной за сотню символов в каждом ответе
-- раздувает текст и выглядит подозрительно.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS clicks (
  id          bigserial   PRIMARY KEY,
  -- Пост, из которого пришли. NULL у постоянных ссылок (/k/tg, /k/max) и у постов,
  -- удалённых после перехода: терять из-за этого сам факт перехода незачем.
  post_id     bigint      REFERENCES posts (id) ON DELETE SET NULL,
  group_id    integer     REFERENCES groups (id) ON DELETE SET NULL,
  keyword_id  integer     REFERENCES keywords (id) ON DELETE SET NULL,
  target      text        NOT NULL,
  -- sha256(ip + user-agent + соль). Сырой IP не храним: он персональные данные,
  -- а для «сколько разных людей пришло» хватает отпечатка.
  visitor     text,
  user_agent  text,
  referer     text,
  is_bot      boolean     NOT NULL DEFAULT false,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS clicks_post_idx ON clicks (post_id, created_at DESC);
-- Частичный индекс: в отчёте боты не участвуют почти никогда, а их в таблице
-- будет заметно больше, чем людей.
CREATE INDEX IF NOT EXISTS clicks_live_idx ON clicks (created_at DESC) WHERE is_bot = false;
CREATE INDEX IF NOT EXISTS clicks_keyword_idx ON clicks (keyword_id, created_at DESC);

COMMENT ON TABLE clicks IS
  'Переходы по ссылкам из постов. Главный экран проекта: по нему решается, какие '
  'кластеры ключей масштабировать, а какие закрывать.';
COMMENT ON COLUMN clicks.is_bot IS
  'Робот, а не человек. Боты пишутся в таблицу, а не отбрасываются: иначе не видно, '
  'что именно отсеклось. В отчёте они исключены.';
COMMENT ON COLUMN clicks.visitor IS
  'Отпечаток посетителя sha256(ip + user-agent + соль). Уникальные переходы считаются '
  'по нему: один человек, кликнувший трижды, — это один переход.';

-- ─────────────────────────────────────────────────────────────────────────────
-- Куда уводит редиректор. Раньше в настройках лежали сами ссылки для текста
-- поста (`ad_link`, `ref_link_visa`, `ref_link_vps`) — теперь их собирает код
-- из PUBLIC_BASE_URL и номера поста, потому что адрес у каждого поста свой.
-- В настройках остаются только конечные адреса.
-- ─────────────────────────────────────────────────────────────────────────────
DELETE FROM settings WHERE key IN ('ad_link', 'ref_link_visa', 'ref_link_vps');

INSERT INTO settings (key, value, title) VALUES
  ('visa_url', 'https://t.me/zarub_robot?start=ref_ccNWK4',
   'Куда уводит /k/visa — выпуск виртуальной карты'),
  ('vps_url', 'https://rdp-onedash.ru/r/4db49f',
   'Куда уводит /k/vps — сервер под ИИ-системы'),
  ('tg_url', '',
   'Куда уводит /k/tg — личный Телеграм для автоответов группы'),
  ('max_url', '',
   'Куда уводит /k/max — профиль в MAX для автоответов группы')
ON CONFLICT (key) DO NOTHING;

-- Соль отпечатка. Своя у каждой установки и не в git: с общей солью хеш
-- превращается в справочник, по которому IP восстанавливается перебором.
INSERT INTO settings (key, value, title)
VALUES ('click_salt', md5(random()::text || clock_timestamp()::text),
        'Соль для отпечатка посетителя. Менять не нужно: смена обнулит склейку переходов.')
ON CONFLICT (key) DO NOTHING;
