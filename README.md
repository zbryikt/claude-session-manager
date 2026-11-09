# claude-session-manager

盤點本機所有 Claude Code session：目前狀態、LLM 摘要、token 用量統計、備份。

開太多 session 又不敢關，因為關掉就忘了在做什麼 —— 這個工具把「我有哪些坑」
變成隨時可查，讓 session 不必兼任待辦清單。

```
$ ccs -s
  # STATUS   IDLE   PROJECT                              SUMMARY
  1 ● busy   now    ~/ai/topics/cpu                      將 session 統計工具從 Python 改寫成 Node…
                                                          ↳ 完成所有指令測試，確認 GCS 備份可用
  2 · closed 12h    ~/ai/2026/0901-tinypng               為 PNG 量化實作 adaptive dithering…
                                                          ↳ 已 push 完成，接著處理編碼問題
```

## 需求

**Node.js >= 22.13**（用內建的 `node:sqlite`，執行期沒有任何相依套件）。
`package.json` 裡的 `@plotdb/guides` 是 devDependency，只用來提供 `context/shared`
的開發慣例文件，跑 `ccs` 用不到。
摘要功能需要已登入的 `claude` CLI；備份功能需要 `gcloud`。

`node:sqlite` 在 22.5 加入、22.13 才免旗標。`bin/ccs` 會自己處理版本差異：

1. 直接試載，可以就走
2. 不行就帶 `--experimental-sqlite` 重跑自己（涵蓋 22.5–22.12）
3. 還是不行就去 volta / n 的安裝目錄找一個 >= 22.13 的 node 重跑

第 3 步是為了 volta / nvm ——**它們依當前目錄決定 node 版本**，而 `ccs` 是從任何
目錄執行的，在某個 pin 了舊版的專案底下會拿到不堪用的 node。

## 安裝

執行期沒有相依套件，所以 `npm i` 對使用者來說幾乎什麼都不做。要做的是把 `ccs`
放上 PATH，有四種方式：

| 方式 | 安裝成本 | 每次執行 | 更新 |
|---|---|---|---|
| `npm link`（clone 後） | clone | **0.09s** | `git pull` 立即生效 |
| `npm i -g github:zbryikt/claude-session-manager` | 3.8s | 0.24s | 重跑安裝指令 |
| `npx -y github:zbryikt/claude-session-manager` | 無 | **2.0s** | 每次自動最新 |
| `./bin/ccs`（clone 後直接跑） | clone | 0.09s | `git pull` 立即生效 |

（數字是實測值，npx 的 2.0s 是有快取後的；首次約 4.9s。）

**日常使用選 `npm i -g` 或 `npm link`。** npx 每次要花 2 秒重新解析套件，
對一個一天會敲很多次的指令來說太慢，而且需要網路。它適合的是試用或一次性查詢：

```bash
# 別台機器上臨時看一下，不想留東西
npx -y github:zbryikt/claude-session-manager -c135
```

**開發機用 `npm link`**（symlink 到 repo，改了立刻生效）；
**其他機器用 `npm i -g`**（安裝的是快照複本，git pull 不會影響它）。

```bash
git clone git@github.com:zbryikt/claude-session-manager.git
cd claude-session-manager
npm link
ccs               # 第一次執行會自動全掃，約 2 秒
```

**用 volta 的話 `npm link` 特別值得做**：volta 會把 shim 綁定到安裝當下的 node
版本，之後不管在哪個目錄執行都用那個版本。

```
$ volta list
package claude-session-manager@0.3.0 / ccs / node@22.23.1
```

這比 `bin/ccs` 裡的執行期版本 fallback 乾淨——volta 使用者靠 shim 就解決了，
那層 fallback 是留給沒有版本管理工具的環境。

移除：`npm unlink -g claude-session-manager`（`npm i -g` 裝的則是
`npm uninstall -g claude-session-manager`）

### 新機器上還需要什麼

| 功能 | 需要 | 沒有的話 |
|---|---|---|
| 列表 / 統計 | 只要 Node | — |
| `ccs sum` 摘要 | 已登入的 `claude` CLI | 摘要欄顯示「尚未摘要」 |
| `ccs backup` | `gcloud` 且已 auth | 報錯並提示要跑什麼 |

資料庫是**衍生資料**，不必搬——新機器第一次跑 `ccs` 就會從該機器的
`~/.claude/projects` 重建。唯一搬得有意義的是 `summaries` 表（花 LLM 額度換來的），
那可以透過 `ccs backup` / 手動複製 `~/.local/state/ccstat/ccstat.db` 帶過去。

## 用法

```bash
ccs                  # 列出 session（執行中的排前面），自動增量掃描
ccs -l               # 只看還開著的
ccs grantdash        # 用路徑、路徑摘要或內容過濾
ccs -a               # 不限筆數

ccs sum              # 產生缺少或過期的摘要（預設前 30 筆）
ccs sum -a           # 全部補齊
ccs stats            # token 用量：每日 / 各專案 / 各模型
ccs sync             # 只做增量掃描
ccs resume 3         # 印出該筆的 cd + claude --resume 指令
ccs sync --rescan    # 清掉快取重新全掃（改過分類規則後用）
```

### 欄位

`-c` 後面接編號，列到的才顯示。`#` 與 `STATUS` 固定顯示，欄寬依終端機寬度自動分配。

| 編號 | 欄位 | 說明 |
|---|---|---|
| 1 | `IDLE` | 距離最後活動多久 |
| 2 | `PATH` | 完整路徑 |
| 3 | `PROJ` | 路徑摘要（見下） |
| 4 | `LAST PROMPT` | 最後一句輸入 |
| 5 | `SUMMARY` | LLM 摘要（在做什麼 / 下一步） |
| 6 | `NAME` | `/rename` 取的名字 |

```bash
ccs              # 預設 -c1634
ccs -c35         # 只要路徑摘要與內容摘要
ccs -c1345       # 加上完整路徑以外的全部
ccs -c24         # 完整路徑 + 最後 prompt
```

### 排序

`-s` 後面接欄位編號，`+` 正序、`-` 逆序（預設逆序）。

```bash
ccs -s1          # 依時間，新到舊
ccs -s1+         # 依時間，舊到新
ccs -s3+         # 依路徑摘要，A→Z
```

不給 `-s` 時是預設排序：**執行中的排前面**，其餘依時間新到舊。給了 `-s` 就純粹
照該欄排，不再把執行中的挑到前面。

`-r` 把顯示順序上下翻轉，讓最新的落在最下面、靠近提示列。它在排序與截取筆數之後才翻，
所以列的仍是同樣那幾筆（最新的 30 筆），`#` 也維持原本的編號，`ccs resume 1` 照樣是最新那筆。
這和 `-s1+` 不同：後者是真的改排序，截到的會是最舊的 30 筆。

```bash
ccs -r           # 最新的在最下面
ccs -r -s3+      # 依路徑摘要 Z→A 往下排
```

### 路徑摘要

從實際路徑歸納出的規則，把 cwd 壓成簡明標籤：

```
~/workspace/plotdb/projects/esh            ->  plotdb:esh
~/workspace/grantdash/boards/itma-2026     ->  grantdash:itma-2026
~/workspace/makeform/blocks/richtext       ->  makeform:richtext
~/workspace/grantdash/v2/backend           ->  grantdash:v2/backend
~/ai/2026/0901-tinypng                     ->  ai:0901 tinypng
~/ai/topics/cpu                            ->  ai:cpu
```

`projects` / `boards` / `blocks` / `case` 這些第三層是組織用的分類詞，不帶識別
資訊，顯示時略過。更深的層級保留首尾兩段而非只留首段 —— 只留首段會撞名，
例如 `case/taicca/movie` 與 `case/taicca/2026/activity-crawler` 會變成同一個標籤。

**刻意用規則而非 LLM。** 70 個實際路徑裡規則涵蓋 66 個，剩下的退回「最後兩段」
也堪用。規則零成本、零延遲，而且同一路徑永遠得到同一標籤 —— 這是一個要用眼睛
掃的欄位，措辭浮動比不夠聰明更礙事。

## 備份

`~/.claude/projects` 是所有對話的唯一副本，預設沒有任何備份機制。

```bash
ccs backup gs://your-bucket/claude/   # 首次：指定目的地，之後會記住
ccs backup                            # 用記住的目的地再備份一次
ccs backup --dry-run                  # 只看會傳什麼
ccs backup --show                     # 顯示目前的目的地
ccs backup --db-only                  # 只備份資料庫
```

傳兩份東西：`projects/`（transcript 本體，無可取代）與 `ccstat.db`（摘要與統計，
理論上可重算，但摘要是花 LLM 額度換來的）。

用 `gcloud storage rsync` —— 注意 `gh` 是 GitHub 的 CLI，碰不到 `gs://`。
**認證與權限請自行處理**，沒登入時 gcloud 的錯誤會直接透出來：

```bash
gcloud auth login
gcloud config set project <你的專案>
```

排程備份可以交給 launchd 或 cron：

```
0 3 * * *  /path/to/ccs backup >/dev/null 2>&1
```

## 快照與還原

記下某個時間點有哪些 session 開著，之後可整批 resume。只照時間留紀錄，主動或意外關掉的 session 不做區分，由還原時選時間點。

```bash
ccs snap              # 存一份；內容沒變只更新「最後看到」
ccs snap 週一進度     # 有名稱的永久保留，--force 覆蓋
ccs snap install      # 用 launchd 每 5 分鐘自動存，自動快照保留 30 天
ccs snap uninstall    # 移除自動快照
ccs snaps             # 列出所有快照
ccs snaps show 3      # 看細節（● 表示現在還開著）
ccs snaps rm 週一進度 # 刪除
ccs restore           # 還原最近一筆，每個 session 開一個 iTerm2 分頁
ccs restore 3 --dry-run
```

已在執行的 session 會跳過，重複還原不會開出重複的分頁。分頁依名稱排序；背景 agent（`kind: bg`）還原後會變成一般 session。

## 資料來源

| 來源 | 性質 | 用途 |
|---|---|---|
| `~/.claude/projects/**/*.jsonl` | append-only，永久保留 | 主體：所有 session 的歷史，含已關閉的 |
| `~/.claude/sessions/<pid>.json` | 只反映當下，進程結束即消失 | 疊上「還開著嗎」 |

存到 `~/.local/state/ccstat/ccstat.db`（SQLite）。刻意不放 `~/.claude` 底下 ——
那是 Claude Code 自己的地盤，清掉或重裝都可能連帶消失。

## 設計筆記

**增量掃描用 byte offset，不用檔案 hash。** transcript 是 append-only 的 jsonl，
所以記住上次讀到第幾個位元組，下次 seek 過去讀新增的部分就好。對 400MB 的資料
來說，每次重算 hash 只是為了確認「沒變」，成本比直接讀新增內容還高。唯一要防的
是檔案被改寫（長度變短）—— 那時 offset 失效，整檔重讀。

實測：首次全量 115 檔 / 123,003 行 / 1.9 秒，之後每次 0.06 秒。

**摘要的快取鍵才是 hash，而且只 hash 餵給模型的那段文字。** 摘要只取決於送進
模型的內容；那段文字本來就要讀，算它的 hash 不花額外 I/O。內容沒變就不重新
呼叫模型。

**摘要走 `claude -p` 而非 API。** 機器上已經有登入好的 `claude`，不需要另外的
API key，吃的是既有訂閱額度。預設 `claude-haiku-4-5`、4 並行，約 7 秒一筆。

**transcript 是資料，不是指令。** 對話內容裡可能出現任何文字，包括看起來像系統
提示的句子。實測過：不隔離的話，模型會把 transcript 裡的「禁止使用任何工具」當
成給自己的指令，然後開始自我辯解而不做摘要。所以一律包在 `<transcript>` 標籤內，
並在 system prompt 明確聲明標籤內是待摘要的資料。

**摘要不能把自己算進去。** `claude -p` 預設也會寫下自己的 transcript，那會被下一
次掃描當成新 session、再被摘要一次——每跑一輪就多出一批，而且污染 token 統計
（多出 haiku 的列、專案欄變成 `/private/tmp`）。實測跑一次 `ccs sum -n 3`，
session 數就從 115 變 118。

兩層處理：摘要呼叫加 `--no-session-persistence` 從源頭不留檔；掃描時再認一次
`entrypoint: "sdk-cli"` / `promptSource: "sdk"`，標成 `kind='sdk'` 排除在列表與
統計之外（`--sdk` 可以看）。第二層是為了舊資料和別處跑的 headless 呼叫。

順帶一提，`--disallowed-tools` 吃可變長度參數，會把後面的東西一路當成工具名，
所以 prompt 一定要用 `--` 隔開。

**表格對齊不能用 `String.padStart`。** 它數的是 UTF-16 字元數而非顯示寬度，
`'訊息'.padStart(9)` 得到 9 個字元但佔 11 格，中文表頭就會歪掉。`util.js` 的
`pad` / `lpad` 是寬度感知的版本。同理 `width()` 用明確的寬字元範圍，而不是
`> 0x2E80`——後者會把 `…` `●` `↳` `—` 這些「東亞模糊寬度」字元誤判成兩格。

**統計用路徑標籤分組，不用路徑最後一段。** 最後一段會撞名：`server` 可能是
`makechart/server`，`suite` 同時是 `servebase/suite` 與 `otl/suite`，
`judge` 橫跨好幾個 board。改用標籤後這些才分得開——這是正確性問題，不只是好看。

**衍生狀態 vs 意圖狀態。** 這個工具只處理前者 —— 在哪個目錄、閒置多久、最後做了
什麼，全都能自動算出來。後者（為什麼做這件事、下一步、卡在哪）沒有工具能推導，
那該寫在各專案 repo 裡的筆記，跟著程式碼走。

## 結構

```
bin/ccs           進入點（順手過濾掉 node:sqlite 的 experimental 警告）
src/db.js         SQLite schema（files / sessions / usage / summaries / config）
src/scan.js       增量掃描 transcript
src/pathlabel.js  路徑 -> 簡明標籤的規則
src/summarize.js  claude -p 摘要，含 prompt injection 防護
src/backup.js     gcloud storage rsync 到 GCS
src/cli.js        指令列介面
src/util.js       顯示寬度、格式化、並行池
```

## 授權

MIT
