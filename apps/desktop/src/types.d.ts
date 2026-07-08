declare module 'electron-squirrel-startup' {
  const started: boolean;
  export default started;
}

interface Window {
  viworkDesktop?: {
    selectDataRoot(): Promise<{
      canceled: boolean;
      dataRoot?: string;
      restartRequired?: boolean;
    }>;
  };
}
