// 第 3 章：文件工具，以及“先读后改”。
//
// 对应 Claude Code 2.1.88：
//   tools/FileReadTool/FileReadTool.ts    读文件，并把“模型看到的是哪个版本”记下来（readFileState）
//   tools/FileEditTool/FileEditTool.ts    validateInput：读过吗？读过以后文件变了吗？old 在文件里唯一吗？
//   tools/FileWriteTool/FileWriteTool.ts  覆盖已有文件同样要求先读；新建文件不用
//   utils/fileStateCache.ts               readFileState 本身：路径 → 内容、修改时间、offset、limit
//
// 和原版相比的简化：
//   · 用内容哈希判断“文件变没变”。原版先比修改时间，只有“完整读取过”时才拿内容兜底，
//     避免云同步、杀毒软件碰一下时间戳就误报“文件被改了”；
//   · readState 属于一次 codingTools() 调用（原版挂在 ToolUseContext 上，子 Agent 拿到的是拷贝）；
//   · Read 不加行号；Edit 没有 replace_all，也不做弯引号的模糊匹配。
import { existsSync } from "node:fs";
import {
  workspacePath,
  atomicWrite,
  fileVersion,
} from "../../runtime/files.mjs";
import { runSandboxed } from "../../runtime/sandbox.mjs";
import { runProcess } from "../../runtime/process.mjs";

// 单次 Read 最多返回这么多字符。超过不是悄悄截断，而是报错并告诉模型怎么办：
// 原版试过截断，发现平均 token 反而变多了，又改了回来（FileReadTool/limits.ts 顶部的注释）。
const READ_MAX_CHARS = 50_000;

const countMatches = (text, part) => text.split(part).length - 1;

// 取 offset 行（从 1 开始）起的 limit 行；都不给就是整个文件。
function sliceLines(text, { offset = 1, limit }) {
  if (offset === 1 && limit === undefined) return { text, partial: false };
  const lines = text.split("\n");
  const end = limit === undefined ? lines.length : offset - 1 + limit;
  const picked = lines.slice(offset - 1, end);
  return { text: picked.join("\n"), partial: picked.length < lines.length };
}

export function codingTools(root, { sandbox = false } = {}) {
  // 模型最后一次“看到”每个文件时的版本：物理路径 → { hash, partial }。
  // Read 写入，Edit / Write 写完以后也写入（所以自己改完的文件不用重读）。
  const readState = new Map();
  const remember = (file, version = fileVersion(file), partial = false) =>
    readState.set(file, { hash: version.hash, partial });

  const shape = (properties, required = Object.keys(properties)) => ({
    type: "object",
    properties,
    required,
  });
  // validate 必须没有副作用：Toolset 分批时也会调用它，来判断“这个输入能不能解析”。
  const pathInput = (input) => {
    if (typeof input.path !== "string") throw Error("path must be string");
    workspacePath(root, input.path);
  };

  // 修改一个已有文件之前的版本检查：Edit 和 Write 共用。
  // 它会被调用两次：校验时一次（Hook 和权限询问之前），写入前一次。
  // 两次之间可能隔着几分钟——用户在权限弹窗前想了很久，期间 linter 可能已经改过这个文件。
  // 只读过一部分（offset / limit）也算读过：和原版一致，原版只有“自动注入、模型没看全”的文件才要求重读。
  function assertFresh(file) {
    const seen = readState.get(file);
    if (!seen) throw Error("file has not been read yet; Read it first");
    if (seen.hash !== fileVersion(file).hash)
      throw Error("file changed since it was read; Read it again");
  }

  // Edit 的全部前置条件。返回当前文件内容，供 execute 直接使用。
  function checkEdit(input) {
    pathInput(input);
    if (
      typeof input.old !== "string" ||
      !input.old ||
      typeof input.next !== "string"
    )
      throw Error("invalid edit strings");
    if (input.old === input.next)
      throw Error("old and next are identical; nothing to change");
    const file = workspacePath(root, input.path);
    if (!existsSync(file)) throw Error(`${input.path} does not exist`);
    assertFresh(file); //                                   ① 读过吗？读过以后变了吗？
    const { text } = fileVersion(file);
    const matches = countMatches(text, input.old); //        ② old 在文件里出现几次？
    if (matches === 0) throw Error("old text not found in file");
    if (matches > 1)
      throw Error(
        `old text appears ${matches} times; include more surrounding text so it matches once`,
      );
    return { file, text };
  }

  return [
    {
      name: "Read",
      description: "Read a workspace file; offset/limit select a line range",
      readOnly: true,
      parallel: true,
      maxResultChars: Infinity, // 自己限长：落盘再让模型 Read 回来，会绕成一个圈
      schema: shape(
        {
          path: { type: "string" },
          offset: { type: "integer" },
          limit: { type: "integer" },
        },
        ["path"],
      ),
      validate: pathInput,
      execute: (input) => {
        const file = workspacePath(root, input.path);
        if (!existsSync(file)) throw Error(`${input.path} does not exist`);
        const version = fileVersion(file);
        const { text, partial } = sliceLines(version.text, input);
        if (text.length > READ_MAX_CHARS)
          throw Error(
            `${text.length} characters is over the ${READ_MAX_CHARS} limit; pass offset and limit to read a range`,
          );
        remember(file, version, partial);
        return { text, details: { hash: version.hash, partial } };
      },
    },
    {
      name: "Edit",
      description: "Replace one unique string in a file you have Read",
      schema: shape({
        path: { type: "string" },
        old: { type: "string" },
        next: { type: "string" },
      }),
      validate: (input) => void checkEdit(input),
      execute: (input) => {
        const { file, text } = checkEdit(input); // 写之前再核对一次
        // 用函数给出替换值：直接传字符串的话，next 里的 $& 之类会被当成特殊写法展开
        const updated = text.replace(input.old, () => input.next);
        atomicWrite(file, updated);
        remember(file); // 刚写下的就是模型“知道”的版本，下一次编辑不用重读
        return { text: "edited", details: { before: text, after: updated } };
      },
    },
    {
      name: "Write",
      description:
        "Write a workspace file (overwriting an existing file requires Read first)",
      schema: shape({ path: { type: "string" }, text: { type: "string" } }),
      validate: (input) => {
        pathInput(input);
        if (typeof input.text !== "string") throw Error("text must be string");
        const file = workspacePath(root, input.path);
        if (existsSync(file)) assertFresh(file); // 新建文件不需要读过
      },
      execute: (input) => {
        const file = workspacePath(root, input.path);
        if (existsSync(file)) assertFresh(file);
        atomicWrite(file, input.text);
        remember(file);
        return { text: "written" };
      },
    },
    {
      name: "Test",
      description: "Run the fixture test using Node argv, without a shell",
      schema: shape({ path: { type: "string" } }),
      validate: pathInput,
      execute: async (input, { signal }) => {
        const result = sandbox
          ? await runSandboxed(
              root,
              process.execPath,
              [workspacePath(root, input.path)],
              { signal },
            )
          : await runProcess(
              process.execPath,
              [workspacePath(root, input.path)],
              { cwd: root, signal },
            );
        return {
          text: result.stdout + result.stderr,
          error: result.code !== 0,
          details: result,
        };
      },
    },
  ];
}
