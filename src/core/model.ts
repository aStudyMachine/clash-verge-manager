import { z } from 'zod';

export const referenceSchema = z
  .object({
    kind: z.enum(['node', 'group', 'builtin']),
    id: z.string().min(1).max(500),
  })
  .strict();
export type Reference = z.infer<typeof referenceSchema>;

export const groupSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1).max(200),
    kind: z.enum(['general', 'scene', 'strategy']),
    strategy: z.enum(['select', 'url-test', 'fallback']),
    members: z.array(referenceSchema),
    interval: z.number().int().min(10).max(86400).default(300),
    timeout: z.number().int().min(1000).max(30000).default(5000),
    tolerance: z.number().int().min(0).max(10000).default(50),
    url: z
      .url()
      .refine((value) => {
        const url = new URL(value);
        return (
          ['http:', 'https:'].includes(url.protocol) &&
          !url.username &&
          !url.password &&
          !url.search &&
          !url.hash
        );
      })
      .default('https://www.gstatic.com/generate_204'),
  })
  .strict();
export type Group = z.infer<typeof groupSchema>;

export const ruleSchema = z
  .object({
    id: z.string().min(1),
    kind: z.string().min(1),
    value: z.string(),
    target: referenceSchema,
    layer: z.enum(['exception', 'custom', 'preset', 'base', 'final']),
    options: z.array(z.string()).default([]),
    presetId: z.string().optional(),
  })
  .strict();
export type Rule = z.infer<typeof ruleSchema>;

export const monitorSettingsSchema = z
  .object({
    enabled: z.boolean().default(true),
    pollSeconds: z.number().int().min(10).max(300).default(30),
    windowSeconds: z.number().int().min(300).max(7200).default(1200),
    freshSeconds: z.number().int().min(60).max(300).default(120),
    minSamples: z.number().int().min(3).max(100).default(10),
    failureThreshold: z.number().int().min(2).max(10).default(3),
    confirmRounds: z.number().int().min(2).max(20).default(3),
    cooldownSeconds: z.number().int().min(60).max(3600).default(180),
    improvementPoints: z.number().min(1).max(50).default(8),
    targetIntervalSeconds: z.number().int().min(120).max(3600).default(180),
    minTargetSamples: z.number().int().min(2).max(30).default(6),
    timeoutMs: z.number().int().min(1000).max(10000).default(5000),
    shortWindowSeconds: z.number().int().min(60).max(600).default(180),
    shortMinSamples: z.number().int().min(3).max(20).default(3),
    minSuccessPercent: z.number().min(50).max(100).default(80),
    quarantineSeconds: z.number().int().min(60).max(1800).default(120),
    recoverySuccesses: z.number().int().min(2).max(10).default(3),
    slowP95Ms: z.number().int().min(500).max(10000).default(3000),
    targetUrls: z
      .array(
        z.url().refine((value) => {
          const url = new URL(value);
          return (
            url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash
          );
        }),
      )
      .min(1)
      .max(4)
      .default(['https://www.google.com/generate_204']),
  })
  .strict();
export type MonitorSettings = z.infer<typeof monitorSettingsSchema>;

export const schemeSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1).max(160),
    schemaVersion: z.literal(1),
    sourceIds: z.array(z.string()).default([]),
    members: z.array(z.string()).default([]),
    nodeRefs: z
      .record(z.string(), z.object({ sourceId: z.string(), name: z.string() }).strict())
      .default({}),
    excluded: z.array(z.string()).default([]),
    groups: z.array(groupSchema).default([]),
    rules: z.array(ruleSchema).default([]),
    defaultTarget: referenceSchema.default({ kind: 'builtin', id: 'DIRECT' }),
    presets: z
      .array(
        z
          .object({ id: z.string(), name: z.string(), version: z.string(), source: z.string() })
          .strict(),
      )
      .default([]),
    monitor: z.object({ groupId: z.string(), settings: monitorSettingsSchema }).strict().optional(),
  })
  .strict();
export type Scheme = z.infer<typeof schemeSchema>;

export function emptyScheme(id: string, name: string): Scheme {
  return schemeSchema.parse({ id, name, schemaVersion: 1 });
}

export interface Issue {
  code: string;
  message: string;
  objectId?: string;
}

export interface Source {
  id: string;
  name: string;
  prefix: string;
  uid?: string;
  privateRevision?: string;
  fetchedAt?: string;
  attemptedAt?: string;
  stale?: boolean;
  cardPending?: boolean;
  error?: string;
  metadata: { upload?: number; download?: number; total?: number; expire?: number };
  dirty?: boolean;
  deleted?: boolean;
  intervalSeconds?: number;
  clientHash?: string;
  runtimeAt?: string;
  runtimeError?: string;
}

export interface NodeSummary {
  id: string;
  sourceId: string;
  name: string;
  displayName: string;
  protocol: string;
  missing: boolean;
}

export interface Device {
  configDir: string;
  appPath?: string;
  corePath?: string;
}

export interface Workspace {
  schemaVersion: 1;
  schemes: Scheme[];
  sources: Source[];
  nodes: NodeSummary[];
  device: Device | null;
  applied: null | {
    schemeId: string;
    hash: string;
    at: string;
    deploymentId: string;
    snapshot?: Scheme;
  };
  deletedSchemes?: string[];
  sync?: {
    remote: string;
    heads: Record<string, { version: string; hash: string }>;
    checkedAt?: string;
    error?: string;
    pending?: {
      requestId: string;
      scheme?: Scheme;
      schemes: Scheme[];
      sources: Source[];
      deletedSchemes: string[];
      summary: string;
    };
  };
}

export type Command =
  | { type: 'workspace.read' }
  | { type: 'scheme.create'; name: string }
  | { type: 'scheme.clone'; schemeId: string; name: string }
  | { type: 'scheme.remove'; schemeId: string }
  | { type: 'scheme.impact'; schemeId: string; kind: 'group' | 'node' | 'source'; id: string }
  | {
      type: 'scheme.removeObject';
      schemeId: string;
      kind: 'group' | 'node' | 'source';
      id: string;
      replacement?: Reference;
      removeReferences?: boolean;
    }
  | { type: 'scheme.save'; scheme: Scheme }
  | { type: 'scheme.preview'; schemeId: string }
  | {
      type: 'rule.explain';
      schemeId: string;
      context: {
        domain?: string;
        ip?: string;
        process?: string;
        network?: string;
        port?: number;
        country?: string;
      };
    }
  | { type: 'device.connect'; configDir: string; appPath?: string; corePath?: string }
  | { type: 'device.discover' }
  | { type: 'source.adopt'; uid: string; sourceId?: string }
  | { type: 'source.refresh'; sourceId: string }
  | { type: 'source.register'; name: string; url: string }
  | { type: 'source.impact'; sourceId: string }
  | { type: 'source.remove'; sourceId: string }
  | {
      type: 'source.update';
      sourceId: string;
      name: string;
      prefix: string;
      intervalSeconds: number;
      url?: string;
    }
  | { type: 'source.absorb'; sourceId: string }
  | { type: 'source.unlink'; sourceId: string }
  | { type: 'runtime.status' }
  | { type: 'monitor.status' }
  | { type: 'monitor.start' }
  | { type: 'monitor.stop' }
  | { type: 'monitor.preview' }
  | { type: 'recovery.list' }
  | { type: 'recovery.restore'; key: string }
  | { type: 'device.inspect' }
  | { type: 'scheme.apply'; schemeId: string }
  | { type: 'deployment.cancel' }
  | { type: 'deployment.status' }
  | { type: 'deployment.history' }
  | { type: 'deployment.preview'; schemeId: string }
  | { type: 'deployment.restore'; id: string }
  | { type: 'git.configure'; remote: string }
  | { type: 'git.authenticate' }
  | { type: 'git.resolvePending' }
  | { type: 'git.fetch' }
  | { type: 'git.publishChanges'; summary: string }
  | { type: 'git.history'; schemeId: string }
  | { type: 'scheme.publish'; schemeId: string; summary: string }
  | { type: 'migration.import'; confirmOverwrite?: boolean }
  | { type: 'preset.catalog' }
  | { type: 'preset.review'; schemeId: string; presetId: string; groupId: string }
  | {
      type: 'preset.apply';
      schemeId: string;
      presetId: string;
      groupId: string;
      addIds: string[];
      removeIds: string[];
    };
