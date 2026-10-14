import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { checkIgnored, findRepo, toGitPath } from './git';
import { SnapshotStore, isSensitiveFile, readTextFile } from './snapshots';

/**
 * 專案開啟時，替「git 管不到」且「可能需要人工檢查」的檔案先建立基準快照，
 * 這樣 AI 在你打開檔案之前就改了它，也一樣看得到變更。
 *
 * - 用副檔名判斷要不要索引（inlineGitReview.indexExtensions）
 * - 跳過 node_modules / build 這類產生出來的資料夾（inlineGitReview.indexExcludeFolders）
 * - 已被 git 追蹤或 untracked 的檔案交給 git，不建快照；只處理被 .gitignore 排除、或不在 repo 裡的檔案
 */

export interface IndexOptions {
  snapshotSensitive: boolean;
  extensions: string[];
  excludeFolders: string[];
  maxFiles: number;
}

export function readIndexOptions(): IndexOptions {
  const c = vscode.workspace.getConfiguration('inlineGitReview');
  return {
    snapshotSensitive: c.get<boolean>('snapshotSensitiveFiles', false),
    extensions: c.get<string[]>('indexExtensions', []).map((e) => e.replace(/^\./, '').toLowerCase()),
    excludeFolders: c.get<string[]>('indexExcludeFolders', []),
    maxFiles: c.get<number>('indexMaxFiles', 5000),
  };
}

function extOf(absPath: string) {
  const base = path.basename(absPath);
  const ext = path.extname(base).slice(1);
  // ".env" 這種只有點開頭的檔名，把點後面當副檔名
  return (ext || (base.startsWith('.') ? base.slice(1) : '')).toLowerCase();
}

/** 這個檔案符不符合索引規則（副檔名 + 不在排除的資料夾裡） */
export function matchesRules(absPath: string, root: string, opts: IndexOptions) {
  if (!opts.extensions.includes(extOf(absPath))) return false;
  if (!opts.snapshotSensitive && isSensitiveFile(absPath)) return false;
  const segments = path.relative(root, absPath).split(path.sep).slice(0, -1);
  return !segments.some((s) => opts.excludeFolders.includes(s));
}

function realpath(p: string) {
  try {
    return fs.realpathSync.native(p);
  } catch {
    return p;
  }
}

/** 只留下 git 管不到的檔案：不在 repo 裡、或被 .gitignore 排除 */
async function filterUntrackedByGit(files: string[]): Promise<string[]> {
  const byRepo = new Map<string, string[]>();
  const result: string[] = [];
  for (const f of files) {
    const repo = await findRepo(f);
    if (!repo) result.push(f);
    else byRepo.set(repo.root, [...(byRepo.get(repo.root) ?? []), f]);
  }
  for (const [root, list] of byRepo) {
    const rels = list.map((f) => toGitPath(root, f));
    const ignored = await checkIgnored(root, rels);
    list.forEach((f, i) => ignored.has(rels[i]) && result.push(f));
  }
  return result;
}

/** 掃描整個工作區建立基準，回傳新建立的快照數 */
export async function indexWorkspace(store: SnapshotStore, opts: IndexOptions): Promise<number> {
  const folders = vscode.workspace.workspaceFolders ?? [];
  if (folders.length === 0 || opts.extensions.length === 0) return 0;
  const include = `**/*.{${opts.extensions.join(',')}}`;
  const exclude = opts.excludeFolders.length ? `**/{${opts.excludeFolders.join(',')}}/**` : undefined;

  let created = 0;
  for (const folder of folders) {
    const uris = await vscode.workspace.findFiles(new vscode.RelativePattern(folder, include), exclude, opts.maxFiles);
    const root = realpath(folder.uri.fsPath);
    const candidates = uris
      .map((u) => path.join(root, path.relative(folder.uri.fsPath, u.fsPath)))
      .filter((f) => matchesRules(f, root, opts));
    for (const f of await filterUntrackedByGit(candidates)) {
      if (store.has(f)) {
        store.check(f); // 已有基準（上次開專案時建的）就沿用，關著 VS Code 時的變更也看得到
        continue;
      }
      const content = readTextFile(f);
      if (content === undefined) continue;
      store.set(f, content);
      created++;
    }
  }
  return created;
}

/** 索引完成後才出現的新檔：符合規則且 git 管不到 → 當成新增檔案（整份都是新增） */
export async function handleCreated(store: SnapshotStore, rawPath: string, opts: IndexOptions) {
  const absPath = realpath(rawPath);
  if (store.has(absPath)) return store.check(absPath);
  // 用原始路徑找工作區資料夾（realpath 可能穿過 symlink，跟工作區的路徑對不上）
  const folder = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(rawPath));
  if (!folder || !matchesRules(absPath, realpath(folder.uri.fsPath), opts)) return;
  if (readTextFile(absPath) === undefined) return;
  if ((await filterUntrackedByGit([absPath])).length === 0) return;
  store.set(absPath, '', true);
}
