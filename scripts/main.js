/**
 * main.js — хуки Foundry, регистрация настроек и команд, мост между Foundry и логикой.
 *
 * Вся работа (запросы к модели, запись в чат, журналы, флаги) выполняется только
 * у активного мастера: game.user.isActiveGM. У остальных клиентов модуль лишь
 * регистрирует настройки и вежливо отклоняет команды /ai.
 */

import {
  MODULE_ID,
  activeParticipants,
  currentAudience,
  escapeHtml,
  findAgentByName,
  formatNotes,
  addNote,
  htmlToText,
  publicTranscript,
  resolveAgentNames,
  transcriptFor,
} from "./visibility.js";
import { createApi, responseText } from "./api.js";
import { createAgentRunner, buildRecapRequest } from "./agent.js";
import { Orchestrator, STOP_REASONS } from "./orchestrator.js";
import { createSystemAdapter } from "./system-adapter.js";
import { parseAiCommand, HELP_TEXT } from "./commands.js";
import {
  registerSettings,
  getLoopConfig,
  getAgentRecords,
  getSceneState,
  setSceneState,
  getSetting,
  setSetting,
} from "./settings.js";

export const CHRONICLE_NAME = "ИИ-игроки: хроника";
const MODULE_ALIAS = "ИИ-игроки";
const CHRONICLE_PROMPT_CHARS = 6000; // сколько последних символов хроники давать агенту
const RECAP_TRANSCRIPT_CHARS = 60000; // сколько символов расшифровки отдавать на сжатие
const TRIGGER_WINDOW_MS = 10000; // сколько ждать создания сообщения после ввода в чат

const state = {
  adapter: null,
  api: null,
  orchestrator: null,
  pendingTriggerAt: 0,
  indicator: null,
  recapRunning: false,
};

const isActiveGM = () => !!game.user?.isActiveGM;

/* ------------------------------------------------------------------ */
/* Хуки                                                                */
/* ------------------------------------------------------------------ */

Hooks.once("init", () => {
  registerSettings();
});

Hooks.once("ready", async () => {
  console.log(`${MODULE_ID} | game.system.id = "${game.system.id}" (${game.system.title}), Foundry ${game.version}`);

  state.adapter = createSystemAdapter({
    systemId: game.system.id,
    title: game.system.title,
    localize: (k) => game.i18n.localize(k),
  });
  if (!state.adapter.supported) {
    console.warn(`${MODULE_ID} | для системы "${game.system.id}" нет адаптера — выжимка листа будет минимальной`);
  }

  state.api = createApi({
    fetchImpl: (...args) => globalThis.fetch(...args),
    getApiKey: () => getSetting("apiKey"),
  });

  const runAgent = createAgentRunner({
    getContext: buildAgentContext,
    callModel: (body, opts) => state.api.messages(body, opts),
    getConfig: () => {
      const c = getLoopConfig();
      return { model: c.model, maxTokens: c.maxTokens, effort: c.effort };
    },
  });

  state.orchestrator = new Orchestrator({
    getParticipants: () => getParticipants(),
    getConfig: () => getLoopConfig(),
    runAgent,
    postAction,
    postThought,
    postSummary,
    setIndicator,
    reportError: (err, agent) =>
      whisperGM(`<p><b>Ошибка API</b>${agent ? ` (ход: ${escapeHtml(agent.name)})` : ""}: ${escapeHtml(err?.message || err)}</p><p>Цикл остановлен.</p>`),
    reportWarning: (text, agent) => whisperGM(`<p><b>${escapeHtml(agent?.name ?? "")}</b>: ${escapeHtml(text)}</p>`),
    getRotation: () => getSetting("rotation"),
    setRotation: (n) => (isActiveGM() ? setSetting("rotation", n) : undefined),
  });

  const mod = game.modules.get(MODULE_ID);
  if (mod) mod.api = { orchestrator: state.orchestrator, api: state.api, adapter: state.adapter };

  if (isActiveGM()) await cleanupIndicators();
});

// Поле API-ключа — как пароль (запасной путь к `input` в registerSettings).
Hooks.on("renderSettingsConfig", (app, html) => {
  const root = html instanceof HTMLElement ? html : html?.[0];
  // TODO: проверить имя поля в SettingsConfig v13 (ожидается "ai-players.apiKey").
  const input = root?.querySelector?.(`input[name="${MODULE_ID}.apiKey"]`);
  if (input) {
    input.type = "password";
    input.autocomplete = "off";
  }
});

/**
 * Ввод в чат. Команды /ai перехватываем (сообщение не создаётся).
 * Обычный текст активного мастера отмечаем: созданное следом сообщение запустит цикл.
 */
Hooks.on("chatMessage", (chatLog, message) => {
  // В v13 сюда приходит обрезанный текст; на всякий случай чистим HTML (v14 передаёт HTML).
  const text = htmlToText(message).trim();
  const cmd = parseAiCommand(text);
  if (cmd) {
    if (!game.user.isGM) {
      ui.notifications.warn("Команды /ai доступны только мастеру.");
    } else if (!isActiveGM()) {
      ui.notifications.warn(`Модуль «ИИ-игроки» работает у активного мастера (${game.users.activeGM?.name ?? "нет"}).`);
    } else {
      handleCommand(cmd).catch((err) => reportUnexpected(err));
    }
    return false;
  }
  if (isActiveGM() && text && !text.startsWith("/")) state.pendingTriggerAt = Date.now();
});

Hooks.on("createChatMessage", async (message, options, userId) => {
  if (!isActiveGM()) return;
  try {
    const flags = message.flags?.[MODULE_ID] ?? {};
    if (flags.kind) return; // собственные сообщения модуля цикл не запускают

    const whispered = (message.whisper?.length ?? 0) > 0;
    // Отметить, кто из агентов был в сцене в момент сообщения.
    if (!whispered && !Array.isArray(flags.audience)) {
      await message.setFlag(MODULE_ID, "audience", currentAudience(getAgents(), getSceneState()));
    }

    // Запуск цикла: обычное сообщение, набранное активным мастером в чате.
    const pending = state.pendingTriggerAt && Date.now() - state.pendingTriggerAt < TRIGGER_WINDOW_MS;
    if (userId !== game.user.id || !pending) return;
    state.pendingTriggerAt = 0;
    if (whispered || message.isRoll || message.blind) return;
    if (!getLoopConfig().autoRespond) return;
    state.orchestrator?.start().catch((err) => reportUnexpected(err));
  } catch (err) {
    reportUnexpected(err);
  }
});

/* ------------------------------------------------------------------ */
/* Агенты и сцена                                                      */
/* ------------------------------------------------------------------ */

/** Агенты из настроек с актуальными именами актёров: [{ id, actorId, name, passport, enabled }]. */
function getAgents() {
  return getAgentRecords()
    .map((r) => {
      const actor = r.actorId ? game.actors.get(r.actorId) : null;
      if (!actor) return null;
      return { id: actor.id, actorId: actor.id, name: actor.name, passport: r.passport, enabled: r.enabled };
    })
    .filter(Boolean);
}

function getParticipants() {
  return activeParticipants(getAgents(), getSceneState());
}

function sceneDescription() {
  const scene = getSceneState();
  const agents = getAgents().filter((a) => a.enabled);
  if (scene.all) return `все (${agents.map((a) => a.name).join(", ") || "агенты не настроены"})`;
  const inScene = getParticipants().map((a) => a.name);
  return inScene.length ? inScene.join(", ") : "никого";
}

/* ------------------------------------------------------------------ */
/* Сообщения чата → нормализованный вид для visibility.js              */
/* ------------------------------------------------------------------ */

const ACTION_PREFIX = { ask_gm: "(вопрос мастеру) ", declare: "(заявка) " };

function speakerName(message) {
  const flags = message.flags?.[MODULE_ID] ?? {};
  if (flags.kind === "agent" && flags.name) return flags.name;
  const alias = message.alias || message.speaker?.alias || "";
  const author = message.author;
  const asCharacter = !!(message.speaker?.actor || message.speaker?.token);
  if (author?.isGM) return asCharacter && alias ? `${alias} (NPC)` : "Мастер";
  return alias || author?.name || "?";
}

function messageText(message) {
  const flags = message.flags?.[MODULE_ID] ?? {};
  if (flags.kind === "agent") {
    const to = flags.action === "say" && flags.to ? `→ ${flags.to}: ` : "";
    return `${ACTION_PREFIX[flags.action] ?? ""}${to}${flags.text ?? ""}`;
  }
  const parts = [];
  const flavor = htmlToText(message.flavor || "");
  if (flavor) parts.push(flavor);
  const content = htmlToText(message.content || "");
  if (content) parts.push(content);
  for (const roll of message.rolls ?? []) {
    if (roll && roll.formula !== undefined) parts.push(`[бросок ${roll.formula} = ${roll.total ?? "?"}]`);
  }
  let text = parts.join(" ");
  if (message.style === CONST.CHAT_MESSAGE_STYLES.EMOTE) text = `(действие) ${text}`;
  return text;
}

function normalizeMessage(message) {
  const flags = message.flags?.[MODULE_ID] ?? {};
  return {
    id: message.id,
    speaker: speakerName(message),
    text: messageText(message),
    whispered: (message.whisper?.length ?? 0) > 0,
    blind: !!message.blind,
    audience: Array.isArray(flags.audience) ? flags.audience : null,
    kind: flags.kind ?? null,
    timestamp: message.timestamp ?? 0,
  };
}

function allMessages() {
  return game.messages.contents
    .slice()
    .sort((a, b) => (a.timestamp ?? 0) - (b.timestamp ?? 0))
    .map(normalizeMessage);
}

/* ------------------------------------------------------------------ */
/* Контекст агента                                                     */
/* ------------------------------------------------------------------ */

async function buildAgentContext(agent) {
  const cfg = getLoopConfig();
  const actor = game.actors.get(agent.actorId);
  const others = getAgents()
    .filter((a) => a.enabled && a.actorId !== agent.actorId)
    .map((a) => a.name);
  return {
    name: agent.name,
    systemTitle: state.adapter?.title ?? game.system.title,
    others,
    passport: agent.passport,
    sheet: actor ? state.adapter.summarizeActor(actor) : "",
    notes: formatNotes(actor?.getFlag(MODULE_ID, "notes")),
    chronicle: readChronicle(CHRONICLE_PROMPT_CHARS),
    transcript: transcriptFor(allMessages(), agent.actorId, cfg.historySize),
  };
}

/* ------------------------------------------------------------------ */
/* Вывод в чат                                                         */
/* ------------------------------------------------------------------ */

const gmIds = () => game.users.filter((u) => u.isGM).map((u) => u.id);

function whisperGM(html, kind = "system") {
  return ChatMessage.implementation.create({
    content: `<div class="ai-players-system">${html}</div>`,
    whisper: gmIds(),
    speaker: { alias: MODULE_ALIAS },
    style: CONST.CHAT_MESSAGE_STYLES.OTHER,
    flags: { [MODULE_ID]: { kind } },
  });
}

const ACTION_LABEL = { say: "", ask_gm: "Вопрос мастеру", declare: "Заявка" };

async function postAction(agent, act) {
  const actor = game.actors.get(agent.actorId);
  const speaker = actor ? ChatMessage.implementation.getSpeaker({ actor }) : { alias: agent.name };
  const label = ACTION_LABEL[act.action];
  const to = act.action === "say" && act.to ? `<span class="ai-players-to">→ ${escapeHtml(act.to)}:</span> ` : "";
  const content =
    `<div class="ai-players-msg ai-players-${act.action}">` +
    (label ? `<span class="ai-players-label">${label}:</span> ` : "") +
    `${to}${escapeHtml(act.text)}</div>`;
  await ChatMessage.implementation.create({
    content,
    speaker,
    style: CONST.CHAT_MESSAGE_STYLES.IC,
    flags: {
      [MODULE_ID]: {
        kind: "agent",
        agentId: agent.actorId,
        name: agent.name,
        action: act.action,
        text: act.text,
        to: act.to || "",
        audience: currentAudience(getAgents(), getSceneState()),
      },
    },
  });
}

async function postThought(agent, act) {
  if (!getLoopConfig().showThoughts || !act.thought) return;
  await whisperGM(`<span class="ai-players-thought">💭 <b>${escapeHtml(agent.name)}</b>: ${escapeHtml(act.thought)}</span>`, "thought");
}

const REASON_TEXT = {
  [STOP_REASONS.ALL_PASSED]: "все промолчали",
  [STOP_REASONS.ALL_DECLARED]: "все сделали заявки или задали вопросы",
  [STOP_REASONS.MAX_ROUNDS]: "достигнут лимит кругов",
  [STOP_REASONS.MAX_REQUESTS]: "достигнут лимит запросов",
  [STOP_REASONS.STOPPED]: "остановлено мастером",
  [STOP_REASONS.ERROR]: "остановлено из-за ошибки",
};

async function postSummary(entries, info) {
  const rows = entries
    .map(({ agent, act }) => {
      let body;
      if (!act) body = `<span class="ai-players-silent">молчит</span>`;
      else if (act.action === "ask_gm") body = `<span class="ai-players-label">вопрос мастеру:</span> ${escapeHtml(act.text)}`;
      else body = `<span class="ai-players-label">заявка:</span> ${escapeHtml(act.text)}`;
      const rr = act?.roll_request;
      const roll = rr
        ? `<div class="ai-players-roll">🎲 предлагает проверку: ${escapeHtml(
            [rr.skill, rr.characteristic].filter(Boolean).join(" / "),
          )}${rr.reason ? ` — ${escapeHtml(rr.reason)}` : ""}</div>`
        : "";
      return `<li><b>${escapeHtml(agent.name)}</b> — ${body}${roll}</li>`;
    })
    .join("");
  const footer = REASON_TEXT[info?.reason] ? `<footer>${REASON_TEXT[info.reason]}</footer>` : "";
  await ChatMessage.implementation.create({
    content: `<div class="ai-players-card"><h3>Заявки группы</h3><ul>${rows}</ul>${footer}</div>`,
    speaker: { alias: MODULE_ALIAS },
    style: CONST.CHAT_MESSAGE_STYLES.OTHER,
    flags: { [MODULE_ID]: { kind: "card" } },
  });
}

/** Индикатор «думает: Имя» — отдельное сообщение внизу чата, удаляется после хода. */
async function setIndicator(agent) {
  const old = state.indicator;
  state.indicator = null;
  if (old) await old.delete().catch(() => {});
  if (!agent) return;
  state.indicator = await ChatMessage.implementation.create({
    content: `<div class="ai-players-thinking">думает: ${escapeHtml(agent.name)}…</div>`,
    speaker: { alias: MODULE_ALIAS },
    style: CONST.CHAT_MESSAGE_STYLES.OTHER,
    flags: { [MODULE_ID]: { kind: "indicator" } },
  });
}

/** Убрать индикаторы, оставшиеся после перезагрузки посреди цикла. */
async function cleanupIndicators() {
  const ids = game.messages.contents.filter((m) => m.flags?.[MODULE_ID]?.kind === "indicator").map((m) => m.id);
  if (ids.length) await ChatMessage.implementation.deleteDocuments(ids).catch(() => {});
}

function reportUnexpected(err) {
  console.error(`${MODULE_ID} |`, err);
  if (isActiveGM()) whisperGM(`<p><b>Внутренняя ошибка модуля:</b> ${escapeHtml(err?.message || err)}</p>`).catch(() => {});
}

/* ------------------------------------------------------------------ */
/* Хроника                                                             */
/* ------------------------------------------------------------------ */

function findChronicle() {
  return game.journal.getName(CHRONICLE_NAME) ?? null;
}

function readChronicle(maxChars) {
  const entry = findChronicle();
  if (!entry) return "";
  const pages = entry.pages.contents.slice().sort((a, b) => (a.sort ?? 0) - (b.sort ?? 0));
  const text = pages
    .filter((p) => p.type === "text")
    .map((p) => `### ${p.name}\n${htmlToText(p.text?.content || "")}`)
    .join("\n\n")
    .trim();
  return text.length > maxChars ? "…" + text.slice(-maxChars) : text;
}

function plainToHtml(text) {
  return String(text)
    .split(/\n+/)
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => `<p>${escapeHtml(l)}</p>`)
    .join("");
}

async function appendChronicle(title, text) {
  let entry = findChronicle();
  if (!entry) entry = await JournalEntry.implementation.create({ name: CHRONICLE_NAME });
  const sort = Math.max(0, ...entry.pages.contents.map((p) => p.sort ?? 0)) + 1000;
  await entry.createEmbeddedDocuments("JournalEntryPage", [
    { name: title, type: "text", sort, text: { content: plainToHtml(text), format: CONST.JOURNAL_ENTRY_PAGE_FORMATS.HTML } },
  ]);
  return entry;
}

async function doRecap() {
  if (state.recapRunning) return whisperGM("<p>Хроника уже составляется.</p>");
  state.recapRunning = true;
  try {
    const since = Number(getSetting("recapSince")) || 0;
    const messages = allMessages().filter((m) => m.timestamp > since);
    let transcript = publicTranscript(messages);
    if (!transcript.trim()) return whisperGM("<p>С прошлой хроники в чате не было публичных событий — записывать нечего.</p>");
    if (transcript.length > RECAP_TRANSCRIPT_CHARS) transcript = "…" + transcript.slice(-RECAP_TRANSCRIPT_CHARS);

    const cfg = getLoopConfig();
    const body = buildRecapRequest({
      model: cfg.model,
      effort: cfg.effort,
      transcript,
      previous: readChronicle(1500),
      characters: getAgents().map((a) => a.name),
    });
    let data;
    try {
      data = await state.api.messages(body);
    } catch (err) {
      return whisperGM(`<p><b>Ошибка API при составлении хроники:</b> ${escapeHtml(err?.message || err)}</p>`);
    }
    const text = data?.stop_reason === "refusal" ? "" : responseText(data);
    if (!text) return whisperGM("<p>Модель не вернула текст хроники. Попробуйте ещё раз.</p>");

    const title = `Сессия ${new Date().toLocaleString("ru-RU", { dateStyle: "medium", timeStyle: "short" })}`;
    await appendChronicle(title, text);
    await setSetting("recapSince", Date.now());
    await whisperGM(`<p><b>Хроника записана</b> в журнал «${escapeHtml(CHRONICLE_NAME)}», страница «${escapeHtml(title)}».</p>${plainToHtml(text)}`);
  } finally {
    state.recapRunning = false;
  }
}

/* ------------------------------------------------------------------ */
/* Команды                                                             */
/* ------------------------------------------------------------------ */

async function handleCommand(cmd) {
  if (cmd.error) return whisperGM(`<p>${escapeHtml(cmd.error)}</p>`);
  const orch = state.orchestrator;
  switch (cmd.cmd) {
    case "help":
      return whisperGM(`<p><b>Команды:</b></p><ul>${HELP_TEXT.map((l) => `<li>${escapeHtml(l)}</li>`).join("")}</ul>`);

    case "go":
      if (!getParticipants().length) return whisperGM("<p>В сцене нет включённых агентов. Настройте агентов и /ai in.</p>");
      orch.start().catch((err) => reportUnexpected(err));
      return;

    case "stop":
      return whisperGM(orch.stop() ? "<p>Цикл остановлен.</p>" : "<p>Цикл сейчас не идёт.</p>");

    case "next": {
      const agent = findAgentByName(getAgents(), cmd.args.name);
      if (!agent) return whisperGM(`<p>Агент «${escapeHtml(cmd.args.name)}» не найден (или имя неоднозначно).</p>`);
      if (!getParticipants().some((a) => a.actorId === agent.actorId)) {
        return whisperGM(`<p>${escapeHtml(agent.name)} сейчас не в сцене или выключен. См. /ai in и окно агентов.</p>`);
      }
      orch.single(agent).catch((err) => reportUnexpected(err));
      return;
    }

    case "in": {
      if (cmd.args.all) {
        await setSceneState({ all: true, ids: [] });
        return whisperGM(`<p>В сцене: ${escapeHtml(sceneDescription())}.</p>`);
      }
      const { found, missing } = resolveAgentNames(getAgents(), cmd.args.names);
      // Опечатка в имени не должна молча выкинуть кого-то из сцены: при ошибке сцену не меняем.
      if (missing.length) {
        return whisperGM(
          `<p>Не найдены (или имя неоднозначно): ${escapeHtml(missing.join(", "))}. Сцена не изменена; сейчас в ней: ${escapeHtml(
            sceneDescription(),
          )}.</p>`,
        );
      }
      await setSceneState({ all: false, ids: found.map((a) => a.actorId) });
      return whisperGM(`<p>В сцене: ${escapeHtml(sceneDescription())}.</p>`);
    }

    case "tell": {
      const agent = findAgentByName(getAgents(), cmd.args.name);
      if (!agent) return whisperGM(`<p>Агент «${escapeHtml(cmd.args.name)}» не найден (или имя неоднозначно).</p>`);
      const actor = game.actors.get(agent.actorId);
      const notes = addNote(actor.getFlag(MODULE_ID, "notes"), cmd.args.text);
      await actor.setFlag(MODULE_ID, "notes", notes);
      return whisperGM(`<p>🔒 Секрет для <b>${escapeHtml(agent.name)}</b>: ${escapeHtml(cmd.args.text)}</p>`, "secret");
    }

    case "recap":
      return doRecap();

    case "status": {
      const c = getLoopConfig();
      const u = state.api.usage;
      const agents = getAgents();
      const list = agents.length
        ? agents.map((a) => `${escapeHtml(a.name)}${a.enabled ? "" : " (выключен)"}`).join(", ")
        : "не настроены";
      return whisperGM(
        `<p><b>ИИ-игроки — статус</b></p><ul>` +
          `<li>Модель: ${escapeHtml(c.model)} (effort: ${escapeHtml(c.effort)})</li>` +
          `<li>Система: ${escapeHtml(game.system.id)}${state.adapter?.supported ? "" : " (адаптера нет)"}</li>` +
          `<li>Цикл: ${orch.isRunning ? "идёт" : "не идёт"}</li>` +
          `<li>Агенты: ${list}</li>` +
          `<li>В сцене: ${escapeHtml(sceneDescription())}</li>` +
          `<li>Запросов за сессию: ${u.requests} (ошибок: ${u.errors})</li>` +
          `<li>Токены: вход ${u.inputTokens}, из кэша ${u.cacheReadTokens}, запись в кэш ${u.cacheWriteTokens}, выход ${u.outputTokens}</li>` +
          `<li>Лимиты: кругов ${c.maxRounds}, запросов на сцену ${c.maxRequests}, токенов на ответ ${c.maxTokens}, сообщений в контексте ${c.historySize}</li>` +
          `<li>Автоответ: ${c.autoRespond ? "вкл" : "выкл"}; мысли мастеру: ${c.showThoughts ? "вкл" : "выкл"}</li>` +
          `</ul>`,
      );
    }

    default:
      return whisperGM("<p>Неизвестная команда. Наберите /ai help.</p>");
  }
}
