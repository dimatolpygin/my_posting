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
