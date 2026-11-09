/** ccs — Claude Code session 總覽 / 摘要 / 統計 / 備份。 */
import { readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { connect } from './db.js';
import * as scan from './scan.js';
import * as summarize from './summarize.js';
import * as backupMod from './backup.js';
import * as snapshot from './snapshot.js';
import { pathLabel } from './pathlabel.js';
import { ago, human, lpad, pad, trunc, width } from './util.js';

const SESSIONS_DIR = join(homedir(), '.claude/sessions');
const COMMANDS = ['ls', 'sum', 'sync', 'stats', 'resume', 'backup', 'snap', 'snaps', 'restore', 'help'];
const NO_SCAN = ['snap', 'snaps', 'restore'];   // 只看目前開著的 session 與快照，不需要 transcript

/**
 * 可開關的欄位。# 與 STATUS 永遠顯示（沒有它們這張表就沒意義）。
 * key 是給 -c / -s 用的編號。
 */
const COLUMNS = {
  1: { name: 'elapsed', head: 'IDLE',        sort: (r) => r.last_at ?? 0 },
  2: { name: 'path',    head: 'PATH',        sort: (r) => r.cwd ?? '' },
  3: { name: 'label',   head: 'PROJ',        sort: (r) => r.label ?? '' },
  4: { name: 'prompt',  head: 'LAST PROMPT', sort: (r) => r.last_prompt ?? '' },
  5: { name: 'doing',   head: 'SUMMARY',     sort: (r) => r.doing ?? '' },
  6: { name: 'name',    head: 'NAME',        sort: (r) => r.name ?? '' },
};
const DEFAULT_COLS = [1, 6, 3, 4];

/** 從 argv 抽出 -c1234 與 -s3+ 這種黏在一起的短旗標，其餘交給 parseArgs。 */
function extractDisplayFlags(argv) {
  let cols = null, sort = null;
  const rest = [];
  const valid = Object.keys(COLUMNS).join('');
  for (const a of argv) {
    let m = a.match(/^-c(.*)$/);
    if (m) {
      if (!/^[1-6]+$/.test(m[1])) {
        throw new Error(`-c 後面只能接 ${valid} 的組合，收到：${a}\n` +
          `  1=閒置時間 2=完整路徑 3=路徑摘要 4=最後 prompt 5=內容摘要 6=名稱`);
      }
      cols = [...new Set(m[1].split('').map(Number))];
      continue;
    }
    m = a.match(/^-s(.*)$/);
    if (m) {
      const mm = m[1].match(/^([1-6])([+-]?)$/);
      if (!mm) {
        throw new Error(`-s 後面只能接 ${valid} 加上選用的 + / -，收到：${a}\n` +
          `  例：-s1（時間，新到舊）、-s3+（路徑摘要，A→Z）`);
      }
      sort = { field: Number(mm[1]), asc: mm[2] === '+' };
      continue;
    }
    rest.push(a);
  }
  return { cols, sort, rest };
}

/**
 * { sessionId: {pid, status, name, cwd, kind} }，只含進程還活著的。
 * ~/.claude/sessions/<pid>.json 只反映當下（進程結束就清掉），所以它是
 * 「還開著嗎」的來源，歷史一律看 transcript。
 */
function liveSessions() {
  const out = new Map();
  let names = [];
  try { names = readdirSync(SESSIONS_DIR).filter((n) => n.endsWith('.json')); } catch { return out; }
  for (const name of names) {
    try {
      const d = JSON.parse(readFileSync(join(SESSIONS_DIR, name), 'utf8'));
      process.kill(d.pid, 0);                 // 探活，死了會丟例外
      out.set(d.sessionId, { pid: d.pid, status: d.status ?? '?', name: d.name ?? null, cwd: d.cwd, kind: d.kind });
    } catch { /* 進程沒了或檔案壞了，略過 */ }
  }
  return out;
}

function fetchRows(db, { pattern, live, limit, sort, sdk = false } = {}) {
  // 預設不列 claude -p 自己留下的 session（kind='sdk'）
  let rows = db.prepare(`
    SELECT s.*, m.doing, m.next_step
    FROM sessions s LEFT JOIN summaries m ON m.sid = s.sid
    ${sdk ? '' : "WHERE COALESCE(s.kind,'interactive') <> 'sdk'"}
    ORDER BY s.last_at DESC`).all();

  const alive = liveSessions();
  rows = rows.map((r) => {
    const live = alive.get(r.sid) ?? null;
    return { ...r, live, name: live?.name ?? r.name, label: r.label ?? pathLabel(r.cwd) };
  });

  if (sort) {
    // 明確指定排序時就純粹照該欄排，不再把執行中的挑到前面
    const key = COLUMNS[sort.field].sort;
    const dir = sort.asc ? 1 : -1;
    rows.sort((a, b) => {
      const x = key(a), y = key(b);
      const c = typeof x === 'number' ? x - y : String(x).localeCompare(String(y), 'zh-Hant');
      return c * dir;
    });
  } else {
    // 預設：執行中的排前面，其餘依最後活動時間新到舊
    rows.sort((a, b) => (a.live ? 0 : 1) - (b.live ? 0 : 1) || (b.last_at ?? 0) - (a.last_at ?? 0));
  }

  if (live) rows = rows.filter((r) => r.live);
  if (pattern) {
    const p = pattern.toLowerCase();
    rows = rows.filter((r) => [r.cwd, r.label, r.name, r.last_prompt, r.doing]
      .some((v) => (v ?? '').toLowerCase().includes(p)));
  }
  return limit ? rows.slice(0, limit) : rows;
}

// ---------- 子指令 ----------

function cmdSync(db, opts) {
  const t0 = Date.now();
  const { files, lines } = scan.sync(db, { verbose: opts.verbose, rescan: opts.rescan });
  const n = db.prepare(
    "SELECT COUNT(*) c FROM sessions WHERE COALESCE(kind,'interactive') <> 'sdk'").get().c;
  const sdk = db.prepare("SELECT COUNT(*) c FROM sessions WHERE kind='sdk'").get().c;
  console.log(`掃描完成：${files} 個檔案有新增，共 ${lines} 行，` +
              `${((Date.now() - t0) / 1000).toFixed(1)}s` +
              `（${n} 個 session${sdk ? `，另有 ${sdk} 個 claude -p 產生的已排除` : ''}）`);
}

/**
 * 依終端機寬度分配欄位。固定寬度的欄位先扣掉，剩下的由文字欄位（last prompt
 * 與 summary）平分——只有一個時就獨佔。
 */
function layout(cols, rows, total) {
  const w = { };
  let fixed = 3 + 1 + 8 + 1;                       // # 與 STATUS
  if (cols.includes(1)) { w.elapsed = 6; fixed += 7; }
  if (cols.includes(6)) {
    w.name = Math.min(24, Math.max(4, ...rows.map((r) => width(r.name))));
    fixed += w.name + 1;
  }
  if (cols.includes(3)) {
    w.label = Math.min(32, Math.max(4, ...rows.map((r) => width(r.label))));
    fixed += w.label + 1;
  }
  if (cols.includes(2)) {
    w.path = Math.min(38, Math.max(4, ...rows.map((r) => width(shortPath(r.cwd)))));
    fixed += w.path + 1;
  }
  const flex = [4, 5].filter((c) => cols.includes(c));
  const room = Math.max(20, total - fixed);
  if (flex.length) {
    const each = Math.floor((room - (flex.length - 1)) / flex.length);
    if (cols.includes(4)) w.prompt = each;
    if (cols.includes(5)) w.doing = each;
  }
  const tableWidth = fixed + flex.reduce(
    (n, c) => n + (c === 4 ? w.prompt : w.doing) + 1, 0) - 1;
  return { w, tableWidth: Math.min(total, tableWidth) };
}

function shortPath(cwd) {
  return (cwd ?? '?').replace(homedir(), '~');
}

function cmdLs(db, opts) {
  const rows = fetchRows(db, {
    pattern: opts.pattern, live: opts.live, sort: opts.sort, sdk: opts.sdk,
    limit: opts.all ? null : opts.n,
  });
  const cols = opts.cols;
  const total = process.stdout.columns && process.stdout.columns > 60
    ? process.stdout.columns - 1 : 118;
  const { w, tableWidth } = layout(cols, rows, total);

  const head = [`${'#'.padStart(3)}`, pad('STATUS', 8)];
  if (cols.includes(1)) head.push(pad(COLUMNS[1].head, w.elapsed));
  if (cols.includes(6)) head.push(pad(COLUMNS[6].head, w.name));
  if (cols.includes(3)) head.push(pad(COLUMNS[3].head, w.label));
  if (cols.includes(2)) head.push(pad(COLUMNS[2].head, w.path));
  if (cols.includes(4)) head.push(pad(COLUMNS[4].head, w.prompt));
  if (cols.includes(5)) head.push(COLUMNS[5].head);
  const line = head.join(' ').trimEnd();
  console.log(line);
  console.log('-'.repeat(tableWidth));

  // -r 只翻轉顯示順序：仍取同樣那幾筆，編號也不變，resume <n> 照樣對得上
  const shown = rows.map((r, i) => [r, i]);
  if (opts.reverse) shown.reverse();

  shown.forEach(([r, i]) => {
    const cells = [String(i + 1).padStart(3),
                   pad(r.live ? `● ${r.live.status}` : '· closed', 8)];
    if (cols.includes(1)) cells.push(pad(ago(r.last_at), w.elapsed));
    if (cols.includes(6)) cells.push(pad(trunc(r.name, w.name), w.name));
    if (cols.includes(3)) cells.push(pad(trunc(r.label, w.label), w.label));
    if (cols.includes(2)) cells.push(pad(trunc(shortPath(r.cwd), w.path), w.path));
    if (cols.includes(4)) cells.push(pad(trunc(r.last_prompt, w.prompt), w.prompt));
    if (cols.includes(5)) {
      cells.push(r.doing ? trunc(r.doing, w.doing) : '(尚未摘要，跑 ccs sum)');
    }
    console.log(cells.join(' ').trimEnd());

    // 摘要的「下一步」接在同一筆下面，縮排對齊摘要欄
    if (cols.includes(5) && r.next_step) {
      const indent = cells.slice(0, -1).reduce((n, c) => n + width(c) + 1, 0);
      console.log(' '.repeat(indent) + '↳ ' + trunc(r.next_step, w.doing - 2));
    }
  });

  const totalN = db.prepare(
    `SELECT COUNT(*) c FROM sessions${opts.sdk ? '' : " WHERE COALESCE(kind,'interactive') <> 'sdk'"}`
  ).get().c;
  console.log('-'.repeat(tableWidth));
  console.log(`共 ${totalN} 個 session（${rows.filter((r) => r.live).length} 執行中），顯示 ${rows.length} 筆`);
}

async function cmdSum(db, opts) {
  const rows = fetchRows(db, { pattern: opts.pattern, live: opts.live, sort: opts.sort,
                               sdk: opts.sdk, limit: opts.all ? null : opts.n });
  const todo = summarize.pending(db, rows.map((r) => ({ sid: r.sid, path: r.path })));
  if (!todo.length) return console.log('摘要都是最新的，沒有要產生的');

  console.log(`產生 ${todo.length} 筆摘要（model=${opts.model}，${opts.workers} 並行）…`);
  const ok = await summarize.generate(db, todo, {
    model: opts.model, workers: opts.workers,
    onDone: (i, n, sid, good) => console.log(`  ${good ? '✓' : '✗'} [${i}/${n}] ${sid.slice(0, 8)}`),
  });
  console.log(`完成 ${ok}/${todo.length}`);
}

/**
 * 用欄位規格畫表，避免每個表各自拼字串又各自算錯寬度。
 * align 'r' 的欄位用 lpad 而不是 String.padStart——後者數字元不數顯示寬度。
 */
function renderTable(title, cols, rows) {
  const cell = (c, v) => (c.align === 'r' ? lpad(trunc(v, c.w), c.w) : pad(trunc(v, c.w), c.w));
  const head = cols.map((c) => cell(c, c.head)).join(' ');
  console.log(`\n=== ${title} ===`);
  console.log(head);
  console.log('-'.repeat(width(head)));
  for (const r of rows) console.log(cols.map((c) => cell(c, c.get(r))).join(' ').trimEnd());
}

function cmdStats(db, opts) {
  // 與列表一致：預設把 claude -p 自己的用量排除，否則它會混進專案與模型統計
  const only = opts.sdk ? '' :
    "AND u.sid IN (SELECT sid FROM sessions WHERE COALESCE(kind,'interactive') <> 'sdk')";
  const onlyBare = opts.sdk ? '' :
    "AND sid IN (SELECT sid FROM sessions WHERE COALESCE(kind,'interactive') <> 'sdk')";

  const num = (head, w, get) => ({ head, w, align: 'r', get });

  renderTable('每日用量（最近 14 天）', [
    { head: '日期', w: 11, align: 'l', get: (r) => r.day },
    num('session', 8, (r) => r.s),
    num('訊息', 8, (r) => r.n),
    num('輸入', 9, (r) => human(r.i)),
    num('輸出', 9, (r) => human(r.o)),
    num('快取讀', 10, (r) => human(r.cr)),
  ], db.prepare(`SELECT day, COUNT(DISTINCT sid) s, COUNT(*) n,
                   SUM(input) i, SUM(output) o, SUM(cache_read) cr
                 FROM usage WHERE day IS NOT NULL ${onlyBare}
                 GROUP BY day ORDER BY day DESC LIMIT 14`).all());

  renderTable('各專案（依輸出 token）', [
    { head: '專案', w: 30, align: 'l', get: (r) => r.p },
    num('session', 8, (r) => r.c),
    num('訊息', 8, (r) => r.n),
    num('輸出', 9, (r) => human(r.o)),
    num('快取讀', 10, (r) => human(r.cr)),
  ], db.prepare(`SELECT COALESCE(s.label, s.project) p, COUNT(DISTINCT s.sid) c,
                   COUNT(u.uuid) n, SUM(u.output) o, SUM(u.cache_read) cr
                 FROM sessions s JOIN usage u ON u.sid = s.sid
                 WHERE 1=1 ${only}
                 GROUP BY p ORDER BY o DESC LIMIT 15`).all());

  renderTable('各模型', [
    { head: '模型', w: 26, align: 'l', get: (r) => r.model },
    num('訊息', 8, (r) => r.n),
    num('輸入', 9, (r) => human(r.i)),
    num('輸出', 9, (r) => human(r.o)),
    num('快取讀', 10, (r) => human(r.cr)),
  ], db.prepare(`SELECT model, COUNT(*) n, SUM(input) i, SUM(output) o, SUM(cache_read) cr
                 FROM usage WHERE model IS NOT NULL ${onlyBare}
                 GROUP BY model ORDER BY o DESC`).all());

  const t = db.prepare(`SELECT COUNT(*) n, SUM(input) i, SUM(output) o,
                          SUM(cache_read) cr, SUM(cache_create) cc
                        FROM usage WHERE 1=1 ${onlyBare}`).get();
  console.log(`\n總計：${t.n} 則助理訊息 / 輸入 ${human(t.i)} / 輸出 ${human(t.o)}` +
              ` / 快取讀 ${human(t.cr)} / 快取寫 ${human(t.cc)}`);
}

function cmdResume(db, opts) {
  const rows = fetchRows(db, { pattern: opts.pattern, sort: opts.sort, sdk: opts.sdk });
  const r = rows[Number(opts.index) - 1];
  if (!r) { console.error('找不到對應的 session'); process.exit(1); }
  console.log(`cd ${r.cwd} && claude --resume ${r.sid}`);
}

function cmdSnap(db, opts) {
  const [arg] = opts.pos;
  if (arg === 'install') {
    const { plist, intervalMin } = snapshot.install();
    return console.log(`已設定每 ${intervalMin} 分鐘自動快照：${plist}`);
  }
  if (arg === 'uninstall') return console.log(`已移除自動快照：${snapshot.uninstall()}`);
  const r = snapshot.take(db, liveSessions(), { name: arg ?? null, force: opts.force });
  if (!r) return console.log('目前沒有開著的 session，沒有記錄');
  console.log(r.changed ? `已存快照 #${r.id}（${r.n} 個 session）` : `內容沒變，沿用快照 #${r.id}（${r.n} 個 session）`);
}

function fmtTime(sec) {
  const d = new Date(sec * 1000);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

const itemName = (i) => i.name ?? shortPath(i.cwd);

function printSnap(snap, live) {
  console.log(`快照 #${snap.id}${snap.name ? `「${snap.name}」` : '（自動）'}`);
  console.log(`建立 ${fmtTime(snap.created_at)}，最後看到 ${fmtTime(snap.last_seen)}，${snap.items.length} 個 session\n`);
  const w = Math.min(24, Math.max(...snap.items.map((i) => width(itemName(i)))));
  for (const i of snap.items) {
    const state = live.has(i.sid) ? '●' : '·';
    console.log(`${state} ${pad(trunc(itemName(i), w), w)} ${pad(i.kind, 11)} ${i.sid.slice(0, 8)}  ${shortPath(i.cwd)}`);
  }
}

function cmdSnaps(db, opts) {
  const [sub, ref] = opts.pos;
  if (sub === 'show') return printSnap(snapshot.find(db, ref), liveSessions());
  if (sub === 'rm') {
    if (ref === undefined) throw new Error('要指定快照的編號或名稱：ccs snaps rm <id|名稱>');
    const s = snapshot.remove(db, ref);
    return console.log(`已刪除快照 #${s.id}${s.name ? `「${s.name}」` : ''}`);
  }
  if (sub !== undefined) throw new Error(`不認識的子指令：${sub}（可用 show、rm）`);
  const snaps = snapshot.list(db);
  if (!snaps.length) return console.log('還沒有任何快照，跑 ccs snap 存一份');
  renderTable('快照', [
    { head: 'ID', w: 5, align: 'r', get: (s) => s.id },
    { head: '名稱', w: 16, align: 'l', get: (s) => s.name ?? '(自動)' },
    { head: '建立', w: 16, align: 'l', get: (s) => fmtTime(s.created_at) },
    { head: '最後看到', w: 16, align: 'l', get: (s) => fmtTime(s.last_seen) },
    { head: '數量', w: 4, align: 'r', get: (s) => s.items.length },
    { head: 'SESSIONS', w: 50, align: 'l', get: (s) => s.items.map(itemName).join(', ') },
  ], snaps);
}

function cmdRestore(db, opts) {
  const snap = snapshot.find(db, opts.pos[0]);
  const live = liveSessions();
  const { open, running, missing } = snapshot.plan(snap, live);
  console.log(`還原快照 #${snap.id}${snap.name ? `「${snap.name}」` : ''}（${fmtTime(snap.last_seen)}）`);
  for (const i of running) console.log(`  跳過（已在執行）  ${itemName(i)}`);
  for (const i of missing) console.log(`  跳過（目錄不存在）${itemName(i)}  ${shortPath(i.cwd)}`);
  for (const i of open) console.log(`  ${opts.dryRun ? '會開啟' : '開啟'}  ${itemName(i)}${opts.dryRun ? `\n    ${i.cmd}` : ''}`);
  if (!open.length) return console.log('沒有需要開啟的 session');
  if (!opts.dryRun) snapshot.openTabs(open.map((i) => i.cmd));
}

async function cmdBackup(db, opts) {
  if (opts.show) {
    const d = backupMod.showDest(db);
    return console.log(d ? `目前的備份目的地：${d}` : '尚未設定備份目的地');
  }
  await backupMod.backup(db, { dest: opts.dest, dryRun: opts.dryRun, dbOnly: opts.dbOnly });
}

// ---------- 進入點 ----------

const HELP = `ccs — Claude Code session 總覽

用法：
  ccs [pattern]            列出 session（執行中的排前面），自動增量掃描
  ccs -l                   只看還開著的
  ccs -a                   不限筆數（預設 30）

欄位（-c 後面接編號，列到的才顯示；# 與 STATUS 固定顯示）：
  1 = 閒置時間   2 = 完整路徑   3 = 路徑摘要   4 = 最後 prompt   5 = 內容摘要   6 = 名稱
  預設 -c1634。例：ccs -c1345、ccs -c35、ccs -c1234

排序（-s 後面接欄位編號，+ 正序 - 逆序，預設逆序）：
  ccs -s1      依時間，新到舊（等同 -s1-）
  ccs -s3+     依路徑摘要，A→Z
  不給 -s 時：執行中的排前面，其餘依時間新到舊
  ccs -r       顯示順序上下翻轉（最新的在最下面）；筆數與編號不變

  ccs sum [pattern]        產生缺少或過期的摘要
  ccs stats                token 用量：每日 / 各專案 / 各模型
  ccs sync                 只做增量掃描
  ccs sync --rescan        清掉快取重新全掃（改過分類規則後用）
  ccs resume <n>           印出該筆的 cd + claude --resume 指令

  ccs snap [名稱]          存一份快照（目前開著哪些 session）；有名稱的永久保留
  ccs snap --force <名稱>  覆蓋同名快照
  ccs snap install         裝 launchd，每 5 分鐘自動存（沒變動不新增，保留 30 天）
  ccs snap uninstall       移除自動快照
  ccs snaps                列出所有快照
  ccs snaps show [id|名稱] 看某份的細節（● 表示現在還開著）
  ccs snaps rm <id|名稱>   刪除快照
  ccs restore [id|名稱]    每個 session 開一個分頁 resume，已在執行的跳過（預設最近一筆）
  ccs restore --dry-run    只印出會做什麼

  ccs backup gs://bucket/path/   備份 transcript 與資料庫到 GCS（會記住目的地）
  ccs backup                     用記住的目的地再備份一次
  ccs backup --show              顯示目前設定的目的地
  ccs backup --dry-run           只看會傳什麼，不實際寫入

選項：
  -n <num>     顯示筆數      --model <id>   摘要用的模型
  --db <path>  資料庫路徑     --workers <n>  摘要並行數
  --no-sync    跳過自動掃描   --sdk          一併列出 claude -p 自己產生的 session
`;

async function main() {
  let argv = process.argv.slice(2);
  const cmd = COMMANDS.includes(argv[0]) ? argv.shift() : 'ls';
  let disp;
  try {
    disp = extractDisplayFlags(argv);
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
  argv = disp.rest;
  if (cmd === 'help' || argv.includes('-h') || argv.includes('--help')) {
    return console.log(HELP);
  }

  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        n: { type: 'string', default: '30' },
        all: { type: 'boolean', short: 'a', default: false },
        live: { type: 'boolean', short: 'l', default: false },
        reverse: { type: 'boolean', short: 'r', default: false },
        model: { type: 'string', default: summarize.MODEL },
        workers: { type: 'string', default: String(summarize.WORKERS) },
        db: { type: 'string' },
        'no-sync': { type: 'boolean', default: false },
        verbose: { type: 'boolean', short: 'v', default: false },
        'dry-run': { type: 'boolean', default: false },
        'db-only': { type: 'boolean', default: false },
        sdk: { type: 'boolean', default: false },
        rescan: { type: 'boolean', default: false },
        show: { type: 'boolean', default: false },
        force: { type: 'boolean', default: false },
      },
    });
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }

  const { values: v, positionals: pos } = parsed;
  const db = connect(v.db);
  if (!v['no-sync'] && cmd !== 'sync' && !NO_SCAN.includes(cmd)) scan.sync(db);   // 增量，沒新東西幾乎不花時間
  if (!NO_SCAN.includes(cmd)) scan.backfillNames(db);

  const opts = {
    pattern: cmd === 'resume' ? pos[1] : pos[0],
    index: pos[0], dest: pos[0],
    n: Number(v.n), all: v.all, live: v.live, reverse: v.reverse,
    cols: disp.cols ?? DEFAULT_COLS, sort: disp.sort,
    model: v.model, workers: Number(v.workers), verbose: v.verbose,
    dryRun: v['dry-run'], dbOnly: v['db-only'], show: v.show,
    sdk: v.sdk, rescan: v.rescan, pos, force: v.force,
  };

  try {
    if (cmd === 'ls') cmdLs(db, opts);
    else if (cmd === 'sum') await cmdSum(db, opts);
    else if (cmd === 'sync') cmdSync(db, opts);
    else if (cmd === 'stats') cmdStats(db, opts);
    else if (cmd === 'resume') cmdResume(db, opts);
    else if (cmd === 'backup') await cmdBackup(db, opts);
    else if (cmd === 'snap') cmdSnap(db, opts);
    else if (cmd === 'snaps') cmdSnaps(db, opts);
    else if (cmd === 'restore') cmdRestore(db, opts);
  } catch (e) {
    console.error(`\n${e.message}`);
    process.exit(1);
  } finally {
    db.close();
  }
}

await main();
