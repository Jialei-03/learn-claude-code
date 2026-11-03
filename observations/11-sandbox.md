---
motto: 规则管的是命令的写法，沙箱管的是进程能碰到什么。
learn:
  - 打开 Claude Code 的沙箱，用八条命令试探文件和网络的边界
  - 第 7 章没挡住的“用 Python 读 .env”，在沙箱里是什么结果
  - 网络怎样按域名过滤：一个本地代理，加上一串环境变量
  - 打开沙箱之后，请求里多了什么
  - 沙箱和权限怎样配合：沙箱里的命令不再逐条询问
  - 读 sandbox-runtime 的源码：录制里看到的每一样东西，出处在哪里
  - 和 Learn Pi Agent 的沙箱扩展对照：两个独立的实现走到了同一个设计
prereq: 第 6、7 章；Learn Pi Agent 第 15 章
time: 40 分钟
build: labs/ch11 —— 一次沙箱里的录制、它的分析，以及和 sandbox-runtime 源码的逐项核对
---

## 为什么还需要沙箱

第 6 章说过，Bash 的权限规则匹配的是命令的文本，`/bin/rm` 就能绕过 `Bash(rm *)`；第 7 章看到 `Read(./.env)` 的 deny 规则挡住了 `cat .env`，却挡不住 `python3 -c "open('.env')"`。文档对此的说法很直接：要不依赖命令写法的限制，用沙箱（[Sandboxing](https://code.claude.com/docs/en/sandboxing)）。

Claude Code 的沙箱只包住 **Shell 命令**（Bash 和它启动的所有子进程）：macOS 上用 Seatbelt，Linux 上用 bubblewrap。Read、Edit、Write 这些内置工具不在沙箱里，它们由权限规则管。钩子、MCP 服务器这些 Claude Code 启动的其他进程，也不在沙箱里。

## 八条命令

打开沙箱，禁止读两个文件：项目外的一个“机密”文件，和项目里的 `.env`；网络只放行 `example.com`：

@code labs/ch11/record.ts#region:settings

让模型按顺序运行这八条命令，手动模式：

@code labs/ch11/record.ts#region:steps

@lab node labs/ch11/sandbox.ts steps

- **写项目里的文件可以，写项目外的不行**（1、2）。默认可写的只有工作目录、每个用户自己的临时目录和额外加入的目录。
- **项目里也有不能写的地方**（3）。`.git/hooks/pre-commit` 会在你下一次（在沙箱外）`git commit` 时运行——往那里写东西，等于在沙箱外面留了一个定时执行的命令。文档列出的受保护路径还有 `.claude` 下的设置、`.mcp.json`、shell 的启动文件、`.git/config` 等。
- **Python 读不到被禁止的文件**（4、5）。第 7 章那个漏洞在这里被堵上了：不管用什么语言、什么写法，进程的 `open` 都会被内核拒绝。注意默认是**整台机器可读**（除了少数目录），机密文件要自己加进 `denyRead`。
- **网络经过一个本地代理**（6、7、8）。沙箱里的命令连不了外网，只能连本机上的一个代理；Claude Code 把 `HTTP_PROXY`、`HTTPS_PROXY`、`ALL_PROXY`，甚至 Docker、gRPC、gcloud 各自认的代理变量都指向它。代理按域名放行：`example.com` 返回 200，`example.org` 被拒绝，错误信息里的 `<sandbox_violations>` 写明了被拒的主机和端口。
- **手动模式下，八条命令一条都没有问用户。** 这是 `autoAllowBashIfSandboxed`（默认开启）：既然命令跑在沙箱里，边界由沙箱保证，就不必逐条确认了。第 6 章里，同样的手动模式，连 `mkdir` 都要问。

第 8 条的 “user denied” 值得一提：文档说，手动模式下访问白名单之外的域名会**询问用户**，`-p` 模式没人回答，所以被拒绝；自动模式下交给分类器判断，`bypassPermissions` 下直接放行。

### 沙箱之外的逃生口

Bash 工具有一个参数 `dangerouslyDisableSandbox`：命令被沙箱挡住时，模型可以请求在沙箱外重新运行。这次实验明确要求模型不要用它；但第 7 章的录制里，模型在被拦下之后就主动加上了这个参数。文档说这样的重试要经过权限检查：手动模式下会弹出一个“不在沙箱里运行的命令”的确认，自动模式下交给分类器，`dontAsk` 下直接拒绝；把 `allowUnsandboxedCommands` 设为 `false` 可以彻底关掉这个口子。

## 请求里多了什么

和第 6 章同一个版本、没开沙箱的录制比较：

@lab node labs/ch11/sandbox.ts request

- **Bash 工具多了一个参数 `allowed_domains`**：模型可以声明这条命令会访问哪些域名。文档说，自动模式下访问白名单之外的域名，只有命令声明了这个主机、并且分类器同意，才会放行——让模型把“要联网”这件事说出来，审查才有依据。
- **环境信息那条 system 消息长了一倍多**，多出来的九千多个字符是沙箱的说明：模型需要知道自己在什么样的限制里工作，被拦下时才知道该怎么办。

## 读源码：sandbox-runtime

Claude Code 是闭源的，但它的沙箱不是。文档写明沙箱建在开源的 `@anthropic-ai/sandbox-runtime` 上（Apache-2.0 许可）。这一节摘录它的源码，版本固定在 v0.0.79：发布时间在本课观察的 Claude Code 2.1.296 之前最近的一版。Claude Code 实际捆绑的是哪一版，从外部无法确认，所以先拿录制和源码逐项核对，看对不对得上：

@lab node labs/ch11/sandbox.ts source

四项都对上了。下面按这四项读源码。

### 默认拒绝的 Seatbelt 策略

`generateSandboxProfile` 生成交给 `sandbox-exec` 的 Seatbelt 策略。它的开头：

@oss sandbox-runtime src/sandbox/macos-sandbox-utils.ts#L1015-L1030

`(deny default)`：**默认拒绝一切**，然后只放行进程运行必需的东西——fork 和 exec、同一个沙箱里的进程信息和信号，以及一份逐个列出的系统服务（注释说参照了 Chrome 的沙箱策略）。Learn Pi Agent 第 15 章的扩展正好相反：默认允许，再收紧写入、读取和网络。默认拒绝更安全（没想到的操作也被挡住），代价是要维护一份很长的放行清单，有些程序会因为缺了某个系统服务而莫名其妙地失败——源码里那些 `enableWeakerNetworkIsolation`、`allowAppleEvents` 开关就是为这些情况准备的。

网络部分只放行本机上代理的端口：

@oss sandbox-runtime src/sandbox/macos-sandbox-utils.ts#L1251-L1262

除此之外的外连都会被内核拒绝——这就是“绕过代理直连”行不通的原因。

### 永远不能写的路径

实验第 3 步写 `.git/hooks/pre-commit` 被拒，出处是这份强制拒写清单：

@oss sandbox-runtime src/sandbox/macos-sandbox-utils.ts#macGetMandatoryDenyEntries collapse=true

@oss sandbox-runtime src/sandbox/sandbox-utils.ts#DANGEROUS_FILES

每个名字都出现两次：工作目录里的那一个，以及任意深度子目录里的同名文件——`sub/.git/hooks` 也算。清单里除了 git 钩子和配置，还有 shell 的启动文件、`.mcp.json`、编辑器配置目录、`.claude/commands` 和 `.claude/agents`：都是“写进去的东西会在沙箱之外被执行或信任”的位置（Learn Pi Agent 第 15 章的同一个思路）。

还有一个细节值得注意：

@oss sandbox-runtime src/sandbox/sandbox-utils.ts#normalizeCaseForComparison

macOS 的文件系统默认不区分大小写，`.cLauDe/Settings.locaL.json` 和 `.claude/settings.local.json` 是同一个文件。路径比较前统一转成小写，否则一个大小写混写的路径就能绕过所有按字符串匹配的规则。

### 网络：先查拒绝名单，再查白名单，最后问人

代理收到一个连接请求，交给 `filterNetworkRequest` 决定：

@oss sandbox-runtime src/sandbox/sandbox-manager.ts#filterNetworkRequest collapse=true

顺序和第 6 章的权限规则一样：拒绝名单优先，然后白名单，都不匹配时调用宿主程序传进来的询问回调——Claude Code 在这里按权限模式决定是问用户、交给分类器还是直接拒绝（本章前面那张表）。`-p` 模式下没人回答，于是得到录制里的 “user denied”。

开头的两道检查是安全工程的好例子：

- 主机名里有控制字符就直接拒绝。注释举的例子是 `evil.com\x00.allowed.com`：用 `endsWith` 判断它“属于 allowed.com”，但 DNS 解析时字符串在空字符处被截断，实际连的是 `evil.com`。
- 先把主机名规范化再比较。`2852039166` 和 `169.254.169.254` 是同一个地址（云服务器的元数据服务），不规范化，拒绝名单就形同虚设。

### 一串环境变量，和藏在用户名里的调用 id

录制第 6 步看到的那一长串代理变量，来自 `generateProxyEnvVars`：

@oss sandbox-runtime src/sandbox/sandbox-utils.ts#generateProxyEnvVars collapse=true

几乎每个变量旁边都有一段注释，解释某个具体的工具为什么需要它：gRPC 只认 HTTP CONNECT 代理，所以 `GRPC_PROXY` 用 http 地址；Python 的 httpx 遇到 socks5 地址会因为缺少依赖而崩溃，所以 `ALL_PROXY` 也优先用 http；gcloud 有自己的一套变量；git 走 SSH 时要借 `nc` 穿过代理。**让“只能经过代理上网”在真实世界里可用，大部分工作是这些兼容性细节。**

代理地址里的用户名不是固定的：

@oss sandbox-runtime src/sandbox/sandbox-utils.ts#proxyUsernameFor

`srt.` 后面是被编码的“命令标识”，代理据此把一次被拒绝的连接归到触发它的那次调用。核对录制时把它解码，得到的正是那条 Bash 调用的 id：Claude Code 把工具调用的 id 传给了沙箱，所以拒绝记录能精确地对应到模型的某一次调用。

### 模型看到的那段说明

被拒绝的连接记下来之后，命令结束时追加到 stderr 后面：

@oss sandbox-runtime src/sandbox/sandbox-manager.ts#annotateStderrWithSandboxFailures

这就是录制里 `<sandbox_violations>` 的出处：沙箱不只是拦下，还用模型能读懂的方式告诉它**为什么**失败，模型才能决定是换个做法、请求用户放行，还是（像第 7 章那样）尝试 `dangerouslyDisableSandbox`。

## 两个独立的实现

Learn Pi Agent 第 15 章为 Pi 和 mox 写了一个沙箱扩展。把两边放在一起：

| | Claude Code | Learn Pi Agent 的沙箱扩展 |
| --- | --- | --- |
| 隔离方式 | macOS：Seatbelt；Linux：bubblewrap | 相同 |
| Seatbelt 策略的默认 | 默认拒绝，逐项放行进程和系统服务 | 默认允许，再收紧写入、读取和网络 |
| 包住什么 | Shell 命令和子进程 | 相同（bash 工具） |
| 默认可写 | 工作目录、临时目录、额外目录 | 工作目录、临时目录 |
| 项目里不能写的 | `.git/hooks`、`.git/config`、`.claude`、`.mcp.json`…… | `.git/hooks`、`.git/config`、`.pi`、`.mox`、`.claude`、`.mcp.json`、`.vscode`、`.idea` |
| 默认不能读 | 少数目录；其余要自己配置 | `~/.ssh`、`~/.aws`、`~/.gnupg` 等常见的凭据位置 |
| 网络 | 本地代理按域名过滤，环境变量指向它 | 相同 |
| 白名单外的域名 | 按权限模式：询问、交给分类器、放行或拒绝 | 拒绝 |
| 逃生口 | `dangerouslyDisableSandbox`，经过权限检查 | 没有 |

两个互不相干的实现，走到了几乎相同的整体设计：用操作系统的沙箱限制文件，用一个本地代理按域名限制网络，项目目录里那些“会在沙箱外被执行或信任的文件”单独保护。这不是巧合——这是在“允许 Agent 自由执行命令”和“不让它碰到不该碰的东西”之间，目前最实用的折中。

@mox extensions/sandbox/policy.ts#defaultDenyWrite

差别在默认值和与权限的配合上。Learn Pi Agent 的扩展默认就禁止读常见的凭据目录；Claude Code 默认整台机器可读，文档特别提醒“这个默认值仍然允许读取凭据文件”。Claude Code 则把沙箱和权限系统打通了：沙箱里的命令免于逐条确认，白名单外的网络访问按权限模式处理，逃生口本身也要过权限这一关。

## 面试题

::: interview 已经有权限规则和钩子了，为什么还需要沙箱？
规则和钩子判断的是命令的**文本**：换一种写法（`/bin/rm`、`python -c open(...)`、`sh -c '...'`）就能绕过。沙箱在操作系统层面限制**进程**能访问的文件和网络，不管命令怎么写、用什么语言，越界的系统调用都会被内核拒绝。所以安全边界应该放在沙箱上，规则和钩子在边界之内提供可控性：哪些事要问用户、哪些要记录、哪些要改写。反过来，沙箱也带来了体验上的收益：既然边界有保证，沙箱里的命令就可以不再逐条确认。
:::

::: interview 沙箱里的进程只能写项目目录，这样就安全了吗？
不够。项目目录里有一些文件会在沙箱**之外**被执行或信任：git 钩子会在你下次提交时运行，`.git/config` 可以指定任意程序，Agent 和编辑器的配置目录会在下次启动时加载，`.mcp.json` 会启动新的服务器。这些路径即使在可写目录里也要禁止写入。另外，默认可读的范围通常很大，凭据文件要显式禁止读取；网络白名单里的域名也可能被用来带出数据（放行 github.com，就能把代码推到任何一个仓库）。
:::

::: interview 怎样按域名限制一个进程的网络访问？
内核层面按域名过滤几乎做不到（域名和 IP 不是一一对应的）。常见做法是两层：沙箱禁止进程的所有外连，只允许连本机的一个端口；这个端口上运行一个代理（在沙箱外），通过 `HTTP_PROXY`、`HTTPS_PROXY` 等环境变量让进程使用它，代理从 HTTP 请求或 HTTPS 的 CONNECT 里拿到域名，按白名单放行。不认代理变量的程序会直接连不上——这是对的，失败时关闭。代理只看域名、不看内容。
:::
