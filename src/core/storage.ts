import { mkdir, readFile, open, rename, realpath, stat } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import type { Workspace } from './model.js';
import { emptyScheme, schemeSchema } from './model.js';

export async function atomicWrite(file: string, content: string | Uint8Array): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${randomUUID()}.tmp`;
  const handle = await open(temporary, 'wx');
  try {
    await handle.writeFile(content);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporary, file);
}

export async function inside(root: string, relative: string): Promise<string> {
  if (!relative || path.isAbsolute(relative) || relative.includes('\\') || relative.includes(':') ||
      relative.split('/').some(part => !part || part === '.' || part === '..' || /[. ]$|[<>"|?*\x00-\x1f]/.test(part) || /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(part))) {
    throw new Error('文件路径不在允许范围内');
  }
  const canonical = await realpath(root);
  const destination = path.join(canonical, relative);
  let existing = destination;
  while (true) {
    try {
      const resolved = await realpath(existing);
      const suffix = path.relative(canonical, resolved);
      if (suffix.startsWith('..') || path.isAbsolute(suffix)) throw new Error('文件路径通过链接越出本机目录');
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      const parent = path.dirname(existing);
      if (parent === existing) throw new Error('目录无法校验');
      existing = parent;
    }
  }
  return destination;
}

export async function readText(file: string): Promise<string> {
  if ((await stat(file)).size > 32 * 1024 * 1024) throw new Error('配置文件超过允许大小');
  return readFile(file, 'utf8');
}

export class WorkspaceStore {
  constructor(private readonly dataDir: string) {}

  async read(): Promise<Workspace> {
    try {
      const value = JSON.parse(await readFile(path.join(this.dataDir, 'workspace.json'), 'utf8'));
      if (value.schemaVersion !== 1 || !Array.isArray(value.schemes) || !Array.isArray(value.sources) || !Array.isArray(value.nodes) || !Object.hasOwn(value, 'applied')) {
        throw new Error('用户数据格式不兼容，未覆盖原文件');
      }
      value.schemes = value.schemes.map((scheme: unknown) => schemeSchema.parse(scheme));
      return { sources: [], nodes: [], device: null, ...value };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      const initial: Workspace = { schemaVersion: 1, schemes: [emptyScheme('default', 'default')], sources: [], nodes: [], device: null, applied: null };
      await this.write(initial);
      return initial;
    }
  }

  async write(workspace: Workspace): Promise<void> {
    await atomicWrite(path.join(this.dataDir, 'workspace.json'), JSON.stringify(workspace, null, 2));
  }
}
