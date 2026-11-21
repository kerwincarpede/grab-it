// tauri-driver's capability: the app it launches and its arguments.
declare global {
  namespace WebdriverIO {
    interface Capabilities {
      "tauri:options"?: {
        application: string;
        args?: string[];
      };
    }
  }
}

export {};
