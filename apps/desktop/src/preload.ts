import { contextBridge, ipcRenderer } from 'electron';

type SelectDataRootResult = {
  canceled: boolean;
  dataRoot?: string;
  restartRequired?: boolean;
};

contextBridge.exposeInMainWorld('viforgeDesktop', {
  selectDataRoot: async (): Promise<SelectDataRootResult> => ipcRenderer.invoke('viforge:select-data-root') as Promise<SelectDataRootResult>,
});
