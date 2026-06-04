declare module 'qrcode' {
  interface QRCodeToDataURLOptions {
    width?: number;
    margin?: number;
    color?: {
      dark?: string;
      light?: string;
    };
  }
  function toDataURL(text: string, options?: QRCodeToDataURLOptions): Promise<string>;
  export = { toDataURL };
}
