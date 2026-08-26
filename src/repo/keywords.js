import { query, withTransaction } from '../db/pool.js';

/**
 * Ключевые запросы — очередь тем для конвейера.
 *
 * Жизнь ключа: `new` → `queued` (взят прогоном) → `used` (стал материалом).
 * Промежуточный `queued` нужен не для красоты: между «взяли фразу» и «завели материал»
 * есть окно, в котором прогон может упасть. Без резервирования параллельный прогон
 * взял бы ту же фразу второй раз, а после падения ключ навсегда остался бы `used`
 * без материала. Резерв снимается обратно в `new` (`release`), если материал не завёлся.
 */

/**
 * Очередная порция фраз, сразу зарезервированных за прогоном.
 *
 * `FOR UPDATE SKIP LOCKED` — защита от гонки двух прогонов: второй не ждёт первого
 * и не берёт те же строки, а просто получает следующие.
 */
export async function takeNext(limit) {
  if (!limit || limit < 1) return [];
  return withTransaction(async (client) => {
    const { rows } = await client.query(
      `SELECT id FROM keywords
        WHERE status = 'new'
        ORDER BY priority DESC, id
        LIMIT $1
        FOR UPDATE SKIP LOCKED`,
      [limit],
    );
    if (rows.length === 0) return [];
    const ids = rows.map((row) => row.id);
    const { rows: taken } = await client.query(
      `UPDATE keywords SET status = 'queued', queued_at = now() WHERE id = ANY($1::int[])
       RETURNING id, phrase, cluster, angle, priority`,
      [ids],
    );
    return taken.sort((a, b) => ids.indexOf(a.id) - ids.indexOf(b.id));
  });
}

/**
 * Ключ стал материалом.
 *
 * Материал ищется по обратной ссылке `articles.keyword_id`, а не передаётся сюда id:
 * материал создаёт общая для всех источников `articles.saveCandidate()`, и она отдаёт
 * только исход вставки. Тянуть id наружу пришлось бы через все вызовы сохранения
 * кандидатов — ради одной строки в одном режиме это не стоит того.
 */
export async function markUsed(id) {
  const { rowCount } = await query(
    `UPDATE keywords
        SET status = 'used', used_at = now(), queued_at = NULL, skip_reason = NULL,
            article_id = (SELECT a.id FROM articles a WHERE a.keyword_id = keywords.id
                           ORDER BY a.id DESC LIMIT 1)
      WHERE id = $1`,
    [id],
  );
  return rowCount;
}

/** Ключ отклонён — материал по нему не завёлся и повторять нечего. */
export async function markSkipped(id, reason) {
  await query(
    `UPDATE keywords SET status = 'skipped', skip_reason = $2, queued_at = NULL WHERE id = $1`,
    [id, reason ? String(reason).slice(0, 500) : null],
  );
}

/** Снять резерв: прогон упал, фраза должна вернуться в очередь. */
export async function release(id) {
  await query(
    `UPDATE keywords SET status = 'new', queued_at = NULL WHERE id = $1 AND status = 'queued'`,
    [id],
  );
}

/** Зависшие резервы: прогон упал так, что не дошёл даже до release. */
export async function releaseStale(olderThanMinutes = 60) {
  const { rowCount } = await query(
    `UPDATE keywords SET status = 'new', queued_at = NULL
      WHERE status = 'queued'
        AND queued_at < now() - ($1 || ' minutes')::interval`,
    [olderThanMinutes],
  );
  return rowCount;
}

export async function counts() {
  const { rows } = await query(`
    SELECT count(*)::int                                       AS total,
           count(*) FILTER (WHERE status = 'new')::int          AS new,
           count(*) FILTER (WHERE status = 'queued')::int       AS queued,
           count(*) FILTER (WHERE status = 'used')::int         AS used,
           count(*) FILTER (WHERE status = 'skipped')::int      AS skipped,
           count(DISTINCT cluster)::int                         AS clusters
      FROM keywords
  `);
  return rows[0];
}

/** Разрез по кластерам — по нему видно, какой пласт тем выработан, а какой не начат. */
export async function byCluster() {
  const { rows } = await query(`
    SELECT COALESCE(cluster, '(без кластера)') AS cluster,
           count(*)::int                                  AS total,
           count(*) FILTER (WHERE status = 'new')::int     AS new,
           count(*) FILTER (WHERE status = 'used')::int    AS used
      FROM keywords
     GROUP BY 1
     ORDER BY 1
  `);
  return rows;
}

export async function list({ status = null, cluster = null, limit = 200 } = {}) {
  const { rows } = await query(
    `SELECT k.*, a.id AS article_id_real, p.id AS post_id, p.status AS post_status
       FROM keywords k
       LEFT JOIN articles a ON a.id = k.article_id
       LEFT JOIN LATERAL (
         SELECT id, status FROM posts WHERE article_id = a.id ORDER BY id DESC LIMIT 1
       ) p ON true
      WHERE ($1::text IS NULL OR k.status = $1)
        AND ($2::text IS NULL OR k.cluster = $2)
      ORDER BY k.status = 'new' DESC, k.priority DESC, k.id
      LIMIT $3`,
    [status, cluster, limit],
  );
  return rows;
}

export async function findById(id) {
  const { rows } = await query('SELECT * FROM keywords WHERE id = $1', [id]);
  return rows[0] ?? null;
}

/**
 * Фраза, заведённая руками из панели.
 * @returns {Promise<{keyword: object|null, duplicate: boolean}>}
 */
export async function add({ phrase, cluster, angle, priority = 0 }) {
  const clean = String(phrase ?? '').trim();
  if (!clean) throw new Error('Пустая фраза');
  const { rows } = await query(
    `INSERT INTO keywords (phrase, cluster, angle, priority)
     VALUES ($1, NULLIF($2, ''), NULLIF($3, ''), $4)
     ON CONFLICT (phrase) DO NOTHING
     RETURNING *`,
    [clean, cluster?.trim() ?? '', angle?.trim() ?? '', priority],
  );
  return { keyword: rows[0] ?? null, duplicate: rows.length === 0 };
}

/** Ручное переключение статуса из панели: снять с очереди или вернуть в неё. */
export async function setStatus(id, status) {
  if (!['new', 'skipped'].includes(status)) {
    throw new Error(`Руками можно вернуть ключ в очередь или снять с неё, а не «${status}»`);
  }
  await query(
    `UPDATE keywords
        SET status = $2,
            skip_reason = CASE WHEN $2 = 'skipped' THEN 'снят с очереди вручную' ELSE NULL END
      WHERE id = $1 AND status IN ('new', 'skipped')`,
    [id, status],
  );
}

/**
 * Кластер последнего запланированного материала.
 *
 * Нужен планировщику: правило «два ключа одного кластера не идут подряд» обязано
 * работать и на стыке прогонов, иначе последний пост одного прогона и первый пост
 * следующего окажутся из одного кластера — а в группе они встанут именно рядом.
 */
export async function lastPlannedCluster() {
  const { rows } = await query(`
    SELECT k.cluster
      FROM run_items ri
      JOIN articles a ON a.id = ri.article_id
      JOIN keywords k ON k.id = a.keyword_id
     WHERE k.cluster IS NOT NULL
     ORDER BY ri.post_at DESC NULLS LAST, ri.id DESC
     LIMIT 1
  `);
  return rows[0]?.cluster ?? null;
}
