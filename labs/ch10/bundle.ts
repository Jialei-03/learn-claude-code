// 第 10 章：从发布的 cli.js 里读出“编译之后”的子 Agent 配置。
// 源码里的 feature('X') 是编译期开关，process.env.USER_TYPE === 'ant' 在外部版本里也被替换成了常量；
// 还原出来的 .ts 保留着判断语句，可发布的包里哪条路真正存在，只能去包里看。
// 这里只做查找和计数，不复制任何源码。
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { SOURCE_DIR } from '../../lab/sourcemap.ts';

export const bundle = readFileSync(join(SOURCE_DIR, 'package/cli.js'), 'utf8');

const id = '[\\w$]+'; // 压缩之后的标识符：a$、mV6 这样的短名字

/** 压缩后的常量定义 `x="Agent"` → 字符串；`x=[a,b]` 这样的数组常量展开成它的元素 */
function resolve(name: string, seen = new Set<string>()): string[] {
  if (seen.has(name)) return [];
  seen.add(name);
  const quoted = new RegExp(`[,;\\s{(]${name.replace(/\$/g, '\\$')}="([A-Za-z_]+)"[,;]`).exec(bundle);
  if (quoted) return [quoted[1]];
  const list = new RegExp(`[,;\\s{(]${name.replace(/\$/g, '\\$')}=\\[([\\w$,]+)\\]`).exec(bundle);
  return list ? list[1].split(',').flatMap((item) => resolve(item, seen)) : [`?${name}`];
}

const elements = (list: string) => list.split(',').flatMap((item) => (item.startsWith('...') ? resolve(item.slice(3)) : resolve(item)));

/**
 * 三张工具清单在发布版里的实际内容。源码里它们是连着声明的三个 Set：
 * 所有子 Agent 的禁用清单、自定义 Agent 的禁用清单（等于前者展开）、后台 Agent 的允许清单。
 */
export function shippedToolLists() {
  const found = new RegExp(`(${id})=new Set\\(\\[(${id}(?:,${id})*)\\]\\),(${id})=new Set\\(\\[\\.\\.\\.\\1\\]\\),(${id})=new Set\\(\\[([^\\]]*)\\]\\)`).exec(bundle);
  if (!found) throw Error('在 cli.js 里找不到子 Agent 的工具清单');
  return { allDisallowed: elements(found[2]), asyncAllowed: elements(found[5]) };
}

/** 各个“可能走得到”的路径，在发布版里是不是真的存在 */
export function shippedGates() {
  return {
    // isForkSubagentEnabled 被折叠成恒为 false：它后面紧跟着的 isInForkChild 是固定的形状
    forkOff: new RegExp(`function ${id}\\(\\)\\{return!1\\}function ${id}\\(${id}\\)\\{return ${id}\\.some\\(\\(${id}\\)=>\\{if\\(${id}\\.type!=="user"\\)return!1;`).test(bundle),
    forkPromptStillInBundle: bundle.includes('You are a forked worker process'),
    // Explore / Plan：编译开关保留，只剩服务端灰度 tengu_amber_stoat，缺省值是 true
    exploreGate: new RegExp(`function ${id}\\(\\)\\{return ${id}\\("tengu_amber_stoat",!0\\)\\}`).test(bundle),
    // verification：灰度名不在包里，推入内置清单的那条分支被整个删掉了
    verificationGateName: bundle.includes('tengu_hive_evidence'),
    verificationPromptStillInBundle: bundle.includes('You are a verification specialist'),
    // 协调者模式：开启它的环境变量名不在包里
    coordinatorEnv: bundle.includes('CLAUDE_CODE_COORDINATOR_MODE'),
    guideAgent: bundle.includes('claude-code-guide'),
  };
}
