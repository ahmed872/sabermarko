import { contextBridge, ipcRenderer } from 'electron';

/**
 * The ONLY bridge between the sandboxed renderer and the main process.
 * No Node, filesystem or Electron APIs are exposed — just one RPC function.
 */
contextBridge.exposeInMainWorld('sbm', {
  invoke: (channel: string, payload?: unknown) => {
    if (typeof channel !== 'string' || channel.length > 64) return Promise.reject(new Error('bad channel'));
    return ipcRenderer.invoke('api', channel, payload);
  },
  platform: process.platform,
});
