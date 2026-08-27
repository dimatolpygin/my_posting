import { createHash } from 'node:crypto';

/**
 * Отпечаток текста для проверки «не написали ли мы это уже».
 *
 * Зачем: соседние ключи одной ниши («сколько стоит чат-бот для бизнеса» и «из чего
 * складывается цена автоматизации») тянут одну и ту же фактуру и легко дают почти
 * одинаковый текст. Яндекс сочтёт такие темы дублями и выкинет одну из выдачи —
 * то есть мы сами себе создадим конкурента. Проверять глазами шестьсот тем в месяц
 * невозможно, поэтому схожесть считается кодом перед сохранением поста.
 *
 * Как считается: текст разбивается на пересекающиеся цепочки по пять слов (шинглы),
 * каждая сворачивается в короткий хеш, дальше берётся коэффициент Жаккара — доля
 * общих цепочек в объединении двух текстов. Пять слов, а не три: на трёх любые два
 * текста про одну нишу дают высокую схожесть просто из-за оборотов языка
 * («чат бот для автосервиса»), и порог пришлось бы задирать до бессмысленного.
 *
 * Что НЕ учитывается: порядок цепочек и стоп-слова. Перестановка абзацев схожесть
 * не снижает — и это правильно, переставленный текст остаётся тем же текстом.
 */

/** Длина цепочки в словах. */
const SHINGLE_WORDS = 5;

/** Короче этого числа слов текст не отпечатывается: сравнивать нечего. */
const MIN_WORDS = SHINGLE_WORDS * 2;

/**
 * Нормализация перед разбором: остаются только буквы, цифры и одиночные пробелы.
 * Регистр, знаки препинания и переводы строк на смысл не влияют, а схожесть
 * из-за них проседает на ровном месте.
 */
function words(text) {
  return String(text ?? '')
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .split(' ')
    .filter(Boolean);
}

/**
 * Отпечаток текста: массив коротких хешей.
 *
 * Хеш, а не сами цепочки: в БД у каждого поста будет по три сотни строк, и хранить
 * их текстом — это мегабайты ради сравнения, которое смотрит только на совпадение.
 *
 * @param {string} text
 * @returns {string[]} отсортированный массив без повторов
 */
export function shingles(text) {
  const list = words(text);
  if (list.length < MIN_WORDS) return [];
  const set = new Set();
  for (let i = 0; i + SHINGLE_WORDS <= list.length; i += 1) {
    const chunk = list.slice(i, i + SHINGLE_WORDS).join(' ');
    set.add(createHash('sha1').update(chunk).digest('hex').slice(0, 10));
  }
  return [...set].sort();
}

/**
 * Коэффициент Жаккара двух отпечатков: 0 — ничего общего, 1 — тот же текст.
 * Пустой отпечаток (слишком короткий текст) считаем несхожим ни с чем: иначе
 * два коротких обрывка дали бы единицу и заблокировали друг друга.
 */
export function similarity(a, b) {
  if (!a?.length || !b?.length) return 0;
  const first = new Set(a);
  let common = 0;
  for (const item of b) if (first.has(item)) common += 1;
  const union = first.size + b.length - common;
  return union === 0 ? 0 : common / union;
}

/**
 * Самый похожий из уже написанных постов.
 *
 * @param {string[]} fingerprint отпечаток нового текста
 * @param {Array<{id: number, shingles: string[]}>} others
 * @returns {{id: number|null, score: number}}
 */
export function mostSimilar(fingerprint, others = []) {
  let best = { id: null, score: 0 };
  for (const other of others) {
    const score = similarity(fingerprint, other.shingles);
    if (score > best.score) best = { id: other.id, score };
  }
  return best;
}
