import { request, HttpError } from './http-client.js';
import { config } from '../config.js';
import { log } from '../logger.js';

const logger = log('openrouter');

/**
 * Клиент OpenRouter (OpenAI-совместимый /chat/completions).
 *
 * Три особенности провайдера, из-за которых нельзя обойтись «просто fetch»:
 *
 * 1. HTTP 200 не значит успех. Если модель начала отвечать и упала, статус остаётся 200,
 *    а ошибка приходит в теле или как `finish_reason: "error"`. Проверяем и то, и другое.
 * 2. Фолбэк по моделям задаётся массивом `models`: следующая берётся, когда у предыдущей
 *    исчерпаны все провайдеры. Поэтому падение основной модели не требует нашего кода —
 *    но требует своего таймаута, потому что перебор занимает время.
 * 3. Строгий JSON требует `strict: true`, полного `required`, `additionalProperties: false`
 *    и `provider.require_parameters`, иначе запрос может уйти провайдеру без поддержки схемы.
 *
 * Ретраи и учёт Retry-After живут в http-client: 400/401/402/403 он не повторяет
 * (повтор не поможет), 408/429/5xx повторяет с бэкоффом.
 */

export class OpenRouterError extends Error {
  constructor(message, { code, cause } = {}) {
    // cause — ради журнала ошибок: тело ответа провайдера остаётся только там.
    super(message, cause ? { cause } : undefined);
    this.name = 'OpenRouterError';
    this.code = code;
  }
}

export function isConfigured() {
  return Boolean(config.openrouter.apiKey);
}

/**
 * Модели по порядку: основная, затем запасная. Перебирает их наш код, а не OpenRouter
 * (см. комментарий в chat): его поле `models` подменяет модель молча.
 */
export function modelChain() {
  return [config.openrouter.model, config.openrouter.fallbackModel].filter(Boolean);
}

/**
 * @param {object} params
 * @param {Array<{role: string, content: string}>} params.messages
 * @param {object} [params.schema]        JSON Schema — включает строгий JSON на выходе
 * @param {string} [params.schemaName]
 * @param {string[]} [params.models]
 * @param {number} [params.temperature]
 * @param {number} [params.maxTokens]
 * @param {string} [params.serviceTier]   'flex' (дешевле) | 'priority' (быстрее)
 * @param {string} [params.sessionId]     липкость к одному эндпоинту → стабильная латентность
 * @returns {Promise<{content: string, data: any, model: string, provider: string,
 *                    usage: object, latencyMs: number, finishReason: string}>}
 */
export async function chat({
  messages,
  schema,
  schemaName = 'result',
  models = modelChain(),
  temperature = 0.85,
  maxTokens = 1800,
  serviceTier,
  sessionId,
  retries = 2,
} = {}) {
  if (!isConfigured()) {
    throw new OpenRouterError('Не задан OPENROUTER_API_KEY — генерация текста недоступна');
  }

  const chain = Array.isArray(models) ? models.filter(Boolean) : [models].filter(Boolean);
  if (chain.length === 0) throw new OpenRouterError('Не задана ни одна модель');

  const buildBody = (model) => {
    // Одна модель в поле `model`, и никакого поля `models`.
    //
    // Поле `models` выглядит как «основная, затем запасная», но ведёт себя иначе:
    // OpenRouter считает список равноправным набором кандидатов и маршрутизирует
    // по своим соображениям. На живой проверке пара [claude-sonnet-5, gemini-3.7-flash]
    // раз за разом уходила в gemini — то есть выбранная модель молча подменялась
    // более дешёвой, и понять это можно было только по полю `model` в ответе.
    // Поэтому перебор запасных делаем сами, ниже по коду.
    const out = { model, messages, temperature, max_tokens: maxTokens };
    if (serviceTier) out.service_tier = serviceTier;
    if (sessionId) out.session_id = sessionId;
    if (schema) {
      out.response_format = {
        type: 'json_schema',
        json_schema: { name: schemaName, strict: true, schema },
      };
      // Провайдер обязан поддерживать структурированный вывод. Побочный эффект:
      // из выдачи выпадают все, кроме Google, — Anthropic и OpenAI такую поддержку
      // не заявляют, и запрос отвечает «404 No endpoints found».
      out.provider = { require_parameters: true };
    }
    return out;
  };

  const startedAt = Date.now();
  let json;
  let lastError;
  for (const [index, model] of chain.entries()) {
    try {
      json = await request(`${config.openrouter.baseUrl}/chat/completions`, {
        method: 'POST',
        label: 'openrouter',
        json: buildBody(model),
        timeoutMs: config.openrouter.timeoutMs,
        retries,
        headers: {
          Authorization: `Bearer ${config.openrouter.apiKey}`,
          Accept: 'application/json',
          'X-OpenRouter-Title': 'my-posting',
        },
      });
      break;
    } catch (error) {
      // Тело ошибки провайдера информативнее статуса: там причина отказа модели.
      lastError = error instanceof HttpError
        ? new OpenRouterError(
          `OpenRouter ${error.status}: ${parseErrorBody(error.body) ?? 'без описания'}`,
          { code: error.status, cause: error },
        )
        : error;
      const isLast = index === chain.length - 1;
      // Ключ и запрет доступа запасной моделью не лечатся, а вот 402 — лечится:
      // OpenRouter держит на запрос залог по потолку токенов, и на дорогой модели
      // его может не хватить там, где дешёвой остатка достаточно. Ровно так и вышло
      // на живом прогоне: claude отвечал 402, а gemini на том же остатке работал.
      const hopeless = [401, 403].includes(lastError.code);
      if (isLast || hopeless) throw lastError;
      logger.warn(
        { модель: model, запасная: chain[index + 1], причина: lastError.message },
        `Модель ${model} не ответила — пробуем запасную ${chain[index + 1]}`,
      );
    }
  }
  const latencyMs = Date.now() - startedAt;

  if (json?.error) {
    throw new OpenRouterError(`OpenRouter ${json.error.code}: ${json.error.message}`, {
      code: json.error.code,
    });
  }

  const choice = json?.choices?.[0];
  if (choice?.finish_reason === 'error') {
    throw new OpenRouterError(
      `Генерация оборвалась после старта: ${JSON.stringify(choice.error ?? {})}`,
    );
  }

  const content = choice?.message?.content ?? '';
  const usage = json?.usage ?? {};

  logger.info(
    {
      модель: json?.model,
      провайдер_модели: json?.provider,
      токенов_вход: usage.prompt_tokens,
      токенов_выход: usage.completion_tokens,
      стоимость_usd: usage.cost,
      ms: latencyMs,
      причина_остановки: choice?.finish_reason,
    },
    `Вызов ИИ: ${json?.model ?? '(модель неизвестна)'}, ${latencyMs} мс, ` +
      `${usage.completion_tokens ?? '?'} токенов ответа, $${usage.cost ?? '?'}`,
  );

  if (!content) {
    throw new OpenRouterError('Модель вернула пустой ответ');
  }

  let data;
  if (schema) {
    try {
      data = JSON.parse(content);
    } catch {
      throw new OpenRouterError(
        `Ожидался JSON по схеме, пришёл текст: ${content.slice(0, 300)}`,
      );
    }
  }

  return {
    content,
    data,
    model: json?.model,
    provider: json?.provider,
    usage,
    latencyMs,
    finishReason: choice?.finish_reason,
  };
}

function parseErrorBody(text) {
  if (!text) return null;
  try {
    const parsed = JSON.parse(text);
    return parsed?.error?.message ?? text.slice(0, 300);
  } catch {
    return text.slice(0, 300);
  }
}

/** Остаток и расход по рантайм-ключу: GET /key. Нужен для проверки перед пачкой. */
export async function keyInfo() {
  const json = await request(`${config.openrouter.baseUrl}/key`, {
    label: 'openrouter',
    retries: 1,
    timeoutMs: 15_000,
    headers: { Authorization: `Bearer ${config.openrouter.apiKey}`, Accept: 'application/json' },
  });
  return json?.data ?? json;
}
