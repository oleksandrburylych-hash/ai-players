/**
 * system-adapter.js — всё, что зависит от игровой системы (Mongoose Traveller 2e, id `mgt2e`).
 *
 * Остальной код модуля про структуру данных системы ничего не знает и общается только
 * с объектом-адаптером:
 *
 *   adapter.id                      — id системы (game.system.id)
 *   adapter.title                   — название системы для промта
 *   adapter.supported               — есть ли для системы специальный адаптер
 *   adapter.isCandidateActor(actor) — каких актёров предлагать в окне агентов
 *   adapter.summarizeActor(actor)   — краткая выжимка листа для промта (строка)
 *   adapter.canRoll                 — умеет ли адаптер бросать (этап 2)
 *   adapter.rollCheck(actor, rr)    — бросок от имени актёра (этап 2; сейчас не реализован)
 *
 * Структура данных mgt2e сверена с исходниками системы:
 *   https://github.com/Mongoose-Publishing/traveller-foundryvtt (автор Samuel Penn / NotASnark),
 *   версия 0.24.0.0, файлы mgt2e/template.json, mgt2e/module/documents/actor.mjs,
 *   mgt2e/module/documents/item.mjs, mgt2e/module/helpers/dice-rolls.mjs, mgt2e/module/mgt2.mjs.
 *
 * Модуль не обращается к глобальным объектам Foundry: функция локализации передаётся снаружи.
 * Поэтому выжимку листа можно проверить в Node на поддельном актёре.
 */

export const MGT2E_ID = "mgt2e";

/** Типы предметов mgt2e, которые имеет смысл показывать как снаряжение. */
const GEAR_TYPES = new Set(["weapon", "armour", "item", "augment", "hardware"]);
/** Статусы предмета в mgt2e (MgT2Item.EQUIPPED / CARRIED / OWNED). */
const STATUS_LABEL = { equipped: "надето/в руках", carried: "при себе" };

const asArray = (c) => {
  if (!c) return [];
  if (Array.isArray(c)) return c;
  if (Array.isArray(c.contents)) return c.contents;
  try {
    return Array.from(c);
  } catch {
    return [];
  }
};

const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

const signed = (n) => (n > 0 ? `+${n}` : `${n}`);

/** DM характеристики по правилам Traveller (на случай, если система не посчитала dm). */
export function characteristicDM(value) {
  const v = Number(value) || 0;
  if (v <= 0) return -3;
  if (v <= 2) return -2;
  if (v <= 5) return -1;
  if (v <= 8) return 0;
  if (v <= 11) return 1;
  if (v <= 14) return 2;
  return 3;
}

/* ------------------------------------------------------------------ */
/* Mongoose Traveller 2e                                               */
/* ------------------------------------------------------------------ */

function mgt2eSkillLabel(localize, id, data) {
  if (data?.label && String(data.label).trim()) return String(data.label).trim();
  const key = `MGT2.Skills.${id}`;
  const s = localize ? localize(key) : key;
  return s && s !== key ? s : id;
}

export function summarizeMgt2eActor(actor, { localize } = {}) {
  const sys = actor?.system || {};
  const lines = [];

  // Кто это
  const who = [];
  const soph = sys.sophont || {};
  if (soph.species) who.push(`вид: ${soph.species}`);
  if (soph.gender) who.push(`пол: ${soph.gender}`);
  if (num(soph.age) !== null) who.push(`возраст: ${soph.age}`);
  if (soph.profession) who.push(`профессия: ${soph.profession}`);
  if (soph.homeworld) who.push(`родной мир: ${soph.homeworld}`);
  lines.push(`Имя: ${actor?.name ?? "?"}` + (who.length ? `; ${who.join("; ")}` : ""));

  // Характеристики: system.characteristics.{STR,…} = { value, current, dm, show, augment }
  const chars = sys.characteristics || {};
  const charParts = [];
  for (const [key, c] of Object.entries(chars)) {
    if (!c || typeof c !== "object") continue;
    const value = num(c.value);
    if (value === null) continue;
    if (c.show === false && !value) continue; // скрытые и нулевые (PSI 0 и т.п.) не показываем
    const current = num(c.current) ?? value;
    const dm = num(c.dm) ?? characteristicDM(current);
    charParts.push(`${key} ${current !== value ? `${current}/${value}` : value} (DM ${signed(dm)})`);
  }
  if (charParts.length) lines.push(`Характеристики: ${charParts.join(", ")}`);

  // Состояние: system.hits = { value, max }; system.damage.{STR,DEX,END}.value
  const state = [];
  if (sys.hits && num(sys.hits.max)) state.push(`хиты ${num(sys.hits.value) ?? "?"}/${num(sys.hits.max)}`);
  if (sys.damage && typeof sys.damage === "object") {
    const dmg = Object.entries(sys.damage)
      .filter(([, d]) => num(d?.value) > 0)
      .map(([k, d]) => `${k} −${num(d.value)}`);
    if (dmg.length) state.push(`урон: ${dmg.join(", ")}`);
  }
  if (num(sys.rads) > 0) state.push(`радиация ${num(sys.rads)} рад`);
  const effects = asArray(actor?.effects)
    .filter((e) => e && !e.disabled && e.name)
    .map((e) => e.name);
  if (effects.length) state.push(`эффекты: ${effects.join(", ")}`);
  lines.push(`Состояние: ${state.length ? state.join("; ") : "в норме"}`);

  // Навыки: system.skills.{id} = { trained, value, label?, specialities: { id: { trained, value, label? } } }
  const skills = sys.skills || {};
  const skillParts = [];
  for (const [id, s] of Object.entries(skills)) {
    if (!s || !s.trained) continue;
    const label = mgt2eSkillLabel(localize, id, s);
    const specs = Object.entries(s.specialities || {}).filter(([, sp]) => sp && (sp.trained || num(sp.value) > 0));
    if (specs.length) {
      // Есть обученные специальности — показываем их (базовый уровень навыка в них уже учтён).
      for (const [sid, sp] of specs) {
        skillParts.push({ text: `${label} (${mgt2eSkillLabel(localize, sid, sp)}) ${num(sp.value) ?? 0}`, v: num(sp.value) ?? 0 });
      }
    } else {
      skillParts.push({ text: `${label} ${num(s.value) ?? 0}`, v: num(s.value) ?? 0 });
    }
  }
  skillParts.sort((a, b) => b.v - a.v || a.text.localeCompare(b.text));
  lines.push(`Навыки: ${skillParts.length ? skillParts.map((p) => p.text).join(", ") : "нет обученных навыков (проверки без навыка с DM −3)"}`);

  // Снаряжение: actor.items, item.system.status = equipped | carried | owned
  const gear = [];
  for (const item of asArray(actor?.items)) {
    if (!item || !GEAR_TYPES.has(item.type)) continue;
    const isys = item.system || {};
    const status = isys.status || null;
    if (status && !STATUS_LABEL[status]) continue; // «owned» — лежит где-то, не при себе
    let text = item.name;
    const q = num(isys.quantity);
    if (q && q > 1) text += ` ×${q}`;
    if (item.type === "weapon" && isys.weapon) {
      const w = isys.weapon;
      const bits = [];
      if (w.damage) bits.push(`урон ${w.damage}`);
      if (num(w.range)) bits.push(`дальность ${w.range} м`);
      if (w.traits) bits.push(String(w.traits));
      if (bits.length) text += ` (${bits.join(", ")})`;
    } else if (item.type === "armour" && isys.armour) {
      if (num(isys.armour.protection)) text += ` (защита ${isys.armour.protection})`;
    }
    if (status) text += ` — ${STATUS_LABEL[status]}`;
    gear.push(text);
  }
  lines.push(`Снаряжение: ${gear.length ? gear.join("; ") : "ничего примечательного"}`);

  const cash = num(sys.finance?.cash);
  if (cash !== null) lines.push(`Наличные: Cr${cash}`);

  return lines.join("\n");
}

function mgt2eAdapter({ localize, title }) {
  return {
    id: MGT2E_ID,
    title: title || "Mongoose Traveller 2e",
    supported: true,
    isCandidateActor: (actor) => ["traveller", "npc"].includes(actor?.type),
    summarizeActor(actor) {
      try {
        return summarizeMgt2eActor(actor, { localize });
      } catch (err) {
        console.warn("ai-players | не удалось собрать выжимку листа", err);
        return `Имя: ${actor?.name ?? "?"}`;
      }
    },
    // Этап 2: здесь появится бросок средствами системы. В mgt2e для этого есть
    // game.mgt2e.rollSkillMacro(skillFqn, { actor }) (mgt2e/module/mgt2.mjs) и
    // rollSkill(actor, skillFqn, options) (mgt2e/module/helpers/dice-rolls.mjs);
    // skillFqn — «навык.специальность», например "athletics.strength".
    // TODO: проверить на этапе 2, открывает ли rollSkillMacro диалог и как передать DM.
    canRoll: false,
    async rollCheck(/* actor, rollRequest */) {
      throw new Error("Броски от имени агентов появятся на этапе 2.");
    },
  };
}

/* ------------------------------------------------------------------ */
/* Любая другая система                                                */
/* ------------------------------------------------------------------ */

function genericAdapter({ id, title }) {
  return {
    id: id || "unknown",
    title: title || id || "",
    supported: false,
    isCandidateActor: (actor) => !!actor,
    summarizeActor(actor) {
      const lines = [`Имя: ${actor?.name ?? "?"}`];
      const items = asArray(actor?.items)
        .map((i) => i?.name)
        .filter(Boolean)
        .slice(0, 30);
      if (items.length) lines.push(`Предметы и способности: ${items.join(", ")}`);
      return lines.join("\n");
    },
    canRoll: false,
    async rollCheck() {
      throw new Error("Броски для этой системы не поддерживаются.");
    },
  };
}

/**
 * @param {object} opts
 * @param {string} opts.systemId  game.system.id
 * @param {string} [opts.title]   game.system.title
 * @param {Function} [opts.localize]  (key) => string, обычно game.i18n.localize
 */
export function createSystemAdapter({ systemId, title, localize } = {}) {
  if (systemId === MGT2E_ID) return mgt2eAdapter({ localize, title });
  return genericAdapter({ id: systemId, title });
}
