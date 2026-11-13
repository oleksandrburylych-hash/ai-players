import test from "node:test";
import assert from "node:assert/strict";
import {
  activeParticipants,
  addNote,
  currentAudience,
  findAgentByName,
  formatNotes,
  htmlToText,
  isVisibleTo,
  publicTranscript,
  resolveAgentNames,
  transcriptFor,
  escapeHtml,
} from "../scripts/visibility.js";

const agents = [
  { actorId: "a1", name: "Вера", enabled: true },
  { actorId: "a2", name: "Борис", enabled: true },
  { actorId: "a3", name: "Сайрус", enabled: false },
  { actorId: "a4", name: "Борислава", enabled: true },
];

const msg = (over) => ({ id: "x", speaker: "Мастер", text: "текст", whispered: false, blind: false, audience: null, kind: null, ...over });

test("кто в сцене: включённые, привязанные, по списку", () => {
  assert.deepEqual(activeParticipants(agents, { all: true }).map((a) => a.actorId), ["a1", "a2", "a4"]);
  assert.deepEqual(activeParticipants(agents, { all: false, ids: ["a2", "a3"] }).map((a) => a.actorId), ["a2"]);
  assert.deepEqual(currentAudience(agents, { all: false, ids: ["a4", "a1"] }), ["a1", "a4"]);
  assert.deepEqual(activeParticipants(agents, null).length, 3, "по умолчанию — все");
});

test("видимость: шёпот, слепые броски, служебное, чужая сцена", () => {
  assert.equal(isVisibleTo(msg(), "a1"), true, "без метки — видно всем");
  assert.equal(isVisibleTo(msg({ whispered: true }), "a1"), false);
  assert.equal(isVisibleTo(msg({ blind: true }), "a1"), false);
  for (const kind of ["thought", "secret", "indicator", "card", "system"]) {
    assert.equal(isVisibleTo(msg({ kind }), "a1"), false, kind);
  }
  assert.equal(isVisibleTo(msg({ kind: "agent" }), "a1"), true, "реплики агентов публичны");
  assert.equal(isVisibleTo(msg({ audience: ["a2"] }), "a1"), false);
  assert.equal(isVisibleTo(msg({ audience: ["a1", "a2"] }), "a1"), true);
  assert.equal(isVisibleTo(msg({ text: "   " }), "a1"), false);
});

test("расшифровка: последние N видимых, «Имя: текст»", () => {
  const list = [];
  for (let i = 0; i < 10; i++) list.push(msg({ speaker: i % 2 ? "Вера" : "Мастер", text: `строка ${i}` }));
  list.push(msg({ speaker: "Мастер", text: "секретно", whispered: true }));
  list.push(msg({ speaker: "Мастер", text: "[бросок 2d6 = 8]" }));
  const t = transcriptFor(list, "a1", 3).split("\n");
  assert.deepEqual(t, ["Мастер: строка 8", "Вера: строка 9", "Мастер: [бросок 2d6 = 8]"], "броски видны как обычные сообщения");
  assert.doesNotMatch(publicTranscript(list), /секретно/);
});

test("заметки: секреты добавляются и форматируются", () => {
  let notes = addNote(undefined, "Знает код от сейфа: 4471", 1);
  notes = addNote(notes, "  ", 2);
  notes = addNote(notes, "Должен денег Хендриксу", 3);
  assert.equal(notes.length, 2);
  assert.equal(formatNotes(notes), "- Знает код от сейфа: 4471\n- Должен денег Хендриксу");
});

test("поиск агента по имени", () => {
  assert.equal(findAgentByName(agents, "вера").actorId, "a1");
  assert.equal(findAgentByName(agents, "Борис").actorId, "a2", "точное совпадение важнее префикса");
  assert.equal(findAgentByName(agents, "Бор"), null, "неоднозначный префикс");
  assert.equal(findAgentByName(agents, "Борисл").actorId, "a4");
  const r = resolveAgentNames(agents, "Вера, Сайрус; Никто");
  assert.deepEqual(r.found.map((a) => a.actorId), ["a1", "a3"]);
  assert.deepEqual(r.missing, ["Никто"]);
});

test("HTML ↔ текст", () => {
  assert.equal(htmlToText("<p>Привет, <b>мир</b>&nbsp;&amp; всё</p><p>Вторая</p>"), "Привет, мир & всё\nВторая");
  assert.equal(htmlToText("<div class='dice'>2D6 <span>= 9</span></div>"), "2D6 = 9");
  assert.equal(escapeHtml(`<img src=x onerror="alert(1)">`), "&lt;img src=x onerror=&quot;alert(1)&quot;&gt;");
});
