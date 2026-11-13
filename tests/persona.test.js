import test from "node:test";
import assert from "node:assert/strict";
import { createWorld, actResponse, FOUR } from "./harness.js";
import { buildSystemPrompt } from "../scripts/agent.js";
import {
  PERSONAS_SCHEMA,
  buildPersonasRequest,
  distinctnessWarnings,
  echoReason,
  mergeSuggestion,
  normalizeAgentRecord,
  overlap,
  parsePersonasResponse,
  temperamentLabel,
  temperamentRules,
} from "../scripts/persona.js";

const CREW = [
  {
    actorId: "a1",
    name: "Вера",
    persona: {
      goal: "найти пропавшего брата",
      fear: "замкнутые пространства",
      voice: "сухо, как отчёт",
      sample: "«Принято.» «Факты, пожалуйста.»",
      publicFace: "холодный штурман с вечным планшетом",
    },
    temperament: { talk: "quiet", risk: "careful", group: "team" },
  },
  {
    actorId: "a2",
    name: "Борис",
    persona: {
      goal: "выплатить долг за корабль любой ценой",
      fear: "снова попасть в тюрьму",
      flaw: "азартен",
      voice: "грубо, с морскими словечками",
      sample: "«Деньги вперёд, салага.»",
      publicFace: "шумный здоровяк-механик",
    },
    temperament: { talk: "chatty", risk: "reckless", group: "contrarian" },
  },
];

test("каждый агент получает свой голос, темперамент и только публичное лицо других", async () => {
  const w = createWorld({ agents: CREW, config: { maxRounds: 1 }, respond: async () => actResponse("pass") });
  w.gmSays("Таможенник требует документы.");
  await w.orchestrator.start();
  const vera = w.calls.find((c) => c.agent === "Вера").body.system[0].text;
  const boris = w.calls.find((c) => c.agent === "Борис").body.system[0].text;

  assert.match(vera, /Манера речи: сухо, как отчёт/);
  assert.match(vera, /Ты молчун/);
  assert.match(vera, /Ты осторожен/);
  assert.match(boris, /Ты разговорчив/);
  assert.match(boris, /Ты рисковый/);
  assert.match(boris, /Ты себе на уме/);
  assert.notEqual(vera, boris);

  // О Борисе Вера знает только видимое со стороны.
  assert.match(vera, /Борис \(болтун, рисковый, спорщик\) — шумный здоровяк-механик/);
  assert.doesNotMatch(vera, /долг за корабль/, "цель Бориса — его тайна");
  assert.doesNotMatch(vera, /тюрьму/, "страх Бориса — его тайна");
  assert.doesNotMatch(boris, /брата/);
  assert.doesNotMatch(boris, /замкнутые/);
});

test("эхо: повтор чужой реплики отклоняется, после подсказки персонаж говорит своё", async () => {
  const replies = { Вера: 0 };
  const w = createWorld({
    agents: CREW,
    config: { maxRounds: 1 },
    respond: async (body, { agent }) => {
      if (agent === "Вера") return actResponse("say", "Этот таможенник явно что-то скрывает, надо проверить его документы.");
      replies.Борис = (replies.Борис ?? 0) + 1;
      return replies.Борис === 1
        ? actResponse("say", "Согласен, таможенник явно что-то скрывает, проверить документы надо.")
        : actResponse("say", "Да плевать на его бумажки — сунем полсотни, и пусть катится.");
    },
  });
  w.gmSays("Таможенник мнётся у трапа.");
  await w.orchestrator.start();
  const borisCalls = w.calls.filter((c) => c.agent === "Борис");
  assert.equal(borisCalls.length, 2, "эхо → один повтор");
  assert.match(borisCalls[1].body.messages[0].content, /почти повторяет то, что уже сказал\(а\) Вера/);
  assert.deepEqual(
    w.posted.map((p) => p.agent + ": " + p.act.text),
    ["Вера: Этот таможенник явно что-то скрывает, надо проверить его документы.", "Борис: Да плевать на его бумажки — сунем полсотни, и пусть катится."],
  );
  assert.equal(w.warnings.length, 0, "эхо мастера не тревожит");
});

test("эхо дважды → персонаж молчит, без предупреждения мастеру", async () => {
  const w = createWorld({
    agents: CREW,
    config: { maxRounds: 1 },
    respond: async () => actResponse("say", "Этот таможенник явно что-то скрывает, надо проверить его документы."),
  });
  w.gmSays("Таможенник мнётся у трапа.");
  await w.orchestrator.start();
  assert.equal(w.posted.length, 1, "в чат попала только первая реплика");
  assert.equal(w.warnings.length, 0);
});

test("echoReason: заявки и короткие реплики не проверяются, свой повтор ловится", () => {
  const recent = [{ name: "Вера", text: "Предлагаю обойти пост через грузовой шлюз ночью" }];
  assert.ok(echoReason({ action: "say", text: "Обойти пост через грузовой шлюз ночью — отличная мысль" }, recent, "Борис"));
  assert.equal(echoReason({ action: "declare", text: "Обхожу пост через грузовой шлюз ночью" }, recent, "Борис"), null);
  assert.equal(echoReason({ action: "say", text: "Да, ночью." }, recent, "Борис"), null);
  assert.equal(echoReason({ action: "say", text: "У меня есть знакомый на станции, он нам поможет" }, recent, "Борис"), null);
  assert.match(echoReason({ action: "say", text: "Предлагаю обойти пост через грузовой шлюз ночью!" }, recent, "Вера"), /свою прошлую/);
  assert.ok(overlap("Таможенник что-то скрывает", "Этот таможенник явно что-то скрывает") > 0.6);
});

test("своя модель для персонажа", async () => {
  const w = createWorld({
    agents: [{ ...CREW[0], model: "claude-haiku-5-5" }, CREW[1]],
    config: { maxRounds: 1 },
    respond: async () => actResponse("pass"),
  });
  w.gmSays("Тишина.");
  await w.orchestrator.start();
  assert.equal(w.calls.find((c) => c.agent === "Вера").body.model, "claude-haiku-5-5");
  assert.equal(w.calls.find((c) => c.agent === "Борис").body.model, "claude-sonnet-5-5");
  assert.equal("thinking" in w.calls.find((c) => c.agent === "Вера").body, false, "between_tools — только для sonnet-5-5");
});

test("старый формат (паспорт текстом) переносится в анкету", () => {
  const r = normalizeAgentRecord({ actorId: "a1", passport: "Цель — разбогатеть", enabled: true });
  assert.equal(r.persona.extra, "Цель — разбогатеть");
  assert.deepEqual(r.temperament, { talk: "normal", risk: "normal", group: "normal" });
  assert.equal(r.model, "");
  assert.deepEqual(normalizeAgentRecord({ temperament: { talk: "дичь" } }).temperament.talk, "normal");
  const p = buildSystemPrompt({ name: "Вера", persona: r.persona, temperament: r.temperament });
  assert.match(p[0].text, /Прочее: Цель — разбогатеть/);
});

test("предупреждения о похожих персонажах", () => {
  const same = { talk: "quiet", risk: "careful", group: "team" };
  const w = distinctnessWarnings([
    { name: "Вера", persona: { goal: "Разбогатеть", voice: "сухо" }, temperament: same },
    { name: "Борис", persona: { goal: "разбогатеть", sample: "«Ну.»" }, temperament: same },
    { name: "Тень", persona: {}, temperament: {} },
    { name: "Сайрус", persona: { goal: "месть" }, temperament: { talk: "chatty" } },
  ]);
  assert.ok(w.some((x) => /Вера и Борис одинаковый темперамент/.test(x)));
  assert.ok(w.some((x) => /Вера и Борис одинаковая цель/.test(x)));
  assert.ok(w.some((x) => /Тень пустая анкета/.test(x)));
  assert.ok(w.some((x) => /Сайрус не задана манера речи/.test(x)));
  assert.deepEqual(distinctnessWarnings(CREW), [], "контрастная пара — без замечаний");
  assert.equal(temperamentLabel({}), "");
  assert.equal(temperamentRules({ talk: "normal" }).length, 0);
});

test("«Придумать разные характеры»: запрос, разбор, слияние без затирания", () => {
  const body = buildPersonasRequest({
    model: "claude-sonnet-5-5",
    effort: "low",
    systemTitle: "Mongoose Traveller 2e",
    slots: [
      { slot: 1, name: "Вера", sheet: "Навыки: Pilot 2", persona: { goal: "найти брата" }, temperament: {} },
      { slot: 2, name: "Борис", sheet: "", persona: {}, temperament: {} },
    ],
  });
  assert.deepEqual(body.output_config, { effort: "low", format: { type: "json_schema", schema: PERSONAS_SCHEMA } });
  assert.deepEqual(body.thinking, { type: "between_tools" });
  assert.match(body.messages[0].content, /Слот 1: Вера[\s\S]*Цель \(goal\): найти брата[\s\S]*Слот 2: Борис[\s\S]*Мастер ничего не задал/);
  assert.equal("tools" in body, false);

  const reply = {
    stop_reason: "end_turn",
    content: [
      {
        type: "text",
        text: JSON.stringify({
          characters: [
            { slot: 1, goal: "ДРУГАЯ цель", fear: "тьма", flaw: "упрямство", voice: "сухо", sample: "«Принято.»", relations: "-", publicFace: "штурман", talk: "quiet", risk: "careful", group: "team" },
            { slot: 2, goal: "долг", fear: "тюрьма", flaw: "азарт", voice: "грубо", sample: "«Ну!»", relations: "-", publicFace: "механик", talk: "chatty", risk: "reckless", group: "contrarian" },
          ],
        }),
      },
    ],
  };
  const parsed = parsePersonasResponse(reply);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.characters.length, 2);

  // Мастер задал цель и выставил темперамент — их не трогаем; пустое заполняем.
  const current = normalizeAgentRecord({ persona: { goal: "найти брата" }, temperament: { talk: "chatty" } });
  const merged = mergeSuggestion(current, parsed.characters[0]);
  assert.equal(merged.persona.goal, "найти брата");
  assert.equal(merged.persona.fear, "тьма");
  assert.deepEqual(merged.temperament, { talk: "chatty", risk: "normal", group: "normal" });
  const fresh = mergeSuggestion(normalizeAgentRecord({}), parsed.characters[1]);
  assert.deepEqual(fresh.temperament, { talk: "chatty", risk: "reckless", group: "contrarian" });

  assert.equal(parsePersonasResponse({ content: [{ type: "text", text: "не json" }] }).ok, false);
  assert.equal(parsePersonasResponse({ stop_reason: "max_tokens", content: [] }).ok, false);
});

test("схема характеров подходит для structured outputs", () => {
  const walk = (node) => {
    if (node.type === "object") {
      assert.equal(node.additionalProperties, false);
      assert.deepEqual([...node.required].sort(), Object.keys(node.properties).sort());
      Object.values(node.properties).forEach(walk);
    }
    if (node.type === "array") walk(node.items);
    for (const bad of ["minimum", "maximum", "minLength", "maxLength", "minItems", "maxItems"]) assert.equal(bad in node, false);
  };
  walk(PERSONAS_SCHEMA);
});
