import { mkdir, open, unlink, readdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import type { Device } from './model.js';
import type { Host } from './host.js';
import { inside, readText, atomicWrite } from './storage.js';

// 所有设备写事务与旧同步器共用锁；仅恢复明确死亡的事务进程所留的锁。
export async function acquireDevice(
  host: Host,
  device: Device,
  recoveryPid?: number,
): Promise<() => Promise<void>> {
  const releaseHost = await host.lock(device);
  const leases: { file: string; handle: Awaited<ReturnType<typeof open>> }[] = [];
  const release = async () => {
    let failure: unknown;
    for (const lease of leases.reverse()) {
      try {
        await lease.handle.close();
        if ((await readText(lease.file)).trim() === String(process.pid)) await unlink(lease.file);
      } catch (error) {
        failure ??= error;
      }
    }
    try {
      await releaseHost();
    } catch (error) {
      failure ??= error;
    }
    if (failure) throw failure;
  };
  try {
    for (const relative of ['config-sync/repository.lock', 'config-sync/import.lock']) {
      const file = await inside(device.configDir, relative);
      try {
        const owner = await readText(file);
        const pid = recoveryPid ?? Number(owner.trim());
        if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error('设备锁内容无效，请人工核对');
        let alive = true;
        try {
          process.kill(pid, 0);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ESRCH') alive = false;
        }
        if (owner.trim() !== String(pid) || alive || (await readText(file)) !== owner)
          throw new Error('恢复锁仍由有效进程占用或已变化');
        if (recoveryPid === undefined) {
          const leaseDirectory = await inside(device.configDir, 'config-manager/leases');
          let leaseNames: string[] = [];
          try {
            leaseNames = await readdir(leaseDirectory);
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
          }
          let owned = false;
          for (const name of leaseNames.filter((name) => /^[a-f0-9-]{36}\.json$/.test(name))) {
            const lease = JSON.parse(await readText(path.join(leaseDirectory, name)));
            if (lease.schemaVersion === 1 && lease.owner === 'clash-manager' && lease.pid === pid)
              owned = true;
          }
          if (!owned) throw new Error('锁缺少新管理器归属证明，请先用原工具核对恢复');
          const directory = await inside(device.configDir, 'config-manager/transactions');
          let files: string[] = [];
          try {
            files = await readdir(directory);
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
          }
          for (const name of files.filter((name) => /^[a-f0-9-]{36}\.json$/.test(name))) {
            const record = JSON.parse(await readText(path.join(directory, name)));
            if (!['verified', 'restored'].includes(record.state))
              throw new Error('存在未完成事务，请先从历史恢复');
          }
        }
        const retained = await inside(
          device.configDir,
          `config-manager/lock-backups/${randomUUID()}.json`,
        );
        const backup = JSON.stringify({ path: relative, owner });
        await atomicWrite(retained, backup);
        if ((await readText(retained)) !== backup || (await readText(file)) !== owner)
          throw new Error('设备锁留档或基线校验失败');
        await unlink(file);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      await mkdir(path.dirname(file), { recursive: true });
      if (!leases.length) {
        const identity = await inside(
          device.configDir,
          `config-manager/leases/${randomUUID()}.json`,
        );
        await atomicWrite(
          identity,
          JSON.stringify({ schemaVersion: 1, owner: 'clash-manager', pid: process.pid }),
        );
      }
      const handle = await open(file, 'wx');
      leases.push({ file, handle });
      await handle.writeFile(String(process.pid));
    }
    return release;
  } catch (error) {
    await release();
    throw error;
  }
}
