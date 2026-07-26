import { contextBridge, ipcRenderer } from 'electron';

type SelectDataRootResult = {
  canceled: boolean;
  dataRoot?: string;
  restartRequired?: boolean;
};

contextBridge.exposeInMainWorld('viforgeDesktop', {
  selectDataRoot: async (): Promise<SelectDataRootResult> => ipcRenderer.invoke('viforge:select-data-root') as Promise<SelectDataRootResult>,
  getAppVersion: async (): Promise<string> => ipcRenderer.invoke('viforge:get-app-version') as Promise<string>,
});
