import { mkdir, mkdtemp } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

export async function fixture(): Promise<string> {
  const root = fileURLToPath(new URL('../tmp/clash-manager-tests/', import.meta.url));
  await mkdir(root, { recursive: true });
  return mkdtemp(path.join(root, 'run-'));
}
