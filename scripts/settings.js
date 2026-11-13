/**
 * settings.js — настройки модуля и окно настройки агентов.
 *
 * Работает только в Foundry (использует game, foundry.*). Логика цикла сюда не попадает.
 */

import { MODULE_ID, escapeHtml, normalizeSceneState } from "./visibility.js";

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

/** Сырые записи агентов: [{ actorId, passport, enabled }] — до четырёх, в порядке слотов. */
export function getAgentRecords() {
  const raw = getSetting("agents");
  const list = Array.isArray(raw?.list) ? raw.list : [];
  return list.slice(0, MAX_AGENTS).map((r) => ({
    actorId: r?.actorId || "",
    passport: String(r?.passport || ""),
    enabled: r?.enabled !== false,
  }));
}

export async function setAgentRecords(records) {
  await setSetting("agents", { list: records.slice(0, MAX_AGENTS) });
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

/** Класс создаётся лениво: foundry.applications.api доступен только внутри Foundry. */
export function getAgentsConfigClass() {
  if (AgentsConfigClass) return AgentsConfigClass;
  const { ApplicationV2 } = foundry.applications.api;

  class AgentsConfig extends ApplicationV2 {
    static DEFAULT_OPTIONS = {
      id: "ai-players-agents",
      tag: "form",
      classes: ["ai-players-config"],
      window: { title: "ИИ-игроки: агенты", icon: "fa-solid fa-users", contentClasses: ["standard-form"] },
      position: { width: 680, height: "auto" },
      form: { handler: AgentsConfig.#onSubmit, closeOnSubmit: true },
    };

    async _prepareContext() {
      const adapter = game.modules.get(MODULE_ID)?.api?.adapter;
      const candidates = game.actors.contents
        .filter((a) => (adapter ? adapter.isCandidateActor(a) : true))
        .sort((a, b) => a.name.localeCompare(b.name, "ru"));
      const records = getAgentRecords();
      const slots = [];
      for (let i = 0; i < MAX_AGENTS; i++) slots.push(records[i] || { actorId: "", passport: "", enabled: true });
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
            .map(
              (a) =>
                `<option value="${escapeHtml(a.id)}"${a.id === s.actorId ? " selected" : ""}>${escapeHtml(a.name)}</option>`,
            )
            .join("");
          return `
          <fieldset class="ai-players-slot">
            <legend>${L("Agents.Slot")} ${i + 1}</legend>
            <div class="form-group">
              <label>${L("Agents.Actor")}</label>
              <div class="form-fields">
                <select name="actor-${i}">
                  <option value="">${L("Agents.NoActor")}</option>${extra}${options}
                </select>
                <label class="checkbox"><input type="checkbox" name="enabled-${i}"${s.enabled ? " checked" : ""}> ${L("Agents.Enabled")}</label>
              </div>
            </div>
            <div class="form-group stacked">
              <label>${L("Agents.Passport")}</label>
              <textarea name="passport-${i}" rows="5" placeholder="${escapeHtml(L("Agents.PassportPlaceholder"))}">${escapeHtml(s.passport)}</textarea>
            </div>
          </fieldset>`;
        })
        .join("");
      return `
        <p class="hint">${L("Agents.Hint")}</p>
        ${slotHtml}
        <footer class="form-footer">
          <button type="submit"><i class="fa-solid fa-floppy-disk"></i> ${L("Agents.Save")}</button>
        </footer>`;
    }

    _replaceHTML(result, content) {
      content.innerHTML = result;
    }

    static async #onSubmit(event, form) {
      const records = [];
      const seen = new Set();
      for (let i = 0; i < MAX_AGENTS; i++) {
        const actorId = form.elements[`actor-${i}`]?.value || "";
        const passport = form.elements[`passport-${i}`]?.value || "";
        const enabled = !!form.elements[`enabled-${i}`]?.checked;
        if (actorId && seen.has(actorId)) {
          ui.notifications.warn(L("Agents.Duplicate"));
          continue;
        }
        if (actorId) seen.add(actorId);
        records.push({ actorId, passport, enabled });
      }
      await setAgentRecords(records);
      ui.notifications.info(L("Agents.Saved"));
    }
  }

  AgentsConfigClass = AgentsConfig;
  return AgentsConfigClass;
}
