/**
 * persona.js — характер персонажа: анкета, темперамент, проверка «не одинаковые ли»,
 * защита от эха и запрос «придумать разные характеры».
 *
 * Чистый модуль: работает в Node, тестируется без Foundry.
 */

import { modelTuning } from "./api.js";

/* ------------------------------------------------------------------ */
/* Анкета                                                              */
/* ------------------------------------------------------------------ */

/** Поля анкеты: ключ → подпись. Порядок — порядок в окне и в промте. */
export const PERSONA_FIELDS = [
  ["goal", "Цель"],
  ["fear", "Страх"],
  ["flaw", "Слабость"],
  ["voice", "Манера речи"],
  ["sample", "Примеры фраз"],
  ["relations", "Отношения с группой"],
  ["publicFace", "Каким его видят другие"],
  ["extra", "Прочее"],
];

export const PERSONA_KEYS = PERSONA_FIELDS.map(([k]) => k);

/** Переключатели темперамента: ось → варианты → { label, rule }. */
export const TEMPERAMENT = {
  talk: {
    title: "Разговорчивость",
    options: {
      quiet: {
        label: "молчун",
        rule: "Ты молчун. Говоришь, только когда есть что-то важное или к тебе обратились. Чаще всего выбирай pass. Не больше одной короткой фразы.",
      },
      normal: { label: "обычно", rule: "" },
      chatty: {
        label: "болтун",
        rule: "Ты разговорчив: любишь вставить слово, подколоть, прокомментировать. Молчишь редко, но всё равно не больше трёх фраз и без пересказа сцены.",
      },
    },
  },
  risk: {
    title: "Риск",
    options: {
      careful: {
        label: "осторожный",
        rule: "Ты осторожен: сначала разузнать, подстраховаться, обойти опасность. Опрометчивые планы тебя пугают или злят, и ты это говоришь.",
      },
      normal: { label: "обычно", rule: "" },
      reckless: {
        label: "рисковый",
        rule: "Ты рисковый: предпочитаешь действовать сразу и смело. Долгие обсуждения раздражают, осторожность других кажется трусостью.",
      },
    },
  },
  group: {
    title: "В группе",
    options: {
      team: {
        label: "командный",
        rule: "Ты командный: ищешь план, который устроит всех, заступаешься за своих. Но поддержку выражаешь своими словами и своим доводом, а не повтором чужих.",
      },
      normal: { label: "обычно", rule: "" },
      contrarian: {
        label: "спорщик",
        rule: "Ты себе на уме: часто не согласен с группой, споришь, предлагаешь свой вариант и тянешь в сторону своей цели.",
      },
    },
  },
};

export const TEMPERAMENT_AXES = Object.keys(TEMPERAMENT);

const str = (v) => (typeof v === "string" ? v : v == null ? "" : String(v));

export function normalizeTemperament(t) {
  const out = {};
  for (const axis of TEMPERAMENT_AXES) {
    const v = t?.[axis];
    out[axis] = TEMPERAMENT[axis].options[v] ? v : "normal";
  }
  return out;
}

/**
 * Привести запись агента к актуальному виду.
 * Старый формат (v0.1: { passport: "текст" }) переносится в поле «Прочее».
 */
export function normalizeAgentRecord(r) {
  const persona = {};
  for (const k of PERSONA_KEYS) persona[k] = str(r?.persona?.[k]).trim();
  if (!r?.persona && r?.passport) persona.extra = str(r.passport).trim();
  return {
    actorId: str(r?.actorId),
    enabled: r?.enabled !== false,
    model: str(r?.model).trim(),
    persona,
    temperament: normalizeTemperament(r?.temperament),
  };
}

export const isPersonaEmpty = (persona) => PERSONA_KEYS.every((k) => !str(persona?.[k]).trim());

export function temperamentLabel(t) {
  const n = normalizeTemperament(t);
  const parts = TEMPERAMENT_AXES.filter((a) => n[a] !== "normal").map((a) => TEMPERAMENT[a].options[n[a]].label);
  return parts.join(", ");
}

export function temperamentRules(t) {
  const n = normalizeTemperament(t);
  return TEMPERAMENT_AXES.map((a) => TEMPERAMENT[a].options[n[a]].rule).filter(Boolean);
}

/** Анкета → текст для промта (без публичного лица — оно идёт в описание группы). */
export function formatPersona(persona, { include = PERSONA_KEYS.filter((k) => k !== "publicFace" && k !== "sample" && k !== "voice") } = {}) {
  return PERSONA_FIELDS.filter(([k]) => include.includes(k) && str(persona?.[k]).trim())
    .map(([k, label]) => `${label}: ${str(persona[k]).trim()}`)
    .join("\n");
}

/* ------------------------------------------------------------------ */
/* Проверка «персонажи разные»                                         */
/* ------------------------------------------------------------------ */

/**
 * Найти, что делает персонажей похожими. agents: [{ name, persona, temperament }].
 * Возвращает список понятных предупреждений (пустой — всё хорошо).
 */
export function distinctnessWarnings(agents) {
  const list = (agents || []).filter(Boolean);
  const warnings = [];
  for (const a of list) {
    if (isPersonaEmpty(a.persona)) warnings.push(`У персонажа ${a.name} пустая анкета — он будет играть «никак».`);
    else if (!str(a.persona?.voice).trim() && !str(a.persona?.sample).trim()) {
      warnings.push(`У персонажа ${a.name} не задана манера речи — по репликам его будет трудно отличить.`);
    }
  }
  for (let i = 0; i < list.length; i++) {
    for (let j = i + 1; j < list.length; j++) {
      const a = normalizeTemperament(list[i].temperament);
      const b = normalizeTemperament(list[j].temperament);
      if (TEMPERAMENT_AXES.every((x) => a[x] === b[x])) {
        warnings.push(`У ${list[i].name} и ${list[j].name} одинаковый темперамент — разведите хотя бы один переключатель.`);
      }
      const goalA = str(list[i].persona?.goal).trim().toLowerCase();
      const goalB = str(list[j].persona?.goal).trim().toLowerCase();
      if (goalA && goalA === goalB) warnings.push(`У ${list[i].name} и ${list[j].name} одинаковая цель.`);
    }
  }
  return warnings;
}

/* ------------------------------------------------------------------ */
/* Защита от эха                                                       */
/* ------------------------------------------------------------------ */

/** Грубые «основы» слов: русские окончания срезаются первыми пятью буквами. */
export function wordStems(text) {
  const words = str(text)
    .toLowerCase()
    .replace(/ё/g, "е")
    .match(/[a-zа-я0-9]+/g);
  return new Set((words || []).filter((w) => w.length >= 4).map((w) => w.slice(0, 5)));
}

/** Доля общих основ относительно более короткой реплики (0…1). */
export function overlap(a, b) {
  const A = wordStems(a);
  const B = wordStems(b);
  const small = Math.min(A.size, B.size);
  if (small === 0) return 0;
  let common = 0;
  for (const w of A) if (B.has(w)) common++;
  return common / small;
}

export const ECHO_THRESHOLD = 0.6;
export const ECHO_MIN_WORDS = 4;

/**
 * Проверить реплику на эхо. recent: [{ name, text }] — реплики этого цикла (свои и чужие).
 * Заявки (declare) не проверяются: двое могут честно заявить одно и то же действие.
 * Возвращает null или причину отказа (строку для подсказки модели).
 */
export function echoReason(act, recent, selfName) {
  if (!act || !["say", "ask_gm"].includes(act.action)) return null;
  if (wordStems(act.text).size < ECHO_MIN_WORDS) return null;
  for (const r of recent || []) {
    if (!r?.text || wordStems(r.text).size < ECHO_MIN_WORDS) continue;
    if (overlap(act.text, r.text) >= ECHO_THRESHOLD) {
      return r.name === selfName
        ? "ты почти дословно повторил свою прошлую реплику"
        : `твой вариант почти повторяет то, что уже сказал(а) ${r.name}`;
    }
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* «Придумать разные характеры»                                        */
/* ------------------------------------------------------------------ */

const enumOf = (axis) => Object.keys(TEMPERAMENT[axis].options);

export const PERSONAS_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["characters"],
  properties: {
    characters: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: [...PERSONA_KEYS.filter((k) => k !== "extra"), "slot", "talk", "risk", "group"],
        properties: {
          slot: { type: "integer" },
          goal: { type: "string" },
          fear: { type: "string" },
          flaw: { type: "string" },
          voice: { type: "string" },
          sample: { type: "string" },
          relations: { type: "string" },
          publicFace: { type: "string" },
          talk: { type: "string", enum: enumOf("talk") },
          risk: { type: "string", enum: enumOf("risk") },
          group: { type: "string", enum: enumOf("group") },
        },
      },
    },
  },
};

/**
 * Запрос: придумать контрастные характеры. slots: [{ slot, name, sheet, persona, temperament }].
 * Уже заполненные поля модель видит и должна учитывать (оставить их смысл).
 */
export function buildPersonasRequest({ model, effort, systemTitle, slots }) {
  const system =
    "Ты помогаешь мастеру настольной ролевой игры подготовить группу персонажей, за которых будут играть ИИ-игроки. " +
    "Придумай каждому характер так, чтобы четвёрка была максимально КОНТРАСТНОЙ: разные цели (иногда противоречащие друг другу), " +
    "разные страхи, разные слабости, узнаваемо разная манера речи, разный темперамент. Никаких двух похожих персонажей. " +
    "Опирайся на лист персонажа (профессия, навыки, возраст), но не повторяй его. Пиши по-русски, коротко: каждое поле — одна-две фразы. " +
    "В поле sample — две-три характерные реплики этого персонажа в кавычках, по которым его сразу узнаешь. " +
    "В поле relations — отношение к другим персонажам группы по именам (с трениями, не только дружба). " +
    "В поле publicFace — как персонаж выглядит со стороны для остальных (без его тайн). " +
    "Если поле уже заполнено мастером — сохрани его смысл (можно чуть подправить формулировку). " +
    "Темперамент (talk / risk / group) выбери так, чтобы у всех персонажей сочетания различались. " +
    "Верни по записи на каждый слот из запроса, с тем же номером slot.";
  const blocks = slots.map((s) => {
    const filled = PERSONA_FIELDS.filter(([k]) => str(s.persona?.[k]).trim())
      .map(([k, label]) => `  ${label} (${k}): ${str(s.persona[k]).trim()}`)
      .join("\n");
    const t = normalizeTemperament(s.temperament);
    return (
      `### Слот ${s.slot}: ${s.name}\n` +
      `Лист:\n${str(s.sheet).trim() || "(пусто)"}\n` +
      (filled ? `Уже задано мастером:\n${filled}\n` : "Мастер ничего не задал.\n") +
      `Текущий темперамент: talk=${t.talk}, risk=${t.risk}, group=${t.group}`
    );
  });
  const user = `Игра: ${systemTitle || "настольная ролевая игра"}.\n\n${blocks.join("\n\n")}`;
  const tuning = modelTuning(model, effort);
  return {
    model,
    max_tokens: 4000,
    system,
    messages: [{ role: "user", content: user }],
    ...tuning,
    output_config: { ...(tuning.output_config || {}), format: { type: "json_schema", schema: PERSONAS_SCHEMA } },
  };
}

/** Разобрать ответ: { ok, characters: [{ slot, persona, temperament }] } или { ok:false, reason }. */
export function parsePersonasResponse(data) {
  if (!data) return { ok: false, reason: "пустой ответ" };
  if (data.stop_reason === "refusal") return { ok: false, reason: "модель отказалась" };
  if (data.stop_reason === "max_tokens") return { ok: false, reason: "ответ обрезан" };
  const text = (data.content || [])
    .filter((b) => b?.type === "text")
    .map((b) => b.text)
    .join("");
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    return { ok: false, reason: "ответ не JSON" };
  }
  if (!Array.isArray(json?.characters)) return { ok: false, reason: "нет списка персонажей" };
  const characters = json.characters
    .filter((c) => c && Number.isInteger(c.slot))
    .map((c) => {
      const persona = {};
      for (const k of PERSONA_KEYS) persona[k] = str(c[k]).trim();
      return { slot: c.slot, persona, temperament: normalizeTemperament({ talk: c.talk, risk: c.risk, group: c.group }) };
    });
  return { ok: true, characters };
}

/**
 * Влить предложение в анкету: заполняются только пустые поля; темперамент меняется,
 * только если мастер его не трогал (все переключатели «обычно»).
 */
export function mergeSuggestion(current, suggestion) {
  const persona = { ...current.persona };
  for (const k of PERSONA_KEYS) if (!str(persona[k]).trim() && str(suggestion.persona?.[k]).trim()) persona[k] = suggestion.persona[k];
  const cur = normalizeTemperament(current.temperament);
  const untouched = TEMPERAMENT_AXES.every((a) => cur[a] === "normal");
  return { ...current, persona, temperament: untouched ? normalizeTemperament(suggestion.temperament) : cur };
}
