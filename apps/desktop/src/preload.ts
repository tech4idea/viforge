import { contextBridge, ipcRenderer } from 'electron';

type SelectDataRootResult = {
  canceled: boolean;
  dataRoot?: string;
  restartRequired?: boolean;
};

contextBridge.exposeInMainWorld('viworkDesktop', {
  selectDataRoot: async (): Promise<SelectDataRootResult> => ipcRenderer.invoke('viwork:select-data-root') as Promise<SelectDataRootResult>,
});
