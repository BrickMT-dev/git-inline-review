import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';

/**
 * 給「git 管不到」的檔案用的基準快照：被 .gitignore 排除、或根本不在 git repo 裡的檔案。
 * 專案開啟時（或第一次看到檔案時）記下磁碟上的內容當作基準，Keep 會更新基準、Undo 會還原成基準。
 *
 * 存在擴充自己的 globalStorage（不會寫進專案），每個檔案一個 JSON：{ path, content, isNew }。
 * isNew = 建立基準之後才出現的新檔，相當於 git 的 untracked（整份都是新增，Undo 會刪檔）。
 */

/**
 * 可能含有密碼、金鑰的檔案：預設不建快照，避免把機密內容複製到擴充的儲存區
 * （.env、.env.local、私鑰、憑證、keystore…）
 */
const SENSITIVE_NAME = /^(\.env(\..+)?|.+\.env|id_(rsa|dsa|ecdsa|ed25519)(\.pub)?|\.netrc|\.npmrc|\.pypirc|credentials(\..+)?)$/i;
const SENSITIVE_EXT = /\.(pem|key|p8|p12|pfx|jks|keystore|mobileprovision|asc|gpg)$/i;

export function isSensitiveFile(absPath: string) {
  const base = path.basename(absPath);
  return SENSITIVE_NAME.test(base) || SENSITIVE_EXT.test(base);
}

/** 太大的檔案不追蹤 */
export const MAX_SNAPSHOT_BYTES = 2 * 1024 * 1024;

interface SnapshotFile {
  path: string;
  content: string;
  isNew?: boolean;
}

export class SnapshotStore {
  private readonly cache = new Map<string, { content: string; isNew: boolean }>();
  /** 磁碟內容跟快照不同的檔案（待檢查），增量維護，避免每次都重讀所有檔案 */
  private readonly dirty = new Set<string>();

  constructor(private readonly dir: string) {
    fs.mkdirSync(dir, { recursive: true });
    for (const name of fs.readdirSync(dir)) {
      if (!name.endsWith('.json')) continue;
      try {
        const data = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8')) as SnapshotFile;
        if (typeof data.path === 'string' && typeof data.content === 'string') {
          this.cache.set(data.path, { content: data.content, isNew: !!data.isNew });
        }
      } catch {
        /* 壞掉的快照直接略過 */
      }
    }
  }

  has(absPath: string) {
    return this.cache.has(absPath);
  }

  get(absPath: string): string | undefined {
    return this.cache.get(absPath)?.content;
  }

  isNew(absPath: string) {
    return this.cache.get(absPath)?.isNew ?? false;
  }

  set(absPath: string, content: string, isNew = false) {
    this.cache.set(absPath, { content, isNew });
    const data: SnapshotFile = { path: absPath, content, isNew: isNew || undefined };
    fs.writeFileSync(this.file(absPath), JSON.stringify(data));
    this.check(absPath);
  }

  delete(absPath: string) {
    this.cache.delete(absPath);
    this.dirty.delete(absPath);
    fs.rmSync(this.file(absPath), { force: true });
  }

  /** 重新比對某個檔案的磁碟內容與快照；檔案已不存在就清掉快照 */
  check(absPath: string) {
    const snap = this.cache.get(absPath);
    if (!snap) return;
    const disk = readTextFile(absPath);
    if (disk === undefined) {
      if (!fs.existsSync(absPath)) this.delete(absPath);
      else this.dirty.delete(absPath);
      return;
    }
    if (disk !== snap.content) this.dirty.add(absPath);
    else this.dirty.delete(absPath);
  }

  checkAll() {
    for (const p of [...this.cache.keys()]) this.check(p);
  }

  all(): string[] {
    return [...this.cache.keys()];
  }

  /** 位於某個資料夾底下、有快照的檔案（絕對路徑） */
  pathsUnder(root: string): string[] {
    const prefix = root.endsWith(path.sep) ? root : root + path.sep;
    return [...this.cache.keys()].filter((p) => p.startsWith(prefix));
  }

  /** 位於某個資料夾底下、內容跟快照不同的檔案（絕對路徑） */
  dirtyUnder(root: string): string[] {
    const prefix = root.endsWith(path.sep) ? root : root + path.sep;
    return [...this.dirty].filter((p) => p.startsWith(prefix));
  }

  private file(absPath: string) {
    return path.join(this.dir, crypto.createHash('sha1').update(absPath).digest('hex') + '.json');
  }
}

/** 讀取磁碟上的文字檔；不存在、太大或是二進位就回 undefined */
export function readTextFile(absPath: string): string | undefined {
  try {
    const st = fs.statSync(absPath);
    if (!st.isFile() || st.size > MAX_SNAPSHOT_BYTES) return undefined;
    const buf = fs.readFileSync(absPath);
    if (buf.includes(0)) return undefined;
    return buf.toString('utf8');
  } catch {
    return undefined;
  }
}
