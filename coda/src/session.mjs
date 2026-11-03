import { randomUUID } from "node:crypto";
import { Journal } from "../../runtime/journal.mjs";

export class Session {
  constructor(file) {
    this.log = new Journal(file);
    this.head = this.log.read().at(-1)?.id ?? null;
  }
  append(message, parent = this.head) {
    const rows = this.log.read();
    if (parent && !rows.some((row) => row.id === parent))
      throw Error("missing parent");
    const row = { id: randomUUID(), parent, message: structuredClone(message) };
    this.log.append(row);
    this.head = row.id;
    return row.id;
  }
  branch(id) {
    if (!this.log.read().some((row) => row.id === id))
      throw Error("unknown branch");
    this.head = id;
  }
  history(id = this.head) {
    const byId = new Map(this.log.read().map((row) => [row.id, row]));
    const result = [],
      seen = new Set();
    while (id) {
      if (seen.has(id) || !byId.has(id)) throw Error("broken session ancestry");
      seen.add(id);
      const row = byId.get(id);
      result.unshift(row.message);
      id = row.parent;
    }
    return result;
  }
}
export function projectHistory(history) {
  const output = [];
  for (let i = 0; i < history.length; i++) {
    const message = structuredClone(history[i]);
    if (message.role === "tool") continue; // Orphan results are excluded from this view.
    output.push(message);
    if (message.role !== "assistant" || !message.calls?.length) continue;
    const following = [];
    while (history[i + 1]?.role === "tool") following.push(history[++i]);
    for (const call of message.calls)
      output.push(
        structuredClone(
          following.find((r) => r.id === call.id) ?? {
            role: "tool",
            id: call.id,
            error: true,
            text: "Interrupted before result was recorded.",
          },
        ),
      );
  }
  return output;
}
