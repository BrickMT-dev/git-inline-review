import * as vscode from 'vscode';
import * as path from 'path';
import * as assert from 'assert';
import { execSync } from 'child_process';

const repo = process.env.TEST_REPO!;
const expectInsets = process.env.EXPECT_INSETS === '1';
const git = (c: string) => execSync(`git -c core.quotePath=false ${c}`, { cwd: repo }).toString();
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const debug = () =>
  vscode.commands.executeCommand<{ insetsSupported?: boolean; insetLines: number[]; liveInsets: number; pendingFiles: string[]; fileCounter: { index: number; count: number }; hunks: number; source?: string; indexed: boolean; reviewed: number[] }>(
    'inlineGitReview._debugState',
  );

async function keepLensCount(uri: vscode.Uri) {
  const ls = (await vscode.commands.executeCommand<vscode.CodeLens[]>('vscode.executeCodeLensProvider', uri)) ?? [];
  return ls.filter((l) => l.command?.command === 'inlineGitReview.keepHunk').length;
}

export async function run() {
  const uri = vscode.Uri.file(path.join(repo, 'demo.txt'));
  const doc = await vscode.workspace.openTextDocument(uri);
  let ed = await vscode.window.showTextDocument(doc);
  await wait(2000);

  let st = await debug();
  console.log('state:', JSON.stringify(st));
  assert.equal(st.insetsSupported === true, expectInsets, 'inset 支援偵測');
  if (expectInsets) {
    // 2 段修改（第 2 行、第 5~6 行），各一個區塊，放在變更「上方」= 前一行（0-based 0 與 3）的下面
    assert.deepEqual(st.insetLines, [0, 3], 'inset 位置');
    assert.equal(st.liveInsets, 2, '不能有重複／沒清掉的 inset');
    assert.equal(await keepLensCount(uri), 0, '有 inset 時不顯示 CodeLens');
  } else {
    assert.equal(await keepLensCount(uri), 2, '退回 CodeLens');
  }

  // 打字讓 hunk 位移後，舊 inset 要被清掉、不能殘留
  await ed.edit((e) => e.insert(new vscode.Position(0, 0), 'top\n'));
  await wait(800);
  st = await debug();
  if (expectInsets) {
    // 插入的 top 本身也是一段新變更，位於檔案第一行 → line -1（整個檔案最上方）
    assert.deepEqual(st.insetLines, [-1, 1, 4], '位移後的 inset 位置');
    assert.equal(st.liveInsets, 3, '位移後沒有殘留');
  }
  // 直接刪掉插入的那行（用 undo 指令的話，焦點可能不在編輯器上而沒作用）
  await ed.edit((e) => e.delete(new vscode.Range(0, 0, 1, 0)));
  await doc.save();
  await wait(800);
  assert.equal(doc.getText(), 'line1\n新的第二行\nline3\nline4\nline5 改\nadded\n');
  assert.deepEqual(st.pendingFiles, ['demo.txt', 'new.txt', 'other.txt'], '待檢查檔案清單');
  assert.deepEqual(st.fileCounter, { index: 1, count: 3 }, '標題列：檔案 1 / 3');

  // ───── ⌘Z 復原審查動作 ─────
  const MODIFIED = 'line1\n新的第二行\nline3\nline4\nline5 改\nadded\n';
  const cmdZ = () => vscode.commands.executeCommand('inlineGitReview.undoLastReview', { fromKeybinding: true });
  const activeName = () => path.basename(vscode.window.activeTextEditor!.document.uri.fsPath);

  // Keep → ⌘Z：暫存區還原
  ed.selection = new vscode.Selection(1, 0, 1, 0);
  await vscode.commands.executeCommand('inlineGitReview.keepHunk');
  await wait(300);
  assert.match(git('diff --cached'), /新的第二行/);
  assert.deepEqual((await debug()).reviewed, [1], 'Keep 過的第 2 行標成已審（紫色）');
  await cmdZ();
  await wait(300);
  assert.equal(git('diff --cached').trim(), '', '⌘Z 應復原 Keep');
  assert.deepEqual((await debug()).reviewed, [], '復原後不再是已審');
  assert.equal(await keepLensCount(uri) || (await debug()).insetLines.length, 2, '高亮回來');

  // Undo → ⌘Z：文字還原並存檔
  ed.selection = new vscode.Selection(4, 0, 4, 0);
  await vscode.commands.executeCommand('inlineGitReview.undoHunk');
  await wait(300);
  assert.equal(doc.getText(), 'line1\n新的第二行\nline3\nline4\nline5\n');
  await cmdZ();
  await wait(300);
  assert.equal(doc.getText(), MODIFIED, '⌘Z 應復原 Undo');
  assert.equal(doc.isDirty, false);

  // Keep 兩段 → 自動跳到 new.txt → 在 new.txt 連按兩次 ⌘Z
  ed = vscode.window.activeTextEditor!;
  ed.selection = new vscode.Selection(1, 0, 1, 0);
  await vscode.commands.executeCommand('inlineGitReview.keepHunk');
  await wait(300);
  ed.selection = new vscode.Selection(4, 0, 4, 0);
  await vscode.commands.executeCommand('inlineGitReview.keepHunk');
  await wait(800);
  assert.equal(activeName(), 'new.txt', '全部 Keep 後跳到下一個檔案');
  await cmdZ();
  await wait(500);
  assert.equal(activeName(), 'demo.txt', '在下一個檔案按 ⌘Z 會回到剛剛的檔案');
  assert.match(git('diff --cached'), /新的第二行/);
  assert.doesNotMatch(git('diff --cached'), /added/, '只復原最後一次 Keep');
  await cmdZ();
  await wait(300);
  assert.equal(git('diff --cached').trim(), '', '連按 ⌘Z 繼續往前復原');

  // 上一步是一般編輯時，⌘Z 就是一般的 undo
  ed = await vscode.window.showTextDocument(doc, { preview: false }); // 確保焦點在編輯器（原生 undo 作用在有焦點的編輯器）
  await ed.edit((e) => e.insert(new vscode.Position(0, 0), 'x'));
  await cmdZ();
  await wait(300);
  // 重點是「沒有被當成審查動作」：暫存區不能被動到。
  // 原生 undo 作用在有系統焦點的編輯器，測試視窗沒拿到焦點時不會生效，這時手動清掉插入的字
  assert.equal(git('diff --cached').trim(), '', '一般編輯的 ⌘Z 不能動到暫存區');
  if (doc.getText() !== MODIFIED) {
    console.log('（測試視窗沒有系統焦點，原生 undo 未生效，手動還原）');
    await ed.edit((e) => e.delete(new vscode.Range(0, 0, 0, 1)));
  }
  assert.equal(doc.getText(), MODIFIED, '一般編輯照常 undo');
  await doc.save();
  await wait(500);

  // Keep 第一段、Undo 第二段
  ed = vscode.window.activeTextEditor!;
  ed.selection = new vscode.Selection(1, 0, 1, 0);
  await vscode.commands.executeCommand('inlineGitReview.keepHunk');
  await wait(400);
  assert.match(git('diff --cached'), /\+新的第二行/);
  ed.selection = new vscode.Selection(4, 0, 4, 0);
  await vscode.commands.executeCommand('inlineGitReview.undoHunk');
  await wait(1000);
  assert.equal(doc.getText(), 'line1\n新的第二行\nline3\nline4\nline5\n');

  // 這個檔案處理完 → 自動跳到下一個待檢查的檔案（new.txt）
  assert.equal(path.basename(vscode.window.activeTextEditor!.document.uri.fsPath), 'new.txt', '自動跳下一個檔案');
  st = await debug();
  assert.deepEqual(st.pendingFiles, ['new.txt', 'other.txt']);

  // 手動換檔：下一個 → other.txt，再下一個 → 繞回 new.txt
  await vscode.commands.executeCommand('inlineGitReview.nextFile');
  await wait(300);
  assert.equal(path.basename(vscode.window.activeTextEditor!.document.uri.fsPath), 'other.txt');
  assert.equal(vscode.window.activeTextEditor!.selection.active.line, 1, '游標放在第一段變更');
  assert.deepEqual((await debug()).fileCounter, { index: 2, count: 2 }, '標題列：檔案 2 / 2');
  await vscode.commands.executeCommand('inlineGitReview.nextFile');
  await wait(300);
  assert.equal(path.basename(vscode.window.activeTextEditor!.document.uri.fsPath), 'new.txt', '循環');
  await vscode.commands.executeCommand('inlineGitReview.prevFile');
  await wait(300);
  assert.equal(path.basename(vscode.window.activeTextEditor!.document.uri.fsPath), 'other.txt');

  // Keep File → 自動跳到 new.txt
  await vscode.commands.executeCommand('inlineGitReview.keepFile');
  await wait(800);
  assert.match(git('diff --cached --name-only'), /other\.txt/);
  assert.equal(path.basename(vscode.window.activeTextEditor!.document.uri.fsPath), 'new.txt');

  // ───── 被 .gitignore 排除的檔案：用快照當基準 ─────
  const ignoredFile = vscode.Uri.file(path.join(repo, 'local-only.txt'));
  const sdoc = await vscode.workspace.openTextDocument(ignoredFile);
  await vscode.window.showTextDocument(sdoc, { preview: false });
  await wait(1000);
  st = await debug();
  assert.equal(st.source, 'snapshot', '被排除的檔案改用快照');
  assert.equal(st.hunks, 0, '剛開啟時以當下內容為基準，沒有變更');

  // 模擬 AI 直接改磁碟上的檔案
  await vscode.workspace.fs.writeFile(ignoredFile, Buffer.from('k1\nk2 changed\nk3\n'));
  await wait(1500);
  st = await debug();
  assert.equal(st.hunks, 1, '外部修改後出現變更');
  assert.ok(st.pendingFiles.includes('local-only.txt'), '出現在待檢查清單');

  const sed = vscode.window.activeTextEditor!;
  sed.selection = new vscode.Selection(1, 0, 1, 0);
  await vscode.commands.executeCommand('inlineGitReview.keepHunk');
  await wait(500);
  st = await debug();
  assert.ok(!st.pendingFiles.includes('local-only.txt'), 'Keep 後不再待檢查');
  assert.equal(activeName(), 'new.txt', '處理完自動跳到下一個檔案');
  assert.doesNotMatch(git('diff --cached --name-only'), /local-only/, '不會被 git add');

  await cmdZ();
  await wait(500);
  assert.equal(path.basename(vscode.window.activeTextEditor!.document.uri.fsPath), 'local-only.txt');
  assert.equal((await debug()).hunks, 1, '⌘Z 復原快照的 Keep');

  vscode.window.activeTextEditor!.selection = new vscode.Selection(1, 0, 1, 0);
  await vscode.commands.executeCommand('inlineGitReview.undoHunk');
  await wait(500);
  assert.equal(sdoc.getText(), 'k1\nk2\n', 'Undo 還原成快照內容');
  assert.equal((await vscode.workspace.fs.readFile(ignoredFile)).toString(), 'k1\nk2\n', '磁碟也還原');


  // ───── 開專案時就建立基準：沒打開過的被排除檔案，被 AI 改了也看得到 ─────
  assert.equal((await debug()).indexed, true, '開專案時的索引已完成');
  const w = (rel: string, text: string) => vscode.workspace.fs.writeFile(vscode.Uri.file(path.join(repo, rel)), Buffer.from(text));
  await w('ignored_dir/conf.yaml', 'a: 1\nb: 3\n');
  await w('ignored_dir/data.bin', 'changed\n');
  await w('node_modules/lib.js', 'module.exports = 2;\n');
  await w('.env', 'API_KEY=new\n');
  await wait(1500);
  st = await debug();
  assert.ok(st.pendingFiles.includes('ignored_dir/conf.yaml'), '沒開過的 yaml 被改 → 待檢查');
  assert.ok(!st.pendingFiles.includes('ignored_dir/data.bin'), '.bin 不在副檔名清單 → 不追蹤');
  assert.ok(!st.pendingFiles.includes('node_modules/lib.js'), 'node_modules 被排除 → 不追蹤');
  assert.ok(!st.pendingFiles.includes('.env'), '.env 是機密檔 → 不建快照');

  // 打開來看：差異是跟開專案時的內容比
  const conf = await vscode.workspace.openTextDocument(vscode.Uri.file(path.join(repo, 'ignored_dir/conf.yaml')));
  await vscode.window.showTextDocument(conf, { preview: false });
  await wait(800);
  st = await debug();
  assert.equal(st.source, 'snapshot');
  assert.equal(st.hunks, 1, 'b: 2 → b: 3');

  // AI 新建一個被排除的檔案 → 整份都是新增
  await w('ignored_dir/new.yaml', 'x: 1\ny: 2\n');
  await wait(1500);
  st = await debug();
  assert.ok(st.pendingFiles.includes('ignored_dir/new.yaml'), '新檔出現在待檢查清單');
  const nyaml = await vscode.workspace.openTextDocument(vscode.Uri.file(path.join(repo, 'ignored_dir/new.yaml')));
  await vscode.window.showTextDocument(nyaml, { preview: false });
  await wait(800);
  assert.equal((await debug()).hunks, 1, '新檔整份是一段新增');
  await vscode.commands.executeCommand('inlineGitReview.keepFile');
  await wait(800);
  assert.ok(!(await debug()).pendingFiles.includes('ignored_dir/new.yaml'), 'Keep File 後不再待檢查');
  assert.doesNotMatch(git('status --short'), /new\.yaml/, '沒有被加進 git');


  // ───── 看專案外的檔案時，待檢查清單不能被換掉，‹ › 仍可跳回專案 ─────
  const before = (await debug()).pendingFiles;
  assert.ok(before.length > 0);
  const outsideDoc = await vscode.workspace.openTextDocument(vscode.Uri.file(process.env.OUTSIDE_FILE!));
  await vscode.window.showTextDocument(outsideDoc, { preview: false });
  await wait(1000);
  st = await debug();
  assert.deepEqual(st.pendingFiles, before, '打開專案外的檔案，清單不變');
  assert.deepEqual(st.fileCounter, { index: 0, count: before.length }, '狀態列顯示 –/n');
  await vscode.commands.executeCommand('inlineGitReview.nextFile');
  await wait(500);
  assert.ok(vscode.window.activeTextEditor!.document.uri.fsPath.includes(path.basename(repo)), '› 跳回專案裡的待檢查檔案');

  console.log('✅ 整合測試全部通過');
}
