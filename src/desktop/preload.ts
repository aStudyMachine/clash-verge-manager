import { contextBridge, ipcRenderer } from 'electron';
import type { Command } from '../core/model.js';

contextBridge.exposeInMainWorld('manager', {
  execute: (command: Command) => ipcRenderer.invoke('manager:command', command),
  choose: (kind: 'config' | 'client' | 'core') => ipcRenderer.invoke('manager:choose', kind),
  ready: () => ipcRenderer.send('manager:view-ready'),
});
