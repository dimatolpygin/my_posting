import * as keywords from '../repo/keywords.js';
import { log } from '../logger.js';

const logger = log('обнаружение');

/**
 * Обнаружение по ключевым запросам.
 *
 * Остальные адаптеры этого слоя ходят наружу — в карту сайта, в WP API, в firecrawl.
 * Здесь «наружу» ходить некуда: список тем наш собственный и лежит в своей таблице.
 * Обращение к `repo` из этого слоя — осознанное исключение ради единой точки входа:
 * `discoverSource()` остаётся местом, где решается «откуда берутся темы», и режим
 * `keywords` не приходится обслуживать отдельной веткой в сервисе проверки.
 *
 * Адрес у темы синтетический. `articles.url_norm` обязателен и уникален, а никакой
 * страницы за фразой не стоит. Домен `keyword.local` не существует специально — по нему
 * в панели сразу видно происхождение материала. Форма `kw-{id}`, а не `kw/{id}`:
 * `isListingUrl()` считает листингом адрес, у которого последний сегмент — число.
 *
 * Ключ темы задаётся явно (`kw-{id}`), а не считается из фразы. Общий разбор тем
 * настроен на названия проектов и режет слова-шумы («сколько», «стоит», «как»);
 * на наших фразах он склеил бы разные запросы в одну тему, и вторая молча ушла бы
 * в дубли — то есть ключ сгорел бы, не дав поста. Уникальность фразы и так гарантирована
 * ограничением на `keywords.phrase`.
 *
 * @param {object} source строка sources
 * @param {object} options
 * @param {number} options.limit сколько тем забрать за раз
 * @returns {Promise<Array<{url, lastmod, title, topicKey, topicName, keywordId, cluster, angle}>>}
 */
export async function discoverViaKeywords(source, { limit }) {
  // Резервы, оставшиеся от прогонов, упавших вместе с процессом. Без этого фраза
  // зависла бы в `queued` навсегда и больше никогда не попала бы в очередь.
  const released = await keywords.releaseStale(60);
  if (released > 0) {
    logger.warn({ вернули: released }, `Зависших резервов вернули в очередь: ${released}`);
  }

  const taken = await keywords.takeNext(limit);
  if (taken.length === 0) {
    logger.info({ источник: source.code }, 'Свободных ключевых запросов не осталось');
    return [];
  }

  logger.info(
    { взято: taken.length, кластеры: [...new Set(taken.map((row) => row.cluster))] },
    `Взято ключевых запросов: ${taken.length}`,
  );

  const now = new Date();
  return taken.map((row) => ({
    url: `https://keyword.local/kw-${row.id}`,
    lastmod: now,
    title: row.phrase,
    topicKey: `kw-${row.id}`,
    topicName: row.phrase,
    keywordId: row.id,
    cluster: row.cluster,
    angle: row.angle,
  }));
}
