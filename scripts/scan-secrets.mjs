import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const run = promisify(execFile);
const root = fileURLToPath(new URL('../', import.meta.url));
const withHistory = process.argv.includes('--history');

const patterns = [
  { name: '订阅地址参数', regex: /[?&](token|sub|key|code)=[A-Za-z0-9_-]{8,}/i },
  { name: '常见订阅协议链接', regex: /\b(ss|ssr|vmess|vless|trojan|hysteria2?|tuic):\/\//i },
  { name: '节点凭据字段', regex: /\b(password|uuid)\s*:\s*["']?[A-Za-z0-9+/=_-]{8,}/i },
  { name: '控制器密钥', regex: /\b(secret|api-key|apiKey)\s*[:=]\s*["']?[A-Za-z0-9_-]{8,}/i },
  { name: '本机绝对路径', regex: /\b[A-Z]:\\Users\\[^\\\s]+|\/home\/[a-z0-9_-]+\//i },
  { name: '真实邮箱', regex: /[\w.+-]+@(?!users\.noreply\.github\.com|example\.(com|invalid))[a-z0-9-]+\.[a-z.]{2,}/i },
];

// 本机专属敏感词（机场名称、真实域名等）只写在忽略文件中，不入库。
const localPatterns = fileURLToPath(new URL('../.secret-patterns.txt', import.meta.url));
try {
  const text = await readFile(localPatterns, 'utf8');
  for (const row of text.split('\n')) {
    const term = row.trim();
    if (!term || term.startsWith('#')) continue;
    patterns.push({ name: `本机敏感词 ${term}`, regex: new RegExp(escapeRegExp(term), 'i') });
  }
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const allow = [
  /example\.invalid/i,
  /example\.com/i,
  /example[-_]/i,
  /127\.0\.0\.1/,
  /@users\.noreply\.github\.com/i,
  /registry\.npmjs\.org/i,
];

function scan(label, text, findings) {
  const lines = text.split('\n');
  for (const [index, line] of lines.entries()) {
    if (allow.some((rule) => rule.test(line))) continue;
    for (const pattern of patterns) {
      if (pattern.regex.test(line)) findings.push(`${label}:${index + 1}: ${pattern.name}`);
    }
  }
}

async function scanWorktree(findings) {
  const { stdout } = await run('git', ['-C', root, 'ls-files', '-z'], { maxBuffer: 64 * 1024 * 1024 });
  const files = stdout.split('\0').filter(Boolean);
  for (const file of files) {
    if (file === 'package-lock.json' || file === 'scripts/scan-secrets.mjs') continue;    if (!/\.(md|json|ts|tsx|js|mjs|cjs|cs|html|css|ya?ml)$/i.test(file)) continue;
    let text;
    try {
      text = await readFile(path.join(root, file), 'utf8');
    } catch {
      continue;
    }
    scan(file, text, findings);
  }
}

async function scanHistory(findings) {
  const { stdout } = await run(
    'git',
    ['-C', root, 'log', '-p', '--all', '--no-color', '--', '.', ':!package-lock.json'],
    { maxBuffer: 512 * 1024 * 1024 },
  );
  let commit = 'unknown';
  let line = 0;
  for (const row of stdout.split('\n')) {
    line++;
    if (row.startsWith('commit ')) commit = row.slice(7, 14);
    if (row.startsWith('+') && !row.startsWith('+++')) scan(`${commit}+${line}`, row, findings);
  }
}

const findings = [];
await scanWorktree(findings);
if (withHistory) await scanHistory(findings);

if (findings.length) {
  process.stdout.write(`发现 ${findings.length} 处疑似敏感内容：\n${findings.join('\n')}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(`未发现疑似敏感内容${withHistory ? '（含历史）' : ''}\n`);
}
