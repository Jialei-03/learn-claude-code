// 第 1 章：query() 外壳里的 yield*。
//   node --disable-warning=ExperimentalWarning labs/ch01/lifecycle.mjs
// 运行的是固定提交里真正的 query 函数（构建时从 git 对象里取出来执行，不复制进仓库）；
// 它里面的 queryLoop 换成一个只会 yield 一次的假生成器，我们看三种结束方式下，外壳做了什么。
import assert from 'node:assert/strict';
import { upstream } from '../engineering/run.mjs';

const rows = [];
for (const [how, label] of [['normal', '消费到底'], ['throw', 'queryLoop 抛错'], ['return', '调用者提前 .return()']]) {
  const log = [];
  const queryLoop = async function* (_params, consumedCommandUuids) {
    consumedCommandUuids.push('命令 A'); // 本次查询消费了一条排队的命令
    try {
      yield '一帧输出';
      if (how === 'throw') throw Error('模型请求失败');
      return { reason: 'completed' };
    } finally {
      log.push('finally');
    }
  };
  const query = upstream('query', 'query', { queryLoop, notifyCommandLifecycle: (uuid, event) => log.push(`${event}(${uuid})`) });
  const generator = query({});
  await generator.next();
  if (how === 'return') await generator.return();
  else if (how === 'throw') await assert.rejects(generator.next(), /模型请求失败/);
  else await generator.next();
  rows.push({ how, label, log });
}

console.log('| 调用者怎么结束它 | queryLoop 的 finally | query() 的 completed 通知 |');
console.log('| --- | --- | --- |');
for (const { label, log } of rows) console.log(`| ${label} | ${log.includes('finally') ? '执行' : '没有'} | ${log.some(x => x.startsWith('completed')) ? '发出' : '没有发出'} |`);

assert.deepEqual(rows.map(r => r.log), [['finally', 'completed(命令 A)'], ['finally'], ['finally']]);
