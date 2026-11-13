import test from "node:test";
import assert from "node:assert/strict";
import { createWorld, actResponse, textResponse, FOUR } from "./harness.js";
import {
  ACT_TOOL,
  PASS,
  buildAgentRequest,
  buildSystemPrompt,
  parseActResponse,
  takeTurn,
} from "../scripts/agent.js";
import { addNote } from "../scripts/visibility.js";

test("секрет одного агента не попадает в контекст других", async () => {
  const w = createWorld({ agents: FOUR, config: { maxRounds: 1 }, respond: async () => actResponse("pass") });
  w.notes.a2 = addNote([], "Груз в трюме — контрабанда, капитан об этом не знает.");
  w.gmSays("Таможенник поднимается на борт.");
  await w.orchestrator.start();

  assert.equal(w.calls.length, 4);
  for (const call of w.calls) {
    const all = JSON.stringify(call.body);
    if (call.agent === "Борис") assert.match(all, /контрабанда/, "Борис знает свой секрет");
    else assert.doesNotMatch(all, /контрабанда/, `${call.agent} не должен знать секрет Бориса`);
  }
});

test("неразобранный ответ: один повтор, затем pass и предупреждение мастеру", async () => {
  const w = createWorld({
    agents: FOUR.slice(0, 1),
    config: { maxRounds: 1 },
    respond: async () => textResponse("Я думаю, что…"),
  });
  w.gmSays("Ваш ход.");
  const res = await w.orchestrator.start();
  assert.equal(w.calls.length, 2, "первый запрос + ровно один повтор");
  assert.equal(w.posted.length, 0, "итог — pass, в чат ничего");
  assert.equal(w.warnings.length, 1, "мастер получил предупреждение");
  assert.match(w.warnings[0].text, /не разобран/);
  assert.equal(res.reason, "all_passed");
});

test("неразобранный ответ, затем удачный повтор — используется повтор", async () => {
  let n = 0;
  const w = createWorld({
    agents: FOUR.slice(0, 1),
    config: { maxRounds: 1 },
    respond: async () => (n++ === 0 ? textResponse() : actResponse("declare", "Открываю люк монтировкой.")),
  });
  w.gmSays("Люк заклинило.");
  await w.orchestrator.start();
  assert.equal(w.calls.length, 2);
  assert.equal(w.posted.length, 1);
  assert.equal(w.posted[0].act.action, "declare");
  assert.equal(w.warnings.length, 0);
});

test("takeTurn: ошибка API — без повтора", async () => {
  let calls = 0;
  const err = Object.assign(new Error("Превышен лимит"), { kind: "rate_limit" });
  const res = await takeTurn({
    request: {},
    callModel: async () => {
      calls++;
      throw err;
    },
  });
  assert.equal(calls, 1);
  assert.equal(res.error, err);
});

test("takeTurn: без бюджета на повтор — сразу pass", async () => {
  let calls = 0;
  const res = await takeTurn({ request: {}, maxAttempts: 1, callModel: async () => (calls++, textResponse()) });
  assert.equal(calls, 1);
  assert.deepEqual(res.act, { ...PASS });
  assert.match(res.warning, /не хватило лимита/);
});

test("parseActResponse: разбор и проверки", () => {
  assert.equal(parseActResponse(actResponse("say", "Привет")).act.action, "say");
  assert.equal(parseActResponse(actResponse("pass", "что-то")).act.text, "", "у pass текст отбрасывается");
  assert.equal(parseActResponse(actResponse("say", "")).ok, false, "say без текста — не разобрано");
  assert.equal(parseActResponse(actResponse("dance", "Танцую")).ok, false);
  assert.equal(parseActResponse(textResponse()).ok, false);
  assert.equal(parseActResponse({ stop_reason: "refusal", content: [] }).ok, false);
  assert.equal(parseActResponse({ stop_reason: "max_tokens", content: [{ type: "thinking", thinking: "" }] }).ok, false);

  // Блоки читаются по типу: thinking перед tool_use не мешает.
  const withThinking = actResponse("declare", "Беру винтовку.");
  withThinking.content.unshift({ type: "thinking", thinking: "", signature: "x" });
  assert.equal(parseActResponse(withThinking).act.text, "Беру винтовку.");

  // Пустой roll_request → null, заполненный — сохраняется.
  assert.equal(parseActResponse(actResponse("declare", "Иду")).act.roll_request, null);
  const rr = parseActResponse(
    actResponse("declare", "Взламываю замок", { roll_request: { skill: "Electronics", characteristic: "", reason: "замок" } }),
  ).act.roll_request;
  assert.deepEqual(rr, { skill: "Electronics", characteristic: "", reason: "замок" });
});

test("запрос агента: инструмент act, auto, без принудительного выбора", () => {
  const body = buildAgentRequest({
    model: "claude-sonnet-5-5",
    maxTokens: 400,
    effort: "low",
    system: buildSystemPrompt({ name: "Вера", passport: "Трусиха" }),
    userText: "Твой ход, Вера.",
  });
  assert.equal(body.model, "claude-sonnet-5-5");
  assert.equal(body.max_tokens, 400);
  assert.deepEqual(body.tools, [ACT_TOOL]);
  assert.equal(body.tool_choice.type, "auto");
  assert.deepEqual(body.thinking, { type: "between_tools" });
  assert.deepEqual(body.output_config, { effort: "low" });
  assert.equal(body.system[0].cache_control.type, "ephemeral");
  assert.match(body.system[0].text, /Ты игрок, а не мастер/);
  assert.match(body.system[0].text, /Трусиха/);
  assert.equal("temperature" in body, false);

  const other = buildAgentRequest({ model: "claude-opus-5-5", maxTokens: 400, effort: "none", system: [], userText: "" });
  assert.equal("thinking" in other, false, "between_tools — только для claude-sonnet-5-5");
  assert.equal("output_config" in other, false, "effort «не отправлять»");
});

test("схема act: строгая и полная", () => {
  const s = ACT_TOOL.input_schema;
  assert.equal(ACT_TOOL.strict, true);
  assert.equal(s.additionalProperties, false);
  assert.deepEqual([...s.required].sort(), Object.keys(s.properties).sort());
  const rr = s.properties.roll_request;
  assert.equal(rr.additionalProperties, false);
  assert.deepEqual([...rr.required].sort(), Object.keys(rr.properties).sort());
  assert.deepEqual(s.properties.action.enum, ["pass", "say", "ask_gm", "declare"]);
});
