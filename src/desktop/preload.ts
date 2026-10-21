import { contextBridge, ipcRenderer } from 'electron';
import type { Command } from '../core/model.js';

contextBridge.exposeInMainWorld('manager', {
  execute: (command: Command) => ipcRenderer.invoke('manager:command', command),
  choose: (kind: 'config' | 'client' | 'core') => ipcRenderer.invoke('manager:choose', kind),
  ready: () => ipcRenderer.send('manager:view-ready'),
  beforeQuit: (save: () => Promise<void>) => {
    const listener = () => {
      void save().then(
        () => ipcRenderer.send('manager:quit-saved', true),
        () => ipcRenderer.send('manager:quit-saved', false),
      );
    };
    ipcRenderer.on('manager:before-quit', listener);
    return () => ipcRenderer.removeListener('manager:before-quit', listener);
  },
});
