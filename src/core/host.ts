import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import type { Device } from './model.js';

const exec = promisify(execFile);

export interface MonitorState {
  exists: boolean;
  running: boolean;
  enabled: boolean;
  name?: string;
  xml?: string;
  legacy?: boolean;
  migrate?: boolean;
}

export interface Host {
  discover?(): Promise<any>;
  inspect(device: Device): Promise<{ supported: boolean; version: string; running: boolean }>;
  running(device: Device): Promise<boolean>;
  preflight(device: Device, configFile: string): Promise<void>;
  start(device: Device): Promise<void>;
  monitorStatus(device: Device): Promise<MonitorState>;
  pauseMonitor(device: Device, state: MonitorState): Promise<void>;
  resumeMonitor(device: Device, state: MonitorState): Promise<void>;
  removeMonitor?(device: Device): Promise<void>;
  lock(device: Device): Promise<() => Promise<void>>;
}

export class SystemHost implements Host {
  constructor(
    private readonly resourcesDir: string,
    private readonly manager?: { executable: string; arguments: string; dataDir: string },
  ) {}

  private async native(action: string, args: object): Promise<any> {
    try {
      const response = await exec(
        path.join(this.resourcesDir, 'bin', 'ManagerNative.exe'),
        [action, JSON.stringify(args)],
        {
          windowsHide: true,
          encoding: 'utf8',
          timeout: action.startsWith('monitor-') ? 70000 : 15000,
        },
      );
      return JSON.parse(response.stdout);
    } catch {
      throw new Error('Windows 本机操作未完成，请核对程序身份、权限和运行状态');
    }
  }

  async discover(): Promise<any> {
    return this.native('discover', {});
  }

  async inspect(device: Device) {
    if (!device.appPath || !device.corePath)
      return { supported: false, version: '未指定客户端和内核', running: false };
    const capability = await this.native('inspect', device);
    try {
      const result = await exec(device.corePath, ['-v'], {
        windowsHide: true,
        encoding: 'utf8',
        timeout: 10000,
      });
      capability.supported &&= /Mihomo Meta v1\.19\.32 windows amd64\b/.test(result.stdout);
    } catch {
      capability.supported = false;
    }
    return capability;
  }

  async running(device: Device): Promise<boolean> {
    return (await this.native('status', device)).running;
  }

  async preflight(device: Device, configFile: string): Promise<void> {
    if (!device.corePath) throw new Error('请指定经过校验的 Mihomo 内核');
    try {
      await exec(device.corePath, ['-t', '-d', path.dirname(configFile), '-f', configFile], {
        windowsHide: true,
        encoding: 'utf8',
        timeout: 60000,
        env: { ...process.env, SAFE_PATHS: device.configDir },
      });
    } catch {
      throw new Error('目标内核预检未通过，私有配置和原始错误未回显');
    }
  }

  async start(device: Device): Promise<void> {
    if (!device.appPath) throw new Error('客户端路径未设置');
    await new Promise<void>((resolve, reject) => {
      const child = spawn(device.appPath!, [], {
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
      });
      child.once('error', () => reject(new Error('客户端启动失败')));
      child.once('spawn', () => {
        child.unref();
        resolve();
      });
    });
  }

  async monitorStatus(device: Device): Promise<MonitorState> {
    return this.native('monitor-status', device);
  }

  async pauseMonitor(device: Device, state: MonitorState): Promise<void> {
    if (!state.exists) return;
    await this.native('monitor-pause', { ...device, state });
  }

  async resumeMonitor(device: Device, state: MonitorState): Promise<void> {
    if (!state.exists && !state.migrate) return;
    if (state.migrate && !this.manager) throw new Error('后台程序启动参数未配置');
    await this.native('monitor-resume', {
      ...device,
      state,
      ...(state.migrate
        ? {
            migrate: true,
            managerExecutable: this.manager!.executable,
            managerArguments: this.manager!.arguments,
            dataDir: this.manager!.dataDir,
          }
        : {}),
    });
  }

  async removeMonitor(device: Device): Promise<void> {
    await this.native('monitor-remove', device);
  }

  async lock(device: Device, scope = 'device'): Promise<() => Promise<void>> {
    const child = spawn(
      path.join(this.resourcesDir, 'bin', 'ManagerNative.exe'),
      ['mutex', JSON.stringify({ ...device, scope })],
      { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] },
    );
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        child.stdin.end();
        reject(new Error('等待设备互斥超时'));
      }, 10000);
      child.once('error', () => {
        clearTimeout(timer);
        reject(new Error('设备互斥辅助程序无法启动'));
      });
      child.once('exit', () => {
        clearTimeout(timer);
        reject(new Error('设备互斥辅助程序已退出'));
      });
      child.stdout.once('data', (data) => {
        clearTimeout(timer);
        if (String(data).includes('locked')) resolve();
        else reject(new Error('设备互斥未取得'));
      });
    });
    return async () => {
      if (child.exitCode !== null) return;
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('设备互斥释放尚未确认')), 5000);
        child.once('exit', () => {
          clearTimeout(timer);
          resolve();
        });
        child.stdin.end();
      });
    };
  }
}
