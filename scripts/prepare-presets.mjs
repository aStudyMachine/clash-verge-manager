import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

// 维护期从已脱敏的仓库规则提取数据，运行程序只读取随包的 JSON。
const source = await readFile(
  new URL('../../../profiles/aggregate/script.js', import.meta.url),
  'utf8',
);
const start = source.indexOf('{', source.indexOf('const migrationSnapshot ='));
const snapshot = JSON.parse(source.slice(start, source.indexOf('\n};', start) + 2));
const rules = snapshot.rules.map((rule) =>
  rule.startsWith('IP-CIDR,') && rule.split(',')[1].includes(':')
    ? rule.replace('IP-CIDR,', 'IP-CIDR6,')
    : rule,
);
const suffixes = (key) => {
  const match = source.match(new RegExp(`const ${key} = suffixRules\\(\\[([\\s\\S]*?)\\],`));
  if (!match) throw new Error('缺少已维护的场景域名');
  return JSON.parse(`[${match[1]}]`).map((value) => `DOMAIN-SUFFIX,${value},出口`);
};
const tikTokStart = rules.indexOf('PROCESS-NAME,com.ss.android.ugc.trill,国际媒体');
const tikTokEnd = rules.indexOf('DOMAIN-KEYWORD,tiktokcdn-,国际媒体');
const telegramStart = rules.indexOf('DOMAIN-SUFFIX,telegra.ph,节点选择');
const telegramEnd = rules.indexOf('IP-CIDR6,2001:b28:f23f::/48,节点选择');
if ([tikTokStart, tikTokEnd, telegramStart, telegramEnd].some((index) => index < 0))
  throw new Error('场景快照范围不完整');
const tikTok = rules.slice(tikTokStart, tikTokEnd + 1);
const buckets = [
  [
    'ai',
    'AI',
    [
      ...suffixes('aiRules'),
      'DOMAIN,gemini.google.com,出口',
      'DOMAIN,proactivebackend-pa.googleapis.com,出口',
    ],
  ],
  ['social', '社交', suffixes('socialRules')],
  ['tiktok', 'TikTok', tikTok],
  ['google', 'Google', suffixes('googleRules')],
  ['steam', 'Steam', rules.filter((rule) => rule.split(',')[2] === '蒸汽平台')],
  ['anime', '港台番剧', rules.filter((rule) => rule.split(',')[2] === '港台番剧')],
  [
    'media',
    '国际媒体',
    rules.filter((rule) => rule.split(',')[2] === '国际媒体' && !tikTok.includes(rule)),
  ],
  [
    'telegram',
    'Telegram',
    [
      ...rules.filter((rule) => rule.split(',')[2] === '电报代理'),
      ...rules.slice(telegramStart, telegramEnd + 1),
    ],
  ],
];
const templates = buckets.map(([id, name, entries]) => {
  const seen = new Set();
  return {
    id,
    name,
    version: '2026.10.21.1',
    source: '内置场景规则模板，按场景逐项维护',
    rules: entries
      .filter((entry) => {
        const key = entry.split(',').slice(0, 2).join(',');
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .map((entry) => {
        const [kind, value, , ...options] = entry.split(',');
        return { kind, value, options };
      }),
  };
});
const target = new URL('../resources/presets.json', import.meta.url);
await mkdir(new URL('../resources/', import.meta.url), { recursive: true });
await writeFile(target, JSON.stringify(templates, null, 2) + '\n', 'utf8');
console.log(`已生成 ${templates.length} 个预设：${fileURLToPath(target)}`);
