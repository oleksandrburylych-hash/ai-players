/**
 * Стенд для тестов: маленький «мир» без Foundry и подставной API Anthropic.
 *
 * Связка настоящая: Orchestrator → createAgentRunner → createApi(fetch) → разбор ответа.
 * Подменяется только сеть (fetch) и всё, что в Foundry делает main.js (чат, флаги, сцена).
 */

import { Orchestrator } from "../scripts/orchestrator.js";
import { createAgentRunner } from "../scripts/agent.js";
import { createApi } from "../scripts/api.js";
import { activeParticipants, currentAudience, formatNotes, transcriptFor } from "../scripts/visibility.js";
import { normalizeAgentRecord } from "../scripts/persona.js";

/** Ответ API с вызовом инструмента act. */
export function actResponse(action, text = "", extra = {}) {
  return {
    id: "msg_test",
    type: "message",
    role: "assistant",
    stop_reason: "tool_use",
    content: [
      {
        type: "tool_use",
        id: "toolu_test",
        name: "act",
        input: {
          action,
          text,
          to: extra.to ?? "",
          thought: extra.thought ?? "",
          roll_request: extra.roll_request ?? { skill: "", characteristic: "", reason: "" },
        },
      },
    ],
    usage: { input_tokens: 100, output_tokens: 20 },
  };
}

/** Ответ без вызова инструмента — «неразобранный». */
export function textResponse(text = "Я бы, пожалуй, промолчал.") {
  return {
    id: "msg_test",
    type: "message",
    role: "assistant",
    stop_reason: "end_turn",
    content: [{ type: "text", text }],
    usage: { input_tokens: 100, output_tokens: 10 },
  };
}

/** Какой агент сейчас ходит — по тексту запроса («Твой ход, Имя.»). */
export function agentOf(body) {
  const user = body.messages?.[0]?.content ?? "";
  const m = String(user).match(/(?:Твой ход|даёт слово тебе), ([^.]+)\./);
  return m ? m[1].trim() : null;
}

export function deferred() {
  let resolve, reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/**
 * @param {object} opts
 * @param {Array}  opts.agents     [{ actorId, name, passport?, enabled? }]
 * @param {object} [opts.scene]    { all, ids }
 * @param {Function} opts.respond  async (body, ctx) => response JSON | Error (бросается) ;
 *                                 ctx = { agent, call } — имя агента и номер вызова
 * @param {object} [opts.config]   { maxRounds, maxRequests, maxTokens, model, effort, historySize }
 */
export function createWorld({ agents, scene = { all: true, ids: [] }, respond, config = {} }) {
  const world = {
    agents: agents.map((a) => {
      const r = normalizeAgentRecord(a);
      return { id: r.actorId, name: a.name, ...r };
    }),
    scene,
    notes: {}, // actorId → [{text, at}]
    messages: [], // нормализованные сообщения (как их отдаёт main.js)
    posted: [], // { agent, act }
    thoughts: [],
    summaries: [],
    errors: [],
    warnings: [],
    indicator: [],
    calls: [], // { body, agent, signal }
    rotation: 0,
    config: { maxRounds: 3, maxRequests: 16, maxTokens: 400, model: "claude-sonnet-5-5", effort: "low", historySize: 40, ...config },
  };

  let n = 0;
  world.fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    const agent = agentOf(body);
    world.calls.push({ url, headers: init.headers, body, agent, signal: init.signal });
    // Как настоящий fetch: отмена сигнала сразу отклоняет запрос.
    const abortError = () => Object.assign(new Error("aborted"), { name: "AbortError" });
    const aborted = new Promise((_, reject) => {
      if (init.signal?.aborted) reject(abortError());
      init.signal?.addEventListener("abort", () => reject(abortError()), { once: true });
    });
    const out = await Promise.race([respond(body, { agent, call: n++, signal: init.signal }), aborted]);
    if (out instanceof Error) throw out;
    if (out && out.__http) {
      return { ok: false, status: out.status, text: async () => JSON.stringify(out.body ?? {}) };
    }
    return { ok: true, status: 200, text: async () => JSON.stringify(out) };
  };

  world.api = createApi({ fetchImpl: world.fetch, getApiKey: () => "sk-ant-test" });

  /** Сообщение мастера (как если бы его создал Foundry и main.js поставил метку аудитории). */
  world.gmSays = (text) => {
    world.messages.push({
      id: `m${world.messages.length}`,
      speaker: "Мастер",
      text,
      whispered: false,
      blind: false,
      audience: currentAudience(world.agents, world.scene),
      kind: null,
    });
  };

  const getContext = async (agent) => ({
    name: agent.name,
    systemTitle: "Mongoose Traveller 2e",
    others: world.agents
      .filter((a) => a.actorId !== agent.actorId)
      .map((a) => ({ name: a.name, temperament: a.temperament, publicFace: a.persona.publicFace })),
    persona: agent.persona,
    temperament: agent.temperament,
    sheet: `Лист: ${agent.name}`,
    notes: formatNotes(world.notes[agent.actorId]),
    chronicle: "",
    transcript: transcriptFor(world.messages, agent.actorId, world.config.historySize),
  });

  world.runAgent = createAgentRunner({
    getContext,
    callModel: (body, opts) => world.api.messages(body, opts),
    getConfig: () => world.config,
  });

  world.orchestrator = new Orchestrator({
    getParticipants: () => activeParticipants(world.agents, world.scene),
    getConfig: () => world.config,
    runAgent: world.runAgent,
    postAction: (agent, act) => {
      world.posted.push({ agent: agent.name, act });
      world.messages.push({
        id: `m${world.messages.length}`,
        speaker: agent.name,
        text: act.text,
        whispered: false,
        blind: false,
        audience: currentAudience(world.agents, world.scene),
        kind: "agent",
      });
    },
    postThought: (agent, act) => world.thoughts.push({ agent: agent.name, thought: act.thought }),
    postSummary: (entries, info) => world.summaries.push({ entries, info }),
    setIndicator: (agent) => world.indicator.push(agent ? agent.name : null),
    reportError: (err, agent) => world.errors.push({ err, agent: agent?.name }),
    reportWarning: (text, agent) => world.warnings.push({ text, agent: agent?.name }),
    getRotation: () => world.rotation,
    setRotation: (r) => {
      world.rotation = r;
    },
  });

  return world;
}

export const FOUR = [
  { actorId: "a1", name: "Вера" },
  { actorId: "a2", name: "Борис" },
  { actorId: "a3", name: "Сайрус" },
  { actorId: "a4", name: "Тень" },
];
