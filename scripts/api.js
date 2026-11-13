/**
 * api.js — вызов Anthropic Messages API напрямую из браузера, обработка ошибок,
 * счётчик токенов за сессию.
 *
 * Чистый модуль: `fetch` и получение ключа передаются снаружи, поэтому его можно
 * тестировать в Node с подставным fetch. Официальный SDK не используется (требование ТЗ).
 */

export const API_URL = "https://api.anthropic.com/v1/messages";
export const ANTHROPIC_VERSION = "2023-06-01";

export class ApiError extends Error {
  /**
   * @param {string} kind  no_key | auth | permission | not_found | bad_request | too_large |
   *                       rate_limit | overloaded | server | network | aborted | bad_response
   * @param {string} message  понятный мастеру текст на русском
   * @param {object} [extra]  { status, apiType, apiMessage }
   */
  constructor(kind, message, extra = {}) {
    super(message);
    this.name = "ApiError";
    this.kind = kind;
    this.status = extra.status ?? null;
    this.apiType = extra.apiType ?? null;
    this.apiMessage = extra.apiMessage ?? null;
  }
}

export function isAbortError(err) {
  return err?.kind === "aborted" || err?.name === "AbortError";
}

/**
 * Параметры размышлений/усилия под конкретную модель.
 *
 * - `output_config.effort` — сколько модель «думает». Для коротких реплик за столом хватает `low`.
 *   Старые модели (Sonnet 4.5, Haiku 4.5) параметр effort не принимают — для них в настройке
 *   выбирается «не отправлять».
 * - Claude Sonnet 5.5 не принимает `thinking: {type: "disabled"}`; самый «тихий» режим там —
 *   `{type: "between_tools"}` (без расширенного размышления), он допустим при effort не выше `high`.
 *   Остальные модели этот тип отвергают, поэтому включаем его только для claude-sonnet-5-5.
 *   Без этого размышление тратит бюджет max_tokens (400 по умолчанию) и ответ может оборваться.
 */
export function modelTuning(model, effort) {
  const out = {};
  const m = String(model || "").trim();
  let e = effort && effort !== "none" ? String(effort) : null;
  if (/^claude-sonnet-5-5(\b|$)/.test(m)) {
    if (e && !["low", "medium", "high"].includes(e)) e = "high";
    out.thinking = { type: "between_tools" };
  }
  if (e) out.output_config = { effort: e };
  return out;
}

/** Понятный текст ошибки по HTTP-статусу и типу ошибки API. */
export function describeHttpError(status, apiType, apiMessage, model) {
  const tail = apiMessage ? ` (${apiMessage})` : "";
  switch (status) {
    case 400:
      return new ApiError("bad_request", `API отклонил запрос${tail}.`, { status, apiType, apiMessage });
    case 401:
      return new ApiError("auth", "Неверный или отозванный API-ключ Anthropic. Проверьте ключ в настройках модуля.", {
        status,
        apiType,
        apiMessage,
      });
    case 403:
      return new ApiError("permission", `У ключа нет доступа к этому ресурсу или модели${tail}.`, { status, apiType, apiMessage });
    case 404:
      return new ApiError("not_found", `Модель «${model}» не найдена. Проверьте настройку «Модель»${tail}.`, {
        status,
        apiType,
        apiMessage,
      });
    case 413:
      return new ApiError("too_large", "Запрос слишком большой. Уменьшите число сообщений чата в настройках.", {
        status,
        apiType,
        apiMessage,
      });
    case 429:
      return new ApiError("rate_limit", "Превышен лимит запросов API Anthropic. Подождите немного и попробуйте снова.", {
        status,
        apiType,
        apiMessage,
      });
    case 529:
      return new ApiError("overloaded", "Сервис Anthropic перегружен. Попробуйте чуть позже.", { status, apiType, apiMessage });
    default:
      if (status >= 500) {
        return new ApiError("server", `Ошибка на стороне сервиса Anthropic (HTTP ${status})${tail}.`, { status, apiType, apiMessage });
      }
      return new ApiError("bad_request", `Неожиданный ответ API (HTTP ${status})${tail}.`, { status, apiType, apiMessage });
  }
}

export function emptyUsage() {
  return { requests: 0, errors: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
}

/**
 * @param {object} opts
 * @param {Function} opts.fetchImpl        fetch (в браузере — globalThis.fetch)
 * @param {Function} opts.getApiKey        () => string
 */
export function createApi({ fetchImpl, getApiKey }) {
  const usage = emptyUsage();

  /**
   * POST /v1/messages. Возвращает разобранный JSON ответа или бросает ApiError.
   * Никаких автоматических повторов здесь нет (ТЗ, раздел 10).
   */
  async function messages(body, { signal } = {}) {
    const key = String(getApiKey?.() || "").trim();
    if (!key) {
      throw new ApiError("no_key", "Не задан API-ключ Anthropic. Откройте «Настройки → Настройки модулей → ИИ-игроки».");
    }
    if (signal?.aborted) throw new ApiError("aborted", "Запрос отменён.");

    usage.requests += 1;
    let res;
    try {
      res = await fetchImpl(API_URL, {
        method: "POST",
        headers: {
          "x-api-key": key,
          "anthropic-version": ANTHROPIC_VERSION,
          "anthropic-dangerous-direct-browser-access": "true",
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
        signal,
      });
    } catch (err) {
      if (isAbortError(err) || signal?.aborted) throw new ApiError("aborted", "Запрос отменён.");
      usage.errors += 1;
      throw new ApiError(
        "network",
        "Нет связи с api.anthropic.com. Проверьте интернет, блокировщик рекламы или прокси.",
        { apiMessage: String(err?.message || err) },
      );
    }

    let data = null;
    let rawText = "";
    try {
      rawText = await res.text();
      data = rawText ? JSON.parse(rawText) : null;
    } catch (err) {
      if (isAbortError(err) || signal?.aborted) throw new ApiError("aborted", "Запрос отменён.");
      data = null;
    }

    if (!res.ok) {
      usage.errors += 1;
      const apiType = data?.error?.type ?? null;
      const apiMessage = data?.error?.message ?? (rawText ? rawText.slice(0, 200) : null);
      throw describeHttpError(res.status, apiType, apiMessage, body?.model);
    }
    if (!data || typeof data !== "object") {
      usage.errors += 1;
      throw new ApiError("bad_response", "API вернул ответ, который не удалось прочитать.");
    }

    const u = data.usage || {};
    usage.inputTokens += u.input_tokens || 0;
    usage.outputTokens += u.output_tokens || 0;
    usage.cacheReadTokens += u.cache_read_input_tokens || 0;
    usage.cacheWriteTokens += u.cache_creation_input_tokens || 0;
    return data;
  }

  function resetUsage() {
    Object.assign(usage, emptyUsage());
  }

  return { messages, usage, resetUsage };
}

/** Собрать весь текст из ответа (для /ai recap). */
export function responseText(data) {
  return (data?.content || [])
    .filter((b) => b && b.type === "text" && typeof b.text === "string")
    .map((b) => b.text)
    .join("\n")
    .trim();
}
