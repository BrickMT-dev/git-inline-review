import * as vscode from 'vscode';
import { Hunk } from './diff';

/**
 * 用 proposed API「editorInsets」在編輯器的行與行之間插入 webview（底層是 Monaco 的 view zone），
 * 做出紅色的「被刪除行」+ 有顏色的 Keep / Undo 按鈕。
 *
 * 沒有啟用 proposed API 時 createWebviewTextEditorInset 會丟例外，
 * 此時 supported 變成 false，extension.ts 會退回 CodeLens + 幽靈文字的顯示方式。
 */

export type InsetAction = 'keep' | 'undo';

interface Entry {
  inset: vscode.WebviewEditorInset;
  disposed: boolean;
}

/** 一次最多建立的 inset 數（每個都是一個 webview，不能無上限） */
const MAX_INSETS_PER_EDITOR = 24;
/** 只替可視範圍附近的 hunk 建立 inset，捲動時再補 */
const VISIBLE_MARGIN = 60;
/** 被刪除的行最多畫幾行，其餘摺成「…還有 N 行」 */
const MAX_DELETED_ROWS = 40;

export class InsetRenderer implements vscode.Disposable {
  /** undefined = 尚未試過；true/false = 是否可用 */
  supported: boolean | undefined;
  private readonly byEditor = new Map<vscode.TextEditor, Map<string, Entry>>();

  constructor(
    private readonly onAction: (action: InsetAction, uri: vscode.Uri, line: number, editor: vscode.TextEditor) => void,
    private readonly onSupportDetected: (supported: boolean) => void,
    private readonly keys: { keep: string; undo: string },
  ) {}

  private rendering = false;

  render(editor: vscode.TextEditor, hunks: Hunk[], anchorOf: (h: Hunk) => number) {
    if (this.supported === false || this.rendering) return;
    this.rendering = true;
    try {
      this.doRender(editor, hunks, anchorOf);
    } finally {
      this.rendering = false;
    }
  }

  private doRender(editor: vscode.TextEditor, hunks: Hunk[], anchorOf: (h: Hunk) => number) {

    const lineCount = editor.document.lineCount;
    const vr = editor.visibleRanges;
    const minLine = (vr[0]?.start.line ?? 0) - VISIBLE_MARGIN;
    const maxLine = (vr[vr.length - 1]?.end.line ?? lineCount) + VISIBLE_MARGIN;

    // 計算這次應該存在的 inset：key 相同就沿用，避免打字時閃爍
    const wanted = new Map<string, { line: number; height: number; html: () => string; anchor: number }>();
    hunks.forEach((h, i) => {
      if (wanted.size >= MAX_INSETS_PER_EDITOR) return;
      const end = h.newStart + h.newLines.length;
      if (end < minLine || h.newStart > maxLine) return;
      // 每段變更一個區塊，放在變更上方：第一列是按鈕，下面是紅色的「被刪除行」
      const label = `${i + 1} / ${hunks.length}`;
      const shown = h.oldLines.slice(0, MAX_DELETED_ROWS);
      const extra = h.oldLines.length - shown.length;
      // inset 會出現在 `line` 這行（0-based）的「下方」，要放在變更上方就得傳前一行；
      // 變更在檔案第一行時傳 -1，會放在整個檔案最上面
      const line = Math.min(h.newStart, lineCount) - 1;
      wanted.set(`${line}:${label}:${h.oldLines.join('\n')}`, {
        line,
        height: 1 + shown.length + (extra > 0 ? 1 : 0),
        anchor: anchorOf(h),
        html: () => this.hunkHtml(label, shown, extra),
      });
    });

    let entries = this.byEditor.get(editor);
    if (!entries) {
      entries = new Map();
      this.byEditor.set(editor, entries);
    }
    for (const [key, e] of entries) {
      if (!wanted.has(key) || e.disposed) {
        e.inset.dispose();
        entries.delete(key);
      }
    }
    for (const [key, w] of wanted) {
      if (entries.has(key)) continue;
      const inset = this.create(editor, w.line, w.height);
      if (!inset) return;
      const entry: Entry = { inset, disposed: false };
      inset.onDidDispose(() => {
        entry.disposed = true;
        if (entries!.get(key) === entry) entries!.delete(key);
      });
      inset.webview.onDidReceiveMessage((m: { action?: InsetAction }) => {
        if (m?.action === 'keep' || m?.action === 'undo') this.onAction(m.action, editor.document.uri, w.anchor, editor);
      });
      inset.webview.html = w.html();
      entries.set(key, entry);
    }
  }

  /** 實際存在（已建立、尚未銷毀）的 inset 數，用來抓漏掉沒清的 inset */
  live = 0;

  /** 給整合測試用：此編輯器上 inset 所在的行 */
  lines(editor: vscode.TextEditor) {
    return [...(this.byEditor.get(editor)?.values() ?? [])].map((e) => e.inset.line).sort((a, b) => a - b);
  }

  clear(editor: vscode.TextEditor) {
    const entries = this.byEditor.get(editor);
    entries?.forEach((e) => e.inset.dispose());
    this.byEditor.delete(editor);
  }

  /** 清掉已經不可見的編輯器的紀錄（inset 本身會隨編輯器關閉自動銷毀） */
  prune(visible: readonly vscode.TextEditor[]) {
    for (const ed of [...this.byEditor.keys()]) if (!visible.includes(ed)) this.clear(ed);
  }

  clearAll() {
    for (const ed of [...this.byEditor.keys()]) this.clear(ed);
  }

  dispose() {
    this.clearAll();
  }

  private create(editor: vscode.TextEditor, line: number, height: number) {
    try {
      const inset = vscode.window.createWebviewTextEditorInset(editor, line, height, { enableScripts: true });
      this.live++;
      inset.onDidDispose(() => this.live--);
      if (this.supported !== true) {
        this.supported = true;
        // 延後通知：同步呼叫會在 render 迴圈中途再次 render，造成同一段重複建立
        setTimeout(() => this.onSupportDetected(true), 0);
      }
      return inset;
    } catch (e: any) {
      // 只有「proposed API 沒啟用」才判定為不支援；其他錯誤（例如編輯器剛被隱藏）忽略即可
      if (/proposal|proposed/i.test(String(e?.message ?? e))) {
        this.supported = false;
        setTimeout(() => {
          this.clearAll();
          this.onSupportDetected(false);
        }, 0);
      }
      return undefined;
    }
  }

  // ───────── HTML ─────────

  private page(rows: number, body: string) {
    return `<!DOCTYPE html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline';">
<style>
  html, body { margin: 0; padding: 0; height: 100%; overflow: hidden; background: var(--vscode-editor-background); }
  body { --row: calc(100vh / ${rows}); font-family: var(--vscode-editor-font-family); font-size: var(--vscode-editor-font-size); font-weight: var(--vscode-editor-font-weight); color: var(--vscode-editor-foreground); }
  .row { height: var(--row); line-height: var(--row); white-space: pre; overflow: hidden; }
  .del { background: rgba(248, 81, 73, .32); box-shadow: inset 3px 0 0 #f85149; padding-left: 6px; }
  .more { opacity: .7; font-style: italic; }
  .bar { height: var(--row); display: flex; align-items: center; gap: 6px; font-family: var(--vscode-font-family); }
  .label { font-size: 12px; opacity: .6; margin-left: 4px; }
  button { font-family: var(--vscode-font-family); font-size: 13px; font-weight: 700; line-height: 1;
           height: calc(var(--row) - 2px); min-height: 20px; padding: 0 12px; border-radius: 6px; cursor: pointer;
           display: inline-flex; align-items: center; gap: 6px; border: none; color: #fff;
           box-shadow: 0 1px 3px rgba(0, 0, 0, .35); transition: filter .1s, transform .05s; }
  button:hover { filter: brightness(1.15); }
  button:active { transform: translateY(1px); }
  button .k { font-size: 11px; font-weight: 600; opacity: .9; padding: 1px 4px; border-radius: 3px; background: rgba(0, 0, 0, .22); }
  .keep { background: #1fb34f; }
  .undo { background: #e5484d; }
</style></head><body>${body}
<script>
  const vscode = acquireVsCodeApi();
  document.querySelectorAll('button[data-action]').forEach((b) =>
    b.addEventListener('click', () => vscode.postMessage({ action: b.dataset.action })));
</script></body></html>`;
  }

  private hunkHtml(label: string, deleted: string[], extra: number) {
    const rows = [
      `<div class="bar">
<button class="keep" data-action="keep" title="git add 這段變更">✓ Keep <span class="k">${this.keys.keep}</span></button>
<button class="undo" data-action="undo" title="還原成 index 版本">↺ Undo <span class="k">${this.keys.undo}</span></button>
<span class="label">${label}</span></div>`,
      ...deleted.map((l) => `<div class="row del">${escapeHtml(l) || ' '}</div>`),
    ];
    if (extra > 0) rows.push(`<div class="row del more">  … 還有 ${extra} 行被刪除</div>`);
    return this.page(rows.length, rows.join(''));
  }
}

function escapeHtml(s: string) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\t/g, '    ');
}
