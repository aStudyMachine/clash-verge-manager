import { z } from 'zod';
import { referenceSchema, schemeSchema, type Command } from './model.js';

const id = z.string().min(1).max(500);
const schemeId = { schemeId: id };
const sourceId = { sourceId: id };
const object = { ...schemeId, kind: z.enum(['group', 'node', 'source']), id };
const preset = { ...schemeId, presetId: id, groupId: id };
const shapes: Record<Command['type'], z.ZodRawShape> = {
  'workspace.read': {},
  'device.discover': {},
  'device.inspect': {},
  'runtime.status': {},
  'device.connect': {
    configDir: z.string().min(1),
    appPath: z.string().optional(),
    corePath: z.string().optional(),
  },
  'scheme.create': { name: z.string().min(1).max(160) },
  'scheme.clone': { ...schemeId, name: z.string().min(1).max(160) },
  'scheme.remove': schemeId,
  'scheme.save': { scheme: schemeSchema },
  'scheme.preview': schemeId,
  'scheme.impact': object,
  'scheme.removeObject': {
    ...object,
    replacement: referenceSchema.optional(),
    removeReferences: z.boolean().optional(),
  },
  'source.adopt': { uid: id, sourceId: id.optional() },
  'source.refresh': sourceId,
  'source.register': { name: z.string().min(1).max(160), url: z.string().max(8192) },
  'source.impact': sourceId,
  'source.remove': sourceId,
  'source.absorb': sourceId,
  'source.unlink': sourceId,
  'source.update': {
    ...sourceId,
    name: z.string().max(160),
    prefix: z.string().max(160),
    intervalSeconds: z.number().int(),
    url: z.string().max(8192).optional(),
  },
  'scheme.apply': schemeId,
  'deployment.cancel': {},
  'deployment.status': {},
  'deployment.history': {},
  'deployment.restore': { id },
  'deployment.preview': schemeId,
  'git.configure': { remote: z.string().max(4096) },
  'git.fetch': {},
  'git.history': schemeId,
  'git.authenticate': {},
  'git.resolvePending': {},
  'git.publishChanges': { summary: z.string().min(1).max(200) },
  'scheme.publish': { ...schemeId, summary: z.string().min(1).max(200) },
  'migration.import': { confirmOverwrite: z.boolean().optional() },
  'preset.catalog': {},
  'preset.review': preset,
  'preset.apply': { ...preset, addIds: z.array(id).max(10000), removeIds: z.array(id).max(10000) },
  'rule.explain': {
    ...schemeId,
    context: z
      .object({
        domain: z.string().max(500).optional(),
        ip: z.string().max(100).optional(),
        process: z.string().max(1000).optional(),
        network: z.string().max(20).optional(),
        port: z.number().int().min(0).max(65535).optional(),
        country: z.string().max(10).optional(),
      })
      .strict(),
  },
  'monitor.status': {},
  'monitor.start': {},
  'monitor.stop': {},
  'monitor.preview': {},
  'recovery.list': {},
  'recovery.restore': { key: id },
};

export function parseCommand(value: unknown): Command {
  if (
    !value ||
    typeof value !== 'object' ||
    !('type' in value) ||
    typeof value.type !== 'string' ||
    !Object.hasOwn(shapes, value.type)
  )
    throw new Error('不支持的应用命令');
  try {
    return z
      .object({ type: z.literal(value.type), ...shapes[value.type as Command['type']] })
      .strict()
      .parse(value) as Command;
  } catch {
    throw new Error('输入格式无效，请检查必填项、数值范围和引用');
  }
}

export function publicError(error: unknown): string {
  const message = error instanceof Error ? error.message : '';
  return /[\u4e00-\u9fff]/.test(message) &&
    message.length <= 400 &&
    !/https?:\/\/|password|secret|token/i.test(message)
    ? message
    : '操作未完成，私有数据与原始错误未回显；请检查输入、连接及本机状态';
}
