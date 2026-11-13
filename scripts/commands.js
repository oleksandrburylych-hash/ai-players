/**
 * commands.js — разбор команд мастера `/ai …` (чистый модуль, тестируется в Node).
 */

export const COMMANDS = ["go", "stop", "next", "in", "tell", "recap", "status", "help"];

/**
 * Разобрать текст сообщения. Если это не команда /ai — вернуть null.
 * Иначе { cmd, args, error? }.
 */
export function parseAiCommand(raw) {
  const text = String(raw ?? "").trim();
  const m = text.match(/^\/ai(?:\s+([\s\S]*))?$/i);
  if (!m) return null;
  const rest = (m[1] || "").trim();
  if (!rest) return { cmd: "help", args: {} };

  const sp = rest.search(/\s/);
  const word = (sp === -1 ? rest : rest.slice(0, sp)).toLowerCase();
  const tail = sp === -1 ? "" : rest.slice(sp + 1).trim();

  switch (word) {
    case "go":
    case "stop":
    case "recap":
    case "status":
    case "help":
      return { cmd: word, args: {} };
    case "next":
      if (!tail) return { cmd: "next", args: {}, error: "Укажите имя: /ai next Имя" };
      return { cmd: "next", args: { name: tail } };
    case "in":
      if (!tail) return { cmd: "in", args: {}, error: "Укажите имена через запятую или all: /ai in Имя, Имя" };
      if (/^(all|все|всех)$/i.test(tail)) return { cmd: "in", args: { all: true } };
      return { cmd: "in", args: { names: tail } };
    case "tell": {
      const i = tail.indexOf(":");
      if (i <= 0) return { cmd: "tell", args: {}, error: "Формат: /ai tell Имя: текст" };
      const name = tail.slice(0, i).trim();
      const message = tail.slice(i + 1).trim();
      if (!name || !message) return { cmd: "tell", args: {}, error: "Формат: /ai tell Имя: текст" };
      return { cmd: "tell", args: { name, text: message } };
    }
    default:
      return { cmd: "unknown", args: { word }, error: `Неизвестная команда «${word}». Наберите /ai help.` };
  }
}

export const HELP_TEXT = [
  "/ai go — запустить цикл по последней сцене",
  "/ai stop — остановить текущий цикл",
  "/ai next Имя — дать слово одному агенту вне очереди",
  "/ai in Имя, Имя — кто сейчас в сцене; /ai in all — все",
  "/ai tell Имя: текст — секрет для одного персонажа",
  "/ai recap — сжать события сессии в хронику",
  "/ai status — запросы, токены, кто в сцене, модель",
];
