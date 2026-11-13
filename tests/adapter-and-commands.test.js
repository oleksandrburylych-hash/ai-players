import test from "node:test";
import assert from "node:assert/strict";
import { createSystemAdapter, summarizeMgt2eActor, characteristicDM } from "../scripts/system-adapter.js";
import { parseAiCommand } from "../scripts/commands.js";

/** Поддельный актёр mgt2e — поля как в template.json / actor.mjs системы. */
const actor = {
  name: "Вера Ланг",
  type: "traveller",
  system: {
    sophont: { species: "Человек", age: 34, gender: "ж", profession: "Скаут", homeworld: "Регина" },
    characteristics: {
      STR: { value: 7, current: 7, dm: 0, show: true },
      DEX: { value: 9, current: 6, dm: 0, show: true },
      END: { value: 8, current: 8, dm: 0, show: true },
      INT: { value: 10, current: 10, dm: 1, show: true },
      EDU: { value: 6, current: 6, dm: 0, show: true },
      SOC: { value: 5, current: 5, dm: -1, show: true },
      PSI: { value: 0, current: 0, dm: -3, show: false },
    },
    hits: { value: 21, max: 24 },
    damage: { STR: { value: 0 }, DEX: { value: 3 }, END: { value: 0 } },
    skills: {
      pilot: { trained: true, value: 0, specialities: { smallcraft: { trained: true, value: 2 }, spacecraft: { trained: false, value: 0 } } },
      recon: { trained: true, value: 1 },
      admin: { trained: false, value: -3 },
      guncombat: { trained: true, value: 0, specialities: { slug: { trained: false, value: 0 } } },
    },
    finance: { cash: 2500 },
  },
  items: [
    { name: "Автопистолет", type: "weapon", system: { status: "equipped", quantity: 1, weapon: { damage: "3D6-3", range: 10, traits: "" } } },
    { name: "Ткань-броня", type: "armour", system: { status: "equipped", armour: { protection: 5 } } },
    { name: "Аптечка", type: "item", system: { status: "carried", quantity: 2 } },
    { name: "Запасной комбинезон", type: "item", system: { status: "owned" } },
    { name: "Срок 1: Скаут", type: "term", system: {} },
  ],
  effects: [{ name: "Ранен", disabled: false }],
};

const localize = (k) => ({ "MGT2.Skills.pilot": "Пилотирование", "MGT2.Skills.smallcraft": "малые суда" })[k] ?? k;

test("выжимка листа mgt2e", () => {
  const s = summarizeMgt2eActor(actor, { localize });
  assert.match(s, /Имя: Вера Ланг; вид: Человек; пол: ж; возраст: 34; профессия: Скаут; родной мир: Регина/);
  assert.match(s, /DEX 6\/9 \(DM 0\)/);
  assert.match(s, /INT 10 \(DM \+1\)/);
  assert.doesNotMatch(s, /PSI/, "скрытая нулевая характеристика не показывается");
  assert.match(s, /хиты 21\/24; урон: DEX −3; эффекты: Ранен/);
  assert.match(s, /Пилотирование \(малые суда\) 2/);
  assert.match(s, /recon 1/, "без перевода — id навыка");
  assert.match(s, /guncombat 0/, "навык без обученных специальностей");
  assert.doesNotMatch(s, /admin/, "необученный навык не показывается");
  assert.match(s, /Автопистолет \(урон 3D6-3, дальность 10 м\) — надето\/в руках/);
  assert.match(s, /Ткань-броня \(защита 5\)/);
  assert.match(s, /Аптечка ×2 — при себе/);
  assert.doesNotMatch(s, /комбинезон/, "то, что не при себе, не показывается");
  assert.doesNotMatch(s, /Срок 1/, "термы карьеры — не снаряжение");
  assert.match(s, /Наличные: Cr2500/);
});

test("адаптер выбирается по game.system.id", () => {
  const a = createSystemAdapter({ systemId: "mgt2e", title: "Mongoose Traveller 2e", localize });
  assert.equal(a.supported, true);
  assert.equal(a.isCandidateActor({ type: "traveller" }), true);
  assert.equal(a.isCandidateActor({ type: "spacecraft" }), false);
  assert.equal(a.canRoll, false, "броски — этап 2");

  const g = createSystemAdapter({ systemId: "dnd5e", title: "D&D" });
  assert.equal(g.supported, false);
  assert.match(g.summarizeActor({ name: "Гимли", items: [{ name: "Топор" }] }), /Гимли[\s\S]*Топор/);
  assert.equal(a.summarizeActor({ name: "Пустой" }).startsWith("Имя: Пустой"), true, "не падает на пустом актёре");
});

test("DM характеристики по таблице Traveller", () => {
  assert.deepEqual([0, 1, 2, 3, 5, 6, 8, 9, 11, 12, 14, 15].map(characteristicDM), [-3, -2, -2, -1, -1, 0, 0, 1, 1, 2, 2, 3]);
});

test("разбор команд /ai", () => {
  assert.equal(parseAiCommand("Привет"), null);
  assert.equal(parseAiCommand("/aim"), null);
  assert.deepEqual(parseAiCommand("/ai"), { cmd: "help", args: {} });
  assert.deepEqual(parseAiCommand("/ai go"), { cmd: "go", args: {} });
  assert.deepEqual(parseAiCommand("/AI Stop"), { cmd: "stop", args: {} });
  assert.deepEqual(parseAiCommand("/ai next Вера Ланг"), { cmd: "next", args: { name: "Вера Ланг" } });
  assert.deepEqual(parseAiCommand("/ai in Вера, Борис"), { cmd: "in", args: { names: "Вера, Борис" } });
  assert.deepEqual(parseAiCommand("/ai in all"), { cmd: "in", args: { all: true } });
  assert.deepEqual(parseAiCommand("/ai in все"), { cmd: "in", args: { all: true } });
  assert.deepEqual(parseAiCommand("/ai tell Борис: Код сейфа — 4471. Никому: ни слова"), {
    cmd: "tell",
    args: { name: "Борис", text: "Код сейфа — 4471. Никому: ни слова" },
  });
  assert.ok(parseAiCommand("/ai tell Борис без двоеточия").error);
  assert.ok(parseAiCommand("/ai next").error);
  assert.equal(parseAiCommand("/ai dance").cmd, "unknown");
  assert.deepEqual(parseAiCommand("/ai recap"), { cmd: "recap", args: {} });
  assert.deepEqual(parseAiCommand("/ai status"), { cmd: "status", args: {} });
});
