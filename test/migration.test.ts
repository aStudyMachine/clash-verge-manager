import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Manager } from '../src/core/manager.js';
import { fixture } from './fixture.js';

test('迁移现有场景及 provider 候选为固定名单，且不执行来源脚本', async () => {
  const root = await fixture();
  const configDir = path.join(root, 'verge');
  await mkdir(path.join(configDir, 'profiles'), { recursive: true });
  await writeFile(path.join(configDir, 'verge.yaml'), '{}');
  await writeFile(path.join(configDir, 'profiles.yaml'), 'current: aggregate\nitems:\n  - uid: remote1\n    type: remote\n    name: 测试来源\n    file: remote1.yaml\n    url: https://example.invalid/subscription\n  - uid: aggregate\n    type: local\n    name: 订阅聚合\n    file: aggregate.yaml\n    option:\n      script: script1\n  - uid: script1\n    type: script\n    file: script1.js\n');
  await writeFile(path.join(configDir, 'profiles', 'remote1.yaml'), 'proxies:\n  - name: 香港甲\n    type: ss\n    server: example.invalid\n    port: 443\n    password: example-only\n');
  await writeFile(path.join(configDir, 'profiles', 'aggregate.yaml'), 'mode: rule\n');
  await writeFile(path.join(configDir, 'profiles', 'script1.js'), 'throw new Error("不应执行来源脚本");');
  await writeFile(path.join(configDir, 'clash-verge.yaml'), 'proxy-providers:\n  airport:\n    type: http\n    url: https://example.invalid/subscription\n    path: ./profiles/remote1.yaml\n    override:\n      additional-prefix: "[测试来源] "\nproxy-groups:\n  - name: 主选择\n    type: select\n    proxies: [DIRECT]\n    use: [airport]\n  - name: 🤖 场景｜AI\n    type: select\n    proxies: [主选择]\nrules:\n  - DOMAIN-SUFFIX,example.com,🤖 场景｜AI\n  - MATCH,主选择\n');
  const manager = new Manager({ dataDir: path.join(root, 'data') });
  await manager.execute({ type: 'device.connect', configDir });
  await manager.execute({ type: 'migration.import' });
  const state = await manager.execute({ type: 'workspace.read' });
  const scheme = state.schemes[0];
  assert.equal(scheme.members.length, 1);
  assert.equal(scheme.groups[1].kind, 'scene');
  const preview = await manager.execute({ type: 'scheme.preview', schemeId: 'default' });
  assert.deepEqual(preview.groups[0].candidates, ['DIRECT', '[测试来源] 香港甲']);
  assert.deepEqual(preview.rules, ['DOMAIN-SUFFIX,example.com,🤖 场景｜AI', 'MATCH,主选择']);
  assert.equal(state.applied, null);
});
