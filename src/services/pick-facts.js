import * as facts from '../repo/facts.js';
import * as settings from '../repo/settings.js';
import { log } from '../logger.js';

const logger = log('фактура');

/**
 * Набор карточек под один пост.
 *
 * Зачем рецепт вообще нужен. Шестьсот тем в месяц руками не написать, а без фактуры
 * модель пишет «о всём и ни о чём»: пятнадцать текстов про чат-ботов, отличающихся
 * порядком слов. Тексты должны расходиться не стилем, а разными фактами внутри —
 * поэтому начинка собирается здесь, до генерации, и уходит в промт параметрами.
 *
 * Рецепт: одна задача + одна-две грабли + вилка цены + возражение, иногда цитата
 * отзыва. Каждый тип делает свою работу: задача даёт узнаваемую боль, грабли
 * показывают опыт (их нельзя выдумать, не поработав), цена снимает главный вопрос,
 * возражение — второй, цитата подтверждает.
 *
 * Чего здесь нет и не будет: подбора «по смыслу» через модель. Кластер темы и кластер
 * карточки — один и тот же справочник, и выбрать по нему можно запросом, а не вызовом
 * ИИ за деньги и полторы секунды.
 */

/** Сколько карточек каждого типа берём. rakes — сколько получится, но не больше двух. */
const RECIPE = [
  { kind: 'task', count: 1, required: true },
  { kind: 'rake', count: 2, required: false },
  { kind: 'price', count: 1, required: true },
  { kind: 'objection', count: 1, required: true },
];

/**
 * Цитата отзыва — не в каждом посте. В каждом она превращается в подпись-штамп,
 * которую перестают замечать, а вес у неё как раз в редкости. Через одну, по чётности
 * номера поста: считать по номеру, а не бросать монетку, чтобы настройка означала
 * ровно то, что написано.
 */
function needsQuote(postNumber) {
  return postNumber % 2 === 0;
}

function take(pool, kind, count, usedIds) {
  const picked = [];
  for (const item of pool) {
    if (picked.length >= count) break;
    if (item.kind !== kind || usedIds.has(item.id)) continue;
    picked.push(item);
    usedIds.add(item.id);
  }
  return picked;
}

/**
 * Собрать начинку.
 *
 * Подбор идёт по каждому типу отдельно: сначала карточки своего кластера, и только
 * если их не осталось — из всей базы. Раньше проверка была общей («хватает ли
 * кластера на весь рецепт»), и это работало плохо: в кластере на девять тем
 * приходится по одной-две карточки возражений, первая же тема их занимает, и весь
 * рецепт целиком уезжал в чужой кластер вместе с задачей и примером. Потипово
 * из своего кластера приходит хотя бы то, что там есть.
 *
 * @param {object} options
 * @param {string} [options.cluster] кластер темы
 * @param {number} options.postNumber порядковый номер поста
 * @param {number[]} [options.avoidIds] карточки, которые уже пробовали в этой теме
 *   (пересборка после проверки на схожесть берёт другой набор, а не тот же)
 * @returns {Promise<{cards: object[], byKind: object, foreign: string[], missing: string[]}>}
 */
export async function pickFacts({ cluster = null, postNumber = 1, avoidIds = [] } = {}) {
  const cooldown = await settings.getInt('fact_cooldown_posts', 5);
  const recent = await facts.usedInLastPosts(cooldown);
  const exclude = [...new Set([...recent, ...avoidIds])];

  const own = cluster ? await facts.candidates({ cluster, excludeIds: exclude }) : [];
  const any = await facts.candidates({ cluster: null, excludeIds: exclude });
  // Последний резерв: снять окно охлаждения. Повтор факта через два поста хуже,
  // чем пост вообще без цены и возражения, но лучше, чем сорванная генерация.
  let relaxed = null;

  const usedIds = new Set();
  const byKind = {};
  const foreign = [];
  const missing = [];

  const steps = [...RECIPE, { kind: 'quote', count: needsQuote(postNumber) ? 1 : 0, required: false }];
  for (const step of steps) {
    if (step.count === 0) {
      byKind[step.kind] = [];
      continue;
    }
    const picked = take(own, step.kind, step.count, usedIds);
    if (picked.length < step.count) {
      const extra = take(any, step.kind, step.count - picked.length, usedIds);
      if (extra.length > 0 && cluster) foreign.push(step.kind);
      picked.push(...extra);
    }
    if (picked.length === 0 && step.required) {
      relaxed = relaxed ?? await facts.candidates({ cluster: null, excludeIds: avoidIds });
      picked.push(...take(relaxed, step.kind, step.count, usedIds));
    }
    byKind[step.kind] = picked;
    if (step.required && picked.length === 0) missing.push(step.kind);
  }

  const cards = Object.values(byKind).flat();
  logger.info(
    {
      кластер: cluster ?? '(любой)',
      карточек: cards.length,
      изДругихКластеров: foreign,
      нехватка: missing,
      номерПоста: postNumber,
    },
    `Фактура собрана: ${cards.length} карточек` +
      (foreign.length > 0 ? ` (из чужих кластеров: ${foreign.join(', ')})` : ''),
  );

  return { cards, byKind, foreign, missing };
}

/** Человеческое название типа для промта. */
const KIND_LABEL = {
  task: 'задача из практики',
  rake: 'грабли',
  price: 'цена',
  objection: 'возражение клиента',
  quote: 'цитата из отзыва',
};

/**
 * Фактура текстом для промта.
 *
 * Порядок блоков совпадает с порядком структуры поста: модель ставит факт туда,
 * где он встретился, и подсказка порядком стоит дешевле, чем ещё один абзац правил.
 */
export function factsToPrompt(cards) {
  if (!cards?.length) return '';
  return cards
    .map((card) => `[${KIND_LABEL[card.kind] ?? card.kind}] ${card.title}\n${card.body}`)
    .join('\n\n');
}
