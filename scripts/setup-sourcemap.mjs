import { existsSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
const lock = JSON.parse(readFileSync(new URL('../source.lock.json', import.meta.url)));
const dir = resolve(process.env.CC_SOURCE_DIR ?? new URL('../../claude-code-sourcemap-source', import.meta.url).pathname);
if (!existsSync(dir)) {
  execFileSync('git', ['clone', '--no-checkout', '--filter=blob:none', lock.repo, dir], { stdio: 'inherit' });
  execFileSync('git', ['-C', dir, 'checkout', '--detach', lock.commit], { stdio: 'inherit' });
}
const head = execFileSync('git', ['-C', dir, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
if (head !== lock.commit) throw new Error(`现有目录 ${dir} 版本不符；未覆盖。需要 ${lock.commit}`);
console.log(`sourcemap ${lock.version} · ${head}`);
