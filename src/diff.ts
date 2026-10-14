/**
 * 純函式的行級 diff 與 hunk 套用工具，不依賴 vscode，方便單元測試。
 *
 * 行的表示方式：以 /\r?\n/ 切開整份文字，所以 "a\nb\n" => ["a", "b", ""]。
 * 這跟 VS Code 的 document.lineCount 一致（結尾換行後會多一個空行），
 * 也自然處理了「檔尾沒有換行」的情況。
 */

export interface Hunk {
  /** 在舊內容（git index）中的起始行，0-based */
  oldStart: number;
  /** 被刪除／被取代的舊行 */
  oldLines: string[];
  /** 在新內容（目前編輯器文件）中的起始行，0-based */
  newStart: number;
  /** 新增／取代後的新行 */
  newLines: string[];
}

export function splitLines(text: string): string[] {
  return text.split(/\r?\n/);
}

export function detectEol(text: string): string {
  return text.includes('\r\n') ? '\r\n' : '\n';
}

/**
 * Myers O(ND) 差異演算法，回傳連續變更區塊（hunk）。
 * 先剝掉共同的前綴／後綴，大幅縮小一般編輯情境下的搜尋空間。
 */
export function computeHunks(oldLines: string[], newLines: string[]): Hunk[] {
  let prefix = 0;
  const minLen = Math.min(oldLines.length, newLines.length);
  while (prefix < minLen && oldLines[prefix] === newLines[prefix]) prefix++;

  let suffix = 0;
  while (
    suffix < minLen - prefix &&
    oldLines[oldLines.length - 1 - suffix] === newLines[newLines.length - 1 - suffix]
  ) {
    suffix++;
  }

  const a = oldLines.slice(prefix, oldLines.length - suffix);
  const b = newLines.slice(prefix, newLines.length - suffix);
  if (a.length === 0 && b.length === 0) return [];

  const ops = myers(a, b); // 'e' 相同, 'd' 刪除, 'i' 新增

  const hunks: Hunk[] = [];
  let ai = 0;
  let bi = 0;
  let cur: Hunk | undefined;
  for (const op of ops) {
    if (op === 'e') {
      if (cur) {
        hunks.push(cur);
        cur = undefined;
      }
      ai++;
      bi++;
      continue;
    }
    if (!cur) {
      cur = { oldStart: prefix + ai, oldLines: [], newStart: prefix + bi, newLines: [] };
    }
    if (op === 'd') cur.oldLines.push(a[ai++]);
    else cur.newLines.push(b[bi++]);
  }
  if (cur) hunks.push(cur);
  return hunks;
}

type Op = 'e' | 'd' | 'i';

/** 差異超過這個編輯距離就不再細算，整段當成一個 hunk（避免巨大檔案吃光記憶體） */
const MAX_EDIT_DISTANCE = 4000;

function myers(a: string[], b: string[]): Op[] {
  const n = a.length;
  const m = b.length;
  const max = n + m;
  const offset = max + 1;
  const v = new Int32Array(2 * max + 3);
  // trace[d] 只保存 k ∈ [-d-1, d+1] 這段，索引為 k + d + 1
  const trace: Int32Array[] = [];
  let found = false;

  outer: for (let d = 0; d <= max; d++) {
    if (d > MAX_EDIT_DISTANCE) break;
    trace.push(v.slice(offset - d - 1, offset + d + 2));
    for (let k = -d; k <= d; k += 2) {
      let x: number;
      if (k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1])) {
        x = v[offset + k + 1]; // 向下：新增
      } else {
        x = v[offset + k - 1] + 1; // 向右：刪除
      }
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x++;
        y++;
      }
      v[offset + k] = x;
      if (x >= n && y >= m) {
        found = true;
        break outer;
      }
    }
  }

  if (!found) {
    return [...Array<Op>(n).fill('d'), ...Array<Op>(m).fill('i')];
  }

  // 回溯
  const ops: Op[] = [];
  let x = n;
  let y = m;
  for (let d = trace.length - 1; d >= 0; d--) {
    const vd = trace[d];
    const at = (kk: number) => vd[kk + d + 1];
    const k = x - y;
    let prevK: number;
    if (k === -d || (k !== d && at(k - 1) < at(k + 1))) {
      prevK = k + 1;
    } else {
      prevK = k - 1;
    }
    const prevX = d === 0 ? 0 : at(prevK);
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      ops.push('e');
      x--;
      y--;
    }
    if (d > 0) {
      if (x === prevX) {
        ops.push('i');
        y--;
      } else {
        ops.push('d');
        x--;
      }
    }
  }
  return ops.reverse();
}

/** Keep：把 hunk 的新內容套進舊內容（index），得到新的 index 行陣列 */
export function applyHunkToOld(oldLines: string[], hunk: Hunk): string[] {
  return [
    ...oldLines.slice(0, hunk.oldStart),
    ...hunk.newLines,
    ...oldLines.slice(hunk.oldStart + hunk.oldLines.length),
  ];
}

/** Undo：把 hunk 從新內容（編輯器）還原成舊內容 */
export function revertHunkInNew(newLines: string[], hunk: Hunk): string[] {
  return [
    ...newLines.slice(0, hunk.newStart),
    ...hunk.oldLines,
    ...newLines.slice(hunk.newStart + hunk.newLines.length),
  ];
}
