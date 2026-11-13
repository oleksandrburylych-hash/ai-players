import test from "node:test";
import assert from "node:assert/strict";
import { createWorld, actResponse, textResponse, deferred, FOUR } from "./harness.js";
import { STOP_REASONS, rotate } from "../scripts/orchestrator.js";

test("цикл останавливается, когда все в круге выбрали pass", async () => {
  const w = createWorld({ agents: FOUR, respond: async () => actResponse("pass") });
  w.gmSays("Вы стоите у шлюза.");
  const res = await w.orchestrator.start();
  assert.equal(res.reason, STOP_REASONS.ALL_PASSED);
  assert.equal(w.calls.length, 4, "ровно один круг — по запросу на агента");
  assert.equal(w.posted.length, 0, "pass в чат не выводится");
  assert.equal(w.summaries.length, 1, "в конце — одна карточка");
  assert.deepEqual(
    w.summaries[0].entries.map((e) => e.act),
    [null, null, null, null],
    "все «молчат»",
  );
});

test("цикл останавливается по лимиту кругов", async () => {
  const w = createWorld({
    agents: FOUR.slice(0, 2),
    config: { maxRounds: 3, maxRequests: 100 },
    respond: async (body, { agent }) => actResponse("say", `${agent}: реплика`),
  });
  w.gmSays("Торговец называет цену.");
  const res = await w.orchestrator.start();
  assert.equal(res.reason, STOP_REASONS.MAX_ROUNDS);
  assert.equal(res.rounds, 3);
  assert.equal(w.calls.length, 6, "2 агента × 3 круга");
  assert.equal(w.posted.length, 6);
  assert.equal(w.summaries.length, 1);
});

test("цикл останавливается по лимиту запросов", async () => {
  const w = createWorld({
    agents: FOUR,
    config: { maxRounds: 10, maxRequests: 5 },
    respond: async () => actResponse("say", "Давайте подумаем."),
  });
  w.gmSays("Корабль дрейфует.");
  const res = await w.orchestrator.start();
  assert.equal(res.reason, STOP_REASONS.MAX_REQUESTS);
  assert.equal(w.calls.length, 5, "ни одного запроса сверх лимита");
  assert.equal(res.requests, 5);
});

test("лимит запросов учитывает повтор: повтор не выходит за предел", async () => {
  const w = createWorld({
    agents: FOUR.slice(0, 2),
    config: { maxRounds: 5, maxRequests: 3 },
    respond: async () => textResponse(), // всё время неразобранные ответы
  });
  w.gmSays("Тишина.");
  await w.orchestrator.start();
  assert.ok(w.calls.length <= 3, `запросов ${w.calls.length}, лимит 3`);
});

test("новое сообщение мастера прерывает цикл и запускает новый", async () => {
  const gate = deferred();
  let firstCycle = true;
  const w = createWorld({
    agents: FOUR.slice(0, 2),
    respond: async (body, { call }) => {
      if (firstCycle && call === 0) return gate.promise; // первый агент «думает»
      return actResponse("pass");
    },
  });
  w.gmSays("Сцена 1.");
  const first = w.orchestrator.start();
  await new Promise((r) => setImmediate(r));
  assert.equal(w.calls.length, 1, "первый цикл успел отправить один запрос");
  const firstSignal = w.calls[0].signal;

  // Мастер пишет новое сообщение посреди цикла.
  firstCycle = false;
  w.gmSays("Сцена 2: в шлюз входит патруль.");
  const second = w.orchestrator.start();
  assert.ok(firstSignal.aborted, "запрос старого цикла отменён");
  gate.resolve(actResponse("declare", "Стреляю в патрульного.")); // запоздалый ответ — игнорируется

  const r1 = await first;
  const r2 = await second;
  assert.equal(r1.reason, STOP_REASONS.INTERRUPTED);
  assert.equal(r2.reason, STOP_REASONS.ALL_PASSED);
  assert.equal(w.posted.length, 0, "ответ из прерванного цикла в чат не попал");
  assert.equal(w.summaries.length, 1, "карточку выводит только новый цикл");
  const lastUser = w.calls.at(-1).body.messages[0].content;
  assert.match(lastUser, /Сцена 2/, "новый цикл видит новое сообщение мастера");
});

test("/ai stop останавливает цикл немедленно", async () => {
  const gate = deferred();
  const w = createWorld({ agents: FOUR, respond: async () => gate.promise });
  w.gmSays("Что делаете?");
  const run = w.orchestrator.start();
  await new Promise((r) => setImmediate(r));
  assert.equal(w.orchestrator.stop(), true);
  gate.resolve(actResponse("declare", "Бегу."));
  const res = await run;
  assert.equal(res.reason, STOP_REASONS.STOPPED);
  assert.equal(w.calls.length, 1);
  assert.equal(w.posted.length, 0);
  assert.equal(w.summaries.length, 0, "заявок не было — карточки нет");
  assert.equal(w.orchestrator.isRunning, false);
});

test("цикл заканчивается, когда все сделали заявку или задали вопрос", async () => {
  const w = createWorld({
    agents: FOUR.slice(0, 3),
    respond: async (body, { agent }) =>
      agent === "Борис"
        ? actResponse("ask_gm", "Сколько охранников у двери?")
        : actResponse("declare", `${agent}: прикрываю вход из-за ящиков`, {
            roll_request: { skill: "Gun Combat", characteristic: "DEX", reason: "если начнут стрелять" },
          }),
  });
  w.gmSays("Двери склада открыты.");
  const res = await w.orchestrator.start();
  assert.equal(res.reason, STOP_REASONS.ALL_DECLARED);
  assert.equal(w.calls.length, 3);
  const card = w.summaries[0].entries;
  assert.equal(card.length, 3);
  assert.equal(card.find((e) => e.agent.name === "Борис").act.action, "ask_gm");
  assert.equal(card.find((e) => e.agent.name === "Вера").act.roll_request.skill, "Gun Combat");
});

test("агент вне сцены не вызывается и не получает сообщений", async () => {
  const w = createWorld({
    agents: FOUR,
    scene: { all: false, ids: ["a1", "a2"] }, // Сайрус и Тень — вне сцены
    respond: async (body, { agent }) => actResponse(agent === "Вера" ? "say" : "pass", "Тут кто-то был."),
  });
  w.gmSays("В трюме вы находите тайник.");
  await w.orchestrator.start();
  const called = new Set(w.calls.map((c) => c.agent));
  assert.deepEqual([...called].sort(), ["Борис", "Вера"]);

  // Позже Сайрус входит в сцену: событий трюма он не видел.
  w.scene = { all: true, ids: [] };
  w.gmSays("Сайрус заходит в кают-компанию.");
  w.config.maxRounds = 1;
  await w.orchestrator.start();
  const cyrus = w.calls.find((c) => c.agent === "Сайрус");
  assert.ok(cyrus, "теперь Сайрус в сцене и вызывается");
  const ctx = cyrus.body.messages[0].content;
  assert.doesNotMatch(ctx, /тайник/, "сообщение мастера из чужой сцены не видно");
  assert.doesNotMatch(ctx, /Тут кто-то был/, "реплики из чужой сцены не видны");
  assert.match(ctx, /кают-компанию/);
});

test("каждый следующий агент видит ответ предыдущего в том же круге", async () => {
  const w = createWorld({
    agents: FOUR.slice(0, 2),
    config: { maxRounds: 1 },
    respond: async (body, { agent }) => (agent === "Вера" ? actResponse("say", "Я против, это ловушка.") : actResponse("pass")),
  });
  w.gmSays("Незнакомец предлагает работу.");
  await w.orchestrator.start();
  const boris = w.calls.find((c) => c.agent === "Борис");
  assert.match(boris.body.messages[0].content, /Вера: Я против, это ловушка\./);
});

test("начало круга сдвигается на одного агента с каждой сценой", async () => {
  const w = createWorld({ agents: FOUR, respond: async () => actResponse("pass") });
  const firsts = [];
  for (let i = 0; i < 5; i++) {
    w.gmSays(`Сцена ${i}`);
    const before = w.calls.length;
    await w.orchestrator.start();
    firsts.push(w.calls[before].agent);
  }
  assert.deepEqual(firsts, ["Вера", "Борис", "Сайрус", "Тень", "Вера"]);
  assert.deepEqual(rotate([1, 2, 3], 4), [2, 3, 1]);
});

test("ошибка API останавливает цикл и сообщается мастеру", async () => {
  const w = createWorld({
    agents: FOUR,
    respond: async () => ({ __http: true, status: 401, body: { type: "error", error: { type: "authentication_error", message: "invalid x-api-key" } } }),
  });
  w.gmSays("Начинаем.");
  const res = await w.orchestrator.start();
  assert.equal(res.reason, STOP_REASONS.ERROR);
  assert.equal(w.calls.length, 1, "без автоматических повторов");
  assert.equal(w.errors.length, 1);
  assert.match(w.errors[0].err.message, /ключ/i);
  assert.equal(w.summaries.length, 0);
});

test("/ai next даёт слово одному агенту вне очереди", async () => {
  const w = createWorld({ agents: FOUR, respond: async (body, { agent }) => actResponse("say", `${agent} говорит`) });
  w.gmSays("Тень, что скажешь?");
  const turn = await w.orchestrator.single(w.agents[3]);
  assert.equal(turn.act.action, "say");
  assert.equal(w.calls.length, 1);
  assert.equal(w.calls[0].agent, "Тень");
  assert.match(w.calls[0].body.messages[0].content, /Мастер даёт слово тебе, Тень/);
  assert.equal(w.posted.length, 1);
});

test("мысли передаются отдельно и в общий чат не попадают", async () => {
  const w = createWorld({
    agents: FOUR.slice(0, 2),
    config: { maxRounds: 1 },
    respond: async (body, { agent }) => actResponse("say", "Согласна.", { thought: `${agent} скрывает долг` }),
  });
  w.gmSays("Капитан ждёт ответа.");
  await w.orchestrator.start();
  assert.equal(w.thoughts.length, 2);
  for (const call of w.calls) assert.doesNotMatch(JSON.stringify(call.body), /скрывает долг/);
});
