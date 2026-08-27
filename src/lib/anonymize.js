/**
 * Обезличивание фактуры.
 *
 * Карточки в `facts` собраны из живой переписки с заказчиками, их заказов и отзывов.
 * Попадёт в пост чужой ник, домен или название компании — и первый же заказчик,
 * нашедший себя в поиске, станет проблемой, а не активом. Поэтому проверка живёт
 * в коде и стоит на входе: карточку с нарушением репозиторий не сохранит.
 *
 * Правило латиницы вывернуто наизнанку: запрещено всё, кроме короткого списка.
 * Обратный порядок (чёрный список ников) не работает в принципе — ников бесконечно
 * много, и следующий заказчик придёт с новым. Заодно правило совпадает с языком
 * постов: аудитория 30+, читает «Вотсап», а не «WhatsApp».
 */

/** Латиница, которую в тексте оставляем. Всё остальное пишется кириллицей. */
const ALLOWED_LATIN = new Set(['PDF', 'CRM', 'API', 'SEO', 'IT', 'HTTPS', 'QR', 'SMS']);

/**
 * Имена и домены заказчиков, встреченные в исходниках.
 *
 * Список не заменяет правило латиницы, а дополняет его: сюда попадает то, что
 * написано кириллицей и потому мимо него проходит.
 */
const CLIENT_NAMES = [
  'пролейка',
  'танаис',
  'шунгит',
  'хозмаг',
  'микрорайон',
  'берёзовская',
  'березовская',
  'шахтёров',
  'фурманова',
  'жилино',
  'долгопрудн',
  'голубое',
];

const RULES = [
  {
    code: 'ссылка',
    test: /(https?:\/\/|www\.|[a-zа-я0-9-]+\.(ru|com|net|org|io|ai|site|online|store)\b)/i,
    hint: 'адрес сайта: ссылки в текст подставляет код по плейсхолдеру, а не факт-база',
  },
  {
    code: 'упоминание',
    test: /@[a-zа-я0-9_]/i,
    hint: 'собака: так пишутся ники и почта заказчиков',
  },
  {
    code: 'телефон',
    test: /(\+7|\b8)[\s(-]?\d{3}[\s)-]?\d{3}[\s-]?\d{2}[\s-]?\d{2}/,
    hint: 'номер телефона',
  },
  {
    code: 'заказчик',
    test: new RegExp(CLIENT_NAMES.join('|'), 'i'),
    hint: 'название или адрес заказчика',
  },
];

/**
 * Что не так с текстом карточки.
 * @returns {{code: string, hint: string, found: string}[]} пустой массив — всё чисто
 */
export function findLeaks(text) {
  const value = String(text ?? '');
  const leaks = [];

  for (const rule of RULES) {
    const match = value.match(rule.test);
    if (match) leaks.push({ code: rule.code, hint: rule.hint, found: match[0].trim() });
  }

  for (const word of value.match(/[A-Za-z][A-Za-z0-9]*/g) ?? []) {
    if (ALLOWED_LATIN.has(word.toUpperCase())) continue;
    leaks.push({
      code: 'латиница',
      hint: `латиницей пишутся ники и бренды; разрешены только ${[...ALLOWED_LATIN].join(', ')}`,
      found: word,
    });
    break;
  }

  return leaks;
}

/** Короткая строка для панели и лога. */
export function leaksText(leaks) {
  return leaks.map((leak) => `${leak.code} «${leak.found}» — ${leak.hint}`).join('; ');
}

/** Бросает, если карточку в таком виде сохранять нельзя. */
export function assertAnonymous(text, what = 'Текст') {
  const leaks = findLeaks(text);
  if (leaks.length > 0) throw new Error(`${what} не обезличен: ${leaksText(leaks)}`);
}
