import { execFileSync, spawnSync } from 'node:child_process';
import path from 'node:path';
const found = JSON.parse(
  execFileSync(path.resolve('resources/bin/ManagerNative.exe'), ['discover', '{}'], {
    encoding: 'utf8',
    windowsHide: true,
  }),
);
const core = found.applications.flatMap((application) => application.cores)[0];
if (!core) throw new Error('没有发现可用于隔离验收的内核');
const result = spawnSync(process.execPath, ['--import', 'tsx', '--test', 'test/mihomo.test.ts'], {
  stdio: 'inherit',
  windowsHide: true,
  env: { ...process.env, CLASH_MANAGER_TEST_CORE: core },
});
process.exitCode = result.status ?? 1;
