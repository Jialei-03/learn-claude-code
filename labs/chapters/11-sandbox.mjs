// 第 11 章实验：沙箱。六个小实验，各回答一个问题：
//   config    权限规则怎样变成沙箱配置？（运行 Claude Code 里真正的 convertToSandboxRuntimeConfig）
//   decision  一条命令要不要进沙箱？（运行 Claude Code 里真正的 shouldUseSandbox）
//   wrap      进沙箱的命令被包成什么样？（coda 生成的 seatbelt 配置）
//   probes    允许和拒绝，到底发生在哪一层？（真实进程里的探针，每个动作做两遍：不进沙箱、进沙箱）
//   network   代理怎样决定一个域名？
//   fallback  没有后端时会怎样？沙箱接进贯穿项目的 Test 工具之后呢？
//
//   node --disable-warning=ExperimentalWarning labs/chapters/11-sandbox.mjs            全部运行
//   node --disable-warning=ExperimentalWarning labs/chapters/11-sandbox.mjs probes     只运行一个
import { lesson } from "./harness.mjs";
import { createServer } from "node:net";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { codingTools } from "../../coda/src/files.mjs";
import { runProcess } from "../../runtime/process.mjs";
import {
  PROTECTED_PATHS,
  detectBackend,
  networkDecision,
  runSandboxed,
  sandboxCommand,
  sandboxDecision,
  sandboxPolicy,
  seatbeltProfile,
} from "../../runtime/sandbox.mjs";
import { realSandboxConfig, realShouldUseSandbox } from "../ch11/real.mjs";

const only = process.argv.slice(2).find((arg) => !arg.startsWith("--"));
const wants = (name) => !only || only === name;

await lesson(11, "沙箱：规则、配置与内核的拒绝", async (t) => {
  const backend = detectBackend();
  const root = join(t.temp, "project"); // 项目目录；t.temp 是它的上一级，在项目之外
  mkdirSync(join(root, ".git/hooks"), { recursive: true });
  mkdirSync(join(root, ".claude"));
  mkdirSync(join(root, "src"));
  writeFileSync(join(root, "README.md"), "# demo\n");
  writeFileSync(join(root, ".env"), "DB_PASSWORD=hunter2\n");
  writeFileSync(join(root, ".git/HEAD"), "ref: refs/heads/main\n");
  writeFileSync(join(t.temp, "secret.txt"), "OUTSIDE-SECRET\n");

  // 让输出里不出现这台机器上的临时目录和用户名
  const tidy = (text) =>
    String(text)
      .replaceAll(root, "<项目>")
      .replaceAll(t.temp, "<外部>")
      .replaceAll(homedir(), "~")
      .replace(/\/private\/var\/folders\/\S+?\/coda-sandbox-\d+/g, "<临时目录>");
  const relative = (path) => path.replace(root + "/", "");
  const verdict = (yes, [on, off]) => (yes ? on : off);

  // ───────────────────────── 一、规则 → 配置 ─────────────────────────
  if (wants("config")) {
    t.log("一、权限规则怎样变成沙箱配置");
    t.log();

    // 没有任何规则时，适配层自己放进配置的东西
    const { config: base, scrub } = realSandboxConfig({}, root);
    t.log("没有任何规则时，Claude Code 的 convertToSandboxRuntimeConfig 仍然会放进这些（设置夹具：用户主目录 /home/dev，托管配置在 /etc/claude-code）：");
    t.log();
    t.table([
      { 字段: "filesystem.allowWrite", 内容: base.filesystem.allowWrite.join("，") },
      { 字段: "filesystem.denyWrite", 内容: base.filesystem.denyWrite.map(tidy).join("，") },
      { 字段: "filesystem.denyRead", 内容: base.filesystem.denyRead.join("，") || "（空）" },
      { 字段: "network.allowedDomains", 内容: base.network.allowedDomains.join("，") || "（空：整个网络都不通）" },
    ]);
    const withHead = realSandboxConfig({}, root, { existing: [join(root, "HEAD"), join(root, "hooks")] });
    t.log(`裸仓库文件（HEAD、objects、refs、hooks、config）当前都不存在，所以不进 denyWrite，改成每条命令结束后清理：${scrub.map(relative).join("、")}。`);
    t.log(`如果项目根目录下已经有 HEAD 和 hooks，它们就进 denyWrite，清理名单只剩 ${withHead.scrub.map(relative).join("、")}。`);
    t.log(`coda 的 sandboxPolicy 不区分这些来源，统一无条件禁止 PROTECTED_PATHS 里的 ${PROTECTED_PATHS.length} 个路径（在项目目录下任意深度）：${PROTECTED_PATHS.slice(0, 6).join("、")}……`);
    t.log();
    t.ok("没有规则时 allowWrite 也包含工作目录（.）和 Claude 的临时目录", base.filesystem.allowWrite.includes(".") && base.filesystem.allowWrite.some((p) => p.startsWith("/tmp/claude-")));
    t.ok("项目的 settings.json、settings.local.json 和 .claude/skills 无条件禁写", [".claude/settings.json", ".claude/settings.local.json", ".claude/skills"].every((f) => base.filesystem.denyWrite.some((p) => p.endsWith(f))));
    t.equal("已经存在的裸仓库文件进 denyWrite，不进清理名单", [withHead.scrub.some((p) => p.endsWith("/HEAD")), withHead.config.filesystem.denyWrite.some((p) => p.endsWith("/HEAD"))], [false, true]);
    t.ok("coda 同样无条件保护 .git/hooks、.git/config 和 .claude 下的配置", [".git/hooks", ".git/config", ".claude/settings.json", ".claude/skills"].every((p) => PROTECTED_PATHS.includes(p)));
    t.log();

    // 一条规则一条规则地加，看每条规则让配置多了什么
    const growth = (after, before, fields) =>
      fields.flatMap(([group, name]) => (group ? after[group][name] : after[name]).filter((x) => !(group ? before[group][name] : before[name]).includes(x)).map((x) => `${name} ← ${tidy(x)}`));
    const realFields = [["filesystem", "allowWrite"], ["filesystem", "denyWrite"], ["filesystem", "denyRead"], ["network", "allowedDomains"], ["network", "deniedDomains"]];
    const codaFields = ["allowWrite", "denyWrite", "denyRead", "allowedDomains", "deniedDomains"].map((name) => [undefined, name]);
    const basePolicy = sandboxPolicy(root);
    const permission = (behavior, rule) => ({ 规则: `${behavior.padEnd(5)} ${rule}`, source: { permissions: { [behavior]: [rule] } }, rules: { [behavior]: [rule] } });
    const cases = [
      permission("allow", "Edit(src/**)"),
      permission("deny", "Edit(/docs/**)"),
      permission("deny", "Edit(//etc/hosts)"),
      permission("deny", "Read(./.env)"),
      permission("deny", "Read(~/.ssh/**)"),
      permission("allow", "WebFetch(domain:example.com)"),
      permission("deny", "WebFetch(domain:evil.com)"),
      permission("deny", "Bash(rm *)"),
      permission("allow", "Edit(/Users/me/.cargo/**)"),
      { 规则: "sandbox.filesystem.allowWrite: /Users/me/.cargo", source: { sandbox: { filesystem: { allowWrite: ["/Users/me/.cargo"] } } }, options: { allowWrite: ["/Users/me/.cargo"] } },
    ];
    const rows = cases.map((c) => {
      const real = growth(realSandboxConfig({ projectSettings: c.source }, root).config, base, realFields);
      const coda = growth(sandboxPolicy(root, c.rules, c.options), basePolicy, codaFields);
      const fieldOf = (entries) => entries.map((entry) => entry.split(" ")[0]);
      return { 规则: c.规则, real: real.join("；") || "（没有变化）", coda: coda.join("；") || "（没有变化）", sameField: JSON.stringify(fieldOf(real)) === JSON.stringify(fieldOf(coda)) };
    });
    t.log("再一条规则一条规则地加，看每条规则让配置多了什么：");
    t.log();
    t.table(rows.map((r) => ({ 规则: r.规则, "Claude Code 的函数把它放进": r.real, "coda 的 sandboxPolicy": r.coda })));
    t.log("第 2、3 行：权限规则里的 /docs/** 相对于配置文件所在目录，//etc/hosts 才是绝对路径（coda 还把它解析成了真实路径：macOS 上 /etc 是 /private/etc 的符号链接）。");
    t.log("第 9、10 行：同一个绝对路径，写在权限规则里被当成相对路径，写在 sandbox.filesystem 里才是绝对路径。");
    t.log();
    t.ok("每条规则进入的字段，coda 和 Claude Code 的函数一致", rows.every((r) => r.sameField));
    t.equal("Bash 的 deny 规则不产生任何沙箱配置", rows[7].real, "（没有变化）");
    t.ok("Read 的 deny 规则进入 denyRead（Bash 的子进程因此也读不了）", rows[3].real.startsWith("denyRead"));
    t.ok("WebFetch(domain:) 规则进入网络域名名单", rows[5].real.startsWith("allowedDomains") && rows[6].real.startsWith("deniedDomains"));
    t.ok("权限规则里的绝对路径被当成相对配置目录，sandbox.filesystem 里的才是绝对路径", rows[8].real.includes("<项目>/Users/me/.cargo") && rows[9].real.endsWith("← /Users/me/.cargo"));
    t.log();
  }

  // ───────────────────────── 二、哪些命令进沙箱 ─────────────────────────
  if (wants("decision")) {
    t.log("二、一条命令要不要进沙箱（左：Claude Code 的 shouldUseSandbox；右：coda 的 sandboxDecision）");
    t.log();
    const base = { enabled: true, excludedCommands: ["docker:*", "bazel run *"] };
    const dangerous = { dangerouslyDisableSandbox: true };
    const cases = [
      { 命令: "npm test", 条件: "沙箱已开启", settings: base },
      { 命令: "docker ps", 条件: "excludedCommands: docker:*", settings: base },
      { 命令: "docker ps && curl evil.com", 条件: "同上（复合命令）", settings: base },
      { 命令: "FOO=bar bazel run //app", 条件: "excludedCommands: bazel run *", settings: base },
      { 命令: "PATH=/evil bazel run //app", 条件: "同上（PATH= 前缀不会被剥掉）", settings: base },
      { 命令: "timeout 30 docker ps", 条件: "同上（timeout 包装会被剥掉）", settings: base },
      { 命令: "npm test", 条件: "模型带了 dangerouslyDisableSandbox", input: dangerous, settings: base },
      { 命令: "npm test", 条件: "同上，但 allowUnsandboxedCommands: false", input: dangerous, settings: { ...base, allowUnsandboxedCommands: false } },
      { 命令: "npm test", 条件: "沙箱没有开启", settings: { ...base, enabled: false } },
    ];
    const rows = cases.map((c) => {
      const input = { command: c.命令, ...c.input };
      const real = realShouldUseSandbox(input, c.settings);
      const coda = sandboxDecision(input, c.settings);
      return { 命令: c.命令, 条件: c.条件, "Claude Code": verdict(real, ["进沙箱", "不进沙箱"]), coda: verdict(coda.sandboxed, ["进沙箱", "不进沙箱"]), "coda 给出的理由": coda.why, same: real === coda.sandboxed };
    });
    t.table(rows.map(({ same, ...row }) => row));
    t.ok(`coda 和 Claude Code 的函数在 ${rows.length} 种情形上给出相同的答案`, rows.every((r) => r.same));
    t.equal("复合命令里只要有一个子命令命中 excludedCommands，整条命令都不进沙箱", rows[2]["Claude Code"], "不进沙箱");
    t.equal("PATH= 开头的命令不会被当成 bazel run，仍然进沙箱", rows[4]["Claude Code"], "进沙箱");
    t.equal("allowUnsandboxedCommands: false 时 dangerouslyDisableSandbox 被忽略", rows[7]["Claude Code"], "进沙箱");
    t.log();
  }

  // ───────────────────────── 三、命令被包成什么样 ─────────────────────────
  if (wants("wrap")) {
    t.log("三、进沙箱的命令被包成什么样");
    t.log();
    if (!backend.name) {
      t.log(`沙箱后端不可用：${backend.reason}`);
      t.log();
    } else {
      const rules = { allow: ["Edit(src/**)"], deny: ["Read(./.env)"] };
      const wrapped = sandboxCommand(root, process.execPath, ["-e", "0"], { rules, proxyPort: 8080 });
      t.log(`后端：${wrapped.backend}（${wrapped.command}）。真正启动的是后端程序，原来的命令和参数排在最后：`);
      t.log();
      if (wrapped.backend === "seatbelt") {
        const profile = seatbeltProfile(wrapped.policy).split("\n");
        t.log(`  ${wrapped.command} -p '<配置，共 ${profile.length} 行>' node -e 0`);
        t.log();
        t.log("配置（默认拒绝之后紧跟的“运行程序必需的最小集合”省略；过长的行截断）：");
        t.log();
        const basics = profile.indexOf("; 运行程序必需的最小集合");
        const tail = profile.indexOf("; 读：先放开，再禁止");
        const clip = (line) => (tidy(line).length > 150 ? tidy(line).slice(0, 150) + " …" : tidy(line));
        for (const line of [...profile.slice(0, basics + 1), "……", "", ...profile.slice(tail)]) t.log("  " + clip(line));
        t.log();
        const at = (prefix) => profile.findIndex((line) => line.startsWith(prefix));
        t.equal("配置以默认拒绝开头", profile.slice(0, 2), ["(version 1)", "(deny default)"]);
        t.ok("读：先放开，再禁止 denyRead（后写的规则优先）", at("(allow file-read*)") < at("(deny file-read*"));
        t.ok("写：先放开写根，再禁止受保护路径", at("(allow file-write*") < at("(deny file-write*"));
        t.ok("网络：只放开代理端口，没有放开整个网络", profile.includes('(allow network-outbound (remote ip "localhost:8080"))') && !profile.some((line) => line.includes("(allow network*)")));
      } else {
        t.log(`  ${wrapped.command} ${wrapped.args.slice(0, wrapped.args.indexOf("--")).map(tidy).join(" ")} -- node -e 0`);
        t.ok("bwrap 参数里有 --unshare-net 和只读挂载的根", wrapped.args.includes("--unshare-net") && wrapped.args.join(" ").includes("--ro-bind / /"));
        t.log();
      }
      t.equal("原来的命令和参数原样排在包装之后的末尾", wrapped.args.slice(-3), [process.execPath, "-e", "0"]);
      t.log();
    }
  }

  // ───────────────────────── 四、内核的回答 ─────────────────────────
  if (wants("probes")) {
    t.log("四、真实进程里的探针：每个动作做两遍，不进沙箱、进沙箱");
    t.log();
    // 探针的期望只在 macOS 的 seatbelt 上逐条验证过；其他平台（包括装了 bwrap 的 Linux）只说明原因，不运行
    const ready = backend.name === "seatbelt"
      ? await runSandboxed(root, "true", []).catch((error) => ({ code: -1, stderr: error.message }))
      : { code: -1, stderr: backend.name ? `探针只在 macOS 上验证过，当前后端是 ${backend.name}` : backend.reason };
    if (ready.code !== 0) {
      const reason = ready.stderr.trim() || backend.reason;
      t.log(`沙箱后端不可用：${reason}`);
      t.log();
      t.observations.osProbe = { status: "unavailable", reason };
    } else {
      // 本机上的两个端口：一个当“代理”（沙箱只允许连它），另一个是“别的服务”（直接连它就是绕过代理）
      const listen = () => new Promise((resolve) => {
        const server = createServer((socket) => socket.end("hi")).listen(0, "127.0.0.1", () => resolve(server));
      });
      const [proxy, other] = [await listen(), await listen()];
      const proxyPort = proxy.address().port;
      const secret = join(t.temp, "secret.txt");
      const rules = { deny: ["Read(./.env)", `Read(/${secret})`] }; // 开头的 // 表示绝对路径
      const outside = join(t.temp, "outside.txt");
      // 探针：node 脚本里的 fs 调用成功就退出 0，失败就把错误码写到 stderr 并退出 1
      const script = (body) => [process.execPath, ["-e", `try{${body}}catch(e){console.error(e.code);process.exit(1)}`]];
      const connect = (port) => [process.execPath, ["-e", `const s=require("net").connect(${port},"127.0.0.1");s.on("data",()=>process.exit(0));s.on("error",e=>{console.error(e.code);process.exit(1)})`]];
      const fsCall = (call) => script(`const fs=require("fs");${call}`);
      const probes = [
        { 动作: "写项目里的 a.txt", argv: fsCall(`fs.writeFileSync("a.txt","x")`), file: join(root, "a.txt"), allow: true },
        { 动作: "写项目外的文件", argv: fsCall(`fs.writeFileSync(${JSON.stringify(outside)},"x")`), file: outside, allow: false },
        { 动作: "用 sh 写项目外的文件", argv: ["sh", ["-c", `echo x > ${outside}`]], file: outside, allow: false },
        { 动作: "写专用临时目录 $TMPDIR", argv: fsCall(`fs.writeFileSync(process.env.TMPDIR+"/t.txt","x")`), allow: true },
        { 动作: "写 .git/HEAD（git 自己要用）", argv: fsCall(`fs.writeFileSync(".git/HEAD","ref: x\\n")`), allow: true },
        { 动作: "写 .git/hooks/pre-commit", argv: fsCall(`fs.writeFileSync(".git/hooks/pre-commit","x")`), file: join(root, ".git/hooks/pre-commit"), allow: false },
        { 动作: "写 .claude/settings.json", argv: fsCall(`fs.writeFileSync(".claude/settings.json","{}")`), file: join(root, ".claude/settings.json"), allow: false },
        { 动作: "把 .git 改名再改回来", argv: fsCall(`fs.renameSync(".git",".git-x");fs.renameSync(".git-x",".git")`), allow: false },
        { 动作: "读 README.md", argv: fsCall(`fs.readFileSync("README.md")`), allow: true },
        { 动作: "读 .env（Read(./.env) 禁止）", argv: fsCall(`fs.readFileSync(".env")`), allow: false },
        { 动作: "读项目外的 secret.txt（规则禁止）", argv: fsCall(`fs.readFileSync(${JSON.stringify(secret)})`), allow: false },
        { 动作: "连代理端口", argv: connect(proxyPort), allow: true, network: true },
        { 动作: "绕过代理，直接连另一个端口", argv: connect(other.address().port), allow: false, network: true },
      ].filter((probe) => !(probe.network && backend.name === "bubblewrap")); // Linux 上代理要经 unix socket 接进网络命名空间，coda 没有实现
      const show = (r) => (r.code === 0 ? "✓ 成功" : `✗ ${/EPERM|not permitted/.test(r.stderr) ? "EPERM（Operation not permitted）" : r.stderr.trim().split("\n").at(-1) || `退出码 ${r.code}`}`);

      const results = [];
      for (const probe of probes) {
        const [command, args] = probe.argv;
        const cleanup = () => { if (probe.file) rmSync(probe.file, { force: true }); };
        const control = await runProcess(command, args, { cwd: root, env: { TMPDIR: t.temp } });
        cleanup();
        const inside = await runSandboxed(root, command, args, { rules, proxyPort });
        const landed = probe.file ? existsSync(probe.file) : undefined;
        cleanup();
        results.push({ probe, control, inside, landed });
      }
      t.table(results.map(({ probe, control, inside, landed }) => ({
        动作: probe.动作,
        不进沙箱: show(control),
        沙箱里: show(inside),
        事后磁盘上: landed === undefined ? "—" : landed ? "有这个文件" : "没有这个文件",
      })));
      // 这组探针的期望是在 macOS（seatbelt）上逐条验证过的；Linux 的 bubblewrap 报错方式不同（例如只读挂载给的是 EROFS），
      // 在别的平台上只打印结果，不做断言
      if (backend.name === "seatbelt") {
        t.ok("每个动作在不进沙箱时都能成功：探针本身没有毛病", results.every((r) => r.control.code === 0));
        t.ok("该允许的动作在沙箱里照常成功", results.filter((r) => r.probe.allow).every((r) => r.inside.code === 0));
        t.ok("该拒绝的动作在沙箱里失败，错误是内核给的 EPERM", results.filter((r) => !r.probe.allow).every((r) => r.inside.code !== 0 && /EPERM|not permitted/.test(r.inside.stderr)));
        t.ok("被拒绝的写入没有在磁盘上留下任何文件", results.filter((r) => !r.probe.allow && r.landed !== undefined).every((r) => r.landed === false));
        t.equal("被改名又改回来的探针，.git 还在原处", existsSync(join(root, ".git/HEAD")), true);
      } else {
        t.log(`（当前后端是 ${backend.name}：上表只供参考，断言只在 macOS 的 seatbelt 上执行）`);
      }
      t.log();
      proxy.close();
      other.close();
      rmSync(join(sandboxPolicy(root).tmp, "t.txt"), { force: true }); // 探针写进专用临时目录的文件
      t.observations.osProbe = { status: "enforced", backend: backend.name };
    }
  }

  // ───────────────────────── 五、代理的决定 ─────────────────────────
  if (wants("network")) {
    t.log("五、代理怎样决定一个域名");
    t.log();
    const policy = sandboxPolicy(root, { allow: ["WebFetch(domain:example.com)", "WebFetch(domain:*.github.com)"], deny: ["WebFetch(domain:169.254.169.254)"] });
    t.log("名单：允许 example.com 和 *.github.com；拒绝 169.254.169.254（云服务器的元数据地址）。名单之外，没有人可问就拒绝。");
    t.log();
    const hosts = [
      ["example.com", "在白名单里"],
      ["EXAMPLE.com.", "大小写和结尾的点统一之后，是同一个域名"],
      ["api.github.com", "*.github.com 匹配子域名"],
      ["github.com", "*.github.com 不匹配它自己"],
      ["example.org", "不在任何名单里"],
      ["169.254.169.254", "拒绝名单"],
      ["2852039166", "这是 169.254.169.254 的十进制写法：规范化之后命中拒绝名单"],
      ["127.1", "inet_aton 缩写，规范化成 127.0.0.1，不在白名单里"],
      ["evil.com\0.github.com", "含控制字符：endsWith 会以为它是 github.com 的子域名，DNS 却在 \\0 处截断，去连 evil.com"],
    ];
    const rows = [];
    for (const [host, note] of hosts) {
      const decision = await networkDecision(host, 443, policy);
      rows.push({ 主机名: host.replace("\0", "\\0"), 结果: verdict(decision.allow, ["放行", "拒绝"]), 理由: decision.why, 说明: note });
    }
    t.table(rows);

    const asked = [];
    const approved = await networkDecision("example.org", 443, policy, async (target) => { asked.push(target); return true; });
    const declined = await networkDecision("example.org", 443, policy, async () => false);
    const failed = await networkDecision("example.org", 443, policy, async () => { throw Error("没有界面可以问"); });
    t.log("名单之外的域名，交给宿主程序传进来的询问回调：");
    t.log();
    t.table([
      { 询问回调: "返回 true", 结果: verdict(approved.allow, ["放行", "拒绝"]), 理由: approved.why },
      { 询问回调: "返回 false（非交互运行里没人回答，就是这个结果）", 结果: verdict(declined.allow, ["放行", "拒绝"]), 理由: declined.why },
      { 询问回调: "抛出异常", 结果: verdict(failed.allow, ["放行", "拒绝"]), 理由: failed.why },
    ]);
    t.equal("白名单里的放行，名单之外的拒绝", [rows[0].结果, rows[4].结果], ["放行", "拒绝"]);
    t.equal("大小写和结尾的点不影响结果", rows[1].结果, "放行");
    t.equal("*.github.com 匹配子域名，不匹配 github.com 本身", [rows[2].结果, rows[3].结果], ["放行", "拒绝"]);
    t.equal("十进制写法的元数据地址，规范化后命中拒绝名单", rows[6].理由, "host is on the deny list");
    t.equal("带控制字符的主机名，在比较名单之前就被拒绝", rows[8].理由, "malformed host");
    t.equal("询问回调拿到的是规范化后的主机名和端口", asked, [{ host: "example.org", port: 443 }]);
    t.equal("回调返回 false 或抛错，都按拒绝处理", [declined.why, failed.why], ["user denied", "permission prompt failed"]);
    t.log();
  }

  // ───────────────────────── 六、没有后端时 ─────────────────────────
  if (wants("fallback")) {
    t.log("六、没有可用的沙箱后端时");
    t.log();
    const marker = join(t.temp, "should-not-exist");
    const script = `require("fs").writeFileSync(${JSON.stringify(marker)},"ran")`;
    const attempts = [];
    for (const platform of ["win32", "freebsd"]) {
      const wrapped = sandboxCommand(root, process.execPath, ["-e", script], { platform });
      const message = await runSandboxed(root, process.execPath, ["-e", script], { platform }).then(() => "（运行了）", (error) => error.message);
      attempts.push({ 平台: platform, "sandboxCommand 返回": wrapped === undefined ? "undefined" : wrapped.backend, "runSandboxed 抛出": message, 命令跑了吗: existsSync(marker) ? "跑了" : "没有" });
    }
    t.table(attempts);
    t.ok("没有后端时 sandboxCommand 返回 undefined", attempts.every((a) => a["sandboxCommand 返回"] === "undefined"));
    t.ok("没有后端时 runSandboxed 抛错，并说明原因", attempts.every((a) => /unavailable/.test(a["runSandboxed 抛出"]) && a["runSandboxed 抛出"].includes(a.平台)));
    t.equal("没有后端时命令一个字节也没有执行", existsSync(marker), false);
    t.log();

    // 接进贯穿项目：Test 工具在 sandbox: true 时通过 runSandboxed 运行（只在 macOS 上验证过）
    if (backend.name === "seatbelt") {
      const leak = join(t.temp, "leak.txt");
      writeFileSync(join(root, "check.js"), [
        `const fs = require("fs");`,
        `fs.writeFileSync("inside.txt", "ok");`,
        `try { fs.writeFileSync(${JSON.stringify(leak)}, "leak"); console.log("项目外写入：成功"); }`,
        `catch (e) { console.log("项目外写入：" + e.code); }`,
      ].join("\n"));
      const test = codingTools(root, { sandbox: true }).find((tool) => tool.name === "Test");
      const result = await test.execute({ path: "check.js" }, {});
      t.log(`coda 的 Test 工具（sandbox: true）运行 check.js，工具结果是：${result.text.trim()}`);
      t.log();
      if (backend.name === "seatbelt") t.equal("Test 工具在沙箱里运行：项目里写得进去，项目外写不出去", [existsSync(join(root, "inside.txt")), existsSync(leak), result.text.includes("EPERM")], [true, false, true]);
      t.log();
    }
  }
});
