import { projectHistory } from "./session.mjs";
export const estimate = (messages) =>
  Math.ceil(JSON.stringify(messages).length / 4);
export function threshold(window, buffer, percent) {
  const normal = Math.max(0, window - buffer),
    p = parseFloat(percent);
  return p > 0 && p <= 100
    ? Math.min(normal, Math.floor((window * p) / 100))
    : normal;
}
export class Compactor {
  constructor({
    window = 2000,
    buffer = 200,
    summarize,
    maxFailures = 2,
  } = {}) {
    Object.assign(this, { window, buffer, summarize, maxFailures });
    this.failures = 0;
  }
  async compact(
    history,
    { force = false, percent, attachments = [], hookResults = [] } = {},
  ) {
    if (this.failures >= this.maxFailures)
      return { changed: false, reason: "circuit-open", messages: history };
    if (
      !force &&
      estimate(history) < threshold(this.window, this.buffer, percent)
    )
      return { changed: false, reason: "below-threshold", messages: history };
    const projected = projectHistory(history);
    let pivot = projected.length - 1;
    while (pivot > 0 && projected[pivot].role !== "user") pivot--;
    if (pivot === 0)
      return { changed: false, reason: "one-atomic-group", messages: history };
    try {
      const summary = await this.summarize(projected.slice(0, pivot));
      if (typeof summary !== "string" || !summary.trim())
        throw Error("empty summary");
      this.failures = 0;
      return {
        changed: true,
        messages: [
          { role: "user", text: `[compact boundary]\n${summary}` },
          ...projected.slice(pivot),
          ...attachments,
          ...hookResults,
        ],
      };
    } catch (error) {
      this.failures++;
      return { changed: false, reason: "summary-failed", messages: history };
    }
  }
}
