/**
 * visibility.js — кто что видит.
 *
 * Чистый модуль: не обращается к глобальным объектам Foundry, работает в Node.
 * На вход получает «нормализованные» сообщения чата (их готовит main.js):
 *
 *   {
 *     id:        string,
 *     speaker:   string,          // как подписать строку: «Мастер», «Вера», …
 *     text:      string,          // уже очищенный от HTML текст
 *     whispered: boolean,         // шёпот (кому угодно) — агентам не виден
 *     blind:     boolean,         // слепой бросок — агентам не виден
 *     audience:  string[] | null, // id актёров-агентов, бывших в сцене в момент сообщения;
 *                                 // null — метки нет (старое сообщение) → видно всем
 *     kind:      string | null,   // служебный тип сообщения модуля (флаг), если есть
 *   }
 */

export const MODULE_ID = "ai-players";

/** Служебные сообщения модуля, которые агентам не показываются никогда. */
export const HIDDEN_KINDS = new Set([
  "indicator", // «думает: Имя»
  "card", // карточка «Заявки группы» — дублирует реплики, которые и так есть в чате
  "thought", // мысли агента (шёпотом мастеру)
  "secret", // подтверждение секрета (шёпотом мастеру)
  "system", // статус, ошибки, служебные ответы
]);

/* ------------------------------------------------------------------ */
/* Сцена                                                               */
/* ------------------------------------------------------------------ */

/**
 * Состояние сцены: { all: true } — в сцене все агенты;
 * { all: false, ids: [...] } — только перечисленные актёры.
 */
export function normalizeSceneState(state) {
  if (!state || typeof state !== "object") return { all: true, ids: [] };
  return { all: state.all !== false, ids: Array.isArray(state.ids) ? state.ids.filter(Boolean) : [] };
}

export function isInScene(sceneState, actorId) {
  const s = normalizeSceneState(sceneState);
  return s.all || s.ids.includes(actorId);
}

/**
 * Агенты, которые участвуют в цикле: включены, привязаны к актёру и находятся в сцене.
 * Порядок — как в списке агентов.
 */
export function activeParticipants(agents, sceneState) {
  return (agents || []).filter((a) => a && a.enabled && a.actorId && isInScene(sceneState, a.actorId));
}

/** Кого записать в «аудиторию» нового сообщения. */
export function currentAudience(agents, sceneState) {
  return activeParticipants(agents, sceneState).map((a) => a.actorId);
}

/* ------------------------------------------------------------------ */
/* Видимость сообщений                                                 */
/* ------------------------------------------------------------------ */

export function isVisibleTo(msg, actorId) {
  if (!msg) return false;
  if (msg.whispered || msg.blind) return false;
  if (msg.kind && HIDDEN_KINDS.has(msg.kind)) return false;
  if (!msg.text || !String(msg.text).trim()) return false;
  if (Array.isArray(msg.audience) && !msg.audience.includes(actorId)) return false;
  return true;
}

/** Последние `limit` сообщений, которые мог видеть персонаж `actorId` (старые сверху). */
export function visibleMessages(messages, actorId, limit = 40) {
  const visible = (messages || []).filter((m) => isVisibleTo(m, actorId));
  return limit > 0 ? visible.slice(-limit) : visible;
}

export function formatLine(msg, maxLen = 1200) {
  let text = String(msg.text).replace(/\s+/g, " ").trim();
  if (text.length > maxLen) text = text.slice(0, maxLen - 1) + "…";
  return `${msg.speaker || "?"}: ${text}`;
}

/** Готовая расшифровка чата «Имя: текст» для одного агента. */
export function transcriptFor(messages, actorId, limit = 40) {
  return visibleMessages(messages, actorId, limit).map((m) => formatLine(m)).join("\n");
}

/** Публичная расшифровка для хроники (без учёта сцены, но без шёпотов и служебного). */
export function publicTranscript(messages) {
  return (messages || [])
    .filter((m) => !m.whispered && !m.blind && !(m.kind && HIDDEN_KINDS.has(m.kind)) && m.text && String(m.text).trim())
    .map((m) => formatLine(m))
    .join("\n");
}

/* ------------------------------------------------------------------ */
/* Личные заметки (секреты)                                            */
/* ------------------------------------------------------------------ */

/**
 * Заметки хранятся во флаге на актёре агента: массив { text, at }.
 * Возвращает новый массив (исходный не меняется).
 */
export function addNote(notes, text, at = Date.now()) {
  const list = Array.isArray(notes) ? notes.slice() : [];
  const clean = String(text || "").trim();
  if (clean) list.push({ text: clean, at });
  return list;
}

export function formatNotes(notes) {
  const list = Array.isArray(notes) ? notes : [];
  return list
    .map((n) => (typeof n === "string" ? n : n?.text))
    .filter((t) => t && String(t).trim())
    .map((t) => `- ${String(t).trim()}`)
    .join("\n");
}

/* ------------------------------------------------------------------ */
/* Имена                                                               */
/* ------------------------------------------------------------------ */

const norm = (s) => String(s || "").trim().toLocaleLowerCase("ru").replace(/ё/g, "е");

/**
 * Найти агента по имени: точное совпадение → начало имени → вхождение.
 * Если на шаге несколько кандидатов — неоднозначно, возвращаем null.
 */
export function findAgentByName(agents, name) {
  const q = norm(name);
  if (!q) return null;
  const list = (agents || []).filter((a) => a && a.actorId);
  for (const test of [(n) => n === q, (n) => n.startsWith(q), (n) => n.includes(q)]) {
    const hits = list.filter((a) => test(norm(a.name)));
    if (hits.length === 1) return hits[0];
    if (hits.length > 1) return null;
  }
  return null;
}

/** Разобрать «Имя, Имя» в список агентов; вернуть и найденных, и ненайденные имена. */
export function resolveAgentNames(agents, namesText) {
  const names = String(namesText || "")
    .split(/[,;]/)
    .map((s) => s.trim())
    .filter(Boolean);
  const found = [];
  const missing = [];
  for (const n of names) {
    const a = findAgentByName(agents, n);
    if (a) {
      if (!found.includes(a)) found.push(a);
    } else missing.push(n);
  }
  return { found, missing };
}

/* ------------------------------------------------------------------ */
/* HTML                                                                */
/* ------------------------------------------------------------------ */

export function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", "#39": "'", mdash: "—", ndash: "–", laquo: "«", raquo: "»" };

/** Грубое, но предсказуемое превращение HTML в текст (работает и без DOM). */
export function htmlToText(html) {
  return String(html ?? "")
    .replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|h[1-6]|tr|section|header|footer)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&(#\d+|#x[0-9a-f]+|[a-z]+\d*);/gi, (m, e) => {
      if (e[0] === "#") {
        const code = e[1].toLowerCase() === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
        return Number.isFinite(code) ? String.fromCodePoint(code) : m;
      }
      return ENTITIES[e.toLowerCase()] ?? m;
    })
    .replace(/[ \t\f\v ]+/g, " ")
    .replace(/\s*\n\s*/g, "\n")
    .trim();
}
