import templates from '../../resources/presets.json' with { type: 'json' };
import { digest } from './compiler.js';
import type { Rule, Scheme } from './model.js';

export function presetCatalog() {
  return templates.map((template) => ({
    id: template.id,
    name: template.name,
    version: template.version,
    source: template.source,
    count: template.rules.length,
  }));
}

export function reviewPreset(scheme: Scheme, presetId: string, groupId: string) {
  const template = templates.find((row) => row.id === presetId);
  const group = scheme.groups.find((row) => row.id === groupId);
  if (!template || !group) throw new Error('预设或目标场景不存在');
  const incoming: Rule[] = template.rules.map((rule) => ({
    ...rule,
    id: `preset-${digest([template.id, rule.kind, rule.value, groupId]).slice(0, 24)}`,
    layer: 'preset',
    target: { kind: 'group', id: groupId },
    presetId,
  }));
  const existing = scheme.rules.filter(
    (rule) =>
      (rule.presetId === presetId || rule.presetId === `migration-${groupId}`) &&
      rule.target.kind === 'group' &&
      rule.target.id === groupId,
  );
  const key = (rule: Rule) => `${rule.kind}/${rule.value}/${rule.options.join(',')}`;
  return {
    template: {
      id: template.id,
      name: template.name,
      version: template.version,
      source: template.source,
    },
    additions: incoming.filter((rule) => !existing.some((old) => key(old) === key(rule))),
    removals: existing.filter((rule) => !incoming.some((next) => key(next) === key(rule))),
    existing: existing.length,
  };
}

export function applyPreset(
  scheme: Scheme,
  presetId: string,
  groupId: string,
  addIds: string[],
  removeIds: string[],
) {
  const review = reviewPreset(scheme, presetId, groupId);
  if (
    addIds.some((id) => !review.additions.some((rule) => rule.id === id)) ||
    removeIds.some((id) => !review.removals.some((rule) => rule.id === id))
  )
    throw new Error('预设审阅已过期，请重新查看差异');
  scheme.rules = scheme.rules.filter((rule) => !removeIds.includes(rule.id));
  scheme.rules.push(...review.additions.filter((rule) => addIds.includes(rule.id)));
  scheme.presets = scheme.presets.filter((preset) => preset.id !== presetId);
  scheme.presets.push(review.template);
  return scheme;
}
