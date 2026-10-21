import { build as bundle } from 'esbuild';
import { build as frontend } from 'vite';
import react from '@vitejs/plugin-react';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { deflateSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import './build-native.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
await mkdir(path.join(root, 'dist', 'desktop'), { recursive: true });
await bundle({
  entryPoints: [path.join(root, 'src/desktop/main.ts')],
  outfile: path.join(root, 'dist/desktop/main.js'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node24',
  external: ['electron'],
  sourcemap: false,
  banner: {
    js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);",
  },
});
await bundle({
  entryPoints: [path.join(root, 'src/desktop/preload.ts')],
  outfile: path.join(root, 'dist/desktop/preload.cjs'),
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node24',
  external: ['electron'],
});
await frontend({
  root,
  base: './',
  plugins: [react()],
  build: { outDir: path.join(root, 'dist', 'renderer'), emptyOutDir: false, sourcemap: false },
  logLevel: 'warn',
});

// 生成小型自有图标，避免发行依赖额外图片工具或远端字体。
const size = 64;
const rows = Buffer.alloc((size * 4 + 1) * size);
for (let y = 0; y < size; y++)
  for (let x = 0; x < size; x++) {
    const offset = y * (size * 4 + 1) + 1 + x * 4;
    const circle = (x - 32) ** 2 + (y - 32) ** 2 < 29 ** 2;
    const point = [
      [21, 22],
      [43, 22],
      [32, 43],
    ].some(([cx, cy]) => (x - cx) ** 2 + (y - cy) ** 2 < 5 ** 2);
    const line =
      (Math.abs(y - 22) < 2 && x > 21 && x < 43) ||
      (Math.abs(y - (2 * x - 20)) < 3 && x > 21 && x < 32) ||
      (Math.abs(y - (-2 * x + 108)) < 3 && x > 32 && x < 43);
    rows.set(
      point || line ? [237, 190, 139, 255] : circle ? [47, 88, 65, 255] : [0, 0, 0, 0],
      offset,
    );
  }
function chunk(type, bytes) {
  const body = Buffer.concat([Buffer.from(type), bytes]);
  let crc = 0xffffffff;
  for (const byte of body) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  const header = Buffer.alloc(4);
  header.writeUInt32BE(bytes.length);
  const footer = Buffer.alloc(4);
  footer.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
  return Buffer.concat([header, body, footer]);
}
const dimensions = Buffer.alloc(13);
dimensions.writeUInt32BE(size);
dimensions.writeUInt32BE(size, 4);
dimensions[8] = 8;
dimensions[9] = 6;
const png = Buffer.concat([
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
  chunk('IHDR', dimensions),
  chunk('IDAT', deflateSync(rows)),
  chunk('IEND', Buffer.alloc(0)),
]);
await writeFile(path.join(root, 'resources', 'bin', 'app-icon.png'), png);
const guide = await readFile(path.resolve(root, '../../docs/subscription-manager.md'), 'utf8');
await writeFile(path.join(root, 'resources', 'bin', '使用说明.md'), guide, 'utf8');
console.log('桌面程序和本机资源构建完成');
