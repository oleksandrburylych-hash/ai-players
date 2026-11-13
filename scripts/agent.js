/**
 * agent.js — сбор контекста и запрос для одного агента, разбор ответа модели.
 *
 * Чистый модуль: всё, что приходит из Foundry (паспорт, лист, заметки, хроника,
 * расшифровка чата), передаётся параметрами. Вызов API тоже подставляется снаружи.
 */

import { modelTuning, isAbortError } from "./api.js";
import { echoReason, formatPersona, temperamentLabel, temperamentRules } from "./persona.js";

export const ACTIONS = ["pass", "say", "ask_gm", "declare"];

export const PASS = Object.freeze({
  action: "pass",
  text: "",
  to: "",
  thought: "",
  roll_request: null,
});

/** Инструмент `act` — единственный способ ответить. */
export const ACT_TOOL = {
  name: "act",
  description:
    "Твой ход за игровым столом. Вызывай этот инструмент ровно один раз за ход и ничего не пиши вне него. " +
    "Выбери одно действие: pass — промолчать; say — реплика группе или конкретному персонажу; " +
    "ask_gm — уточняющий вопрос мастеру; declare — заявка: что твой персонаж делает.",
  strict: true,
  input_schema: {
    type: "object",
    additionalProperties: false,
    required: ["action", "text", "to", "thought", "roll_request"],
    properties: {
      action: { type: "string", enum: ACTIONS, description: "pass | say | ask_gm | declare" },
      text: {
        type: "string",
        description: "Реплика, вопрос или заявка от первого лица, по-русски, одна-три фразы. Для pass — пустая строка.",
      },
      to: { type: "string", description: "Имя персонажа, к которому обращаешься, или пустая строка." },
      thought: {
        type: "string",
        description: "Одна короткая строка: почему персонаж так поступает. Её видит только мастер.",
      },
      roll_request: {
        type: "object",
        additionalProperties: false,
        required: ["skill", "characteristic", "reason"],
        description: "Если заявка, по-твоему, требует проверки — какой. Иначе все поля пустые. Сам не бросай.",
        properties: {
          skill: { type: "string", description: "Навык, например «Убеждение» или «Атлетика (сила)», или пусто." },
          characteristic: { type: "string", description: "Характеристика (STR, DEX, END, INT, EDU, SOC…) или пусто." },
          reason: { type: "string", description: "Зачем проверка, или пусто." },
        },
      },
    },
  },
};

/** Правила игры за столом (ТЗ, раздел 8). */
export const TABLE_RULES = [
  "Ты игрок, а не мастер. Ты управляешь только своим персонажем: его словами, решениями и заявками. Результаты действий, слова NPC и мир описывает мастер.",
  "Знаешь только то, что твой персонаж видел и слышал сам.",
  "Действуй из характера. Если выгодное решение противоречит паспорту — побеждает паспорт. Персонаж может ошибаться, спорить, жадничать и трусить.",
  "Не соглашайся с группой автоматически. Если у тебя другая цель — отстаивай её.",
  "Говори коротко: одна-три фразы. Без пересказа сцены и без описания чужих действий.",
  "Если добавить нечего — выбирай pass. Молчать нормально.",
  "Кубы не бросаешь и результаты не придумываешь. Заявляешь действие и ждёшь мастера.",
  "Заявка — конкретное действие: что делаю, чем, с какой целью.",
  "Пиши по-русски, от первого лица.",
];

const MAX_TEXT = 1000;
const MAX_THOUGHT = 300;

/* ------------------------------------------------------------------ */
/* Промт                                                               */
/* ------------------------------------------------------------------ */

/**
 * Системный промт агента. Возвращается массивом блоков: так на него можно повесить
 * cache_control — в пределах сцены промт одного агента не меняется, и повторные круги
 * читаются из кэша.
 *
 * persona — анкета (persona.js), temperament — переключатели; passport — старый
 * свободный текст (если анкеты нет). others — [{ name, publicFace, temperament }] или строки.
 */
export function buildSystemPrompt({ name, systemTitle, others = [], persona, temperament, passport, sheet, notes, chronicle }) {
  const parts = [];
  parts.push(
    `Ты — игрок за столом настольной ролевой игры${systemTitle ? ` «${systemTitle}»` : ""}. ` +
      `Твой персонаж — ${name}. Мастер — человек. За остальных персонажей играют другие игроки, ` +
      `и у каждого из них свой характер, совсем не такой, как у тебя.`,
  );
  parts.push("## Правила игры за столом\n" + TABLE_RULES.map((r) => `- ${r}`).join("\n"));
  parts.push(
    "## Как отвечать\n" +
      "Каждый ход — ровно один вызов инструмента act, без текста вне него.\n" +
      "- pass — промолчать (в чат ничего не попадёт).\n" +
      "- say — реплика группе или одному персонажу (имя в поле to).\n" +
      "- ask_gm — уточняющий вопрос мастеру о том, что персонаж видит, слышит или знает.\n" +
      "- declare — заявка: что персонаж делает, чем и зачем.\n" +
      "Поле thought — одна короткая строка для мастера, другие игроки её не видят.\n" +
      "roll_request заполняй, только если заявка явно требует проверки; иначе оставь поля пустыми.\n" +
      "Если ты уже сделал заявку и менять её незачем — выбирай pass.\n" +
      "Не повторяй и не пересказывай то, что уже сказали другие или ты сам. Если согласен с кем-то — " +
      "добавь своё (довод, условие, сомнение, цену) или выбери pass. Простое «согласен» — это pass.",
  );

  const p = persona || {};
  const card = formatPersona(p);
  parts.push(
    "## Твой персонаж\n" +
      (card || String(passport || "").trim() || "(анкета не заполнена — играй по листу и здравому смыслу)") +
      (card && passport && String(passport).trim() ? `\n${String(passport).trim()}` : ""),
  );

  const voice = String(p.voice || "").trim();
  const sample = String(p.sample || "").trim();
  parts.push(
    "## Твой голос\n" +
      (voice ? `Манера речи: ${voice}\n` : "") +
      (sample ? `Так ты говоришь (это образцы стиля, не повторяй их дословно): ${sample}\n` : "") +
      "Говори так, чтобы по одной реплике было понятно, что это именно ты: свой словарь, свой ритм, свои привычки. " +
      "Не подстраивайся под стиль других игроков.",
  );

  const rules = temperamentRules(temperament);
  if (rules.length) parts.push("## Твой темперамент\n" + rules.map((r) => `- ${r}`).join("\n"));

  if (others.length) {
    const lines = others.map((o) => {
      if (typeof o === "string") return `- ${o}`;
      const t = temperamentLabel(o.temperament);
      const face = String(o.publicFace || "").trim();
      return `- ${o.name}${t ? ` (${t})` : ""}${face ? ` — ${face}` : ""}`;
    });
    parts.push(
      "## Остальные в группе (какими ты их видишь со стороны)\n" +
        lines.join("\n") +
        "\nТы — не они. Держись своей цели и своего взгляда, даже когда они звучат убедительно.",
    );
  }

  if (sheet && String(sheet).trim()) parts.push("## Лист персонажа (кратко)\n" + String(sheet).trim());
  if (notes && String(notes).trim()) {
    parts.push("## Личные заметки (это знает только твой персонаж, другие — нет)\n" + String(notes).trim());
  }
  if (chronicle && String(chronicle).trim()) parts.push("## Хроника кампании\n" + String(chronicle).trim());
  return [{ type: "text", text: parts.join("\n\n"), cache_control: { type: "ephemeral" } }];
}

export function buildUserMessage({ name, transcript, round, maxRounds, single = false }) {
  const lines = [];
  lines.push("Последние события за столом (старые сверху):");
  lines.push(String(transcript || "").trim() || "(в чате пока ничего нет)");
  lines.push("");
  if (single) {
    lines.push(`Мастер даёт слово тебе, ${name}. Твой ход: вызови act.`);
  } else {
    let turn = `Твой ход, ${name}. Круг ${round} из ${maxRounds}.`;
    if (round >= maxRounds) turn += " Это последний круг обсуждения: если собираешься действовать — сделай заявку.";
    lines.push(turn + " Вызови act.");
  }
  return lines.join("\n");
}

/** Тело запроса к /v1/messages для одного хода агента. */
export function buildAgentRequest({ model, maxTokens, effort, system, userText }) {
  return {
    model,
    max_tokens: maxTokens,
    system,
    tools: [ACT_TOOL],
    // Принудительный tool_choice ({type:"tool"}) часть новых моделей отвергает с ошибкой 400,
    // поэтому — auto + требование в промте + проверка, что вызов был (иначе повтор).
    tool_choice: { type: "auto", disable_parallel_tool_use: true },
    messages: [{ role: "user", content: userText }],
    ...modelTuning(model, effort),
  };
}

/* ------------------------------------------------------------------ */
/* Разбор ответа                                                       */
/* ------------------------------------------------------------------ */

const str = (v) => (typeof v === "string" ? v : v == null ? "" : String(v));
const clip = (s, n) => (s.length > n ? s.slice(0, n - 1) + "…" : s);

/**
 * Разобрать ответ модели. Возвращает { ok: true, act } или { ok: false, reason }.
 * Блоки читаются по типу, а не по позиции: ответ может начинаться с блоков thinking.
 */
export function parseActResponse(data) {
  if (!data || typeof data !== "object") return { ok: false, reason: "пустой ответ" };
  if (data.stop_reason === "refusal") return { ok: false, reason: "модель отказалась отвечать (refusal)" };
  const blocks = Array.isArray(data.content) ? data.content : [];
  const call = blocks.find((b) => b && b.type === "tool_use" && String(b.name).toLowerCase() === "act");
  if (!call) {
    if (data.stop_reason === "max_tokens") return { ok: false, reason: "ответ обрезан лимитом токенов" };
    return { ok: false, reason: "модель не вызвала инструмент act" };
  }
  let input = call.input;
  if (typeof input === "string") {
    try {
      input = JSON.parse(input);
    } catch {
      return { ok: false, reason: "аргументы act — не JSON" };
    }
  }
  if (!input || typeof input !== "object") return { ok: false, reason: "пустые аргументы act" };

  const action = str(input.action).trim().toLowerCase();
  if (!ACTIONS.includes(action)) return { ok: false, reason: `неизвестное действие «${clip(str(input.action), 40)}»` };

  const text = clip(str(input.text).trim(), MAX_TEXT);
  if (action !== "pass" && !text) return { ok: false, reason: `действие ${action} без текста` };

  let roll = null;
  const rr = input.roll_request;
  if (rr && typeof rr === "object") {
    const r = { skill: str(rr.skill).trim(), characteristic: str(rr.characteristic).trim(), reason: str(rr.reason).trim() };
    if (r.skill || r.characteristic) roll = r;
  }

  return {
    ok: true,
    act: {
      action,
      text: action === "pass" ? "" : text,
      to: clip(str(input.to).trim(), 80),
      thought: clip(str(input.thought).replace(/\s+/g, " ").trim(), MAX_THOUGHT),
      roll_request: roll,
    },
  };
}

/* ------------------------------------------------------------------ */
/* Один ход                                                            */
/* ------------------------------------------------------------------ */

/**
 * Выполнить ход: запрос → разбор → проверка; если не разобралось или не прошло проверку —
 * один повтор (если позволяет бюджет запросов), затем pass.
 *
 * validate(act) → null | строка-причина: например, «повторяет реплику Веры». Такой ответ
 * считается неудачным, а при повторе модель получает подсказку через onRetry(request, reason).
 *
 * Возвращает одно из:
 *   { act, requests }                       — успешно
 *   { act: PASS, requests, warning? }       — не вышло, считаем pass (warning — для мастера)
 *   { error, requests }                     — ошибка API: цикл надо остановить
 *   { aborted: true, requests }             — цикл прерван
 */
export async function takeTurn({ callModel, request, maxAttempts = 2, signal, validate, onRetry }) {
  const attempts = Math.max(1, Math.min(2, maxAttempts));
  let requests = 0;
  let lastReason = "";
  let lastKind = "";
  let req = request;
  for (let i = 0; i < attempts; i++) {
    if (i > 0 && onRetry) req = onRetry(request, lastReason, lastKind);
    if (signal?.aborted) return { aborted: true, requests };
    let data;
    try {
      requests += 1;
      data = await callModel(req, { signal });
    } catch (err) {
      if (isAbortError(err) || signal?.aborted) return { aborted: true, requests };
      return { error: err, requests };
    }
    if (signal?.aborted) return { aborted: true, requests };
    const parsed = parseActResponse(data);
    if (!parsed.ok) {
      lastReason = parsed.reason;
      lastKind = "parse";
      continue;
    }
    const rejected = validate ? validate(parsed.act) : null;
    if (!rejected) return { act: parsed.act, requests };
    lastReason = rejected;
    lastKind = "echo";
  }
  // Эхо после повтора — не ошибка: персонажу нечего добавить, он молчит. Мастера не тревожим.
  if (lastKind === "echo") return { act: { ...PASS }, requests, note: lastReason };
  return {
    act: { ...PASS },
    requests,
    warning:
      attempts > 1
        ? `ответ не разобран дважды (${lastReason}) — считаю, что персонаж промолчал`
        : `ответ не разобран (${lastReason}), на повтор не хватило лимита запросов — считаю, что персонаж промолчал`,
  };
}

/**
 * Собрать исполнителя ходов. Все зависимости — снаружи.
 *
 * @param {object} deps
 * @param {Function} deps.getContext  async (agent, {single}) => { name, systemTitle, others, persona, temperament,
 *                                     passport, sheet, notes, chronicle, transcript }
 * @param {Function} deps.callModel   async (body, {signal}) => response JSON
 * @param {Function} deps.getConfig   () => { model, maxTokens, effort }
 *
 * agent.model (если задан) заменяет общую модель для этого персонажа.
 * opts.recent — реплики текущего цикла [{ name, text }] для защиты от эха.
 */
export function createAgentRunner({ getContext, callModel, getConfig }) {
  return async function runAgent(agent, { round = 1, maxRounds = 1, single = false, maxAttempts = 2, signal, recent = [] } = {}) {
    const cfg = getConfig();
    const ctx = await getContext(agent, { single });
    const system = buildSystemPrompt(ctx);
    const userText = buildUserMessage({ name: ctx.name, transcript: ctx.transcript, round, maxRounds, single });
    const model = String(agent.model || "").trim() || cfg.model;
    const request = buildAgentRequest({ model, maxTokens: cfg.maxTokens, effort: cfg.effort, system, userText });
    return takeTurn({
      callModel,
      request,
      maxAttempts,
      signal,
      validate: (act) => echoReason(act, recent, ctx.name),
      onRetry: (req, reason, kind) => {
        const hint =
          kind === "echo"
            ? `\n\n(Ведущий: прошлый вариант не подошёл — ${reason}. Скажи что-то своё, своим голосом, со своей позиции — или выбери pass.)`
            : `\n\n(Ведущий: прошлый ответ не удалось прочитать — ${reason}. Ответь ровно одним вызовом инструмента act.)`;
        return { ...req, messages: [{ role: "user", content: req.messages[0].content + hint }] };
      },
    });
  };
}

/* ------------------------------------------------------------------ */
/* Хроника                                                             */
/* ------------------------------------------------------------------ */

export const RECAP_MAX_TOKENS = 1500;

export function buildRecapRequest({ model, effort, transcript, previous, characters = [] }) {
  const system =
    "Ты ведёшь хронику кампании настольной ролевой игры. Сожми события сессии в краткую хронику на русском: " +
    "что произошло, какие решения приняли персонажи, что узнали, какие вопросы остались открытыми. " +
    "Пиши в прошедшем времени, от третьего лица, 5–15 пунктов, без выдумок сверх расшифровки. " +
    "Если персонажа не было в сцене, так и отметь. Не пересказывай броски кубов цифрами — только итог.";
  const user =
    (characters.length ? `Персонажи группы: ${characters.join(", ")}.\n\n` : "") +
    (previous ? `Конец прежней хроники (для связности, не повторяй):\n${previous}\n\n` : "") +
    `Расшифровка чата сессии:\n${transcript || "(пусто)"}\n\nНапиши хронику этой сессии списком.`;
  return {
    model,
    max_tokens: RECAP_MAX_TOKENS,
    system,
    messages: [{ role: "user", content: user }],
    ...modelTuning(model, effort),
  };
}
