/**
 * Постобработка сгенерированного текста.
 *
 * Зачем кодом, а не промтом: просить модель «не используй markdown и длинное тире»
 * работает через раз, а чистка регулярками работает всегда. Промт отвечает за стиль,
 * код — за чистоту разметки.
 *
 * Что НЕЛЬЗЯ трогать (осознанный стиль, а не мусор):
 *   - сами булиты в начале строки: так устроен формат поста в промте;
 *   - эмодзи-иконки в подзаголовках: для ОК и аудитории 30+ они работают;
 *   - разделители «--------» вокруг рекламного блока.
 *
 * Чистка идёт по тексту МОДЕЛИ, до сборки готовой темы: заголовок и хвост
 * приклеивает код, и чистить в них нечего.
 *
 * Что делается с тире: внутри предложения оно убирается, а там, где остаётся
 * (булиты, рекламный блок), длинное «—» заменяется коротким «-». Длинных тире
 * в готовом тексте не остаётся вообще — требование заказчика.
 */

/** Строка-булит: тире (или дефис) с пробелом в начале строки. Сам булит сохраняем. */
const BULLET_LINE = /^(\s*)[—–-]\s+/;

/** Длинное и среднее тире. В готовом тексте их быть не должно — только дефис. */
const LONG_DASH = /[—–]/g;

/** Ряд дефисов — разделитель рекламного блока из промта, не markdown-hr. */
const AD_SEPARATOR = /^\s*-{4,}\s*$/;

function stripMarkdownInline(line) {
  return line
    // ссылки [текст](url) → «текст (url)»: ссылку из рекламного блока терять нельзя
    // Сравнение без хвостового слэша: модель часто пишет [https://site.ru](https://site.ru/),
    // и строгое равенство оставляло ссылку в тексте дважды.
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, (_, text, url) => {
      const bare = (value) => value.trim().replace(/\/+$/, '');
      return bare(text) === bare(url) ? url.trim() : `${text} ${url}`;
    })
    // **жирный**, __жирный__, *курсив*, _курсив_
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    .replace(/(^|[\s(«"])\*([^*\n]+)\*(?=[\s).,!?»"]|$)/g, '$1$2')
    .replace(/(^|[\s(«"])_([^_\n]+)_(?=[\s).,!?»"]|$)/g, '$1$2')
    // `код` и ~~зачёркнутый~~
    .replace(/`([^`]+)`/g, '$1')
    .replace(/~~([^~]+)~~/g, '$1')
    // «https://site.ru (https://site.ru/)» → одна ссылка. Так выглядит уже разобранная
    // markdown-ссылка, у которой текст и адрес различались только слэшем.
    .replace(/(https?:\/\/[^\s()]+?)\/?\s+\((https?:\/\/[^\s()]+?)\/?\)/g, (match, first, second) =>
      first === second ? first : match);
}

/**
 * Тире внутри предложения заменяется на запятую или убирается.
 * «Проект — это развод» → «Проект это развод». Тире в начале строки (булит) сохраняется,
 * поэтому обработка идёт построчно и первый символ строки не участвует.
 */
function stripInlineDash(line) {
  const bullet = line.match(BULLET_LINE);
  // Булит сохраняем как маркер, но приводим к короткому дефису.
  const head = bullet ? `${bullet[1]}- ` : '';
  const rest = bullet ? line.slice(bullet[0].length) : line;
  const cleaned = rest
    // «слово — слово» → «слово слово»; двойной пробел подчищается ниже
    .replace(/\s+[—–]\s+/g, ' ')
    // «слово—слово» без пробелов
    .replace(/(\S)[—–](\S)/g, '$1 $2');
  return head + cleaned;
}

export function cleanPostText(raw) {
  if (!raw) return '';

  // Рекламный блок между строками-разделителями — дословный текст клиента.
  // Внутри него не чистим ничего, кроме markdown: там есть «— он принес нам…»,
  // и удаление этого тире ломает фразу заказчика.
  let insideAd = false;

  const lines = String(raw)
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => {
      if (AD_SEPARATOR.test(line)) {
        insideAd = !insideAd;
        return line.trim();
      }
      // В рекламном блоке текст клиента дословный: тире там не удаляем (иначе ломается
      // фраза «— он принес нам»), но длинное меняем на короткое.
      if (insideAd) return stripMarkdownInline(line).replace(LONG_DASH, '-').trimEnd();

      let out = line
        // заголовки markdown: решётки убираем, текст оставляем
        .replace(/^\s{0,3}#{1,6}\s+/, '')
        // цитаты
        .replace(/^\s{0,3}>\s?/, '')
        // нумерованные и звёздочные списки приводим к булиту клиента
        .replace(/^\s*\d+[.)]\s+/, '- ')
        .replace(/^\s*[*+]\s+/, '- ');

      out = stripMarkdownInline(out);
      out = stripInlineDash(out);

      return out.replace(/[ \t]{2,}/g, ' ').trimEnd();
    });

  return lines
    .join('\n')
    // больше двух пустых строк подряд не нужно
    .replace(/\n{3,}/g, '\n\n')
    // Контрольный проход: длинных тире в тексте не остаётся ни в каком виде.
    .replace(LONG_DASH, '-')
    .trim();
}

/**
 * Обрезка лишних пунктов в списках. Последняя мера против переросшего поста, когда
 * модель уже трижды отказалась уложиться в лимит.
 *
 * Почему именно пункты: промт клиента просит по три пункта в двух блоках, а модель
 * регулярно выдаёт по пять-шесть, и именно они дают перебор. Удаление лишних пунктов
 * с конца блока не ломает ни структуру, ни рекламный блок, ни «Итог» — в отличие от
 * обрезки текста по символам, которая оставляет пост оборванным на полуслове.
 *
 * @param {string} text
 * @param {number} keepPerBlock сколько пунктов оставить в каждом блоке
 */
export function trimBulletLists(text, keepPerBlock = 3) {
  const lines = String(text ?? '').split('\n');
  const out = [];
  let insideAd = false;
  let bulletsInBlock = 0;

  for (const line of lines) {
    if (AD_SEPARATOR.test(line)) {
      insideAd = !insideAd;
      bulletsInBlock = 0;
      out.push(line);
      continue;
    }
    // В рекламном блоке не трогаем ничего: это дословный текст клиента.
    if (!insideAd && /^\s*[—–-]\s+\S/.test(line)) {
      bulletsInBlock += 1;
      if (bulletsInBlock > keepPerBlock) continue;
    } else if (line.trim() === '') {
      bulletsInBlock = 0;
    }
    out.push(line);
  }

  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

/**
 * Проверка готового текста темы. Возвращает список нарушений; пустой список = годен.
 * Нарушения уходят модели следующей попыткой — это работает заметно лучше, чем
 * просто повторить тот же запрос.
 *
 * На вход идёт ГОТОВЫЙ текст темы: первая строка-заголовок, тело и подставленный
 * хвост. Не текст модели — его проверяет `validateModelText`.
 *
 * @param {string} text
 * @param {object} rules
 * @param {number} rules.minChars
 * @param {number} rules.maxChars
 * @param {string} [rules.phrase] фраза ключа — она же обязана быть первой строкой
 */
export function validatePost(text, { minChars, maxChars, phrase }) {
  const problems = [];
  const value = String(text ?? '');

  // Ноль в любом из пределов = ограничения нет.
  if (minChars > 0 && value.length < minChars) {
    problems.push(`коротко: ${value.length} символов, нужно от ${minChars}`);
  }
  if (maxChars > 0 && value.length > maxChars) {
    problems.push(`длинно: ${value.length} символов, нужно до ${maxChars}`);
  }

  // Заголовок. Одноклассники собирают <title> страницы из ПЕРВОЙ СТРОКИ текста —
  // отдельного поля заголовка у темы нет. Значит первая строка обязана быть точной
  // фразой запроса: по ней тема ранжируется, и ничем другим её не заменить.
  if (phrase) {
    const first = value.split('\n')[0].trim();
    if (first !== phrase.trim()) {
      problems.push(`первая строка не равна фразе ключа: «${first.slice(0, 80)}»`);
    }
    // Заголовок, повторённый внутри текста, забирает место в сниппете и читается
    // как заедающая пластинка.
    const body = value.slice(value.indexOf('\n') + 1);
    if (body.includes(phrase.trim())) problems.push('фраза ключа повторена внутри текста');
  }

  // Пример диалога — самая ценная часть темы: он показывает продукт лучше любого
  // описания. Проверяем кодом, потому что модель считает его необязательным
  // украшением и выбрасывает первым, когда ужимает текст.
  const lines = value.split('\n');
  const clientLines = lines.filter((line) => /^\s*клиент\s*:/i.test(line)).length;
  const agentLines = lines.filter((line) => /^\s*агент\s*:/i.test(line)).length;
  if (clientLines < 3 || agentLines < 3) {
    problems.push(
      `нет примера диалога: реплик клиента ${clientLines}, агента ${agentLines}, ` +
        'нужно минимум по 3 в виде «Клиент: …» и «Агент: …»',
    );
  }

  // Булиты: без них тема читается стеной текста, а её будут листать с телефона.
  const bulletLines = lines.filter((line) => /^\s*[—–-]\s+\S/.test(line)).length;
  if (bulletLines < 4) {
    problems.push(`мало пунктов-булитов: ${bulletLines}, нужно минимум 4 (по 2-3 в двух блоках)`);
  }

  if (/\*\*|^#{1,6}\s|\[[^\]]+\]\(/m.test(value)) {
    problems.push('осталась markdown-разметка');
  }
  if (/[—–]/.test(value)) {
    problems.push('остались длинные тире');
  }

  return problems;
}

/**
 * Штампы, по которым текст читается как машинный. Список короткий и злой: сюда
 * попадают только обороты, которые модель ставит сама и от которых текст не теряет
 * ничего при удалении.
 */
const CLICHES = [
  'в современном мире',
  'в наше время',
  'сегодня бизнес',
  'динамично развива',
  'не секрет, что',
  'в условиях современного',
  'играет важную роль',
  'осуществляется',
  'в рамках данного',
  'является ключевым',
];

/**
 * Проверка текста, который написала модель, — до сборки готовой темы.
 *
 * Отдельно от `validatePost` по одной причине: ссылки. В готовой теме ссылка есть
 * и обязана быть, а в тексте модели её быть не должно ни в каком виде — адрес
 * подставляет код, и выдуманный моделью адрес увёл бы человека в никуда.
 *
 * @returns {string[]} список нарушений
 */
export function validateModelText(text) {
  const problems = [];
  const value = String(text ?? '');

  // Найденный кусок называем дословно. На «в тексте есть номер телефона» модель
  // перебирает варианты вслепую и три попытки подряд возвращает тот же номер
  // (поймано на живом прогоне), а на «убери 8 900 123 45 67» убирает сразу.
  const firstMatch = (re) => value.match(re)?.[0]?.trim();

  const link = firstMatch(/(https?:\/\/\S+|www\.\S+|[a-zа-я0-9-]+\.(ru|com|net|org|io|ai)\b)/i);
  if (link) {
    problems.push(`убери из текста адрес «${link}»: ссылку в конец подставляет система`);
  }
  const at = firstMatch(/\S*@[a-zа-я0-9_.-]+/i);
  if (at) {
    problems.push(`убери из текста «${at}»: ни почт, ни ников писать не нужно`);
  }
  const phone = firstMatch(/(\+7|\b8)[\s(-]?\d{3}[\s)-]?\d{3}[\s-]?\d{2}[\s-]?\d{2}/);
  if (phone) {
    problems.push(`убери номер телефона «${phone}» вместе с фразой, где он стоит`);
  }

  const lower = value.toLowerCase();
  const found = CLICHES.filter((cliche) => lower.includes(cliche));
  if (found.length > 0) {
    problems.push(`канцелярит и штампы: ${found.join(', ')} — переписать своими словами`);
  }

  return problems;
}

/**
 * Латиница в тексте. Не нарушение, а замечание в журнал: аудитория 30+ читает
 * «Вотсап», а не латиницей, но брак поста из-за одного слова обошёлся бы дороже,
 * чем само слово. Разрешённые сокращения берём те же, что и в факт-базе.
 *
 * @returns {string[]} найденные слова латиницей
 */
export function latinWords(text, allowed = ['CRM', 'API', 'PDF', 'SMS', 'QR', 'SEO', 'IT']) {
  const ok = new Set(allowed.map((word) => word.toUpperCase()));
  const found = new Set();
  for (const match of String(text ?? '').matchAll(/[A-Za-z][A-Za-z0-9+]*/g)) {
    if (!ok.has(match[0].toUpperCase())) found.add(match[0]);
  }
  return [...found];
}
