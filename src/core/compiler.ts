import { createHash } from 'node:crypto';
import ipaddr from 'ipaddr.js';
import type { Issue, Scheme, Rule, Reference, Workspace, Command } from './model.js';

export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value).filter(([, entry]) => entry !== undefined).sort(([a], [b]) => a.localeCompare(b, 'en')).map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export function digest(value: unknown): string {
  return createHash('sha256').update(canonical(value)).digest('hex');
}

export function label(reference: Reference, scheme: Scheme, workspace: Workspace): string {
  if (reference.kind === 'builtin') return reference.id;
  if (reference.kind === 'group') return scheme.groups.find(group => group.id === reference.id)?.name ?? reference.id;
  return workspace.nodes.find(node => node.id === reference.id)?.displayName ?? reference.id;
}

export function validateScheme(scheme: Scheme): Issue[] {
  const issues: Issue[] = [];
  const ids = new Set<string>();
  const names = new Set<string>();
  for (const group of scheme.groups) {
    if (ids.has(group.id) || names.has(group.name) || ['DIRECT', 'REJECT'].includes(group.name)) {
      issues.push({ code: 'DUPLICATE_GROUP', message: '组标识或名称重复', objectId: group.id });
    }
    ids.add(group.id);
    names.add(group.name);
    if (/[,`\r\n]/.test(group.name) || group.name.startsWith('cm-node-')) issues.push({ code: 'INVALID_NAME', message: '组名包含配置分隔符或软件保留前缀', objectId: group.id });
    if (!group.members.length) issues.push({ code: 'EMPTY_GROUP', message: `代理组「${group.name}」没有候选`, objectId: group.id });
    if (new Set(group.members.map(member => `${member.kind}/${member.id}`)).size !== group.members.length) issues.push({ code: 'DUPLICATE_MEMBER', message: '同一组中有重复候选', objectId: group.id });
  }
  const groups = new Map(scheme.groups.map(group => [group.id, group]));
  const complete = new Set<string>();
  const visiting = new Set<string>();
  function visit(id: string): void {
    if (visiting.has(id)) {
      issues.push({ code: 'GROUP_CYCLE', message: '组引用存在循环', objectId: id });
      return;
    }
    if (complete.has(id)) return;
    const group = groups.get(id);
    if (!group) {
      issues.push({ code: 'MISSING_GROUP', message: '引用的代理组不存在', objectId: id });
      return;
    }
    visiting.add(id);
    for (const member of group.members) {
      if (member.kind === 'group') visit(member.id);
      if (member.kind === 'node' && !scheme.members.includes(member.id)) {
        issues.push({ code: 'OUTSIDE_MEMBERS', message: '候选节点不在本方案聚合成员中', objectId: member.id });
      }
      if (member.kind === 'builtin' && !['DIRECT', 'REJECT'].includes(member.id)) {
        issues.push({ code: 'INVALID_BUILTIN', message: '内置目标无效', objectId: member.id });
      }
    }
    visiting.delete(id);
    complete.add(id);
  }
  for (const group of scheme.groups) visit(group.id);
  return issues;
}

const priorities = { exception: 0, custom: 1, preset: 2, base: 3, final: 4 };
const supportedRules = new Set(['DOMAIN', 'DOMAIN-SUFFIX', 'DOMAIN-KEYWORD', 'IP-CIDR', 'IP-CIDR6', 'SRC-IP-CIDR', 'GEOIP', 'GEOSITE', 'PROCESS-NAME', 'PROCESS-PATH', 'NETWORK', 'DST-PORT', 'SRC-PORT']);

function ruleKey(rule: Rule): string {
  const value = rule.kind.startsWith('DOMAIN') ? rule.value.toLowerCase().replace(/\.$/, '') : rule.value;
  return `${rule.kind}/${value}/${rule.options.join(',')}`;
}

export function orderedRules(scheme: Scheme): Rule[] {
  const sorted = scheme.rules.map((rule, index) => ({ rule, index })).sort((a, b) => {
    const layer = priorities[a.rule.layer] - priorities[b.rule.layer];
    if (layer) return layer;
    if (a.rule.layer === 'preset') {
      const order: Record<string, number> = { DOMAIN: 0, 'DOMAIN-SUFFIX': 1, 'DOMAIN-KEYWORD': 2 };
      const specificity = (order[a.rule.kind] ?? 3) - (order[b.rule.kind] ?? 3);
      if (specificity) return specificity;
      if (a.rule.kind.startsWith('DOMAIN')) return b.rule.value.length - a.rule.value.length || a.index - b.index;
    }
    return a.index - b.index;
  });
  const keys = new Set<string>();
  return sorted.filter(({ rule }) => {
    const key = ruleKey(rule);
    if (keys.has(key)) return false;
    keys.add(key);
    return true;
  }).map(({ rule }) => rule);
}

export function previewScheme(scheme: Scheme, workspace: Workspace) {
  const issues = validateScheme(scheme);
  const checkReference = (reference: Reference, objectId: string): void => {
    if (reference.kind === 'group' && !scheme.groups.some(group => group.id === reference.id)) issues.push({ code: 'MISSING_GROUP', message: '规则或默认出口引用了不存在的组', objectId });
    if (reference.kind === 'node' && !scheme.members.includes(reference.id)) issues.push({ code: 'OUTSIDE_MEMBERS', message: '出口节点不在方案固定成员中', objectId });
    if (reference.kind === 'builtin' && !['DIRECT', 'REJECT'].includes(reference.id)) issues.push({ code: 'INVALID_BUILTIN', message: '内置出口无效', objectId });
  };
  for (const id of scheme.members) {
    const node = workspace.nodes.find(row => row.id === id);
    if (!node || node.missing) issues.push({ code: 'MISSING_NODE', message: '固定成员已失效或尚未在本机绑定', objectId: id });
    else if (!scheme.sourceIds.includes(node.sourceId)) issues.push({ code: 'SOURCE_DISABLED', message: '固定成员的来源未参与本方案', objectId: id });
    if (scheme.excluded.includes(id)) issues.push({ code: 'EXCLUDED_NODE', message: '固定成员仍在排除清单中，需明确重新允许', objectId: id });
    if (node && /[,`\r\n]/.test(node.displayName)) issues.push({ code: 'INVALID_NAME', message: '节点名称包含配置分隔符，无法安全编译', objectId: id });
  }
  for (const id of scheme.sourceIds) {
    if (!workspace.sources.some(source => source.id === id && !source.deleted)) issues.push({ code: 'MISSING_SOURCE', message: '方案引用的来源不存在或已删除', objectId: id });
  }
  const labels = new Set(['DIRECT', 'REJECT', ...scheme.groups.map(group => group.name)]);
  for (const id of scheme.members) {
    const name = workspace.nodes.find(node => node.id === id)?.displayName;
    if (name && labels.has(name)) issues.push({ code: 'COLLIDING_NAME', message: '节点或代理组的运行名称发生冲突', objectId: id });
    if (name) labels.add(name);
  }
  if (scheme.monitor) {
    const group = scheme.groups.find(group => group.id === scheme.monitor!.groupId);
    if (!group || group.strategy !== 'fallback' || group.members.some(member => member.kind !== 'node')) issues.push({ code: 'INVALID_MONITOR', message: '现有稳定监测只能关联由固定节点组成的故障转移池' });
  }
  const layers = new Map<string, string>();
  for (const rule of scheme.rules) {
    checkReference(rule.target, rule.id);
    if (!supportedRules.has(rule.kind) || !rule.value || /[\r\n,]/.test(rule.value)) issues.push({ code: 'UNSUPPORTED_RULE', message: '规则类型或匹配内容无法编译', objectId: rule.id });
    if (rule.options.some(option => option !== 'no-resolve') || (rule.options.length && !['IP-CIDR', 'IP-CIDR6', 'SRC-IP-CIDR', 'GEOIP'].includes(rule.kind))) issues.push({ code: 'RULE_OPTIONS', message: '当前规则类型不支持所选参数', objectId: rule.id });
    const key = `${rule.layer}/${ruleKey(rule)}`;
    const target = `${rule.target.kind}/${rule.target.id}`;
    if (layers.has(key) && layers.get(key) !== target) issues.push({ code: 'RULE_CONFLICT', message: '同层相同匹配条件指向不同出口', objectId: rule.id });
    layers.set(key, target);
  }
  checkReference(scheme.defaultTarget, scheme.id);
  const selectedRules = orderedRules(scheme);
  const rules = selectedRules.map(rule => [rule.kind, rule.value, label(rule.target, scheme, workspace), ...rule.options].join(','));
  rules.push(`MATCH,${label(scheme.defaultTarget, scheme, workspace)}`);
  const groups = scheme.groups.map(group => ({
    id: group.id, name: group.name, type: group.strategy,
    candidates: group.members.map(member => label(member, scheme, workspace)),
  }));
  return { valid: !issues.length, issues, groups, rules, schemeHash: digest(scheme), hash: digest({ scheme, sources: workspace.sources.filter(source => scheme.sourceIds.includes(source.id)).map(source => ({ id: source.id, name: source.name, prefix: source.prefix })) }), overridden: scheme.rules.length - selectedRules.length };
}

type Context = Extract<Command, { type: 'rule.explain' }>['context'];

function matches(rule: Rule, context: Context): boolean | undefined {
  const domain = context.domain?.toLowerCase().replace(/\.$/, '');
  const value = rule.value.toLowerCase();
  if (rule.kind === 'DOMAIN') return domain === undefined ? undefined : domain === value;
  if (rule.kind === 'DOMAIN-SUFFIX') return domain === undefined ? undefined : domain === value || domain.endsWith(`.${value}`);
  if (rule.kind === 'DOMAIN-KEYWORD') return domain === undefined ? undefined : domain.includes(value);
  if (rule.kind.startsWith('IP-CIDR')) {
    if (!context.ip) return undefined;
    try {
      const address = ipaddr.parse(context.ip);
      const [network, prefix] = ipaddr.parseCIDR(rule.value);
      return address.kind() === network.kind() && (address as ipaddr.IPv4).match(network as ipaddr.IPv4, prefix);
    } catch { return undefined; }
  }
  if (rule.kind === 'PROCESS-NAME' || rule.kind === 'PROCESS-PATH') return context.process === undefined ? undefined : context.process.toLowerCase() === value;
  if (rule.kind === 'NETWORK') return context.network === undefined ? undefined : context.network.toLowerCase() === value;
  if (rule.kind === 'DST-PORT') return context.port === undefined ? undefined : String(context.port) === rule.value;
  if (rule.kind === 'GEOIP') return context.country === undefined ? undefined : context.country.toLowerCase() === value;
  return undefined;
}

export function explainRule(scheme: Scheme, workspace: Workspace, context: Context) {
  const preview = previewScheme(scheme, workspace);
  if (!preview.valid) return { status: 'invalid', issues: preview.issues };
  for (const rule of orderedRules(scheme)) {
    const matched = matches(rule, context);
    if (matched === undefined) return { status: 'needs-context', ruleId: rule.id, message: '缺少该规则所需的域名、IP、进程或数据库上下文' };
    if (matched) return { status: 'matched', ruleId: rule.id, chain: [label(rule.target, scheme, workspace)] };
  }
  return { status: 'matched', ruleId: 'MATCH', chain: [label(scheme.defaultTarget, scheme, workspace)] };
}
