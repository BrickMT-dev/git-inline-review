import { spawn } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';

export class GitError extends Error {
  constructor(message: string, readonly exitCode: number | null, readonly stderr: string) {
    super(message);
  }
}

export function runGit(cwd: string, args: string[], input?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, { cwd, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' } });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on('data', (d: Buffer) => out.push(d));
    child.stderr.on('data', (d: Buffer) => err.push(d));
    child.on('error', reject);
    child.on('close', (code) => {
      const stdout = Buffer.concat(out).toString('utf8');
      const stderr = Buffer.concat(err).toString('utf8');
      if (code === 0) resolve(stdout);
      else reject(new GitError(`git ${args.join(' ')} 失敗：${stderr.trim()}`, code, stderr));
    });
    if (input !== undefined) child.stdin.end(input, 'utf8');
    else child.stdin.end();
  });
}

export interface RepoInfo {
  root: string;
  gitDir: string;
}

const repoCache = new Map<string, Promise<RepoInfo | undefined>>();

/** 找出檔案所在的 repo（結果依目錄快取） */
export function findRepo(filePath: string): Promise<RepoInfo | undefined> {
  const dir = path.dirname(filePath);
  let p = repoCache.get(dir);
  if (!p) {
    p = (async () => {
      if (!fs.existsSync(dir)) return undefined;
      try {
        const out = await runGit(dir, ['rev-parse', '--show-toplevel', '--absolute-git-dir']);
        const [root, gitDir] = out.trim().split('\n');
        return { root, gitDir };
      } catch {
        return undefined;
      }
    })();
    repoCache.set(dir, p);
  }
  return p;
}

export function clearRepoCache() {
  repoCache.clear();
}

export type IndexEntry =
  | { kind: 'tracked'; mode: string; sha: string; content: string }
  | { kind: 'untracked' }
  | { kind: 'ignored' }
  | { kind: 'unsupported'; reason: string };

/** 讀取檔案在 git index（暫存區）中的內容 */
export async function readIndexEntry(root: string, rel: string): Promise<IndexEntry> {
  const ls = await runGit(root, ['ls-files', '-s', '-z', '--', rel]);
  const entries = ls.split('\0').filter(Boolean);
  if (entries.length === 0) {
    try {
      await runGit(root, ['check-ignore', '-q', '--', rel]);
      return { kind: 'ignored' };
    } catch {
      return { kind: 'untracked' };
    }
  }
  if (entries.length > 1) return { kind: 'unsupported', reason: 'merge conflict' };

  // 格式："<mode> <sha> <stage>\t<path>"
  const [meta] = entries[0].split('\t');
  const [mode, sha, stage] = meta.split(' ');
  if (stage !== '0') return { kind: 'unsupported', reason: 'merge conflict' };
  if (mode === '120000' || mode === '160000') return { kind: 'unsupported', reason: 'symlink/submodule' };

  // --filters 會套用 autocrlf / smudge 等轉換，讓內容與工作目錄的格式一致
  const content = await runGit(root, ['cat-file', '--filters', `--path=${rel}`, sha]);
  if (content.includes('\0')) return { kind: 'unsupported', reason: 'binary' };
  return { kind: 'tracked', mode, sha, content };
}

/** 讀取檔案在 HEAD（最近一次 commit）中的內容；HEAD 裡沒有這個檔就回空字串，二進位回 undefined */
export async function readHeadContent(root: string, rel: string): Promise<string | undefined> {
  try {
    const content = await runGit(root, ['cat-file', '--filters', `HEAD:${rel}`]);
    return content.includes('\0') ? undefined : content;
  } catch {
    return ''; // 新檔（或 repo 還沒有任何 commit）
  }
}

/** 把指定內容寫進 index（等同於只 add 這份內容，不碰工作目錄的檔案） */
export async function writeIndexContent(root: string, rel: string, content: string, mode: string) {
  const sha = (await runGit(root, ['hash-object', '-w', '--stdin', `--path=${rel}`], content)).trim();
  await runGit(root, ['update-index', '--add', '--cacheinfo', `${mode},${sha},${rel}`]);
}

/** 一次問 git 哪些檔案被 .gitignore 排除（已追蹤的檔案不算） */
export async function checkIgnored(root: string, rels: string[]): Promise<Set<string>> {
  if (rels.length === 0) return new Set();
  try {
    const out = await runGit(root, ['check-ignore', '--stdin', '-z'], rels.join('\0') + '\0');
    return new Set(out.split('\0').filter(Boolean));
  } catch (e) {
    // exit code 1 = 沒有任何檔案被排除
    if (e instanceof GitError && e.exitCode === 1) return new Set();
    throw e;
  }
}

/** 把檔案從 index 移除（回到 untracked），不碰工作目錄 */
export async function removeFromIndex(root: string, rel: string) {
  await runGit(root, ['update-index', '--force-remove', '--', rel]);
}

/** 列出工作區中與 index 不同的檔案（相對路徑），略過二進位與已刪除的檔案 */
export async function listChangedFiles(root: string, includeUntracked: boolean): Promise<string[]> {
  const files = new Set<string>();
  // numstat -z 格式："<added>\t<deleted>\t<path>\0"；二進位檔的行數為 "-"
  const numstat = await runGit(root, ['diff', '--numstat', '-z', '--no-renames']);
  for (const rec of numstat.split('\0')) {
    const m = /^(\S+)\t(\S+)\t(.+)$/.exec(rec);
    if (!m || m[1] === '-') continue;
    if (fs.existsSync(path.join(root, m[3]))) files.add(m[3]);
  }
  if (includeUntracked) {
    const others = await runGit(root, ['ls-files', '--others', '--exclude-standard', '-z']);
    others
      .split('\0')
      .filter(Boolean)
      .slice(0, 2000)
      .filter((f) => isProbablyTextFile(path.join(root, f))) // PDF、圖片等不能當文字開
      .forEach((f) => files.add(f));
  }
  return [...files];
}

/** 常見的二進位副檔名：直接判定，不必讀檔 */
const BINARY_EXTENSIONS = new Set(
  (
    'pdf png jpg jpeg gif webp bmp ico icns heic tiff psd ai sketch fig ' +
    'zip gz tgz bz2 xz 7z rar tar jar war aar apk ipa dmg pkg iso ' +
    'mp3 mp4 m4a mov avi mkv wav flac ogg webm ' +
    'ttf otf woff woff2 eot ' +
    'doc docx xls xlsx ppt pptx key numbers pages ' +
    'so dylib dll exe o a lib class pyc wasm sqlite db realm keystore jks p12 mobileprovision'
  ).split(' '),
);
const MAX_TEXT_BYTES = 5 * 1024 * 1024;

/** 判斷是不是可以當文字開的檔案（跟 git 一樣：前 8KB 有 NUL 就當二進位） */
export function isProbablyTextFile(absPath: string): boolean {
  if (BINARY_EXTENSIONS.has(path.extname(absPath).slice(1).toLowerCase())) return false;
  let fd: number | undefined;
  try {
    const st = fs.statSync(absPath);
    if (!st.isFile() || st.size > MAX_TEXT_BYTES) return false;
    fd = fs.openSync(absPath, 'r');
    const buf = Buffer.alloc(8000);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    return !buf.subarray(0, n).includes(0);
  } catch {
    return false;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

export function guessMode(absPath: string): string {
  try {
    return fs.statSync(absPath).mode & 0o111 ? '100755' : '100644';
  } catch {
    return '100644';
  }
}

export function toGitPath(root: string, absPath: string): string {
  return path.relative(root, absPath).split(path.sep).join('/');
}
