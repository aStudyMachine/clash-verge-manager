import type { Reference, Scheme, Workspace } from './model.js';

export function affected(scheme: Scheme, workspace: Workspace, kind: 'group' | 'node' | 'source', id: string) {
  const removed = new Set(kind === 'source' ? scheme.members.filter(member => scheme.nodeRefs[member]?.sourceId === id || workspace.nodes.some(node => node.id === member && node.sourceId === id)) : [id]);
  const matches = (reference: Reference) => reference.kind === (kind === 'group' ? 'group' : 'node') && removed.has(reference.id);
  return {
    removed,
    matches,
    groups: scheme.groups.filter(group => group.members.some(matches)).map(group => ({ id: group.id, name: group.name })),
    rules: scheme.rules.filter(rule => matches(rule.target)).map(rule => ({ id: rule.id, kind: rule.kind, value: rule.value })),
    defaultTarget: matches(scheme.defaultTarget),
  };
}

export function removeObject(scheme: Scheme, workspace: Workspace, kind: 'group' | 'node' | 'source', id: string, replacement?: Reference, removeReferences = false) {
  const impact = affected(scheme, workspace, kind, id);
  if (replacement && impact.matches(replacement)) throw new Error('替代项不能是正在移除的对象');
  if (impact.defaultTarget && !replacement) throw new Error('默认出口仍引用该对象，请指定替代项');
  if ((impact.groups.length || impact.rules.length) && !replacement && !removeReferences) throw new Error('仍有组或规则引用，需明确替换或移除引用');
  for (const group of scheme.groups) group.members = group.members.flatMap(member => impact.matches(member) ? replacement ? [replacement] : [] : [member]);
  scheme.rules = scheme.rules.flatMap(rule => impact.matches(rule.target) ? replacement ? [{ ...rule, target: replacement }] : [] : [rule]);
  if (impact.defaultTarget) scheme.defaultTarget = replacement!;
  if (kind === 'group') {
    scheme.groups = scheme.groups.filter(group => group.id !== id);
    if (scheme.monitor?.groupId === id) delete scheme.monitor;
  } else {
    scheme.members = scheme.members.filter(member => !impact.removed.has(member));
    if (kind === 'node' && !scheme.excluded.includes(id)) scheme.excluded.push(id);
    if (kind === 'source') scheme.sourceIds = scheme.sourceIds.filter(sourceId => sourceId !== id);
  }
  return scheme;
}
