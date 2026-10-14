# Git Inline Review

直接在檔案內逐段審閱 **尚未暫存（unstaged）** 的 git 變更，特別適合檢查 AI 改過的程式碼：

## 安裝

1. 從 [Releases](https://github.com/BrickMT-dev/git-inline-review/releases) 下載 `git-inline-review-x.y.z.vsix`，或自行建置：
   ```bash
   npm install
   npm run package
   ```
2. VS Code 擴充功能面板右上角 `⋯` →「Install from VSIX…」選擇該檔案，或在終端機執行：
   ```bash
   code --install-extension git-inline-review-x.y.z.vsix
   ```

## 功能

| 動作 | 效果 |
| --- | --- |
| **Keep** (`⌘Y`) | 把這段變更寫入 git index（等同只 `git add` 這一段），高亮消失 |
| **Undo** (`⌘N`) | 把這段還原成 index 中的版本，高亮消失 |
| **Keep File** (`⌘⌥Y` / 標題列按鈕) | `git add` 整個檔案 |
| **Undo File** (`⌘⌥N` / 標題列按鈕) | 整個檔案還原成 index 版本（未追蹤的新檔會詢問後移到垃圾桶） |
| 上一段／下一段 (`⌥[` / `⌥]`、標題列 ∧ ∨) | 在變更之間跳轉，狀態列右側顯示「段落 1/3」 |
| 上一個／下一個檔案 (`⌥⇧[` / `⌥⇧]`、標題列 ‹ ›) | 跳到 repo 中下一個還有未暫存變更的檔案；狀態列右側顯示「檔案 21/30」（點擊可列出全部檔案） |
| 復原審查 (`⌘Z`) | 剛剛 Keep / Undo 錯了？直接按 `⌘Z` 復原（Keep 會從暫存區撤回、Undo 會把內容還原、被移到垃圾桶的新檔會救回），可連按往前復原 |

`⌘Z` 只有在「上一步就是 Keep / Undo、之後沒再編輯」時才會復原審查動作，其他時候就是一般的 undo。
自動跳到下一個檔案後，在新檔案按 `⌘Z` 也會跳回去並復原。

一個檔案的變更全部 Keep / Undo 完，會自動跳到下一個待檢查的檔案（`inlineGitReview.autoNextFile`）。

比較基準是 **git index**，所以：
- AI 或你改了檔案 → 出現綠色高亮 + Keep / Undo 按鈕
- Keep 後內容進入暫存區，跟 index 一致 → 高亮消失
- 在終端機自己 `git add` / `git checkout` 也會自動同步

> `⌘Y` / `⌘N` 只在游標位於某段變更內時生效（不會蓋掉其他地方的「新增檔案」）。
> Windows/Linux 為 `Ctrl+Alt+Y` / `Ctrl+Alt+N`。可在「鍵盤快速鍵」中改綁。

## git 管不到的檔案

被 `.gitignore` 排除、或不在任何 git repo 裡（但在工作區資料夾內）的檔案，改用擴充自己保存的「快照」當基準：

- **開專案時**就替「可能需要人工檢查」的檔案建立基準：用副檔名判斷（`inlineGitReview.indexExtensions`，預設是常見的程式碼與設定檔），並略過 `node_modules`、`build`、`.dart_tool`、`Pods` 等產生出來的資料夾（`inlineGitReview.indexExcludeFolders`）
- 所以 AI 在你**還沒打開檔案**時就改了它，一樣會出現在待檢查清單
- 建立基準之後才出現的新檔，整份顯示為新增（Undo 會詢問後刪檔），跟 git 的 untracked 一樣
- 不符合副檔名規則的檔案，第一次開啟時才建立基準
- **Keep** = 更新基準（不會 `git add`），**Undo** = 還原成基準，⌘Z、換檔、計數都一樣能用
- 基準跨重開保留：VS Code 關著時被改的內容，下次開專案也看得到
- 快照存在擴充自己的儲存區，不會寫進專案
- **可能含有密碼、金鑰的檔案不建快照**（`.env`、私鑰、憑證、keystore 等），避免把機密內容複製出去；確定要的話可開啟 `inlineGitReview.snapshotSensitiveFiles`
- 想把目前內容全部當成新基準：命令面板 →「Inline Review: 以目前內容重設 git 管不到的檔案基準」

不需要時可關閉 `inlineGitReview.trackIgnoredFiles`（全部關閉）或 `inlineGitReview.indexOnOpen`（只關掉開專案時的掃描）。

## 顯示方式

### 經典樣式（預設）
- 新增／修改的行：跟隨佈景主題的綠色背景
- 每段上方的 CodeLens：`✓ Keep ⌘Y | ↺ Undo ⌘N | 1/3 ~1 行`（點最後一項開啟完整 diff）
- 被刪除的行：紅色框線 + 行尾刪除線幽靈文字；滑鼠移上去顯示完整的 `-/+` diff

### 彩色嵌入區塊（`inlineGitReview.useInsets: true`）
每段變更上方插入一個區塊：鮮綠色 **✓ Keep**／鮮紅色 **↺ Undo** 按鈕，下面用紅色整行顯示被刪除的內容。

這用到 VS Code 的 proposed API `editorInsets`，需要一次性啟用：

1. `⌘⇧P` →「Preferences: Configure Runtime Arguments」，開啟 `argv.json`
2. 加入一行：
   ```jsonc
   "enable-proposed-api": ["local.git-inline-review"]
   ```
3. **完全結束 VS Code（⌘Q）再重開**（Reload Window 不夠）

沒有啟用 proposed API 時，即使打開這個設定也會自動退回經典樣式。

## 開發
```bash
npm install
npm test          # 編譯 + 單元測試
npm run itest -- "/Applications/Visual Studio Code.app/Contents/MacOS/Code"   # 在真的 VS Code 跑整合測試
npm run package   # 產生 .vsix
```
在 VS Code 開啟此資料夾按 `F5` 即可在 Extension Development Host 中試用。

## 設定
- CodeLens 字體大小由 VS Code 的 `editor.codeLensFontSize` 控制（會影響所有 CodeLens）
- `inlineGitReview.enabled`：開關
- `inlineGitReview.showUntracked`：未追蹤的新檔也顯示為新增（預設開）
- `inlineGitReview.useInsets`：改用彩色嵌入區塊（預設關，需啟用 proposed API）
- `inlineGitReview.showCodeLens`：經典樣式下顯示 Keep / Undo 的 CodeLens（預設開）
- `inlineGitReview.autoNextFile`：檔案處理完自動跳下一個（預設開）
- `inlineGitReview.trackIgnoredFiles`：git 管不到的檔案用快照當基準（預設開）
- `inlineGitReview.indexOnOpen`：開專案時就建立基準（預設開）
- `inlineGitReview.indexExtensions`：開專案時要建立基準的副檔名
- `inlineGitReview.indexExcludeFolders`：建立基準時略過的資料夾
- `inlineGitReview.indexMaxFiles`：每個工作區資料夾最多建立幾個（預設 5000）
- `inlineGitReview.snapshotSensitiveFiles`：機密檔案也建立快照（預設關）
- `inlineGitReview.saveAfterAction`：Keep / Undo 後自動存檔（預設開）

## 隱私與安全

- 不會連線到網路，唯一執行的外部程式是 `git`（以參數陣列呼叫，不經過 shell）
- Keep 只寫入 git index，不會 commit 或 push
- 刪除檔案（Undo 未追蹤的新檔）一律先詢問，並移到垃圾桶
