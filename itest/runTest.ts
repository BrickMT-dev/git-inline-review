import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';
import { execSync } from 'child_process';
import { runTests } from '@vscode/test-electron';

// 用法：node out/itest/runTest.js [VS Code 執行檔路徑]
// 會分別在「啟用 / 未啟用 editorInsets proposed API」兩種模式下各跑一次
async function main() {
  for (const insets of [true, false]) {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'inline-review-'));
    const sh = (c: string) => execSync(c, { cwd: repo });
    sh('git init -q && git config user.email t@t && git config user.name t');
    fs.writeFileSync(path.join(repo, 'demo.txt'), 'line1\n舊的第二行\nline3\nline4\nline5\n');
    fs.writeFileSync(path.join(repo, 'other.txt'), 'a\nb\n');
    fs.writeFileSync(path.join(repo, '.gitignore'), 'local-only.txt\nignored_dir/\nnode_modules/\n.env\n');
    // submodule：之後在裡面多一個 commit，讓 superproject 看到指標變動（不能被當成待檢查的檔案）
    const subSrc = fs.mkdtempSync(path.join(os.tmpdir(), 'inline-review-sub-'));
    execSync('git init -q && git config user.email t@t && git config user.name t && echo v1 > lib.txt && git add . && git commit -qm v1', { cwd: subSrc });
    sh(`git -c protocol.file.allow=always submodule add -q "${subSrc}" sub`);
    sh('git add . && git commit -qm init');
    execSync('git config user.email t@t && git config user.name t && echo v2 > lib.txt && git commit -qam v2', { cwd: path.join(repo, 'sub') });
    // 被 git 排除的檔案（開專案時應該替符合副檔名、且不在 node_modules 的檔案建立基準）
    fs.writeFileSync(path.join(repo, 'local-only.txt'), 'k1\nk2\n');
    fs.writeFileSync(path.join(repo, '.env'), 'API_KEY=old\n'); // 機密檔：預設不能被複製成快照
    fs.mkdirSync(path.join(repo, 'ignored_dir'));
    fs.writeFileSync(path.join(repo, 'ignored_dir', 'conf.yaml'), 'a: 1\nb: 2\n');
    fs.writeFileSync(path.join(repo, 'ignored_dir', 'data.bin'), 'binary-ish\n');
    fs.mkdirSync(path.join(repo, 'node_modules'));
    fs.writeFileSync(path.join(repo, 'node_modules', 'lib.js'), 'module.exports = 1;\n');
    fs.writeFileSync(path.join(repo, 'demo.txt'), 'line1\n新的第二行\nline3\nline4\nline5 改\nadded\n');
    fs.writeFileSync(path.join(repo, 'other.txt'), 'a\nb changed\n');
    fs.writeFileSync(path.join(repo, 'new.txt'), 'brand new\n');
    // 未追蹤的二進位檔：不能出現在待檢查清單（否則換檔時會試圖用文字開啟而報錯）
    fs.writeFileSync(path.join(repo, '系統設計.pdf'), Buffer.from('%PDF-1.7\n%\xe2\xe3\xcf\xd3\n', 'latin1'));
    fs.writeFileSync(path.join(repo, 'blob.dat'), Buffer.from([0x41, 0x00, 0x42, 0x0a]));

    // 開發模式下 proposed API 一律可用，所以用設定關掉 inset 來測退回 CodeLens 的路徑
    const userDir = fs.mkdtempSync(path.join(os.tmpdir(), 'inline-review-user-'));
    fs.mkdirSync(path.join(userDir, 'User'));
    fs.writeFileSync(path.join(userDir, 'User', 'settings.json'), JSON.stringify({ 'inlineGitReview.useInsets': insets }));
    // 專案外、不相關的另一個 repo（模擬「跳到定義」打開 SDK／套件原始碼）
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'inline-review-outside-'));
    execSync('git init -q && git config user.email t@t && git config user.name t && echo sdk > sdk.dart && git add . && git commit -qm sdk', { cwd: outside });
    console.log(`\n=== ${insets ? 'Inset 模式' : 'CodeLens 模式'} ===`);
    await runTests({
      vscodeExecutablePath: process.argv[2],
      extensionDevelopmentPath: path.resolve(__dirname, '../..'),
      extensionTestsPath: path.resolve(__dirname, 'suite'),
      launchArgs: [
        repo,
        '--disable-extensions',
        '--user-data-dir',
        userDir,
      ],
      extensionTestsEnv: { TEST_REPO: repo, EXPECT_INSETS: insets ? '1' : '0', OUTSIDE_FILE: path.join(outside, 'sdk.dart') },
    });
  }
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
