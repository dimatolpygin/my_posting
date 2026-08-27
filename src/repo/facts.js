import { query } from '../db/pool.js';
import { findLeaks, leaksText } from '../lib/anonymize.js';

/**
 * Факт-база — начинка постов.
 *
 * Пять типов карточек: задача заказчика, грабли, деньги, возражение и цитата
 * отзыва. Пост собирается из них по рецепту, поэтому тексты расходятся не стилем,
 * а разными фактами внутри.
 *
 * Обезличивание проверяется здесь, а не в панели: карточка может прийти и из
 * миграции, и из формы, и из будущего разбора переписок, а мимо репозитория
 * не пройдёт ни одна.
 */

export const KINDS = ['task', 'rake', 'price', 'objection', 'quote'];

const KIND_TEXT = {
  task: 'задача',
  rake: 'грабли',
  price: 'деньги',
  objection: 'возражение',
  quote: 'цитата',
};

export function kindText(kind) {
  return KIND_TEXT[kind] ?? kind;
}

function assertClean({ title, body }) {
  const leaks = [...findLeaks(title), ...findLeaks(body)];
  if (leaks.length > 0) throw new Error(`Карточка не обезличена: ${leaksText(leaks)}`);
}

function parseClusters(value) {
  if (Array.isArray(value)) return value.map((item) => String(item).trim()).filter(Boolean);
  return String(value ?? '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

/** Сводка для карточек статистики. */
export async function counts() {
  const { rows } = await query(`
    SELECT count(*)::int                                        AS total,
           count(*) FILTER (WHERE is_active)::int                AS active,
           count(*) FILTER (WHERE NOT is_active)::int            AS off,
           count(DISTINCT kind)::int                             AS kinds,
           coalesce(sum(used_count), 0)::int                     AS used_total
      FROM facts
  `);
  return rows[0];
}

/** Сколько карточек каждого типа — по ним видно, не перекошена ли база. */
export async function byKind() {
  const { rows } = await query(`
    SELECT kind,
           count(*)::int                             AS total,
           count(*) FILTER (WHERE is_active)::int    AS active,
           coalesce(sum(used_count), 0)::int         AS used
      FROM facts
     GROUP BY kind
     ORDER BY count(*) DESC
  `);
  return rows;
}

/** Кластеры, в которых карточки вообще есть, — для фильтра и подсказки в форме. */
export async function clusters() {
  const { rows } = await query(`
    SELECT cluster, count(*)::int AS total
      FROM facts, unnest(clusters) AS cluster
     GROUP BY cluster
     ORDER BY cluster
  `);
  return rows;
}

export async function list({ kind = null, cluster = null, onlyActive = false, limit = 300 } = {}) {
  const { rows } = await query(
    `SELECT *
       FROM facts
      WHERE ($1::text IS NULL OR kind = $1)
        AND ($2::text IS NULL OR $2 = ANY (clusters))
        AND ($3::boolean IS FALSE OR is_active)
      ORDER BY kind, id
      LIMIT $4`,
    [kind, cluster, onlyActive, limit],
  );
  return rows;
}

export async function findById(id) {
  const { rows } = await query('SELECT * FROM facts WHERE id = $1', [id]);
  return rows[0] ?? null;
}

export async function add({ kind, title, body, niche, channel, clusters: clusterList }) {
  if (!KINDS.includes(kind)) throw new Error(`Неизвестный тип карточки: ${kind}`);
  const clean = { title: String(title ?? '').trim(), body: String(body ?? '').trim() };
  if (!clean.title || !clean.body) throw new Error('Метка и текст карточки обязательны');
  assertClean(clean);

  const { rows } = await query(
    `INSERT INTO facts (kind, title, body, niche, channel, clusters)
     VALUES ($1, $2, $3, NULLIF($4, ''), NULLIF($5, ''), $6::text[])
     RETURNING *`,
    [kind, clean.title, clean.body, niche?.trim() ?? '', channel?.trim() ?? '', parseClusters(clusterList)],
  );
  return rows[0];
}

export async function update(id, { kind, title, body, niche, channel, clusters: clusterList }) {
  if (!KINDS.includes(kind)) throw new Error(`Неизвестный тип карточки: ${kind}`);
  const clean = { title: String(title ?? '').trim(), body: String(body ?? '').trim() };
  if (!clean.title || !clean.body) throw new Error('Метка и текст карточки обязательны');
  assertClean(clean);

  const { rows } = await query(
    `UPDATE facts
        SET kind = $2, title = $3, body = $4,
            niche = NULLIF($5, ''), channel = NULLIF($6, ''), clusters = $7::text[]
      WHERE id = $1
      RETURNING *`,
    [id, kind, clean.title, clean.body, niche?.trim() ?? '', channel?.trim() ?? '', parseClusters(clusterList)],
  );
  if (!rows[0]) throw new Error(`Карточки #${id} нет`);
  return rows[0];
}

/** Выключенная карточка остаётся в базе, но в посты не идёт. */
export async function setActive(id, isActive) {
  const { rows } = await query(
    'UPDATE facts SET is_active = $2 WHERE id = $1 RETURNING id, title, is_active',
    [id, Boolean(isActive)],
  );
  if (!rows[0]) throw new Error(`Карточки #${id} нет`);
  return rows[0];
}

/**
 * Проверка всей базы на обезличивание.
 *
 * Нужна отдельно от проверки на входе: правила меняются (в список заказчиков
 * добавится новое название), и уже лежащие карточки надо перепроверять этими
 * же правилами, а не теми, что действовали в день вставки.
 */
export async function checkAnonymity() {
  const { rows } = await query('SELECT id, kind, title, body FROM facts ORDER BY id');
  const dirty = [];
  for (const row of rows) {
    const leaks = [...findLeaks(row.title), ...findLeaks(row.body)];
    if (leaks.length > 0) dirty.push({ ...row, leaks, text: leaksText(leaks) });
  }
  return { checked: rows.length, dirty };
}

/**
 * Карточки, уже использованные в последних N постах.
 *
 * Нужны сборщику как чёрный список. Правило «одна карточка не попадает в два поста
 * подряд» — это N = 1; настройка поднимает его выше, и тогда факт возвращается
 * в оборот не раньше, чем через N тем. Без такого окна счётчик использований
 * выравнивает базу слишком медленно: подряд идущие темы одного кластера тянут
 * одни и те же карточки, потому что на момент выбора у всех них счётчик ещё нулевой.
 */
export async function usedInLastPosts(posts = 1) {
  if (!posts || posts < 1) return [];
  const { rows } = await query(
    `SELECT DISTINCT pf.fact_id
       FROM post_facts pf
      WHERE pf.post_id IN (
        SELECT id FROM posts WHERE status <> 'failed' ORDER BY id DESC LIMIT $1
      )`,
    [posts],
  );
  return rows.map((row) => row.fact_id);
}

/**
 * Карточки-кандидаты для поста.
 *
 * Порядок выбора: сначала те, что использовались реже всех, среди равных — те, что
 * дольше не появлялись, дальше случайно. Так база расходуется равномерно, а не
 * первыми двадцатью карточками по алфавиту.
 *
 * @param {object} options
 * @param {string} [options.cluster] кластер темы; null — берём из всей базы
 * @param {number[]} [options.excludeIds] карточки, занятые недавними постами
 */
export async function candidates({ cluster = null, excludeIds = [] } = {}) {
  const { rows } = await query(
    `SELECT * FROM facts
      WHERE is_active
        AND ($1::text IS NULL OR $1 = ANY (clusters))
        AND NOT (id = ANY ($2::int[]))
      ORDER BY used_count ASC, last_used_at ASC NULLS FIRST, random()`,
    [cluster, excludeIds],
  );
  return rows;
}

/**
 * Отметить карточки использованными в посте.
 *
 * Связка `post_facts` и счётчик обновляются вместе: счётчик нужен для быстрого
 * выбора, связка — чтобы в панели было видно, из чего собран конкретный пост,
 * и чтобы правило «не два поста подряд» имело на что опереться.
 */
export async function markUsed(postId, factIds) {
  const ids = (factIds ?? []).map(Number).filter(Boolean);
  if (ids.length === 0) return 0;
  await query(
    `INSERT INTO post_facts (post_id, fact_id)
     SELECT $1, unnest($2::int[])
     ON CONFLICT DO NOTHING`,
    [postId, ids],
  );
  const { rowCount } = await query(
    `UPDATE facts SET used_count = used_count + 1, last_used_at = now() WHERE id = ANY ($1::int[])`,
    [ids],
  );
  return rowCount;
}

/** Из каких карточек собран пост — для карточки поста в панели. */
export async function forPost(postId) {
  const { rows } = await query(
    `SELECT f.id, f.kind, f.title
       FROM post_facts pf
       JOIN facts f ON f.id = pf.fact_id
      WHERE pf.post_id = $1
      ORDER BY f.kind, f.id`,
    [postId],
  );
  return rows;
}
