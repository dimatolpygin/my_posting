import * as openrouter from '../lib/openrouter.js';
import {
  cleanPostText,
  validatePost,
  validateModelText,
  latinWords,
  trimBulletLists,
} from '../lib/text-clean.js';
import { buildTail, renderLinks, hasPlaceholders } from '../lib/post-tail.js';
import { shingles, mostSimilar } from '../lib/shingle.js';
import { collectMaterial, collectForKeyword } from './research.js';
import { postShape } from '../lib/post-shape.js';
import { clickUrl } from '../lib/clicks.js';
import { config } from '../config.js';
import { pickFacts, factsToPrompt } from './pick-facts.js';
import * as prompts from '../repo/prompts.js';
import * as posts from '../repo/posts.js';
import * as facts from '../repo/facts.js';
import * as settings from '../repo/settings.js';
import { captureError } from './capture-error.js';
import { log, errFields } from '../logger.js';
import { getRequestId } from '../context.js';

const logger = log('генерация');

/**
 * Сборка темы для группы.
 *
 * Тема собирается из трёх частей, и пишет их не один автор:
 *
 *   1. **Заголовок** — точная фраза поискового запроса, ставит код. Одноклассники
 *      берут <title> страницы из первой строки текста, отдельного поля заголовка
 *      у темы нет. Позволить модели «улучшить» заголовок значит потерять ключ,
 *      по которому тема должна ранжироваться, — а это единственное, ради чего
 *      тема пишется.
 *   2. **Текст** — модель, по промту из БД и фактуре из факт-базы.
 *   3. **Хвост** — рекламный блок или реф-ссылка, ставит код (см. post-tail.js).
 *
 * Соседние ключи одной ниши тянут одну фактуру и дают похожие тексты, поэтому перед
 * сохранением считается схожесть с прошлыми постами. Превысил порог — пересобираем
 * на другом наборе карточек, а не переписываем тем же самым.
 */

/**
 * Ответ модели берём обычным текстом, без строгой JSON-схемы. Схема тут была
 * оправдана, пока модель отдавала два поля (заголовок и тело). Теперь поле одно,
 * а плата за схему высокая:
 *
 *   - OpenRouter выбирает под неё провайдера с `require_parameters`, и почти все,
 *     кроме Google, из выдачи выпадают — модель нельзя даже сравнить с другой;
 *   - ответ, упёршийся в лимит токенов, обрывается посреди JSON, и разбор роняет
 *     всю генерацию вместе с уже написанным текстом. На живом прогоне так сгорели
 *     три попытки подряд.
 *
 * Текстом обе беды исчезают: обрыв виден по `finish_reason` и лечится повтором,
 * а модель можно взять любую.
 */

/** Вступление вида «Вот текст:» перед самим текстом. Модели любят его дописывать. */
const PREAMBLE = /^\s*(вот|ниже|готово)[^\n:]{0,60}:\s*$/i;

/** Сколько заходов сокращения делаем, прежде чем сдаться. */
const SHRINK_ROUNDS = 3;

/** Сколько исходного текста отдаём модели: больше 12 тысяч символов смысла не добавляет. */
const MAX_SOURCE_CHARS = 12_000;

/**
 * Пользовательская часть запроса. Системная — промт из БД, она стабильна и идёт первой
 * (порядок «стабильное начало → переменная часть в конце» — на случай, когда провайдеры
 * включат кеш промта).
 */
function buildUserMessage({ phrase, angle, cluster, shape, factsText, material, budget }) {
  const lines = [
    `Поисковый запрос: ${phrase}`,
    'Эта фраза уже стоит первой строкой темы. Писать её ещё раз не нужно, ' +
      'текст начинается сразу после неё.',
  ];
  if (angle) lines.push(`Угол подачи: ${angle}`);
  if (cluster) lines.push(`Направление: ${cluster}`);
  // Вид темы решает код, а не модель: от него зависит проверка готового текста,
  // и обе стороны обязаны понимать её одинаково.
  lines.push(
    shape === 'продукт'
      ? 'Вид темы: ПРОДУКТОВАЯ. Пиши по структуре вида Б, блок с диалогом обязателен.'
      : 'Вид темы: РАЗБОР ВОПРОСА. Пиши по структуре вида А. Блока с диалогом ' +
        'быть не должно: человек пришёл за ответом, а не за сценкой.',
  );

  if (factsText) {
    lines.push(
      '',
      'Фактура из моей практики. Вплети её своими словами по местам структуры, ' +
        'не пересказывай списком и не переноси дословно:',
      '',
      factsText,
    );
  } else {
    // Пустая факт-база — не повод не написать тему, но текст выйдет общим,
    // и знать об этом надо по журналу, а не по итоговому качеству.
    lines.push(
      '',
      'Фактуры под эту тему нет. Пиши по существу запроса, но не выдумывай ' +
        'ни сумм, ни сроков, ни названий компаний.',
    );
  }

  if (material) {
    // Материал идёт последним и со своей шапкой (её ставит research.js): там сказано,
    // что это чужие статьи, что из них брать и чего из них не брать. Без такой рамки
    // модель принимает выдержки за образец и пересказывает их близко к тексту.
    lines.push('', material.slice(0, MAX_SOURCE_CHARS));
  } else {
    lines.push(
      '',
      'Чужих статей по этому запросу прочитать не удалось. Значит, пиши только то, ' +
        'что есть в фактуре и что знаешь наверняка: ни сумм, ни сроков, ни названий ' +
        'сервисов из головы.',
    );
  }

  // Лимит длины есть и в промте, но в самом его конце, среди прочих правил, и модель
  // о нём забывает: на клиентском проекте живой прогон дал подряд 2534, 2918 и 3426
  // символов. Повтор рядом с задачей стоит одну строку и экономит переделки.
  if (budget > 0) {
    // Целимся заметно ниже потолка. Модель стабильно промахивается вверх на сотню-другую
    // знаков: на живом прогоне пять текстов подряд вышли за лимит на первой попытке и
    // укладывались только на второй. Вторая попытка — это ещё один платный вызов,
    // а заниженная цель стоит одной строки.
    const target = Math.max(500, budget - 250);
    lines.push(
      '',
      `Длина твоего текста: от ${Math.max(400, target - 600)} до ${target} знаков, ` +
        `и ни знаком больше ${budget}. Заголовок и блок со ссылкой в этот счёт ` +
        'не входят, их добавит система.',
    );
  }

  return lines.join('\n');
}

/**
 * Указание к переделке. Список нарушений сам по себе модель понимает плохо: на
 * «длинно: 2534 символов, нужно до 2200» она возвращает такой же длинный текст три
 * раза подряд. Помогает не констатация, а задание: на сколько сократить, за счёт
 * чего и что трогать нельзя.
 */
function fixInstruction(problems, { budget, length }) {
  const lines = [
    'Предыдущий вариант не прошёл проверку. Исправь ровно это и верни текст заново:\n- ' +
      problems.join('\n- '),
  ];
  if (budget > 0 && length > budget) {
    lines.push(
      `Сократи текст на ${length - budget + 100} знаков. Режь общие рассуждения и повторы, ` +
        'а не факты и не пример диалога. Структуру блоков оставь как есть.',
    );
  }
  return lines.join('\n\n');
}

/**
 * Последняя попытка спасти текст, забракованный ТОЛЬКО длиной. Отдельный вызов
 * с одной задачей «сократи» работает там, где переписывание с нуля не помогает:
 * модель уже не сочиняет заново, а режет готовое.
 */
async function shrinkBody(body, { budget, temperature, serviceTier, shape }) {
  // Доля, а не абсолютное число: «убери примерно четверть текста» модель выполняет
  // заметно точнее, чем «уложись в 2090 знаков» — считать символы она не умеет.
  const cutPercent = Math.max(10, Math.round((1 - budget / body.length) * 100));

  // Вид темы редактору обязателен. Прежнее «сохраняй пример диалога целиком» стояло
  // безусловно, и на разборе вопроса редактор понимал его как разрешение диалог
  // дописать: сокращённый текст выходил нужной длины и тут же падал на проверке
  // «убери блок с диалогом». Тема терялась на ровном месте.
  const dialogueRule = shape === 'продукт'
    ? 'Пример диалога сохрани полностью: это самая ценная часть текста.'
    : 'Диалогов и сценок в тексте быть не должно. Если встретишь реплики вида ' +
      '«Клиент: …» и «Агент: …» — удали их целиком, ничем не заменяя.';

  const result = await openrouter.chat({
    messages: [
      {
        role: 'system',
        content:
          'Ты редактор. Сокращаешь готовый текст, ничего не дописывая и не выдумывая. ' +
          'Сохраняешь структуру блоков. Убираешь только повторы и общие рассуждения. ' +
          `Ссылок не добавляешь. ${dialogueRule}`,
      },
      {
        role: 'user',
        content:
          `Сократи этот текст примерно на ${cutPercent} процентов: сейчас ${body.length} ` +
          `знаков, нужно около ${budget}. Каждое предложение сделай короче, оставь по три ` +
          `пункта в каждом списке. Блок «Итог» сохрани. ${dialogueRule}` +
          `\n\n${body}`,
      },
    ],
    temperature: Math.min(temperature, 0.4),
    maxTokens: 1800,
    serviceTier,
  });
  return { body: cleanPostText(stripPreamble(result.content)), result };
}

/** Снять служебное вступление, если модель его дописала. */
function stripPreamble(text) {
  const lines = String(text ?? '').split('\n');
  if (lines.length > 1 && PREAMBLE.test(lines[0])) lines.shift();
  return lines.join('\n');
}

/**
 * Модель нередко всё-таки начинает текст с заголовка, хотя промт этого не просит.
 * Отбрасываем повтор молча: браковать пост из-за строки, которую можно снять
 * одним сравнением, — это лишняя генерация за деньги.
 */
function dropRepeatedTitle(text, phrase) {
  const lines = String(text).split('\n');
  const normalize = (value) => value.trim().replace(/[.:!?]+$/, '').toLowerCase();
  while (lines.length > 0 && (lines[0].trim() === '' || normalize(lines[0]) === normalize(phrase))) {
    lines.shift();
  }
  return lines.join('\n').trim();
}

/** Готовая тема: заголовок, текст, хвост. */
function assemble(phrase, text, tailText) {
  return `${phrase}\n\n${text}\n\n${tailText}`.replace(/\n{3,}/g, '\n\n').trim();
}

/**
 * Генерация поста по материалу.
 *
 * Повторы нужны не из-за сети (это забота http-client), а из-за качества: модель
 * регулярно отдаёт текст короче минимума, забывает диалог или пишет ссылку. Нарушения
 * передаются ей следующей попыткой — это работает заметно лучше, чем просто повторить
 * тот же запрос.
 *
 * @returns {Promise<object>} строка из posts
 */
export async function generatePost(article, { interactive = false, models = null } = {}) {
  const requestId = getRequestId() ?? 'no-rid';
  const prompt = await prompts.getActive('post_prompt');
  if (!prompt) throw new Error('В БД нет активного промта post_prompt');

  const phrase = (article.keyword_phrase || article.topic_name || article.title || '').trim();
  // Вид темы: разбор вопроса или продуктовая. Считается по самой фразе — от него
  // зависит и структура в промте, и то, требует ли проверка блок с диалогом.
  const shape = postShape(phrase);
  if (!phrase) throw new Error(`У материала #${article.id} нет ни фразы ключа, ни названия темы`);

  const minChars = await settings.getInt('post_min_chars', 1500);
  const maxChars = await settings.getInt('post_max_chars', 2500);
  const maxAttempts = await settings.getInt('generation_attempts', 3);
  const temperature = Number(await settings.get('openrouter_temperature', '0.85'));
  const maxTokens = await settings.getInt('openrouter_max_tokens', 1800);
  const everyN = await settings.getInt('ad_block_every_n', 3);
  const similarityMax = Number(await settings.get('similarity_max', '0.30'));
  const comparePosts = await settings.getInt('similarity_compare_posts', 200);
  // flex вдвое дешевле, но может ждать в очереди — для крона это нормально.
  // Когда генерацию дёрнул человек из панели и ждёт ответ, берём priority.
  const serviceTier = interactive ? 'priority' : await settings.get('openrouter_service_tier', 'flex');

  // Номер поста решает две вещи: ставить ли рекламный блок и брать ли цитату отзыва.
  // Считаем по числу уже сделанных постов, а не по случайности: настройка «каждый
  // третий» должна означать ровно то, что написано.
  const postNumber = (await posts.countMade()) + 1;

  // Ссылка у каждого поста своя — `/k/{id}`, иначе не узнать, какая тема принесла
  // переход. Настоящий id появляется только после вставки в БД, поэтому длину
  // считаем по ссылке с номером-заготовкой, а подставляем настоящую после
  // сохранения. Разница в длине — символ-другой, в бюджет она заложена.
  const linksFor = (postId) => ({
    kwork: clickUrl(config.publicBaseUrl, 'kwork', postId),
    visa: clickUrl(config.publicBaseUrl, 'visa', postId),
    vps: clickUrl(config.publicBaseUrl, 'vps', postId),
  });
  const links = linksFor(postNumber);
  const tail = buildTail({ postNumber, everyN, subject: `${phrase} ${article.cluster ?? ''}` });
  const tailRendered = renderLinks(tail.text, links);
  if (hasPlaceholders(tailRendered)) {
    logger.warn(
      { пост: postNumber, хвост: tail.kind },
      `В хвосте поста остался незаполненный плейсхолдер: не задана ссылка для «${tail.kind}»`,
    );
  }

  // Сколько знаков остаётся модели: общий потолок минус заголовок и хвост.
  const budget = maxChars > 0
    ? Math.max(600, maxChars - phrase.length - tailRendered.length - 4)
    : 0;

  // Тема из очереди ключей читает чужие статьи по своему же запросу, обычный
  // материал — ищет по названию проекта. Разворот решения этапа 4: тогда сбор для
  // ключей был выключен как лишняя трата лимита, потому что «фактура у нас своя».
  // На живых текстах это оказалось ошибкой: карточки закрывают только то, что мы
  // делали руками, а на вопрос «как оплатить зарубежный сервис» модель без интернета
  // пишет то, что считает правдоподобным. Получается уверенный текст, в котором
  // нечего проверить, — ровно то, ради чего тему открывать не станут.
  const research = article.keyword_id
    ? await collectForKeyword(article, { phrase })
    : await collectMaterial(article);
  const material = research ? research.text : article.content;

  const recent = await posts.recentShingles(comparePosts);

  let picked = await pickFacts({ cluster: article.cluster ?? null, postNumber });
  const triedFactIds = [...picked.cards.map((card) => card.id)];

  let lastProblems = [];
  let lastError;
  let lastResult;
  let lastText = '';

  const savePost = async (text, result, attempt, similar) => {
    const withPlaceholders = assemble(phrase, text, tail.text);

    // Сохраняем текст с плейсхолдером, а подставляем ссылку следующим запросом.
    // Не наоборот: ссылка персональная (`/k/{post_id}`), а id появляется только
    // после вставки. Опубликованную тему задним числом не отредактировать,
    // поэтому подстановка обязана идти до публикации, но после сохранения.
    //
    // Отпечаток для дедупа считается по тексту с плейсхолдером: иначе одинаковые
    // тексты с разными номерами постов дадут разную схожесть на ровном месте.
    const saved = await posts.create({
      articleId: article.id,
      title: phrase,
      body: withPlaceholders,
      model: result.model,
      provider: result.provider,
      promptVersion: prompt.version,
      tokensIn: result.usage?.prompt_tokens ?? null,
      tokensOut: result.usage?.completion_tokens ?? null,
      costUsd: result.usage?.cost ?? null,
      latencyMs: result.latencyMs,
      attempts: attempt,
      topicKey: article.topic_key,
      requestId,
      shingles: shingles(withPlaceholders),
      similarity: similar?.score ?? null,
      similarTo: similar?.id ?? null,
      tailKind: tail.kind,
    });
    const finalBody = renderLinks(withPlaceholders, linksFor(saved.id));
    const withLinks = await posts.replaceBody(saved.id, finalBody);
    await facts.markUsed(saved.id, picked.cards.map((card) => card.id));
    await posts.markArticleQueued(article.id);

    const latin = latinWords(finalBody);
    if (latin.length > 0) {
      logger.warn(
        { пост: saved.id, слова: latin },
        `В тексте осталась латиница: ${latin.join(', ')} — аудитории 30+ привычнее кириллицей`,
      );
    }

    logger.info(
      {
        пост: saved.id,
        материал: article.id,
        ключ: phrase,
        символов: withLinks.char_count,
        попыток: attempt,
        карточек: picked.cards.length,
        хвост: tail.kind,
        схожесть: similar?.score ? Number(similar.score.toFixed(3)) : 0,
        модель: result.model,
      },
      `Пост #${saved.id} готов: ${withLinks.char_count} символов, попыток ${attempt}, ` +
        `фактов ${picked.cards.length}, хвост «${tail.kind}», модель ${result.model}`,
    );
    return withLinks;
  };

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const userMessage = buildUserMessage({
      phrase,
      shape,
      angle: article.angle,
      cluster: article.cluster,
      factsText: factsToPrompt(picked.cards),
      material,
      budget,
    });
    const messages = [
      { role: 'system', content: prompt.body },
      { role: 'user', content: userMessage },
    ];
    if (lastProblems.length > 0) {
      messages.push({
        role: 'user',
        content: fixInstruction(lastProblems, { budget, length: lastText.length }),
      });
    }

    try {
      const result = await openrouter.chat({
        messages,
        // Модель можно переопределить вызовом: так сравниваются кандидаты на одном
        // и том же ключе и фактуре, без правки .env и перезапуска.
        ...(models ? { models } : {}),
        temperature,
        maxTokens,
        serviceTier,
        // липкость к одному эндпоинту: стабильная латентность вместо перескоков
        sessionId: `my-posting-post-${article.source_code ?? 'x'}`,
      });
      lastResult = result;

      const text = dropRepeatedTitle(cleanPostText(stripPreamble(result.content)), phrase);
      const draft = assemble(phrase, text, tail.text);
      const finalBody = renderLinks(draft, links);
      const problems = [
        ...validateModelText(text),
        ...validatePost(finalBody, { minChars, maxChars, phrase, shape }),
      ];
      // Ответ упёрся в потолок токенов: текст оборван на полуслове, и остальные
      // претензии к нему разбирать бессмысленно.
      if (result.finishReason === 'length') {
        problems.unshift('ответ оборван на середине: не уложился в лимит токенов, пиши короче');
      }

      // Схожесть считаем только у текста, прошедшего остальные проверки: гонять
      // сравнение по заведомо бракованному тексту незачем.
      let similar = { id: null, score: 0 };
      if (problems.length === 0) {
        similar = mostSimilar(shingles(draft), recent);
        if (similar.score >= similarityMax) {
          problems.push(
            `слишком похоже на пост #${similar.id}: схожесть ${similar.score.toFixed(2)} ` +
              `при пороге ${similarityMax}`,
          );
          // Пересобираем на другой фактуре. Просить у модели «напиши иначе» на том же
          // наборе фактов бессмысленно: одинаковая начинка даёт одинаковый текст,
          // как её ни переставляй.
          picked = await pickFacts({
            cluster: article.cluster ?? null,
            postNumber,
            avoidIds: triedFactIds,
          });
          triedFactIds.push(...picked.cards.map((card) => card.id));
          logger.warn(
            { материал: article.id, похоже_на: similar.id, схожесть: Number(similar.score.toFixed(3)) },
            `Текст слишком похож на пост #${similar.id} — пересобираем на другой фактуре`,
          );
        }
      }

      if (problems.length > 0) {
        lastProblems = problems;
        lastText = text;
        logger.warn(
          { материал: article.id, попытка: attempt, символов: finalBody.length, нарушения: problems },
          `Текст не прошёл проверку (попытка ${attempt}/${maxAttempts}): ${problems.join('; ')}`,
        );
        // Единственная претензия — длина: переписывать текст заново бессмысленно
        // и вредно. Живой прогон: три полные генерации подряд дали 2879, 3571 и 3192
        // знака при потолке 2500 — модель не считает символы и на «сократи» отвечает
        // новым длинным текстом. Тот же текст, отданный редактору одной задачей
        // «сократи», ужался до 2154 знаков с первого захода. Значит, при одной только
        // длине уходим к редактору сразу, не тратя оставшиеся попытки.
        if (problems.every((problem) => problem.startsWith('длинно:'))) break;
        continue;
      }

      return await savePost(text, result, attempt, similar);
    } catch (error) {
      lastError = error;
      // 400/401/402/403 повторять бессмысленно — это ключ, кредиты или запрос
      if ([400, 401, 402, 403].includes(error.code)) break;
      logger.warn(
        { материал: article.id, попытка: attempt, ...errFields(error) },
        `Вызов ИИ упал на попытке ${attempt}/${maxAttempts}`,
      );
    }
  }

  // Спасение текста, забракованного только длиной. Всё остальное в нём уже правильно:
  // структура, диалог, фактура. Выбрасывать такой текст и терять тему из-за двух
  // сотен лишних знаков расточительно, а отдельный вызов «сократи» решает задачу,
  // с которой не справляется переписывание с нуля.
  const onlyLength = lastProblems.length > 0
    && lastProblems.every((problem) => problem.startsWith('длинно:'));
  if (!lastError && onlyLength && lastText && budget > 0) {
    try {
      const original = lastText.length;
      let text = lastText;
      let result = lastResult;

      // Несколько заходов: модель сокращает, но недостаточно — с 3426 знаков за раз
      // получилось 3042. Каждый следующий заход считает долю от новой длины, поэтому
      // текст сходится к лимиту, а не топчется около него.
      for (let round = 1; round <= SHRINK_ROUNDS && text.length > budget; round += 1) {
        const shrunk = await shrinkBody(text, { budget, temperature, serviceTier, shape });
        if (!shrunk.body || shrunk.body.length >= text.length) break;
        text = dropRepeatedTitle(shrunk.body, phrase);
        result = shrunk.result;
        logger.info(
          { материал: article.id, заход: round, символов: text.length },
          `Сокращение, заход ${round}: ${text.length} знаков`,
        );
      }

      // Не помогло словами — убираем лишние пункты списков. Промт просит по три,
      // модель раздаёт по пять-шесть, и перебор обычно именно в них.
      if (text.length > budget) {
        const trimmed = trimBulletLists(text);
        if (trimmed.length < text.length) {
          logger.info(
            { материал: article.id, было: text.length, стало: trimmed.length },
            `Лишние пункты списков убраны: ${text.length} → ${trimmed.length} знаков`,
          );
          text = trimmed;
        }
      }

      const draft = assemble(phrase, text, tail.text);
      const finalBody = renderLinks(draft, links);
      const problems = [
        ...validateModelText(text),
        ...validatePost(finalBody, { minChars, maxChars, phrase, shape }),
      ];
      if (problems.length === 0) {
        logger.info(
          { материал: article.id, было: original, стало: text.length },
          `Текст был длиннее лимита (${original}) — сокращён до ${text.length} знаков`,
        );
        return await savePost(text, result, maxAttempts + 1, mostSimilar(shingles(draft), recent));
      }
      logger.warn(
        { материал: article.id, символов: finalBody.length, нарушения: problems },
        `Сокращение не помогло: ${problems.join('; ')}`,
      );
    } catch (error) {
      logger.warn({ материал: article.id, ...errFields(error) }, 'Сокращение текста упало');
    }
  }

  const reason = lastError
    ? lastError.message
    : `валидация не прошла за ${maxAttempts} попыток: ${lastProblems.join('; ')}`;
  const failed = await posts.createFailed({
    articleId: article.id,
    title: phrase,
    model: lastResult?.model ?? openrouter.modelChain()[0],
    promptVersion: prompt.version,
    attempts: maxAttempts,
    topicKey: article.topic_key,
    requestId,
    error: reason,
  });
  logger.error({ материал: article.id, пост: failed.id, причина: reason }, `Генерация поста провалилась: ${reason}`);
  // Записываем именно `lastError`, если он был: в нём тело ответа провайдера, а в `reason`
  // только текст. Когда провайдер отвечал нормально, а брак дала валидация, сервиса нет.
  await captureError('генерация текста', lastError ?? new Error(reason), {
    service: lastError ? 'openrouter' : null,
    details: lastError ? undefined : `Валидация не прошла: ${lastProblems.join('; ')}`,
    articleId: article.id,
    postId: failed.id,
  });
  throw new Error(reason);
}

/** Следующий материал в очереди → пост. Используется кнопкой в панели и cron'ом. */
export async function generateNext({ sourceId = null, ...options } = {}) {
  const article = await posts.nextArticleForGeneration(sourceId);
  if (!article) throw new Error('Нет материалов, готовых к генерации');
  return generatePost(article, options);
}
