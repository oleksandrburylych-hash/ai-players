/**
 * orchestrator.js — цикл сцены, очередь, остановка.
 *
 * Чистый модуль: никаких глобальных объектов Foundry. Всё, что касается чата, API и
 * хранения, приходит через `deps`, поэтому цикл тестируется в Node с подставным API.
 *
 * deps:
 *   getParticipants()            → [{ id, name }]  агенты в сцене, в порядке списка
 *   getConfig()                  → { maxRounds, maxRequests }
 *   runAgent(agent, opts)        → результат takeTurn (см. agent.js)
 *   postAction(agent, act)       — показать say / ask_gm / declare в чате
 *   postThought(agent, act)      — показать мысль мастеру (решает сам deps, по настройке)
 *   postSummary(entries, info)   — карточка «Заявки группы»
 *   setIndicator(agent | null)   — «думает: Имя»
 *   reportError(error, agent)    — ошибка API: шёпотом мастеру
 *   reportWarning(text, agent)   — неразобранный ответ и т.п.: шёпотом мастеру
 *   getRotation() / setRotation(n) — сдвиг начала круга между сценами
 */

export const STOP_REASONS = {
  ALL_PASSED: "all_passed",
  ALL_DECLARED: "all_declared",
  MAX_ROUNDS: "max_rounds",
  MAX_REQUESTS: "max_requests",
  INTERRUPTED: "interrupted", // мастер написал новое сообщение
  STOPPED: "stopped", // /ai stop
  ERROR: "error",
  NO_AGENTS: "no_agents",
};

const FINAL = new Set(["declare", "ask_gm"]);

const noop = () => {};

/** Сдвинуть список так, чтобы круг начинался с `offset`. */
export function rotate(list, offset) {
  if (!list.length) return [];
  const k = ((offset % list.length) + list.length) % list.length;
  return [...list.slice(k), ...list.slice(0, k)];
}

export class Orchestrator {
  constructor(deps) {
    this.deps = {
      postAction: noop,
      postThought: noop,
      postSummary: noop,
      setIndicator: noop,
      reportError: noop,
      reportWarning: noop,
      getRotation: () => this._rotation,
      setRotation: (n) => {
        this._rotation = n;
      },
      ...deps,
    };
    this._rotation = 0;
    this.gen = 0; // номер текущего цикла; смена номера = прерывание старого
    this.controller = null;
    this.current = null; // { gen, promise, reason }
    this.lastResult = null;
  }

  get isRunning() {
    return !!this.current;
  }

  /**
   * Начать новый цикл (сообщение мастера или /ai go). Текущий цикл прерывается:
   * его запрос к API отменяется, его результат в чат не попадает.
   */
  start() {
    this._abort(STOP_REASONS.INTERRUPTED);
    const gen = ++this.gen;
    const controller = new AbortController();
    this.controller = controller;
    const run = { gen, reason: null, promise: null };
    run.promise = this._runCycle(run, controller.signal).finally(() => {
      if (this.current === run) this.current = null;
    });
    this.current = run;
    return run.promise;
  }

  /** /ai stop — немедленно остановить текущий цикл. */
  stop() {
    const wasRunning = this.isRunning;
    this._abort(STOP_REASONS.STOPPED);
    this.gen++;
    return wasRunning;
  }

  /**
   * /ai next Имя — дать слово одному агенту вне очереди. Текущий цикл прерывается.
   * Возвращает результат хода.
   */
  async single(agent) {
    this._abort(STOP_REASONS.INTERRUPTED);
    const gen = ++this.gen;
    const controller = new AbortController();
    this.controller = controller;
    const run = { gen, reason: null, promise: null };
    this.current = run;
    const signal = controller.signal;
    const isCurrent = () => this.gen === gen && !signal.aborted;
    try {
      await this.deps.setIndicator(agent);
      let turn;
      try {
        turn = await this.deps.runAgent(agent, { single: true, maxAttempts: 2, signal });
      } finally {
        if (this.gen === gen) await this.deps.setIndicator(null);
      }
      if (!isCurrent() || turn.aborted) return { aborted: true };
      if (turn.error) {
        await this.deps.reportError(turn.error, agent);
        return turn;
      }
      if (turn.warning) await this.deps.reportWarning(turn.warning, agent);
      if (turn.act.action !== "pass") await this.deps.postAction(agent, turn.act);
      if (turn.act.thought) await this.deps.postThought(agent, turn.act);
      return turn;
    } finally {
      if (this.current === run) this.current = null;
    }
  }

  _abort(reason) {
    if (this.current && !this.current.reason) this.current.reason = reason;
    if (this.controller) {
      this.controller.abort();
      this.controller = null;
    }
  }

  async _runCycle(run, signal) {
    const { deps } = this;
    const gen = run.gen;
    const isCurrent = () => this.gen === gen && !signal.aborted;
    const finish = (reason, extra = {}) => {
      run.reason = run.reason || reason;
      const result = { reason: run.reason, ...extra };
      this.lastResult = result;
      return result;
    };

    const participants = deps.getParticipants() || [];
    if (!participants.length) return finish(STOP_REASONS.NO_AGENTS, { requests: 0, rounds: 0 });

    const cfg = deps.getConfig();
    const maxRounds = Math.max(1, Number(cfg.maxRounds) || 1);
    const maxRequests = Math.max(1, Number(cfg.maxRequests) || 1);

    const rotation = Number(deps.getRotation()) || 0;
    const order = rotate(participants, rotation);
    await deps.setRotation(rotation + 1);

    const outcomes = new Map(); // id → последний declare/ask_gm этого агента в цикле
    const recent = []; // реплики цикла [{ name, text }] — для защиты от эха
    let requests = 0;
    let rounds = 0;
    let reason = null;

    outer: for (let round = 1; round <= maxRounds; round++) {
      rounds = round;
      let allPassed = true;
      for (const agent of order) {
        if (!isCurrent()) {
          reason = run.reason || STOP_REASONS.INTERRUPTED;
          break outer;
        }
        const budget = maxRequests - requests;
        if (budget <= 0) {
          reason = STOP_REASONS.MAX_REQUESTS;
          break outer;
        }

        await deps.setIndicator(agent);
        let turn;
        try {
          turn = await deps.runAgent(agent, { round, maxRounds, maxAttempts: Math.min(2, budget), signal, recent: recent.slice() });
        } finally {
          if (this.gen === gen) await deps.setIndicator(null);
        }
        requests += turn?.requests || 0;

        // Пока ждали ответ, мастер мог написать новое сообщение или остановить цикл.
        if (!isCurrent() || turn?.aborted) {
          reason = run.reason || STOP_REASONS.INTERRUPTED;
          break outer;
        }
        if (turn.error) {
          await deps.reportError(turn.error, agent);
          reason = STOP_REASONS.ERROR;
          break outer;
        }
        if (turn.warning) await deps.reportWarning(turn.warning, agent);

        const act = turn.act;
        if (act.action !== "pass") {
          allPassed = false;
          recent.push({ name: agent.name, text: act.text });
          await deps.postAction(agent, act);
        }
        if (act.thought) await deps.postThought(agent, act);
        if (FINAL.has(act.action)) outcomes.set(agent.id, act);

        if (participants.every((p) => outcomes.has(p.id))) {
          reason = STOP_REASONS.ALL_DECLARED;
          break outer;
        }
      }
      if (allPassed) {
        reason = STOP_REASONS.ALL_PASSED;
        break;
      }
    }
    if (!reason) reason = STOP_REASONS.MAX_ROUNDS;
    run.reason = run.reason || reason;

    // Прерванный новым сообщением цикл карточку не выводит — сразу начинается новый.
    // Остановленный командой или ошибкой выводит то, что успели заявить (если что-то есть).
    const entries = participants.map((p) => ({ agent: p, act: outcomes.get(p.id) || null }));
    const partial = run.reason === STOP_REASONS.STOPPED || run.reason === STOP_REASONS.ERROR;
    const showCard = run.reason !== STOP_REASONS.INTERRUPTED && (!partial || outcomes.size > 0);
    if (showCard) await deps.postSummary(entries, { reason: run.reason, rounds, requests });

    return finish(run.reason, { requests, rounds, entries });
  }
}
