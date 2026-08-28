import { query } from '../db/pool.js';

/**
 * Записать переход.
 *
 * Группа и ключ не передаются вызовом, а достаются тем же запросом из поста:
 * связь пост → материал → ключ и пост → публикация → группа уже есть в базе,
 * а дублировать её в аргументах — это лишний способ ошибиться.
 */
export async function record({ postId, target, visitor, userAgent, referer, isBot }) {
  if (postId) {
    const { rows } = await query(
      `INSERT INTO clicks (post_id, group_id, keyword_id, target, visitor, user_agent, referer, is_bot)
       SELECT p.id,
              (SELECT pub.group_id FROM publications pub WHERE pub.post_id = p.id ORDER BY pub.id LIMIT 1),
              a.keyword_id,
              $2, $3, $4, $5, $6
         FROM posts p
         LEFT JOIN articles a ON a.id = p.article_id
        WHERE p.id = $1
       RETURNING id`,
      [postId, target, visitor, userAgent, referer, isBot],
    );
    if (rows.length > 0) return rows[0];
    // Поста с таким номером нет — ссылку кто-то подобрал руками или пост удалён.
    // Переход всё равно пишем: без него в отчёте будет необъяснимая дыра.
  }

  const { rows } = await query(
    `INSERT INTO clicks (target, visitor, user_agent, referer, is_bot)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id`,
    [target, visitor, userAgent, referer, isBot],
  );
  return rows[0];
}

/** Сводка за период: сколько всего, сколько людей, сколько разных людей. */
export async function totals(days) {
  const { rows } = await query(
    `SELECT COUNT(*)::int                                            AS всего,
            COUNT(*) FILTER (WHERE is_bot)::int                      AS роботы,
            COUNT(*) FILTER (WHERE NOT is_bot)::int                  AS люди,
            COUNT(DISTINCT visitor) FILTER (WHERE NOT is_bot)::int   AS уникальные
       FROM clicks
      WHERE created_at > now() - ($1 || ' days')::interval`,
    [days],
  );
  return rows[0];
}

/** Переходы по целям: Kwork, карта, сервер, Телеграм, MAX. */
export async function byTarget(days) {
  const { rows } = await query(
    `SELECT target,
            COUNT(*) FILTER (WHERE NOT is_bot)::int                 AS переходы,
            COUNT(DISTINCT visitor) FILTER (WHERE NOT is_bot)::int  AS уникальные
       FROM clicks
      WHERE created_at > now() - ($1 || ' days')::interval
      GROUP BY target
      ORDER BY уникальные DESC, target`,
    [days],
  );
  return rows;
}

/** Переходы по темам. Показываем только те, где переходы были. */
export async function byPost(days, limit = 50) {
  const { rows } = await query(
    `SELECT c.post_id,
            p.title,
            k.phrase                                                AS ключ,
            k.cluster                                               AS кластер,
            COUNT(*) FILTER (WHERE NOT c.is_bot)::int               AS переходы,
            COUNT(DISTINCT c.visitor) FILTER (WHERE NOT c.is_bot)::int AS уникальные,
            MAX(c.created_at)                                       AS последний
       FROM clicks c
       LEFT JOIN posts p ON p.id = c.post_id
       LEFT JOIN keywords k ON k.id = c.keyword_id
      WHERE c.created_at > now() - ($1 || ' days')::interval
        AND c.post_id IS NOT NULL
        AND NOT c.is_bot
      GROUP BY c.post_id, p.title, k.phrase, k.cluster
      ORDER BY уникальные DESC, последний DESC
      LIMIT $2`,
    [days, limit],
  );
  return rows;
}

/**
 * Переходы по кластерам ключей — тот самый экран, по которому принимается
 * решение «масштабировать или закрывать». Считаем и знаменатель: сколько тем
 * этого кластера вообще опубликовано со ссылкой, иначе кластер из трёх тем
 * с двумя переходами выглядит хуже кластера из тридцати с тремя.
 */
export async function byCluster(days) {
  const { rows } = await query(
    `WITH переходы AS (
       SELECT COALESCE(k.cluster, 'без кластера') AS кластер,
              COUNT(*) FILTER (WHERE NOT c.is_bot)::int               AS переходы,
              COUNT(DISTINCT c.visitor) FILTER (WHERE NOT c.is_bot)::int AS уникальные
         FROM clicks c
         JOIN keywords k ON k.id = c.keyword_id
        WHERE c.created_at > now() - ($1 || ' days')::interval
        GROUP BY 1
     ),
     темы AS (
       SELECT COALESCE(k.cluster, 'без кластера') AS кластер,
              COUNT(*)::int AS постов,
              COUNT(*) FILTER (WHERE p.tail_kind = 'kwork')::int AS со_ссылкой
         FROM posts p
         JOIN articles a ON a.id = p.article_id
         JOIN keywords k ON k.id = a.keyword_id
        WHERE p.status = 'published'
        GROUP BY 1
     )
     SELECT COALESCE(т.кластер, п.кластер) AS кластер,
            COALESCE(т.постов, 0)     AS постов,
            COALESCE(т.со_ссылкой, 0) AS со_ссылкой,
            COALESCE(п.переходы, 0)   AS переходы,
            COALESCE(п.уникальные, 0) AS уникальные
       FROM темы т
       FULL JOIN переходы п ON п.кластер = т.кластер
      ORDER BY уникальные DESC, постов DESC`,
    [days],
  );
  return rows;
}

/** Откуда приходят: поиск, сама площадка, прямой заход. */
export async function bySource(days) {
  const { rows } = await query(
    `SELECT CASE
              WHEN referer IS NULL THEN 'прямой заход'
              WHEN referer ~* '(yandex|google|mail\\.ru|bing|rambler)' THEN 'поиск'
              WHEN referer ~* '(ok\\.ru|odnoklassniki)' THEN 'сами Одноклассники'
              ELSE 'другое'
            END AS откуда,
            COUNT(*)::int AS переходы
       FROM clicks
      WHERE created_at > now() - ($1 || ' days')::interval
        AND NOT is_bot
      GROUP BY 1
      ORDER BY переходы DESC`,
    [days],
  );
  return rows;
}

/** Последние переходы — чтобы видеть живую жизнь, а не только суммы. */
export async function recent(limit = 30) {
  const { rows } = await query(
    `SELECT c.id, c.post_id, c.target, c.is_bot, c.referer, c.user_agent, c.created_at,
            p.title, k.phrase AS ключ
       FROM clicks c
       LEFT JOIN posts p ON p.id = c.post_id
       LEFT JOIN keywords k ON k.id = c.keyword_id
      ORDER BY c.id DESC
      LIMIT $1`,
    [limit],
  );
  return rows;
}

/** Сколько опубликованных тем вообще несут ссылку на Kwork — знаменатель отчёта. */
export async function postsWithLink(days) {
  const { rows } = await query(
    `SELECT COUNT(*)::int                                        AS опубликовано,
            COUNT(*) FILTER (WHERE tail_kind = 'kwork')::int     AS со_ссылкой
       FROM posts
      WHERE status = 'published'
        AND created_at > now() - ($1 || ' days')::interval`,
    [days],
  );
  return rows[0];
}
