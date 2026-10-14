import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { applyHunkToOld, computeHunks, revertHunkInNew, splitLines } from '../src/diff';

function roundTrip(oldText: string, newText: string) {
  const a = splitLines(oldText);
  const b = splitLines(newText);
  const hunks = computeHunks(a, b);

  // 依序 Keep 所有 hunk（從後往前，避免行號位移）→ 應得到新內容
  let kept = a;
  for (const h of [...hunks].reverse()) kept = applyHunkToOld(kept, h);
  assert.equal(kept.join('\n'), newText, 'keep all');

  // 依序 Undo 所有 hunk → 應回到舊內容
  let undone = b;
  for (const h of [...hunks].reverse()) undone = revertHunkInNew(undone, h);
  assert.equal(undone.join('\n'), oldText, 'undo all');

  // 單獨 Keep 任一 hunk 之後，再 diff 應該只剩其他 hunk
  hunks.forEach((h, i) => {
    const remaining = computeHunks(applyHunkToOld(a, h), b);
    assert.equal(remaining.length, hunks.length - 1, `keep hunk ${i}`);
    const rest = computeHunks(a, revertHunkInNew(b, h));
    assert.equal(rest.length, hunks.length - 1, `undo hunk ${i}`);
  });
  return hunks;
}

test('改一行', () => {
  const oldText = '行內變更測試\n\n這是在專案根目錄新增的測試檔。\n內容沒有功能用途。\n';
  const newText = '行內變更測試\n\n這是在專案根目錄改過一行的測試檔。\n內容沒有功能用途。\n';
  const hunks = roundTrip(oldText, newText);
  assert.deepEqual(hunks, [
    { oldStart: 2, oldLines: ['這是在專案根目錄新增的測試檔。'], newStart: 2, newLines: ['這是在專案根目錄改過一行的測試檔。'] },
  ]);
});

test('多段新增、刪除、修改', () => {
  const oldText = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', ''].join('\n');
  const newText = ['x', 'a', 'b', 'd', 'e', 'E2', 'f', 'h', 'y', ''].join('\n');
  const hunks = roundTrip(oldText, newText);
  assert.equal(hunks.length, 5);
});

test('檔尾沒有換行／刪到檔尾', () => {
  roundTrip('a\nb\nc', 'a\nb');
  roundTrip('a\nb', 'a\nb\n');
  roundTrip('a\nb\n', 'a\nb');
  roundTrip('a', '');
  roundTrip('', 'new file\ncontent\n');
});

test('完全相同沒有 hunk', () => {
  assert.deepEqual(computeHunks(['a', 'b'], ['a', 'b']), []);
});

test('隨機壓力測試', () => {
  let seed = 42;
  const rnd = (n: number) => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed % n;
  };
  for (let iter = 0; iter < 300; iter++) {
    const base = Array.from({ length: rnd(30) }, () => 'l' + rnd(8));
    const mod = base.filter(() => rnd(5) !== 0);
    for (let i = 0; i < rnd(6); i++) mod.splice(rnd(mod.length + 1), 0, 'n' + rnd(8));
    const a = splitLines(base.join('\n'));
    const b = splitLines(mod.join('\n'));
    let kept = a;
    for (const h of computeHunks(a, b).reverse()) kept = applyHunkToOld(kept, h);
    assert.deepEqual(kept, b);
  }
});
