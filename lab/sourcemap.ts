import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CC_SOURCE } from '../course/syllabus.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const SOURCE_DIR = process.env.CC_SOURCE_DIR ?? join(ROOT, CC_SOURCE.dir);
const git = (args: string[]) => execFileSync('git', ['-C', SOURCE_DIR, ...args], { encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 });
export interface SourceReference { chapter: string; file: string; anchor: string; span: number; claim: string }
export interface VerifiedReference extends SourceReference { start: number; end: number; url: string; sha256: string; sourceMapMatch: boolean }

export function verifySourcemap(): Record<string, VerifiedReference> {
  const head = git(['rev-parse', 'HEAD']).trim();
  if (head !== CC_SOURCE.commit) throw new Error(`CC_SOURCE_DIR 位于 ${head}，课程固定 ${CC_SOURCE.commit}`);
  const pkg = JSON.parse(git(['show', `${head}:package/package.json`]));
  if (pkg.version !== CC_SOURCE.version) throw new Error('还原 npm 包的版本与课程不符');
  const bytes = readFileSync(join(SOURCE_DIR, 'package/cli.js.map'));
  const blob = createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
  if (blob !== git(['rev-parse', `${head}:package/cli.js.map`]).trim()) throw new Error('cli.js.map 与固定提交不一致');
  const map = JSON.parse(bytes.toString('utf8')) as { sources: string[]; sourcesContent: string[] };
  const raw = JSON.parse(readFileSync(join(ROOT, 'course/source-references.json'), 'utf8')) as Record<string, SourceReference>;
  const verified: Record<string, VerifiedReference> = {};
  for (const [key, ref] of Object.entries(raw)) {
    const text = git(['show', `${head}:${ref.file}`]);
    const suffix = ref.file.replace(/^restored-src\//, '');
    const indexes = map.sources.flatMap((s, i) => s === `../${suffix}` ? [i] : []);
    if (indexes.length !== 1 || map.sourcesContent[indexes[0]] !== text) throw new Error(`${key}: 还原文件与 source map sourcesContent 不符`);
    const lines = text.split('\n');
    const hits = lines.flatMap((line, i) => line.includes(ref.anchor) ? [i] : []);
    if (hits.length !== 1) throw new Error(`${key}: 源码锚点不唯一或不存在 (${hits.length})`);
    const start = hits[0] + 1;
    const end = Math.min(start + ref.span - 1, lines.length);
    verified[key] = { ...ref, start, end, url: `${CC_SOURCE.repo}/blob/${head}/${ref.file}#L${start}-L${end}`, sha256: createHash('sha256').update(text).digest('hex'), sourceMapMatch: true };
  }
  return verified;
}
