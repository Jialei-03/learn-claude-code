// 第 13 章：把整段旅程做成可以逐步点击的回放（网站构建时调用）。
//   node labs/ch13/trace.mjs
// 每个请求显示模型这一次真正收到的全部消息；点“下一步”可以看到：谁发了请求、模型要求了什么、
// 每个工具调用被哪一关放行或拦下、结果怎样回到对话里。
import { mkdtempSync, mkdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describeCall, describeResult, runJourney, shorten, STEPS } from "./journey.mjs";

const ROOT = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const temp = realpathSync(mkdtempSync(join(tmpdir(), "coda-trace-")));
const root = join(temp, "project");
mkdirSync(root);

let result;
try {
  result = await runJourney(root, { fixture: join(ROOT, "labs/fixtures/mcp-server.mjs") });
} finally {
  // 回放数据在内存里，临时项目不用留
}

const clean = (text) => String(text).split(root).join("<项目>");
const cap = (text, n = 1600) => (text.length > n ? `${text.slice(0, n)}…（共 ${text.length} 字符）` : text);
const esc = (text) => String(text).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]);

// 内部消息 → 回放器认识的形状。meta 消息（不是用户敲的）显示成 system
function show(messages) {
  const names = new Map(messages.flatMap((m) => (m.calls ?? []).map((c) => [c.id, c.name])));
  return messages.map((m) => {
    if (m.role === "assistant") return { role: "assistant", text: cap(clean(m.text ?? "")), calls: (m.calls ?? []).map((c) => ({ name: c.name, args: c.input })) };
    if (m.role === "tool") return { role: "toolResult", name: names.get(m.id), text: cap(clean(m.text)), error: m.error };
    return { role: m.meta ? "system" : "user", text: cap(clean(m.text)) };
  });
}

const steps = [];
function replay(run, label, notes) {
  const gate = (id) => result.decisions.find((d) => d.id === id);
  let shown = [];
  let seen = 0;
  let index = 0;
  const callById = new Map();
  for (const frame of run.frames) {
    if (frame.type === "request") {
      index++;
      shown = show(frame.wire.messages);
      const reason = frame.transition.reason;
      steps.push({
        kind: "request",
        label: `${label}第 ${index} 次请求`,
        messages: shown,
        fresh: shown.map((_, i) => i).filter((i) => i >= seen),
        explain:
          reason === "initial"
            ? "请求从这里开始。<b>system</b> 里只有稳定的默认提示；CLAUDE.md、日期、Skill 目录是前面两条 meta 消息；工具按名字排序，MCP 排在最后。"
            : reason === "stop_hook_blocking"
              ? "Stop Hook 拦下了收工：它的反馈作为新消息追加在末尾，循环再来一圈。"
              : "上一圈的工具结果已经放回对话（高亮的是新增的消息），循环带着完整上下文再请求一次。",
      });
      seen = shown.length;
    }
    if (frame.type === "assistant") {
      const m = frame.message;
      m.calls.forEach((c) => callById.set(c.id, c));
      shown = [...shown, ...show([m])];
      steps.push({
        kind: "response",
        label: m.calls.length ? m.calls.map(describeCall).join(" + ") : "模型给出文字",
        messages: [...shown],
        fresh: [shown.length - 1],
        explain: esc(notes?.[index - 1] ?? ""),
      });
    }
    if (frame.type === "tool_result") {
      const m = frame.message;
      const call = callById.get(m.id);
      const decision = gate(m.id);
      shown = [...shown, ...show([{ ...m }]).map((x) => ({ ...x, name: call?.name }))];
      steps.push({
        kind: "tool",
        label: `${m.error ? "✗ " : ""}${call?.name ?? "工具"}`,
        messages: [...shown],
        fresh: [shown.length - 1],
        explain: `<b>${esc(call ? describeCall(call) : m.id)}</b> → ${esc(describeResult(call, m, root))}。${decision ? `权限一关：<code>${decision.behavior}/${decision.source}</code>。` : "没有走到权限这一关（校验或 Hook 已经拦下）。"}`,
      });
    }
    if (frame.type === "terminal") {
      steps.push({ kind: "end", label: "运行结束", messages: [...shown], fresh: [], explain: `终态 <b>${esc(frame.reason)}</b>。` + (label ? "" : "对话已经写进会话文件。") });
    }
  }
}

replay(result.run1, "", STEPS.map((s) => s.note));
steps.push({
  kind: "end",
  label: "关闭，重新打开",
  messages: [],
  fresh: [],
  explain: "<code>app.close()</code> 关掉了 MCP 服务器进程。接下来是一个全新的 app，只拿到同一个会话文件的路径。",
});
replay(result.run2, "重开后·", ["重开后先跑 Test：Skill 的授权只管上一次运行，这次要重新问用户。", "没有工具调用，运行结束。"]);

rmSync(temp, { recursive: true, force: true });
process.stdout.write(JSON.stringify({ title: "回放：修复 slug()", subtitle: "coda/src/app.mjs · 脚本模型，其余全是真实运行的", steps }) + "\n");
