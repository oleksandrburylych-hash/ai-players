import test from "node:test";
import assert from "node:assert/strict";
import { createApi, modelTuning, API_URL, ANTHROPIC_VERSION, responseText } from "../scripts/api.js";

function fakeFetch(responder) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init });
    const r = await responder(url, init);
    if (r instanceof Error) throw r;
    return { ok: r.status >= 200 && r.status < 300, status: r.status, text: async () => (typeof r.body === "string" ? r.body : JSON.stringify(r.body)) };
  };
  fn.calls = calls;
  return fn;
}

test("заголовки и адрес запроса", async () => {
  const f = fakeFetch(() => ({ status: 200, body: { content: [], usage: { input_tokens: 1, output_tokens: 1 } } }));
  const api = createApi({ fetchImpl: f, getApiKey: () => " sk-ant-xyz " });
  await api.messages({ model: "m", max_tokens: 10, messages: [] });
  const { url, init } = f.calls[0];
  assert.equal(url, API_URL);
  assert.equal(url, "https://api.anthropic.com/v1/messages");
  assert.equal(init.method, "POST");
  assert.deepEqual(init.headers, {
    "x-api-key": "sk-ant-xyz",
    "anthropic-version": ANTHROPIC_VERSION,
    "anthropic-dangerous-direct-browser-access": "true",
    "content-type": "application/json",
  });
  assert.equal(ANTHROPIC_VERSION, "2023-06-01");
});

test("счётчик токенов складывает usage из ответов", async () => {
  const f = fakeFetch(() => ({
    status: 200,
    body: { content: [], usage: { input_tokens: 120, output_tokens: 30, cache_read_input_tokens: 900, cache_creation_input_tokens: 50 } },
  }));
  const api = createApi({ fetchImpl: f, getApiKey: () => "k" });
  await api.messages({});
  await api.messages({});
  assert.deepEqual(api.usage, {
    requests: 2,
    errors: 0,
    inputTokens: 240,
    outputTokens: 60,
    cacheReadTokens: 1800,
    cacheWriteTokens: 100,
  });
});

test("без ключа запрос не отправляется", async () => {
  const f = fakeFetch(() => ({ status: 200, body: {} }));
  const api = createApi({ fetchImpl: f, getApiKey: () => "" });
  await assert.rejects(api.messages({}), (e) => e.kind === "no_key" && /ключ/i.test(e.message));
  assert.equal(f.calls.length, 0);
  assert.equal(api.usage.requests, 0);
});

test("понятные ошибки по статусам", async () => {
  const cases = [
    [401, "authentication_error", "auth", /ключ/i],
    [403, "permission_error", "permission", /доступ/i],
    [404, "not_found_error", "not_found", /Модель «claude-x» не найдена/],
    [429, "rate_limit_error", "rate_limit", /лимит/i],
    [529, "overloaded_error", "overloaded", /перегружен/i],
    [500, "api_error", "server", /сервиса/i],
    [400, "invalid_request_error", "bad_request", /credit balance/],
  ];
  for (const [status, type, kind, re] of cases) {
    const f = fakeFetch(() => ({ status, body: { type: "error", error: { type, message: "Your credit balance is too low" } } }));
    const api = createApi({ fetchImpl: f, getApiKey: () => "k" });
    await assert.rejects(api.messages({ model: "claude-x" }), (e) => {
      assert.equal(e.kind, kind, `HTTP ${status}`);
      assert.match(e.message, re);
      assert.equal(e.status, status);
      return true;
    });
    assert.equal(api.usage.errors, 1);
  }
});

test("сеть и отмена", async () => {
  const api = createApi({ fetchImpl: fakeFetch(() => new TypeError("Failed to fetch")), getApiKey: () => "k" });
  await assert.rejects(api.messages({}), (e) => e.kind === "network" && /api\.anthropic\.com/.test(e.message));

  const abortErr = Object.assign(new Error("The operation was aborted"), { name: "AbortError" });
  const api2 = createApi({ fetchImpl: fakeFetch(() => abortErr), getApiKey: () => "k" });
  await assert.rejects(api2.messages({}), (e) => e.kind === "aborted");
  assert.equal(api2.usage.errors, 0, "отмена — не ошибка");
});

test("modelTuning по модели", () => {
  assert.deepEqual(modelTuning("claude-sonnet-5-5", "low"), { thinking: { type: "between_tools" }, output_config: { effort: "low" } });
  assert.deepEqual(modelTuning("claude-sonnet-5-5", "max"), { thinking: { type: "between_tools" }, output_config: { effort: "high" } });
  assert.deepEqual(modelTuning("claude-sonnet-5-5", "none"), { thinking: { type: "between_tools" } });
  assert.deepEqual(modelTuning("claude-opus-5-5", "medium"), { output_config: { effort: "medium" } });
  assert.deepEqual(modelTuning("claude-haiku-4-5", "none"), {});
  assert.deepEqual(modelTuning("claude-sonnet-5", "low"), { output_config: { effort: "low" } }, "Sonnet 5 — не 5.5");
});

test("responseText собирает только текстовые блоки", () => {
  assert.equal(
    responseText({ content: [{ type: "thinking", thinking: "" }, { type: "text", text: "- пункт 1" }, { type: "text", text: "- пункт 2" }] }),
    "- пункт 1\n- пункт 2",
  );
});
