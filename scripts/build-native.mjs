import { access, mkdir } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
if (process.platform !== 'win32') throw new Error('本机辅助程序须在 Windows 上构建');
const compiler = path.join(process.env.WINDIR ?? 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');
await access(compiler);
await mkdir(path.join(root, 'resources', 'bin'), { recursive: true });
await promisify(execFile)(compiler, [
  '/nologo', '/target:exe', '/platform:x64', '/optimize+',
  '/reference:System.Web.Extensions.dll', '/reference:Microsoft.CSharp.dll',
  '/reference:System.IO.Compression.dll', '/reference:System.IO.Compression.FileSystem.dll',
  `/out:${path.join(root, 'resources', 'bin', 'ManagerNative.exe')}`,
  path.join(root, 'native', 'ManagerNative.cs'),
], { windowsHide: true, encoding: 'utf8' });
console.log('Windows 辅助程序构建完成');
