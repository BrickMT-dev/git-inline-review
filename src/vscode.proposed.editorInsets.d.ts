// 來源：microsoft/vscode src/vscode-dts/vscode.proposed.editorInsets.d.ts
// 需要在 ~/.vscode/argv.json 加入 "enable-proposed-api": ["local.git-inline-review"] 才能使用

declare module 'vscode' {
  export interface WebviewEditorInset {
    readonly editor: TextEditor;
    readonly line: number;
    readonly height: number;
    readonly webview: Webview;
    readonly onDidDispose: Event<void>;
    dispose(): void;
  }

  export namespace window {
    export function createWebviewTextEditorInset(
      editor: TextEditor,
      line: number,
      height: number,
      options?: WebviewOptions,
    ): WebviewEditorInset;
  }
}
