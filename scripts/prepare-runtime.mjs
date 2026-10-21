import { readFile, writeFile, mkdir, access, rename } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import './build-native.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const lock = JSON.parse(
  await readFile(new URL('../resources/runtime-lock.json', import.meta.url), 'utf8'),
);
const destination = path.join(root, 'resources', 'bin', 'mingit');
const marker = path.join(destination, 'manager-runtime.json');
try {
  const existing = JSON.parse(await readFile(marker, 'utf8'));
  if (existing.sha256 !== lock.git.sha256)
    throw new Error('已有专用 Git 版本不同，请使用新的构建目录；未覆盖旧文件');
  await access(path.join(destination, 'cmd', 'git.exe'));
  console.log('已复用校验过的专用 Git');
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
  const cache = fileURLToPath(new URL('../tmp/clash-manager-runtime/', import.meta.url));
  await mkdir(cache, { recursive: true });
  const archive = path.join(cache, `${lock.git.sha256}.zip`);
  let data;
  try {
    data = await readFile(archive);
  } catch (failure) {
    if (failure.code !== 'ENOENT') throw failure;
    const response = await fetch(lock.git.url, { signal: AbortSignal.timeout(120000) });
    if (!response.ok) throw new Error('专用 Git 官方下载失败');
    data = Buffer.from(await response.arrayBuffer());
    if (
      data.length !== lock.git.bytes ||
      createHash('sha256').update(data).digest('hex') !== lock.git.sha256
    )
      throw new Error('专用 Git 下载摘要不符');
    await writeFile(archive, data, { flag: 'wx' });
  }
  if (
    data.length !== lock.git.bytes ||
    createHash('sha256').update(data).digest('hex') !== lock.git.sha256
  )
    throw new Error('专用 Git 缓存摘要不符，未使用');
  const staging = path.join(root, 'resources', 'bin', `mingit-${randomUUID()}`);
  const allowedRoot = path.join(root, 'resources', 'bin') + path.sep;
  if (
    !path.resolve(staging).startsWith(allowedRoot) ||
    !path.resolve(destination).startsWith(allowedRoot)
  )
    throw new Error('运行环境路径越界');
  await promisify(execFile)(
    path.join(root, 'resources', 'bin', 'ManagerNative.exe'),
    ['extract', JSON.stringify({ archive, destination: staging })],
    { windowsHide: true, encoding: 'utf8' },
  );
  await writeFile(
    path.join(staging, 'manager-runtime.json'),
    JSON.stringify({ version: lock.git.version, sha256: lock.git.sha256 }),
    'utf8',
  );
  await rename(staging, destination);
  console.log('专用 Git 已按官方 SHA-256 校验并准备完成');
}
