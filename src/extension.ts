import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import {
  Hunk,
  applyHunkToOld,
  computeHunks,
  detectEol,
  revertHunkInNew,
  splitLines,
} from './diff';
import {
  clearRepoCache,
  findRepo,
  guessMode,
  listChangedFiles,
  readIndexEntry,
  removeFromIndex,
  toGitPath,
  writeIndexContent,
} from './git';
import { InsetRenderer } from './insets';
import { SnapshotStore, isSensitiveFile, readTextFile } from './snapshots';
import { handleCreated, indexWorkspace, readIndexOptions } from './indexer';

const isMac = process.platform === 'darwin';
const KEEP_KEY = isMac ? '⌘Y' : 'Ctrl+Alt+Y';
const UNDO_KEY = isMac ? '⌘N' : 'Ctrl+Alt+N';
const INDEX_SCHEME = 'inline-git-index';

/** 某份文件的比較基準（依內容快取，打字時只重算 diff） */
interface Baseline {
  /** git：跟 git index 比；snapshot：git 管不到的檔案，跟擴充自己存的快照比 */
  source: 'git' | 'snapshot';
  absPath: string;
  root: string;
  rel: string;
  gitDir: string;
  untracked: boolean;
  mode: string;
  /** 基準內容（git index 或快照；untracked 時為空字串） */
  indexText: string;
}

interface FileState {
  baseline: Baseline;
  hunks: Hunk[];
  version: number;
}

/** 經典樣式（跟隨佈景主題的柔和綠） */
let addedDeco: vscode.TextEditorDecorationType;
/** 嵌入區塊樣式（鮮豔綠 + 左側粗線） */
let addedVividDeco: vscode.TextEditorDecorationType;
let removedDeco: vscode.TextEditorDecorationType;
let removedAtEndDeco: vscode.TextEditorDecorationType;

const baselines = new Map<string, Promise<Baseline | undefined>>();
const states = new Map<string, FileState>();
const indexWatchers = new Map<string, vscode.Disposable>();
const refreshTimers = new Map<string, NodeJS.Timeout>();
const codeLensEmitter = new vscode.EventEmitter<void>();
let statusItem: vscode.StatusBarItem;
let fileStatusItem: vscode.StatusBarItem;
/** 目前 repo 中待檢查（與 index 不同）的檔案，供「換檔」按鈕與狀態列使用 */
let pending: { root: string; files: string[] } | undefined;
let pendingTimer: NodeJS.Timeout | undefined;
/** 標題列計數器目前的值（同步給 context key，也給整合測試讀） */
let fileCounter = { index: 0, count: 0 };
let renderer: InsetRenderer;
let snapshots: SnapshotStore;
/** 開專案時的基準索引是否完成（完成後新出現的檔案才當成「新增檔案」） */
let indexed = false;
let busy = false;

function cfg() {
  return vscode.workspace.getConfiguration('inlineGitReview');
}
function enabled() {
  return cfg().get<boolean>('enabled', true);
}

export function activate(context: vscode.ExtensionContext) {
  addedDeco = vscode.window.createTextEditorDecorationType({
    isWholeLine: true,
    backgroundColor: new vscode.ThemeColor('diffEditor.insertedLineBackground'),
    overviewRulerColor: new vscode.ThemeColor('editorOverviewRuler.addedForeground'),
    overviewRulerLane: vscode.OverviewRulerLane.Left,
  });
  addedVividDeco = vscode.window.createTextEditorDecorationType({
    isWholeLine: true,
    backgroundColor: 'rgba(46, 204, 64, 0.22)',
    borderColor: '#2ecc40',
    borderStyle: 'solid',
    borderWidth: '0 0 0 3px',
    overviewRulerColor: '#2ecc40',
    overviewRulerLane: vscode.OverviewRulerLane.Left,
  });
  // 被刪掉的行：VS Code API 無法插入「虛擬行」，所以用紅色上框線 + 行尾幽靈文字標示，完整內容在 hover / CodeLens
  removedDeco = vscode.window.createTextEditorDecorationType({
    isWholeLine: true,
    borderColor: new vscode.ThemeColor('editorGutter.deletedBackground'),
    borderStyle: 'solid',
    borderWidth: '2px 0 0 0',
    overviewRulerColor: new vscode.ThemeColor('editorOverviewRuler.deletedForeground'),
    overviewRulerLane: vscode.OverviewRulerLane.Left,
  });
  removedAtEndDeco = vscode.window.createTextEditorDecorationType({
    isWholeLine: true,
    borderColor: new vscode.ThemeColor('editorGutter.deletedBackground'),
    borderStyle: 'solid',
    borderWidth: '0 0 2px 0',
    overviewRulerColor: new vscode.ThemeColor('editorOverviewRuler.deletedForeground'),
    overviewRulerLane: vscode.OverviewRulerLane.Left,
  });

  snapshots = new SnapshotStore(path.join(context.globalStorageUri.fsPath, 'snapshots'));
  // 清掉舊版本可能存下的機密檔案快照
  if (!cfg().get<boolean>('snapshotSensitiveFiles', false)) {
    snapshots.all().filter(isSensitiveFile).forEach((p) => snapshots.delete(p));
  }
  // 狀態列右側：「段落 1/3」「檔案 21/30」（標題列的按鈕文字無法動態變更，計數放這裡）
  statusItem = vscode.window.createStatusBarItem('inlineGitReview.hunks', vscode.StatusBarAlignment.Right, 1001);
  statusItem.name = 'Inline Review：變更段落';
  statusItem.command = 'inlineGitReview.nextHunk';
  fileStatusItem = vscode.window.createStatusBarItem('inlineGitReview.files', vscode.StatusBarAlignment.Right, 1000);
  fileStatusItem.name = 'Inline Review：待檢查檔案';
  fileStatusItem.command = 'inlineGitReview.pickFile';
  renderer = new InsetRenderer(
    async (action, uri, line, editor) => {
      if (action === 'keep') await keepHunk(uri, line);
      else await undoHunk(uri, line);
      // 點 webview 按鈕會把焦點帶走，還給編輯器
      if (vscode.window.visibleTextEditors.includes(editor)) {
        await vscode.window.showTextDocument(editor.document, editor.viewColumn);
      }
    },
    () => updateUi(),
    { keep: KEEP_KEY, undo: UNDO_KEY },
  );
  if (!cfg().get<boolean>('useInsets', false)) renderer.supported = false;
  let scrollTimer: NodeJS.Timeout | undefined;

  const fsWatcher = vscode.workspace.createFileSystemWatcher('**/*');
  // git 管不到的檔案：檔案變動時只重新比對那一個，不必整批重讀
  const noisy = (uri: vscode.Uri) => {
    const segs = uri.fsPath.split(path.sep);
    return segs.includes('.git') || readIndexOptions().excludeFolders.some((f) => segs.includes(f));
  };
  const onFsChange = (uri: vscode.Uri) => {
    if (noisy(uri)) return; // 建置時 build/、node_modules/ 會大量寫檔，不必每次都重新檢查
    const abs = realpath(uri.fsPath);
    if (snapshots.has(abs)) snapshots.check(abs);
    schedulePendingRefresh(500);
  };
  fsWatcher.onDidChange(onFsChange);
  fsWatcher.onDidDelete(onFsChange);
  fsWatcher.onDidCreate(async (uri) => {
    if (noisy(uri)) return;
    if (indexed && indexingEnabled()) await handleCreated(snapshots, uri.fsPath, readIndexOptions()).catch(() => undefined);
    onFsChange(uri);
  });

  const cmd = (id: string, fn: (...args: any[]) => unknown) =>
    vscode.commands.registerCommand(`inlineGitReview.${id}`, async (...args) => {
      try {
        await fn(...args);
      } catch (e: any) {
        vscode.window.showErrorMessage(`Inline Git Review：${e?.message ?? e}`);
      }
    });

  context.subscriptions.push(
    addedDeco,
    addedVividDeco,
    removedDeco,
    removedAtEndDeco,
    statusItem,
    fileStatusItem,
    renderer,
    fsWatcher,
    codeLensEmitter,
    cmd('keepHunk', (uri?: UriArg, line?: number) => keepHunk(uri, line)),
    cmd('undoHunk', (uri?: UriArg, line?: number) => undoHunk(uri, line)),
    cmd('keepFile', (uri?: UriArg) => keepFile(uri)),
    cmd('undoFile', (uri?: UriArg) => undoFile(uri)),
    cmd('nextHunk', () => navigate(1)),
    cmd('prevHunk', () => navigate(-1)),
    // 標題列的文字按鈕：另外註冊一組沒有綁快捷鍵的指令，否則 VS Code 會在文字下方多顯示一行快捷鍵
    ...(['prevHunk', 'nextHunk', 'prevFile', 'nextFile', 'undoFile', 'keepFile'] as const).map((id) =>
      vscode.commands.registerCommand(`inlineGitReview.bar.${id}`, () => vscode.commands.executeCommand(`inlineGitReview.${id}`)),
    ),
    cmd('pickFile', () => pickFile()),
    cmd('rebuildBaselines', () => rebuildBaselines()),
    cmd('undoLastReview', (args?: { fromKeybinding?: boolean }) => undoLastReview(args)),
    cmd('nextFile', () => gotoFile(1)),
    cmd('prevFile', () => gotoFile(-1)),
    cmd('openDiff', (uri?: UriArg) => openDiff(uri)),
    cmd('toggle', async () => {
      await cfg().update('enabled', !enabled(), vscode.ConfigurationTarget.Global);
    }),
    cmd('refresh', () => invalidateAll()),
    // 整合測試用：只在開發／測試模式註冊，正式安裝的版本沒有這個指令
    ...(context.extensionMode === vscode.ExtensionMode.Production ? [] : [registerDebugCommand()]),
  );

  function registerDebugCommand() {
    return vscode.commands.registerCommand('inlineGitReview._debugState', () => {
      const ed = vscode.window.activeTextEditor;
      return {
        insetsSupported: renderer.supported,
        insetLines: ed ? renderer.lines(ed) : [],
        liveInsets: renderer.live,
        pendingFiles: pending?.files ?? [],
        fileCounter,
        indexed,
        hunks: ed ? states.get(ed.document.uri.toString())?.hunks.length ?? 0 : 0,
        source: ed ? states.get(ed.document.uri.toString())?.baseline.source : undefined,
      };
    });
  }

  context.subscriptions.push(
    vscode.languages.registerCodeLensProvider({ scheme: 'file' }, { provideCodeLenses, onDidChangeCodeLenses: codeLensEmitter.event }),
    vscode.languages.registerHoverProvider({ scheme: 'file' }, { provideHover }),
    vscode.workspace.registerTextDocumentContentProvider(INDEX_SCHEME, {
      provideTextDocumentContent: async (uri) => {
        const fileUri = vscode.Uri.parse(uri.query);
        const b = await getBaseline(fileUri);
        return b?.indexText ?? '';
      },
    }),
    vscode.workspace.onDidChangeTextDocument((e) => scheduleRefresh(e.document, 120)),
    vscode.workspace.onDidSaveTextDocument((doc) => {
      scheduleRefresh(doc, 0);
      schedulePendingRefresh(300);
    }),
    vscode.workspace.onDidCloseTextDocument((doc) => {
      states.delete(doc.uri.toString());
      baselines.delete(doc.uri.toString());
    }),
    vscode.window.onDidChangeVisibleTextEditors((eds) => {
      renderer.prune(eds);
      eds.forEach((ed) => scheduleRefresh(ed.document, 0));
    }),
    vscode.window.onDidChangeTextEditorVisibleRanges((e) => {
      clearTimeout(scrollTimer);
      scrollTimer = setTimeout(() => renderInsets(e.textEditor), 120);
    }),
    vscode.window.onDidChangeActiveTextEditor(() => {
      updateUi();
      schedulePendingRefresh(0);
    }),
    vscode.window.onDidChangeTextEditorSelection(() => updateContextKeys()),
    vscode.window.onDidChangeWindowState((s) => s.focused && invalidateAll()),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('inlineGitReview.useInsets')) {
        renderer.clearAll();
        renderer.supported = cfg().get<boolean>('useInsets', false) ? undefined : false;
      }
      if (e.affectsConfiguration('inlineGitReview')) invalidateAll();
      if (['indexOnOpen', 'indexExtensions', 'indexExcludeFolders', 'indexMaxFiles', 'trackIgnoredFiles'].some((k) =>
        e.affectsConfiguration(`inlineGitReview.${k}`))) runIndex();
    }),
    { dispose: () => indexWatchers.forEach((w) => w.dispose()) },
  );

  invalidateAll();
  runIndex();
}

export function deactivate() {}

// ───────────────────────── 開專案時建立基準 ─────────────────────────

function indexingEnabled() {
  return cfg().get<boolean>('trackIgnoredFiles', true) && cfg().get<boolean>('indexOnOpen', true);
}

let indexRun: Promise<void> | undefined;

function runIndex() {
  if (!indexingEnabled()) {
    indexed = true;
    return;
  }
  const run = (async () => {
    const msg = vscode.window.setStatusBarMessage('$(sync~spin) Inline Review：建立 git 管不到的檔案基準…');
    try {
      const n = await indexWorkspace(snapshots, readIndexOptions());
      if (n > 0) vscode.window.setStatusBarMessage(`$(check) Inline Review：已替 ${n} 個 git 管不到的檔案建立基準`, 4000);
    } catch (e) {
      console.error('inline review index failed', e);
    } finally {
      msg.dispose();
      indexed = true;
      vscode.window.visibleTextEditors.forEach((ed) => scheduleRefresh(ed.document, 0));
      schedulePendingRefresh(0);
    }
  })();
  indexRun = run;
  return run;
}

/** 把所有 git 管不到的檔案的基準重設成目前內容（等於全部 Keep），再重新掃描一次 */
async function rebuildBaselines() {
  const pick = await vscode.window.showWarningMessage(
    '要把 git 管不到的檔案的基準全部重設成目前的內容嗎？（等於全部 Keep，現有的變更標示會消失）',
    { modal: true },
    '重設',
  );
  if (pick !== '重設') return;
  await indexRun;
  for (const folder of vscode.workspace.workspaceFolders ?? []) {
    for (const abs of snapshots.pathsUnder(realpath(folder.uri.fsPath))) {
      const disk = readTextFile(abs);
      if (disk === undefined) snapshots.delete(abs);
      else snapshots.set(abs, disk);
    }
  }
  baselines.clear();
  await runIndex();
  invalidateAll();
}

// ───────────────────────── 狀態計算 ─────────────────────────

function getBaseline(uri: vscode.Uri): Promise<Baseline | undefined> {
  const key = uri.toString();
  let p = baselines.get(key);
  if (!p) {
    p = loadBaseline(uri).catch(() => undefined);
    baselines.set(key, p);
  }
  return p;
}

async function loadBaseline(uri: vscode.Uri): Promise<Baseline | undefined> {
  if (uri.scheme !== 'file') return undefined;
  let absPath = uri.fsPath;
  try {
    absPath = fs.realpathSync.native(absPath);
  } catch {
    /* 新檔可能還沒存到磁碟 */
  }
  const repo = await findRepo(absPath);
  if (repo) {
    const rel = toGitPath(repo.root, absPath);
    if (rel.startsWith('..') || rel.startsWith('.git/')) return undefined;
    watchIndex(repo.gitDir);

    const entry = await readIndexEntry(repo.root, rel);
    const git = { source: 'git' as const, absPath, root: repo.root, gitDir: repo.gitDir, rel };
    if (entry.kind === 'tracked') {
      snapshots.delete(absPath); // 改由 git 管了，舊快照作廢
      return { ...git, untracked: false, mode: entry.mode, indexText: entry.content };
    }
    if (entry.kind === 'untracked') {
      if (!cfg().get<boolean>('showUntracked', true)) return undefined;
      snapshots.delete(absPath);
      return { ...git, untracked: true, mode: guessMode(absPath), indexText: '' };
    }
    if (entry.kind === 'ignored') return snapshotBaseline(absPath, repo.root);
    return undefined;
  }
  // 不在任何 git repo 裡：只處理工作區資料夾內的檔案
  const folder = vscode.workspace.getWorkspaceFolder(uri);
  if (!folder) return undefined;
  return snapshotBaseline(absPath, realpath(folder.uri.fsPath));
}

/** git 管不到的檔案：第一次看到時記下磁碟內容當基準，之後跟這份快照比 */
function snapshotBaseline(absPath: string, root: string): Baseline | undefined {
  if (!cfg().get<boolean>('trackIgnoredFiles', true)) return undefined;
  if (isSensitiveFile(absPath) && !cfg().get<boolean>('snapshotSensitiveFiles', false)) return undefined;
  const common = { source: 'snapshot' as const, absPath, root, rel: toGitPath(root, absPath), gitDir: '', mode: '' };
  // 建立基準之後才出現的新檔：整份都是新增（Undo 會刪檔）
  if (snapshots.isNew(absPath)) return { ...common, untracked: true, indexText: '' };
  let content = snapshots.get(absPath);
  if (content === undefined) {
    content = readTextFile(absPath);
    if (content === undefined) return undefined;
    snapshots.set(absPath, content);
  }
  return {
    source: 'snapshot',
    absPath,
    root,
    rel: toGitPath(root, absPath),
    gitDir: '',
    untracked: false,
    mode: '',
    indexText: content,
  };
}

function realpath(p: string) {
  try {
    return fs.realpathSync.native(p);
  } catch {
    return p;
  }
}

/** 使用者在終端機 git add / commit / checkout 時，index 會變，要重新讀取 */
function watchIndex(gitDir: string) {
  if (indexWatchers.has(gitDir)) return;
  const watcher = vscode.workspace.createFileSystemWatcher(
    new vscode.RelativePattern(vscode.Uri.file(gitDir), 'index'),
  );
  let timer: NodeJS.Timeout | undefined;
  const onChange = () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      if (busy) return; // 我們自己寫入 index 時會自行刷新
      for (const [key, p] of [...baselines]) {
        p.then((b) => {
          if (b?.gitDir === gitDir) baselines.delete(key);
        });
      }
      setTimeout(() => vscode.window.visibleTextEditors.forEach((ed) => scheduleRefresh(ed.document, 0)), 0);
      schedulePendingRefresh(0);
    }, 150);
  };
  watcher.onDidChange(onChange);
  watcher.onDidCreate(onChange);
  watcher.onDidDelete(onChange);
  indexWatchers.set(gitDir, watcher);
}

function invalidateAll() {
  baselines.clear();
  clearRepoCache();
  states.clear();
  vscode.window.visibleTextEditors.forEach((ed) => scheduleRefresh(ed.document, 0));
  updateUi();
  schedulePendingRefresh(0);
}

function scheduleRefresh(doc: vscode.TextDocument, delay: number) {
  if (doc.uri.scheme !== 'file') return;
  const key = doc.uri.toString();
  clearTimeout(refreshTimers.get(key));
  refreshTimers.set(
    key,
    setTimeout(() => {
      refreshTimers.delete(key);
      refresh(doc).catch(() => undefined);
    }, delay),
  );
}

async function refresh(doc: vscode.TextDocument): Promise<FileState | undefined> {
  const key = doc.uri.toString();
  if (!enabled()) {
    states.delete(key);
    updateUi();
    return undefined;
  }
  const baseline = await getBaseline(doc.uri);
  if (!baseline) {
    states.delete(key);
    updateUi();
    return undefined;
  }
  const oldLines = baseline.untracked ? [''] : splitLines(baseline.indexText);
  const hunks = computeHunks(oldLines, splitLines(doc.getText()));
  const state: FileState = { baseline, hunks, version: doc.version };
  const prevCount = states.get(key)?.hunks.length ?? 0;
  states.set(key, state);
  if ((prevCount === 0) !== (hunks.length === 0)) schedulePendingRefresh(200);
  updateUi();
  return state;
}

/** 取得「跟目前文件版本一致」的最新狀態 */
async function freshState(doc: vscode.TextDocument): Promise<FileState | undefined> {
  const s = states.get(doc.uri.toString());
  if (s && s.version === doc.version) return s;
  return refresh(doc);
}

/** hunk 在編輯器中要掛標記的那一行 */
function anchorLine(h: Hunk, lineCount: number): number {
  return Math.min(h.newStart, lineCount - 1);
}

function hunkContainsLine(h: Hunk, line: number, lineCount: number): boolean {
  if (h.newLines.length > 0) return line >= h.newStart && line < h.newStart + h.newLines.length;
  return line === anchorLine(h, lineCount);
}

// ───────────────────────── UI ─────────────────────────

function updateUi() {
  for (const ed of vscode.window.visibleTextEditors) renderDecorations(ed);
  codeLensEmitter.fire();
  updateContextKeys();
}

function renderDecorations(ed: vscode.TextEditor) {
  const state = states.get(ed.document.uri.toString());
  const added: vscode.DecorationOptions[] = [];
  const removed: vscode.DecorationOptions[] = [];
  const removedAtEnd: vscode.DecorationOptions[] = [];
  const lineCount = ed.document.lineCount;

  for (const h of state?.hunks ?? []) {
    const isEmptyTrailingLine = (l: number) => l === lineCount - 1 && ed.document.lineAt(l).text === '';
    for (let i = 0; i < h.newLines.length; i++) {
      const line = h.newStart + i;
      if (line >= lineCount || isEmptyTrailingLine(line)) continue;
      added.push({ range: new vscode.Range(line, 0, line, 0) });
    }
    if (h.oldLines.length > 0) {
      const preview = h.oldLines[0].trim() || '(空白行)';
      const more = h.oldLines.length > 1 ? `  …共刪除 ${h.oldLines.length} 行` : '';
      const ghost: vscode.DecorationOptions['renderOptions'] = {
        after: {
          contentText: `   ⊖ ${truncate(preview, 60)}${more}`,
          color: new vscode.ThemeColor('editorGutter.deletedBackground'),
          fontStyle: 'italic',
          textDecoration: 'line-through',
        },
      };
      const line = anchorLine(h, lineCount);
      const range = new vscode.Range(line, 0, line, 0);
      // 刪除點落在檔尾之後時，畫在最後一行的「下方」
      if (h.newStart >= lineCount) removedAtEnd.push({ range, renderOptions: ghost });
      else removed.push({ range, renderOptions: ghost });
    }
  }
  // 有 inset 時，被刪除的行改由 inset 畫成紅色整行，不再需要幽靈文字
  const useInsets = renderer.supported === true;
  ed.setDecorations(addedDeco, useInsets ? [] : added);
  ed.setDecorations(addedVividDeco, useInsets ? added : []);
  ed.setDecorations(removedDeco, useInsets ? [] : removed);
  ed.setDecorations(removedAtEndDeco, useInsets ? [] : removedAtEnd);
  renderInsets(ed);
}

function renderInsets(ed: vscode.TextEditor) {
  const hunks = states.get(ed.document.uri.toString())?.hunks ?? [];
  const lc = ed.document.lineCount;
  renderer.render(ed, hunks, (h) => anchorLine(h, lc));
}

function provideCodeLenses(doc: vscode.TextDocument): vscode.CodeLens[] {
  const state = states.get(doc.uri.toString());
  if (!state || !cfg().get<boolean>('showCodeLens', true) || renderer.supported === true) return [];
  const lenses: vscode.CodeLens[] = [];
  state.hunks.forEach((h, i) => {
    const line = anchorLine(h, doc.lineCount);
    const range = new vscode.Range(line, 0, line, 0);
    const summary =
      h.newLines.length && h.oldLines.length
        ? `~${h.newLines.length} 行`
        : h.newLines.length
          ? `+${h.newLines.length} 行`
          : `−${h.oldLines.length} 行`;
    lenses.push(
      new vscode.CodeLens(range, {
        title: `$(check) Keep ${KEEP_KEY}`,
        command: 'inlineGitReview.keepHunk',
        arguments: [doc.uri, line],
        tooltip: state.baseline.source === 'git' ? '把這段變更 git add 到暫存區' : '接受這段變更（此檔不受 git 管理，更新擴充保存的基準）',
      }),
      new vscode.CodeLens(range, {
        title: `$(discard) Undo ${UNDO_KEY}`,
        command: 'inlineGitReview.undoHunk',
        arguments: [doc.uri, line],
        tooltip: state.baseline.source === 'git' ? '把這段還原成暫存區（index）的版本' : '把這段還原成基準版本',
      }),
      new vscode.CodeLens(range, {
        title: `${i + 1}/${state.hunks.length}  ${summary}`,
        command: 'inlineGitReview.openDiff',
        arguments: [doc.uri],
        tooltip: '開啟完整 diff',
      }),
    );
  });
  return lenses;
}

function provideHover(doc: vscode.TextDocument, pos: vscode.Position): vscode.Hover | undefined {
  const state = states.get(doc.uri.toString());
  const h = state?.hunks.find((x) => hunkContainsLine(x, pos.line, doc.lineCount));
  if (!h || h.oldLines.length === 0) return undefined;
  const line = anchorLine(h, doc.lineCount);
  const args = encodeURIComponent(JSON.stringify([doc.uri.toString(), line]));
  const md = new vscode.MarkdownString(undefined, true);
  md.isTrusted = { enabledCommands: ['inlineGitReview.keepHunk', 'inlineGitReview.undoHunk'] };
  md.appendMarkdown(
    `[$(check) Keep](command:inlineGitReview.keepHunk?${args})  ·  [$(discard) Undo](command:inlineGitReview.undoHunk?${args})\n\n`,
  );
  const body = [...h.oldLines.map((l) => `- ${l}`), ...h.newLines.map((l) => `+ ${l}`)].join('\n');
  md.appendCodeblock(truncate(body, 5000), 'diff');
  return new vscode.Hover(md);
}

function updateContextKeys() {
  const ed = vscode.window.activeTextEditor;
  const state = ed && states.get(ed.document.uri.toString());
  const hunks = state?.hunks ?? [];
  let current = -1;
  if (ed && hunks.length) {
    const line = ed.selection.active.line;
    current = hunks.findIndex((h) => hunkContainsLine(h, line, ed.document.lineCount));
  }
  vscode.commands.executeCommand('setContext', 'inlineGitReview.hasHunks', hunks.length > 0);
  vscode.commands.executeCommand('setContext', 'inlineGitReview.cursorInHunk', current >= 0);
  vscode.commands.executeCommand('setContext', 'inlineGitReview.canUndoReview', undoableTop() !== undefined);

  if (hunks.length) {
    statusItem.text = `$(git-compare) 段落 ${current >= 0 ? current + 1 : '–'}/${hunks.length}`;
    statusItem.tooltip = '這個檔案的變更段落（點擊跳到下一段）';
    statusItem.show();
  } else {
    statusItem.hide();
  }
  updateFileStatus();
}

function activeRel(root: string): string | undefined {
  const ed = vscode.window.activeTextEditor;
  const b = ed && states.get(ed.document.uri.toString())?.baseline;
  return b?.root === root ? b.rel : undefined;
}

function updateFileStatus() {
  const files = enabled() ? pending?.files ?? [] : [];
  const current = pending && activeRel(pending.root);
  const others = files.filter((f) => f !== current);
  vscode.commands.executeCommand('setContext', 'inlineGitReview.hasOtherFiles', others.length > 0);
  if (files.length === 0) {
    fileCounter = { index: 0, count: 0 };
    fileStatusItem.hide();
    return;
  }
  const idx = current ? files.indexOf(current) : -1;
  fileCounter = { index: idx + 1, count: files.length };
  fileStatusItem.text = `$(files) 檔案 ${idx >= 0 ? idx + 1 : '–'}/${files.length}`;
  fileStatusItem.tooltip = `待檢查的檔案：${idx >= 0 ? `第 ${idx + 1} 個，` : ''}共 ${files.length} 個（點擊列出全部）`;
  fileStatusItem.show();
}

// ───────────────────────── 待檢查檔案清單 ─────────────────────────

function schedulePendingRefresh(delay: number) {
  clearTimeout(pendingTimer);
  pendingTimer = setTimeout(() => {
    refreshPending().catch(() => undefined);
  }, delay);
}

/** 目前要看的 repo：優先用作用中編輯器所在的 repo，否則用第一個工作區資料夾 */
async function currentRoot(): Promise<string | undefined> {
  const doc = vscode.window.activeTextEditor?.document;
  if (doc?.uri.scheme === 'file') {
    const b = await getBaseline(doc.uri);
    if (b) return b.root;
    const repo = await findRepo(doc.uri.fsPath);
    if (repo) return repo.root;
  }
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) return undefined;
  return (await findRepo(path.join(folder.uri.fsPath, '_')))?.root ?? realpath(folder.uri.fsPath);
}

async function refreshPending(root?: string) {
  root ??= await currentRoot();
  if (!root || !enabled()) {
    pending = undefined;
    updateFileStatus();
    return pending;
  }
  const files = new Set(await listChangedFiles(root, cfg().get<boolean>('showUntracked', true)).catch(() => [] as string[]));
  // git 管不到、但有快照的檔案：磁碟內容跟快照不同就算待檢查（由 watcher 增量維護）
  if (cfg().get<boolean>('trackIgnoredFiles', true)) {
    for (const abs of snapshots.dirtyUnder(root)) files.add(toGitPath(root, abs));
  }
  // 以開著的文件為準：未存檔的修改也算待檢查；已經沒有 hunk 的就排除
  for (const doc of vscode.workspace.textDocuments) {
    const st = states.get(doc.uri.toString());
    if (!st || st.baseline.root !== root || st.version !== doc.version) continue;
    if (st.hunks.length > 0) files.add(st.baseline.rel);
    else files.delete(st.baseline.rel);
  }
  pending = { root, files: [...files].sort(byPath) };
  updateFileStatus();
  return pending;
}

function byPath(a: string, b: string) {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** 跳到上／下一個待檢查的檔案，並把游標放在第一段變更 */
async function gotoFile(dir: 1 | -1, from?: { root: string; rel?: string }): Promise<vscode.TextDocument | undefined> {
  const list = await refreshPending(from?.root);
  if (!list) return;
  const current = from ? from.rel : activeRel(list.root);
  const others = list.files.filter((f) => f !== current);
  if (others.length === 0) {
    vscode.window.setStatusBarMessage('$(pass) 所有變更都檢查完了', 4000);
    return;
  }
  // 依方向排出候選順序（循環），第一個就是要跳的檔案
  let start: number;
  if (current === undefined) start = dir === 1 ? 0 : others.length - 1;
  else if (dir === 1) start = Math.max(0, others.findIndex((f) => f > current));
  else start = findLastIndex(others, (f) => f < current) >= 0 ? findLastIndex(others, (f) => f < current) : others.length - 1;
  const ordered = others.map((_, i) => others[(start + dir * i + others.length * 2) % others.length]);

  // 打不開成文字的檔案（例如二進位）就跳過，換下一個
  let doc: vscode.TextDocument | undefined;
  for (const rel of ordered) {
    try {
      doc = await vscode.workspace.openTextDocument(vscode.Uri.file(path.join(list.root, rel)));
      break;
    } catch {
      /* 換下一個 */
    }
  }
  if (!doc) {
    vscode.window.setStatusBarMessage('$(pass) 沒有其他可以檢查的文字檔', 4000);
    return undefined;
  }
  const ed = await vscode.window.showTextDocument(doc, { preview: false });
  const state = await freshState(doc);
  const first = state?.hunks[0];
  if (first) {
    const pos = new vscode.Position(anchorLine(first, doc.lineCount), 0);
    ed.selection = new vscode.Selection(pos, pos);
    ed.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenterIfOutsideViewport);
  }
  updateUi();
  return doc;
}

/** 列出所有待檢查的檔案，選一個跳過去 */
async function pickFile() {
  const list = await refreshPending();
  if (!list || list.files.length === 0) {
    vscode.window.setStatusBarMessage('$(pass) 所有變更都檢查完了', 4000);
    return;
  }
  const current = activeRel(list.root);
  const pick = await vscode.window.showQuickPick(
    list.files.map((f, i) => ({
      label: `${f === current ? '$(arrow-right) ' : ''}${path.basename(f)}`,
      description: path.dirname(f) === '.' ? '' : path.dirname(f),
      detail: undefined,
      rel: f,
      index: i,
    })),
    { placeHolder: `待檢查的檔案（共 ${list.files.length} 個）`, matchOnDescription: true },
  );
  if (!pick) return;
  // 借用 gotoFile 的開檔＋定位邏輯：從目標的前一個位置往下跳
  const prev = list.files[pick.index - 1];
  await gotoFile(1, { root: list.root, rel: prev ?? '' });
}

/** 這個檔案的變更全部處理完後，自動跳到下一個待檢查的檔案 */
async function maybeAdvance(doc: vscode.TextDocument, baseline: Baseline) {
  if (!cfg().get<boolean>('autoNextFile', true)) return;
  if ((states.get(doc.uri.toString())?.hunks.length ?? 0) > 0) return;
  noteJump(await gotoFile(1, { root: baseline.root, rel: baseline.rel }));
}

// ───────────────────────── 審查紀錄（⌘Z 復原 Keep / Undo） ─────────────────────────

type ReviewAction = {
  uri: vscode.Uri;
  /** 復原後游標要回到的行 */
  line: number;
  /** 動作前／後的文件版本：之後沒再編輯過（版本相同）才讓 ⌘Z 復原這個動作 */
  versionBefore: number;
  version: number;
  /** 動作後自動跳到的檔案：在那個檔案按 ⌘Z 也能復原 */
  jumped?: { uri: string; version: number };
} & (
  | {
      kind: 'keep';
      source: Baseline['source'];
      absPath: string;
      root: string;
      rel: string;
      mode: string;
      before?: string;
      after: string;
    }
  | { kind: 'revert'; textBefore: string }
  | { kind: 'delete'; content: string; snapshotNew?: string }
);

const history: ReviewAction[] = [];
const MAX_HISTORY = 200;

function recordAction(a: ReviewAction) {
  history.push(a);
  if (history.length > MAX_HISTORY) history.shift();
  updateContextKeys();
}

function noteJump(doc: vscode.TextDocument | undefined) {
  const top = history[history.length - 1];
  if (top && doc) top.jumped = { uri: doc.uri.toString(), version: doc.version };
  updateContextKeys();
}

/** 目前作用中的編輯器按 ⌘Z 時，可以復原的審查動作（沒有就回 undefined，交給原生 undo） */
function undoableTop(): ReviewAction | undefined {
  const top = history[history.length - 1];
  const doc = vscode.window.activeTextEditor?.document;
  if (!top || !doc) return undefined;
  const key = doc.uri.toString();
  if (top.kind !== 'delete' && key === top.uri.toString() && doc.version === top.version) return top;
  if (top.jumped && key === top.jumped.uri && doc.version === top.jumped.version) return top;
  return undefined;
}

const normalizeEol = (t: string) => t.replace(/\r\n/g, '\n');

async function undoLastReview(args?: { fromKeybinding?: boolean }) {
  // 從快捷鍵來：只有「上一步就是審查動作」才攔截，否則照常執行編輯器的 undo
  const top = args?.fromKeybinding ? undoableTop() : history[history.length - 1];
  if (!top) {
    if (args?.fromKeybinding) await vscode.commands.executeCommand('undo');
    else vscode.window.setStatusBarMessage('沒有可以復原的 Keep / Undo', 3000);
    return;
  }
  await withLock(async () => {
    history.pop();
    let label: string;
    if (top.kind === 'keep' && top.source === 'snapshot') {
      snapshots.set(top.absPath, top.before ?? '', top.before === undefined);
      baselines.delete(top.uri.toString());
      label = 'Keep';
    } else if (top.kind === 'keep') {
      const cur = await readIndexEntry(top.root, top.rel);
      const curText = cur.kind === 'tracked' ? normalizeEol(cur.content) : undefined;
      if (curText !== normalizeEol(top.after)) {
        vscode.window.showWarningMessage('暫存區在 Keep 之後又被其他操作改過，無法復原這次 Keep。');
        return;
      }
      if (top.before === undefined) await removeFromIndex(top.root, top.rel);
      else await writeIndexContent(top.root, top.rel, top.before, top.mode);
      baselines.delete(top.uri.toString());
      label = 'Keep';
    } else if (top.kind === 'revert') {
      const ed = await vscode.window.showTextDocument(top.uri, { preview: false });
      // 優先用編輯器原生的 undo，讓 undo/redo 歷史保持自然；對不上再整份還原
      if (ed.document.version === top.version) await vscode.commands.executeCommand('undo');
      if (ed.document.getText() !== top.textBefore) {
        const fix = new vscode.WorkspaceEdit();
        fix.replace(ed.document.uri, fullRange(ed.document), top.textBefore);
        await vscode.workspace.applyEdit(fix);
      }
      await maybeSave(ed.document);
      label = 'Undo';
    } else {
      await vscode.workspace.fs.writeFile(top.uri, Buffer.from(top.content, 'utf8'));
      if (top.snapshotNew) snapshots.set(top.snapshotNew, '', true);
      baselines.delete(top.uri.toString());
      label = '刪除檔案';
    }

    const doc = await vscode.workspace.openTextDocument(top.uri);
    const ed = await vscode.window.showTextDocument(doc, { preview: false });
    await refresh(doc);
    const pos = new vscode.Position(Math.min(top.line, doc.lineCount - 1), 0);
    ed.selection = new vscode.Selection(pos, pos);
    ed.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenterIfOutsideViewport);

    // 連續按 ⌘Z：前一個動作若緊接在這個動作之前，更新它的版本讓它也能被復原
    const prev = history[history.length - 1];
    const key = doc.uri.toString();
    if (prev) {
      const chained = (v: number) => top.kind === 'delete' || v === top.versionBefore;
      if (prev.uri.toString() === key && chained(prev.version)) prev.version = doc.version;
      if (prev.jumped?.uri === key && chained(prev.jumped.version)) prev.jumped.version = doc.version;
    }
    updateUi();
    vscode.window.setStatusBarMessage(`$(discard) 已復原 ${label}，可以重新審查`, 3000);
  });
}

// ───────────────────────── 指令 ─────────────────────────

type UriArg = vscode.Uri | string | undefined;

function toUri(uri: UriArg): vscode.Uri | undefined {
  if (uri instanceof vscode.Uri) return uri;
  if (typeof uri === 'string') return vscode.Uri.parse(uri);
  return undefined;
}

async function resolveTarget(uriArg?: UriArg, line?: number) {
  const ed = vscode.window.activeTextEditor;
  const uri = toUri(uriArg);
  const doc = uri ? await vscode.workspace.openTextDocument(uri) : ed?.document;
  if (!doc) return undefined;
  const state = await freshState(doc);
  if (!state) return undefined;
  const targetLine =
    typeof line === 'number' ? line : ed && ed.document === doc ? ed.selection.active.line : -1;
  const hunk = state.hunks.find((h) => hunkContainsLine(h, targetLine, doc.lineCount));
  return { doc, state, hunk };
}

async function withLock(fn: () => Promise<void>) {
  if (busy) return;
  busy = true;
  try {
    await fn();
  } finally {
    busy = false;
  }
}

async function keepHunk(uri?: UriArg, line?: number) {
  await withLock(async () => {
    const t = await resolveTarget(uri, line);
    if (!t?.hunk) return;
    const { baseline } = t.state;
    const oldLines = baseline.untracked ? [''] : splitLines(baseline.indexText);
    const eol = baseline.untracked ? eolOf(t.doc) : detectEol(baseline.indexText);
    const next = applyHunkToOld(oldLines, t.hunk).join(eol);
    await stage(t.doc, baseline, next, anchorLine(t.hunk, t.doc.lineCount));
    await maybeAdvance(t.doc, baseline);
  });
}

async function keepFile(uri?: UriArg) {
  await withLock(async () => {
    const t = await resolveTarget(uri);
    if (!t || t.state.hunks.length === 0) return;
    await stage(t.doc, t.state.baseline, t.doc.getText(), anchorLine(t.state.hunks[0], t.doc.lineCount));
    await maybeAdvance(t.doc, t.state.baseline);
  });
}

async function stage(doc: vscode.TextDocument, baseline: Baseline, content: string, line: number) {
  const versionBefore = doc.version;
  if (baseline.source === 'snapshot') snapshots.set(baseline.absPath, content);
  else await writeIndexContent(baseline.root, baseline.rel, content, baseline.mode);
  // 直接更新快取的基準，讓高亮立刻消失，不必等 watcher
  baselines.set(doc.uri.toString(), Promise.resolve({ ...baseline, untracked: false, indexText: content }));
  await refresh(doc);
  await maybeSave(doc);
  recordAction({
    kind: 'keep',
    uri: doc.uri,
    line,
    versionBefore,
    version: doc.version,
    source: baseline.source,
    absPath: baseline.absPath,
    root: baseline.root,
    rel: baseline.rel,
    mode: baseline.mode,
    before: baseline.untracked ? undefined : baseline.indexText,
    after: content,
  });
}

async function undoHunk(uri?: UriArg, line?: number) {
  await withLock(async () => {
    const t = await resolveTarget(uri, line);
    if (!t?.hunk) return;
    if (t.state.baseline.untracked && t.state.hunks.length === 1) {
      await deleteUntracked(t.doc);
      return;
    }
    const reverted = revertHunkInNew(splitLines(t.doc.getText()), t.hunk);
    await revert(t.doc, reverted.join(eolOf(t.doc)), anchorLine(t.hunk, t.doc.lineCount), t.hunk);
    await maybeAdvance(t.doc, t.state.baseline);
  });
}

async function undoFile(uri?: UriArg) {
  await withLock(async () => {
    const t = await resolveTarget(uri);
    if (!t || t.state.hunks.length === 0) return;
    if (t.state.baseline.untracked) {
      await deleteUntracked(t.doc);
      return;
    }
    const text = splitLines(t.state.baseline.indexText).join(eolOf(t.doc));
    await revert(t.doc, text, anchorLine(t.state.hunks[0], t.doc.lineCount));
    await maybeAdvance(t.doc, t.state.baseline);
  });
}

async function revert(doc: vscode.TextDocument, newText: string, line: number, hunk?: Hunk) {
  const textBefore = doc.getText();
  const versionBefore = doc.version;
  await replaceDocument(doc, newText, hunk);
  recordAction({ kind: 'revert', uri: doc.uri, line, versionBefore, version: doc.version, textBefore });
}

/** 只替換變動的範圍，盡量保留游標位置與 undo 歷史 */
async function replaceDocument(doc: vscode.TextDocument, newText: string, hunk?: Hunk) {
  const edit = new vscode.WorkspaceEdit();
  if (hunk) {
    const eol = eolOf(doc);
    const start = hunk.newStart;
    const end = hunk.newStart + hunk.newLines.length;
    if (end < doc.lineCount) {
      edit.replace(doc.uri, new vscode.Range(start, 0, end, 0), hunk.oldLines.map((l) => l + eol).join(''));
    } else if (start > 0) {
      const from = doc.lineAt(start - 1).range.end;
      const to = doc.lineAt(doc.lineCount - 1).range.end;
      edit.replace(doc.uri, new vscode.Range(from, to), hunk.oldLines.map((l) => eol + l).join(''));
    } else {
      edit.replace(doc.uri, fullRange(doc), newText);
    }
  } else {
    edit.replace(doc.uri, fullRange(doc), newText);
  }
  await vscode.workspace.applyEdit(edit);
  if (doc.getText() !== newText) {
    // 保險：範圍計算若有落差，退回整份替換
    const fix = new vscode.WorkspaceEdit();
    fix.replace(doc.uri, fullRange(doc), newText);
    await vscode.workspace.applyEdit(fix);
  }
  await refresh(doc);
  await maybeSave(doc);
}

async function deleteUntracked(doc: vscode.TextDocument) {
  const pick = await vscode.window.showWarningMessage(
    `「${doc.fileName.split(/[\\/]/).pop()}」是尚未被 git 追蹤的新檔案，Undo 會把它移到垃圾桶。`,
    { modal: true },
    '移到垃圾桶',
  );
  if (pick !== '移到垃圾桶') return;
  const baseline = await getBaseline(doc.uri);
  if (doc.isDirty) await doc.save();
  const content = doc.getText();
  const versionBefore = doc.version;
  for (const tab of vscode.window.tabGroups.all.flatMap((g) => g.tabs)) {
    if (tab.input instanceof vscode.TabInputText && tab.input.uri.toString() === doc.uri.toString()) {
      await vscode.window.tabGroups.close(tab);
    }
  }
  await vscode.workspace.fs.delete(doc.uri, { useTrash: true });
  states.delete(doc.uri.toString());
  baselines.delete(doc.uri.toString());
  const snapshotNew = baseline?.source === 'snapshot' ? baseline.absPath : undefined;
  if (snapshotNew) snapshots.delete(snapshotNew);
  recordAction({ kind: 'delete', uri: doc.uri, line: 0, versionBefore, version: versionBefore, content, snapshotNew });
  updateUi();
  if (baseline && cfg().get<boolean>('autoNextFile', true)) {
    await gotoFile(1, { root: baseline.root, rel: baseline.rel });
  }
  // 刪除後停在哪個檔案，就允許在那裡按 ⌘Z 把檔案救回來
  noteJump(vscode.window.activeTextEditor?.document);
}

async function maybeSave(doc: vscode.TextDocument) {
  if (doc.isDirty && cfg().get<boolean>('saveAfterAction', true)) await doc.save();
}

async function navigate(dir: 1 | -1) {
  const ed = vscode.window.activeTextEditor;
  if (!ed) return;
  const state = await freshState(ed.document);
  if (!state || state.hunks.length === 0) return;
  const line = ed.selection.active.line;
  const lc = ed.document.lineCount;
  const anchors = state.hunks.map((h) => anchorLine(h, lc));
  let idx =
    dir === 1 ? anchors.findIndex((a) => a > line) : findLastIndex(anchors, (a) => a < line);
  if (idx < 0) idx = dir === 1 ? 0 : anchors.length - 1; // 循環
  const pos = new vscode.Position(anchors[idx], 0);
  ed.selection = new vscode.Selection(pos, pos);
  ed.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenterIfOutsideViewport);
}

async function openDiff(uri?: UriArg) {
  const target = toUri(uri) ?? vscode.window.activeTextEditor?.document.uri;
  if (!target) return;
  const left = vscode.Uri.from({ scheme: INDEX_SCHEME, path: target.path, query: target.toString() });
  const name = target.path.split('/').pop();
  await vscode.commands.executeCommand('vscode.diff', left, target, `${name} (Index ↔ 工作區)`);
}

// ───────────────────────── 小工具 ─────────────────────────

function eolOf(doc: vscode.TextDocument) {
  return doc.eol === vscode.EndOfLine.CRLF ? '\r\n' : '\n';
}

function fullRange(doc: vscode.TextDocument) {
  return new vscode.Range(0, 0, doc.lineCount - 1, doc.lineAt(doc.lineCount - 1).text.length);
}

function truncate(s: string, n: number) {
  return s.length > n ? s.slice(0, n) + '…' : s;
}

function findLastIndex<T>(arr: T[], pred: (x: T) => boolean) {
  for (let i = arr.length - 1; i >= 0; i--) if (pred(arr[i])) return i;
  return -1;
}
