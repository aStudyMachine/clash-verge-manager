import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, Tray } from 'electron';
import { writeFile, mkdir, open } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Manager } from '../core/manager.js';
import { SystemHost } from '../core/host.js';
import { runMonitor } from '../core/monitor.js';
import { parseCommand, publicError } from '../core/commands.js';
import { emptyScheme, groupSchema, type Workspace } from '../core/model.js';

const argument = (name: string) => { const index = process.argv.indexOf(name); return index >= 0 ? process.argv[index + 1] : undefined; };
const monitorMode = process.argv.includes('--monitor');
const previewPath = argument('--render-preview');
const demo = process.argv.includes('--demo');
const resourcesDir = app.isPackaged ? path.join(process.resourcesPath, 'manager-resources') : path.join(app.getAppPath(), 'resources');
const dataDir = argument('--data-dir') ?? app.getPath('userData');
const desktopDir = path.dirname(fileURLToPath(import.meta.url));
let quitting = false;
let ready = false;
let tray: Tray | undefined;
let window: BrowserWindow | undefined;

if (!monitorMode && !previewPath && !app.requestSingleInstanceLock()) app.exit(0);

async function seedDemo() {
  const scheme = emptyScheme('default', '日常方案');
  const sources = [
    { id: 'evergreen', name: '示例来源 A', prefix: '[来源A] ', metadata: {}, fetchedAt: '2026-10-21T08:35:00+08:00' },
    { id: 'coast', name: '示例来源 B', prefix: '[来源B] ', metadata: {}, fetchedAt: '2026-10-21T08:40:00+08:00' },
  ];
  const names = ['香港 · 01', '香港 · 02', '台湾 · 01', '台湾 · 02', '新加坡 · IEPL 01', '新加坡 · IEPL 02', '日本 · 东京 01', '日本 · 东京 02', '韩国 · 首尔 01', '美国 · 洛杉矶 01', '英国 · 伦敦 01', '德国 · 法兰克福 01'];
  const nodes = names.map((name, index) => ({ id: `node-${index}`, sourceId: sources[index % 2].id, name, displayName: sources[index % 2].prefix + name, protocol: index % 3 ? 'ss' : 'trojan', missing: false }));
  scheme.sourceIds = sources.map(source => source.id);
  scheme.members = nodes.slice(0, 10).map(node => node.id);
  scheme.nodeRefs = Object.fromEntries(nodes.map(node => [node.id, { sourceId: node.sourceId, name: node.name }]));
  const group = (id: string, name: string, kind: 'general' | 'scene' | 'strategy', strategy: 'select' | 'url-test' | 'fallback', members: { kind: 'node' | 'group' | 'builtin'; id: string }[]) => groupSchema.parse({ id, name, kind, strategy, members });
  scheme.groups = [
    group('general', '🌐 默认｜通用代理', 'general', 'select', [{ kind: 'group', id: 'singapore' }, { kind: 'group', id: 'home' }]),
    group('ai', '🤖 场景｜AI', 'scene', 'select', [{ kind: 'group', id: 'home' }, { kind: 'node', id: 'node-0' }]),
    group('social', '💬 场景｜社交', 'scene', 'select', [{ kind: 'group', id: 'home' }]),
    group('google', '🔎 场景｜Google', 'scene', 'select', [{ kind: 'group', id: 'singapore' }, { kind: 'group', id: 'home' }]),
    group('media', '🎬 场景｜国际媒体', 'scene', 'select', [{ kind: 'group', id: 'general' }]),
    group('telegram', '✈ 场景｜Telegram', 'scene', 'select', [{ kind: 'group', id: 'singapore' }]),
    group('home', '🛡 稳定优先', 'strategy', 'fallback', nodes.slice(0, 4).map(node => ({ kind: 'node' as const, id: node.id }))),
    group('singapore', '⚡ 新加坡｜测速优选', 'strategy', 'url-test', nodes.slice(4, 6).map(node => ({ kind: 'node' as const, id: node.id }))),
  ];
  scheme.defaultTarget = { kind: 'group', id: 'general' };
  const state: Workspace = { schemaVersion: 1, schemes: [scheme], sources, nodes, device: { configDir: path.join(dataDir, 'demo-verge') }, applied: null };
  await mkdir(dataDir, { recursive: true });
  await writeFile(path.join(dataDir, 'workspace.json'), JSON.stringify(state), 'utf8');
}

async function main() {
  await app.whenReady();
  if (monitorMode) {
    const configDir = argument('--config-dir');
    if (!configDir) throw new Error('后台模式缺少配置目录');
    await runMonitor(configDir, resourcesDir);
    app.exit(0); return;
  }
  if (previewPath && (!demo || !argument('--data-dir'))) throw new Error('离屏预览必须使用独立的演示数据目录');
  if (demo) await seedDemo();
  const host = new SystemHost(resourcesDir, { executable: process.execPath, arguments: app.isPackaged ? '' : `"${app.getAppPath()}"`, dataDir });
  const manager = new Manager({ dataDir, resourcesDir, host, gitPath: path.join(resourcesDir, 'bin', 'mingit', 'cmd', 'git.exe') });
  const entry = path.join(desktopDir, '../renderer/index.html');
  window = new BrowserWindow({
    title: 'Clash 订阅管理器', width: 1540, height: 1000, minWidth: 1180, minHeight: 720,
    show: !previewPath, backgroundColor: '#f6f7f3', icon: path.join(resourcesDir, 'bin', 'app-icon.png'),
    autoHideMenuBar: true,
    webPreferences: { preload: path.join(desktopDir, 'preload.cjs'), nodeIntegration: false, contextIsolation: true, sandbox: true, offscreen: !!previewPath, backgroundThrottling: false },
  });
  if (previewPath) window.setSize(1680, 1080);
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', event => event.preventDefault());
  const allowed = (event: Electron.IpcMainInvokeEvent | Electron.IpcMainEvent) => event.sender === window?.webContents && event.senderFrame === window.webContents.mainFrame;
  ipcMain.handle('manager:command', async (event, value: unknown) => {
    if (!allowed(event)) throw new Error('请求来源无效');
    try {
      const command = parseCommand(value);
      if (demo && !['workspace.read', 'scheme.preview', 'preset.catalog', 'deployment.status'].includes(command.type)) throw new Error('演示预览不执行本机操作');
      return await manager.execute(command);
    } catch (error) { throw new Error(publicError(error)); }
  });
  ipcMain.handle('manager:choose', async (event, kind: unknown) => {
    if (!allowed(event) || !['config', 'client', 'core'].includes(String(kind)) || demo) throw new Error('文件选择请求无效');
    const result = await dialog.showOpenDialog(window!, { title: kind === 'config' ? '选择 Clash Verge 配置目录' : '选择已安装的程序', properties: kind === 'config' ? ['openDirectory'] : ['openFile'], ...(kind === 'config' ? {} : { filters: [{ name: '可执行程序', extensions: ['exe'] }] }) });
    return result.canceled ? null : result.filePaths[0];
  });
  ipcMain.on('manager:view-ready', async event => {
    if (!allowed(event) || ready) return;
    ready = true;
    if (previewPath) {
      await new Promise(resolve => setTimeout(resolve, 800));
      const screenshot = await window!.webContents.capturePage();
      await mkdir(path.dirname(previewPath), { recursive: true });
      const file = await open(previewPath, 'wx');
      try { await file.writeFile(screenshot.toPNG()); } finally { await file.close(); }
      quitting = true; app.exit(0);
    }
  });
  window.on('close', event => { if (!quitting && !previewPath) { event.preventDefault(); window?.hide(); } });
  if (!previewPath) {
    const icon = nativeImage.createFromPath(path.join(resourcesDir, 'bin', 'app-icon.png'));
    tray = new Tray(icon.resize({ width: 20, height: 20 }));
    tray.setToolTip('Clash 订阅管理器');
    tray.setContextMenu(Menu.buildFromTemplate([{ label: '打开配置工作台', click: () => window?.show() }, { type: 'separator' }, { label: '退出管理器（独立监测保持原状态）', click: () => app.quit() }]));
    tray.on('double-click', () => window?.show());
    app.on('second-instance', () => { window?.show(); window?.focus(); });
    let refreshing = false;
    const timer = setInterval(async () => {
      if (refreshing || quitting) return;
      refreshing = true;
      try {
        const state: Workspace = await manager.execute({ type: 'workspace.read' });
        for (const source of state.sources.filter(source => !source.deleted && source.privateRevision)) {
          if (source.uid && !source.cardPending) await manager.execute({ type: 'source.absorb', sourceId: source.id });
          if (Date.now() - Date.parse(source.fetchedAt ?? '') >= (source.intervalSeconds ?? 7200) * 1000) await manager.execute({ type: 'source.refresh', sourceId: source.id });
        }
      } catch { /* 刷新错误由来源状态记录，不回显私有内容。 */ }
      finally { refreshing = false; }
    }, 5000);
    app.on('before-quit', event => {
      if (quitting) return;
      event.preventDefault(); quitting = true; clearInterval(timer);
      void manager.execute({ type: 'deployment.cancel' }).then(() => manager.settle()).finally(() => { tray?.destroy(); app.exit(0); });
    });
  }
  await window.loadFile(entry);
  if (previewPath) setTimeout(() => { if (!ready) { quitting = true; app.exit(1); } }, 20000).unref();
}

main().catch(() => { process.stderr.write('配置管理器启动未完成，私有数据与原始错误未回显\n'); app.exit(1); });
