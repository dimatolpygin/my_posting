/**
 * Редиректор: разбор адреса, отсев роботов, отпечаток посетителя.
 *
 * Пять вещей ломают учёт переходов, и все пять решаются здесь или в роуте:
 *
 * 1. **Только 302, никогда 301.** Постоянный редирект браузер кеширует намертво:
 *    второй и все следующие переходы того же человека до сервера не долетят вообще.
 *    Статистика тихо занизится в разы, и по самим цифрам это не разглядеть.
 * 2. **Роботы.** По ссылке пойдут поисковые пауки и превьюшный робот ОК — он
 *    дёргает адрес в момент публикации, чтобы построить сниппет. Без фильтра
 *    каждый пост получит «переход» ровно в момент выхода, и картина будет ложной.
 * 3. **Дедуп.** Один человек кликнул трижды — это один переход. Считается
 *    в отчёте, `COUNT(DISTINCT visitor)`, а не при записи: редирект должен быть
 *    быстрым, лишний запрос в БД на пути человека тут ни к чему.
 * 4. **Ссылку подставляет код, а не модель** — см. `post-tail.js`.
 * 5. **Ссылка не в каждом посте** (`ad_block_every_n`): при анализе делить
 *    на число постов со ссылкой, а не на все.
 */

import { createHash } from 'node:crypto';

/** Цель перехода → ключ настройки с конечным адресом. */
export const TARGETS = {
  kwork: 'kwork_url',
  visa: 'visa_url',
  vps: 'vps_url',
  tg: 'tg_url',
  max: 'max_url',
};

export const TARGET_TITLES = {
  kwork: 'профиль на Kwork',
  visa: 'виртуальная карта',
  vps: 'сервер',
  tg: 'Телеграм',
  max: 'MAX',
};

/**
 * Признаки робота в user-agent. Список намеренно широкий: ложно принять человека
 * за робота не страшно (переход всё равно записан, просто не попадёт в отчёт),
 * а пропущенный робот портит цифры.
 */
const BOT_RE = new RegExp(
  [
    'bot', 'crawl', 'spider', 'slurp', 'archiver', 'scrap', 'fetch', 'monitor', 'uptime',
    'yandex', 'google', 'bing', 'baidu', 'duckduck', 'mail\\.ru', 'sputnik',
    'facebookexternal', 'whatsapp', 'telegrambot', 'vkshare', 'skypeuripreview', 'preview',
    'headless', 'phantomjs', 'curl', 'wget', 'python-requests', 'python-urllib', 'go-http',
    'axios', 'okhttp', 'libwww', 'httpclient', 'java/', 'apache-http',
  ].join('|'),
  'i',
);

/** Робот ли это. Пустой user-agent — тоже робот: браузеры его всегда шлют. */
export function isBot(userAgent) {
  const ua = String(userAgent ?? '').trim();
  if (ua.length === 0) return true;
  return BOT_RE.test(ua);
}

/**
 * Отпечаток посетителя. Сырой IP не храним и не логируем: для «сколько разных
 * людей пришло» достаточно хеша, а хранение адреса — это персональные данные
 * без всякой пользы для дела.
 */
export function visitorHash(ip, userAgent, salt) {
  return createHash('sha256')
    .update(`${ip ?? ''}|${userAgent ?? ''}|${salt ?? ''}`)
    .digest('hex')
    .slice(0, 32);
}

/**
 * Адрес редиректора для поста.
 *
 * Kwork — самая частая ссылка и стоит в тексте на виду, поэтому у неё самый
 * короткий вид: `/k/54`. Остальные цели с приставкой: `/k/visa/54`.
 *
 * @param {string} base PUBLIC_BASE_URL
 * @param {string} target ключ из TARGETS
 * @param {number|null} postId номер поста, если ссылка персональная
 */
export function clickUrl(base, target, postId = null) {
  const root = String(base ?? '').replace(/\/+$/, '');
  const id = Number(postId);
  const suffix = Number.isFinite(id) && id > 0 ? `/${id}` : '';
  if (target === 'kwork') return `${root}/k${suffix || '/kwork'}`;
  return `${root}/k/${target}${suffix}`;
}

/**
 * Разбор пути редиректора. Принимает два сегмента после `/k/`:
 * `/k/54` → kwork, пост 54; `/k/visa/54` → visa, пост 54; `/k/tg` → tg, без поста.
 *
 * @returns {{target: string, postId: number|null}|null} null — адрес не наш
 */
export function parseClickPath(first, second) {
  const a = String(first ?? '').trim().toLowerCase();
  const b = String(second ?? '').trim();

  if (a.length === 0) return null;

  // `/k/54` — номер поста без цели: это ссылка на Kwork.
  if (/^\d+$/.test(a)) return b.length === 0 ? { target: 'kwork', postId: Number(a) } : null;

  if (!Object.hasOwn(TARGETS, a)) return null;
  if (b.length === 0) return { target: a, postId: null };
  if (!/^\d+$/.test(b)) return null;
  return { target: a, postId: Number(b) };
}

/** Обрезка длинных полей: user-agent и referer приходят какой угодно длины. */
export function trim(value, limit = 400) {
  const text = String(value ?? '').trim();
  if (text.length === 0) return null;
  return text.length > limit ? text.slice(0, limit) : text;
}
