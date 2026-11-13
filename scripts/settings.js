/**
 * settings.js — настройки модуля и окно настройки агентов.
 *
 * Работает только в Foundry (использует game, foundry.*). Логика цикла сюда не попадает.
 */

import { MODULE_ID, escapeHtml, normalizeSceneState } from "./visibility.js";
import {
  PERSONA_FIELDS,
  TEMPERAMENT,
  TEMPERAMENT_AXES,
  distinctnessWarnings,
  mergeSuggestion,
  normalizeAgentRecord,
} from "./persona.js";

export const MAX_AGENTS = 4;
export const DEFAULT_MODEL = "claude-sonnet-5-5";

/** Ключ локализации. Названия и подсказки настроек Foundry локализует сам при показе окна. */
const K = (key) => `AIPLAYERS.${key}`;
/** Локализованная строка (только во время работы, не в хуке init: переводы грузятся позже). */
const L = (key) => game.i18n.localize(K(key));

/* ------------------------------------------------------------------ */
/* Регистрация                                                         */
/* ------------------------------------------------------------------ */

export function registerSettings() {
  const fields = foundry.data.fields;

  // API-ключ: scope "client" — хранится только в браузере этого клиента, в мир не уходит.
  game.settings.register(MODULE_ID, "apiKey", {
    name: K("Settings.ApiKey.Name"),
    hint: K("Settings.ApiKey.Hint"),
    scope: "client",
    config: true,
    type: new fields.StringField({ required: false, blank: true, initial: "" }),
    default: "",
    // Поле «пароль». TODO: проверить, что SettingsConfig v13 использует `input`;
    // на всякий случай тип поля дополнительно меняется в хуке renderSettingsConfig (main.js).
    input: (field, config) => {
      const el = foundry.applications.fields.createTextInput(config);
      el.type = "password";
      el.autocomplete = "off";
      return el;
    },
  });

  game.settings.register(MODULE_ID, "model", {
    name: K("Settings.Model.Name"),
    hint: K("Settings.Model.Hint"),
    scope: "world",
    config: true,
    type: String,
    default: DEFAULT_MODEL,
  });

  game.settings.register(MODULE_ID, "effort", {
    name: K("Settings.Effort.Name"),
    hint: K("Settings.Effort.Hint"),
    scope: "world",
    config: true,
    type: String,
    choices: {
      // Варианты — сразу текстом: в хуке init переводы ещё не загружены.
      low: "low — коротко думает (рекомендуется)",
      medium: "medium",
      high: "high",
      none: "не отправлять (для старых моделей без effort)",
    },
    default: "low",
  });

  const numberSetting = (key, def, min, max, step) =>
    game.settings.register(MODULE_ID, key, {
      name: K(`Settings.${key}.Name`),
      hint: K(`Settings.${key}.Hint`),
      scope: "world",
      config: true,
      type: Number,
      range: { min, max, step },
      default: def,
    });
  numberSetting("maxRounds", 3, 1, 10, 1);
  numberSetting("maxRequests", 16, 1, 64, 1);
  numberSetting("maxTokens", 400, 100, 4000, 50);
  numberSetting("historySize", 40, 5, 200, 5);

  game.settings.register(MODULE_ID, "autoRespond", {
    name: K("Settings.AutoRespond.Name"),
    hint: K("Settings.AutoRespond.Hint"),
    scope: "world",
    config: true,
    type: Boolean,
    default: true,
  });

  game.settings.register(MODULE_ID, "showThoughts", {
    name: K("Settings.ShowThoughts.Name"),
    hint: K("Settings.ShowThoughts.Hint"),
    scope: "world",
    config: true,
    type: Boolean,
    default: true,
  });

  // Скрытые настройки состояния (мир).
  game.settings.register(MODULE_ID, "agents", { scope: "world", config: false, type: Object, default: { list: [] } });
  game.settings.register(MODULE_ID, "sceneState", { scope: "world", config: false, type: Object, default: { all: true, ids: [] } });
  game.settings.register(MODULE_ID, "rotation", { scope: "world", config: false, type: Number, default: 0 });
  game.settings.register(MODULE_ID, "recapSince", { scope: "world", config: false, type: Number, default: 0 });

  game.settings.registerMenu(MODULE_ID, "agentsMenu", {
    name: K("Settings.AgentsMenu.Name"),
    label: K("Settings.AgentsMenu.Label"),
    hint: K("Settings.AgentsMenu.Hint"),
    icon: "fa-solid fa-users",
    type: getAgentsConfigClass(),
    restricted: true,
  });
}

/* ------------------------------------------------------------------ */
/* Чтение и запись                                                     */
/* ------------------------------------------------------------------ */

export const getSetting = (key) => game.settings.get(MODULE_ID, key);
export const setSetting = (key, value) => game.settings.set(MODULE_ID, key, value);

export function getLoopConfig() {
  return {
    model: String(getSetting("model") || DEFAULT_MODEL).trim() || DEFAULT_MODEL,
    effort: getSetting("effort") || "low",
    maxRounds: Number(getSetting("maxRounds")) || 3,
    maxRequests: Number(getSetting("maxRequests")) || 16,
    maxTokens: Number(getSetting("maxTokens")) || 400,
    historySize: Number(getSetting("historySize")) || 40,
    autoRespond: !!getSetting("autoRespond"),
    showThoughts: !!getSetting("showThoughts"),
  };
}

/**
 * Записи агентов: [{ actorId, enabled, model, persona, temperament }] — до четырёх, в порядке слотов.
 * Старый формат (свободный «паспорт») переносится в поле анкеты «Прочее».
 */
export function getAgentRecords() {
  const raw = getSetting("agents");
  const list = Array.isArray(raw?.list) ? raw.list : [];
  return list.slice(0, MAX_AGENTS).map(normalizeAgentRecord);
}

export async function setAgentRecords(records) {
  await setSetting("agents", { list: records.slice(0, MAX_AGENTS).map(normalizeAgentRecord) });
}

export function getSceneState() {
  return normalizeSceneState(getSetting("sceneState"));
}

export async function setSceneState(state) {
  await setSetting("sceneState", normalizeSceneState(state));
}

/* ------------------------------------------------------------------ */
/* Окно настройки агентов (ApplicationV2)                              */
/* ------------------------------------------------------------------ */

let AgentsConfigClass = null;

const PLACEHOLDERS = {
  goal: "Чего он хочет добиться? Например: выплатить долг за корабль любой ценой",
  fear: "Чего боится? Например: снова попасть в тюрьму",
  flaw: "Слабость: азарт, жадность, вспыльчивость, доверчивость…",
  voice: "Как говорит: коротко и грубо / витиевато / с шуточками / сухо, как отчёт",
  sample: "2–3 характерные фразы: «Деньги вперёд.» «Я бы не стал…»",
  relations: "Как относится к остальным по именам: кому верит, кого презирает",
  publicFace: "Как выглядит для остальных (без тайн): «вечно хмурый механик»",
  extra: "Всё остальное, что важно для игры",
};

/** Прочитать все слоты из формы. */
function readForm(form) {
  const el = (n) => form.elements[n];
  const records = [];
  for (let i = 0; i < MAX_AGENTS; i++) {
    const persona = {};
    for (const [k] of PERSONA_FIELDS) persona[k] = el(`p-${i}-${k}`)?.value ?? "";
    const temperament = {};
    for (const a of TEMPERAMENT_AXES) temperament[a] = el(`t-${i}-${a}`)?.value ?? "normal";
    records.push(
      normalizeAgentRecord({
        actorId: el(`actor-${i}`)?.value || "",
        enabled: !!el(`enabled-${i}`)?.checked,
        model: el(`model-${i}`)?.value || "",
        persona,
        temperament,
      }),
    );
  }
  return records;
}

/** Записать один слот обратно в форму (после «Придумать разные характеры»). */
function writeSlot(form, i, record) {
  for (const [k] of PERSONA_FIELDS) {
    const f = form.elements[`p-${i}-${k}`];
    if (f) f.value = record.persona[k] ?? "";
  }
  for (const a of TEMPERAMENT_AXES) {
    const f = form.elements[`t-${i}-${a}`];
    if (f) f.value = record.temperament[a];
  }
}

/** Класс создаётся лениво: foundry.applications.api доступен только внутри Foundry. */
export function getAgentsConfigClass() {
  if (AgentsConfigClass) return AgentsConfigClass;
  const { ApplicationV2 } = foundry.applications.api;

  class AgentsConfig extends ApplicationV2 {
    static DEFAULT_OPTIONS = {
      id: "ai-players-agents",
      tag: "form",
      classes: ["ai-players-config"],
      window: { title: "ИИ-игроки: агенты", icon: "fa-solid fa-users", contentClasses: ["standard-form"], resizable: true },
      position: { width: 760, height: 820 },
      form: { handler: AgentsConfig.#onSubmit, closeOnSubmit: true },
      actions: { suggest: AgentsConfig.#onSuggest },
    };

    async _prepareContext() {
      const adapter = game.modules.get(MODULE_ID)?.api?.adapter;
      const candidates = game.actors.contents
        .filter((a) => (adapter ? adapter.isCandidateActor(a) : true))
        .sort((a, b) => a.name.localeCompare(b.name, "ru"));
      const records = getAgentRecords();
      const slots = [];
      for (let i = 0; i < MAX_AGENTS; i++) slots.push(records[i] || normalizeAgentRecord({}));
      return { candidates, slots };
    }

    async _renderHTML(context) {
      const { candidates, slots } = context;
      const slotHtml = slots
        .map((s, i) => {
          const known = candidates.some((a) => a.id === s.actorId);
          const extra =
            s.actorId && !known && game.actors.get(s.actorId)
              ? `<option value="${escapeHtml(s.actorId)}" selected>${escapeHtml(game.actors.get(s.actorId).name)}</option>`
              : "";
          const options = candidates
            .map((a) => `<option value="${escapeHtml(a.id)}"${a.id === s.actorId ? " selected" : ""}>${escapeHtml(a.name)}</option>`)
            .join("");
          const title = s.actorId ? escapeHtml(game.actors.get(s.actorId)?.name ?? "?") : L("Agents.NoActor");
          const temper = TEMPERAMENT_AXES.map((axis) => {
            const opts = Object.entries(TEMPERAMENT[axis].options)
              .map(([v, o]) => `<option value="${v}"${s.temperament[axis] === v ? " selected" : ""}>${escapeHtml(o.label)}</option>`)
              .join("");
            return `<label class="ai-players-temper">${escapeHtml(TEMPERAMENT[axis].title)}
                      <select name="t-${i}-${axis}">${opts}</select></label>`;
          }).join("");
          const fields = PERSONA_FIELDS.map(
            ([k, label]) => `
              <div class="form-group stacked">
                <label>${escapeHtml(label)}</label>
                <textarea name="p-${i}-${k}" rows="${k === "sample" || k === "extra" ? 2 : 1}"
                  placeholder="${escapeHtml(PLACEHOLDERS[k])}">${escapeHtml(s.persona[k])}</textarea>
              </div>`,
          ).join("");
          return `
          <details class="ai-players-slot" open>
            <summary>${L("Agents.Slot")} ${i + 1}: ${title}</summary>
            <div class="form-group">
              <label>${L("Agents.Actor")}</label>
              <div class="form-fields">
                <select name="actor-${i}">
                  <option value="">${L("Agents.NoActor")}</option>${extra}${options}
                </select>
                <label class="checkbox"><input type="checkbox" name="enabled-${i}"${s.enabled ? " checked" : ""}> ${L("Agents.Enabled")}</label>
              </div>
            </div>
            <div class="form-group"><label>Темперамент</label><div class="form-fields">${temper}</div></div>
            ${fields}
            <div class="form-group">
              <label>Своя модель</label>
              <div class="form-fields">
                <input type="text" name="model-${i}" value="${escapeHtml(s.model)}" placeholder="пусто — общая модель из настроек">
              </div>
            </div>
          </details>`;
        })
        .join("");
      return `
        <p class="hint">${L("Agents.Hint")}</p>
        <p class="hint">Чтобы персонажи звучали по-разному, у каждого должны быть своя цель, свой темперамент и своя манера речи.
          Кнопка ниже заполнит пустые поля так, чтобы группа получилась контрастной (один запрос к модели).
          Заполненное вами не меняется.</p>
        <button type="button" data-action="suggest" class="ai-players-suggest">
          <i class="fa-solid fa-wand-magic-sparkles"></i> Придумать разные характеры
        </button>
        ${slotHtml}
        <footer class="form-footer">
          <button type="submit"><i class="fa-solid fa-floppy-disk"></i> ${L("Agents.Save")}</button>
        </footer>`;
    }

    _replaceHTML(result, content) {
      content.innerHTML = result;
    }

    /** «Придумать разные характеры»: заполнить пустые поля в форме (без сохранения). */
    static async #onSuggest(event, target) {
      const form = this.element;
      const records = readForm(form);
      const slots = records
        .map((r, i) => ({ ...r, index: i, slot: i + 1, name: game.actors.get(r.actorId)?.name }))
        .filter((r) => r.actorId && r.name);
      if (!slots.length) return ui.notifications.warn("Сначала выберите актёров хотя бы в одном слоте.");
      const api = game.modules.get(MODULE_ID)?.api;
      if (!api?.suggestPersonas) return ui.notifications.error("Модуль ещё не готов: войдите в мир мастером.");

      const label = target.innerHTML;
      target.disabled = true;
      target.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> Придумываю…`;
      try {
        const suggestions = await api.suggestPersonas(slots);
        let n = 0;
        for (const sug of suggestions) {
          const slot = slots.find((s) => s.slot === sug.slot);
          if (!slot) continue;
          writeSlot(form, slot.index, mergeSuggestion(records[slot.index], sug));
          n++;
        }
        ui.notifications.info(`Готово: предложены характеры для ${n} персонажей. Проверьте, поправьте и нажмите «Сохранить».`);
      } catch (err) {
        ui.notifications.error(`Не удалось придумать характеры: ${err?.message || err}`);
      } finally {
        target.disabled = false;
        target.innerHTML = label;
      }
    }

    static async #onSubmit(event, form) {
      const records = [];
      const seen = new Set();
      for (const r of readForm(form)) {
        if (r.actorId && seen.has(r.actorId)) {
          ui.notifications.warn(L("Agents.Duplicate"));
          continue;
        }
        if (r.actorId) seen.add(r.actorId);
        records.push(r);
      }
      await setAgentRecords(records);
      ui.notifications.info(L("Agents.Saved"));

      const active = records
        .filter((r) => r.actorId && r.enabled)
        .map((r) => ({ ...r, name: game.actors.get(r.actorId)?.name ?? "?" }));
      for (const w of distinctnessWarnings(active).slice(0, 4)) ui.notifications.warn(w, { permanent: true });
    }
  }

  AgentsConfigClass = AgentsConfig;
  return AgentsConfigClass;
}
