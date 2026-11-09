/**
 * 快照：記下某個時間點有哪些 session 開著，之後可整批 resume 回來。
 *
 * 只照時間留紀錄，不判斷 session 為什麼消失——主動關掉和意外關掉對程式來說一樣，
 * 所以由用戶還原時選時間點。資料來源是 ~/.claude/sessions/<pid>.json，不需要碰終端機。
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const KEEP_AUTO_DAYS = 30;
const SNAP_KINDS = ['interactive', 'bg'];        // 排除 claude -p 之類的 session
const INTERVAL_SEC = 300;
const LABEL = 'com.zbryikt.ccs-snap';
const PLIST = join(homedir(), 'Library/LaunchAgents', `${LABEL}.plist`);
const LOG = join(homedir(), '.local/state/ccstat/snap.log');
const PROJECTS = join(homedir(), '.claude/projects');

// 用 argv 傳指令，省掉 AppleScript 字串跳脫
const OPEN_TABS = `
on run argv
  tell application "iTerm"
    activate
    set isNew to (count of windows) is 0
    if isNew then
      set w to (create window with default profile)
    else
      set w to current window
    end if
    repeat with i from 1 to count of argv
      if i > 1 or not isNew then
        tell w to create tab with default profile
      end if
      tell current session of w to write text (item i of argv)
    end repeat
  end tell
end run
`;

/** daemon 預先開的 bg session 還沒對話就沒有 transcript，resume 會失敗。 */
const hasTranscript = (i) => existsSync(join(PROJECTS, i.cwd.replace(/[^A-Za-z0-9]/g, '-'), `${i.sid}.jsonl`));

function liveItems(live) {
  return [...live]
    .filter(([, s]) => SNAP_KINDS.includes(s.kind) && s.cwd)
    .map(([sid, s]) => ({ sid, name: s.name ?? null, cwd: s.cwd, kind: s.kind }))
    .filter(hasTranscript)
    .sort((a, b) => a.sid.localeCompare(b.sid));
}

/** 判斷內容有沒有變。cwd 不算，避免 session 內切目錄就多一筆。 */
const signature = (items) => items.map((i) => `${i.sid}\t${i.name ?? ''}`).sort().join('\n');

function itemsOf(db, id) {
  return db.prepare('SELECT sid, name, cwd, kind FROM snapshot_items WHERE snap_id=?').all(id);
}

function insert(db, name, items, now) {
  const { lastInsertRowid: id } = db.prepare(
    'INSERT INTO snapshots (name, created_at, last_seen) VALUES (?,?,?)').run(name, now, now);
  const add = db.prepare('INSERT INTO snapshot_items (snap_id, sid, name, cwd, kind) VALUES (?,?,?,?,?)');
  for (const i of items) add.run(id, i.sid, i.name, i.cwd, i.kind);
  return Number(id);
}

function drop(db, id) {
  db.prepare('DELETE FROM snapshot_items WHERE snap_id=?').run(id);
  db.prepare('DELETE FROM snapshots WHERE id=?').run(id);
}

function tx(db, fn) {
  db.exec('BEGIN');
  try {
    const out = fn();
    db.exec('COMMIT');
    return out;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

/**
 * 存一份快照，回傳 { id, n, changed }；沒有 session 開著的自動快照回傳 null。
 * 沒給名稱就是自動快照：內容沒變只更新 last_seen，過期的會被清掉。
 */
export function take(db, live, { name = null, force = false } = {}) {
  const items = liveItems(live);
  const now = Math.floor(Date.now() / 1000);

  if (name !== null) {
    if (/^\d+$/.test(name)) throw new Error('快照名稱不能全是數字（會跟編號混淆）');
    if (!items.length) throw new Error('目前沒有開著的 session，沒有東西可記');
    return tx(db, () => {
      const old = db.prepare('SELECT id FROM snapshots WHERE name=?').get(name);
      if (old && !force) throw new Error(`快照「${name}」已存在，要覆蓋請加 --force`);
      if (old) drop(db, old.id);
      return { id: insert(db, name, items, now), n: items.length, changed: true };
    });
  }

  // 重開機後還沒有 session 時不記，否則最新一筆會是空的
  if (!items.length) return null;
  return tx(db, () => {
    const last = db.prepare('SELECT id FROM snapshots WHERE name IS NULL ORDER BY id DESC LIMIT 1').get();
    if (last && signature(itemsOf(db, last.id)) === signature(items)) {
      db.prepare('UPDATE snapshots SET last_seen=? WHERE id=?').run(now, last.id);
      return { id: last.id, n: items.length, changed: false };
    }
    const id = insert(db, null, items, now);
    const cutoff = now - KEEP_AUTO_DAYS * 86400;
    for (const { id: old } of db.prepare(
      'SELECT id FROM snapshots WHERE name IS NULL AND last_seen < ?').all(cutoff)) drop(db, old);
    return { id, n: items.length, changed: true };
  });
}

export function list(db) {
  return db.prepare('SELECT * FROM snapshots ORDER BY last_seen DESC, id DESC').all()
    .map((s) => ({ ...s, items: sorted(itemsOf(db, s.id)) }));
}

/** ref 是編號或名稱；沒給就取最近的一筆。 */
export function find(db, ref) {
  let snap;
  if (ref === undefined) snap = db.prepare('SELECT * FROM snapshots ORDER BY last_seen DESC, id DESC LIMIT 1').get();
  else if (/^\d+$/.test(ref)) snap = db.prepare('SELECT * FROM snapshots WHERE id=?').get(Number(ref));
  else snap = db.prepare('SELECT * FROM snapshots WHERE name=?').get(ref);
  if (!snap) throw new Error(ref === undefined ? '還沒有任何快照' : `找不到快照：${ref}`);
  return { ...snap, items: sorted(itemsOf(db, snap.id)) };
}

export function remove(db, ref) {
  const snap = find(db, ref);
  tx(db, () => drop(db, snap.id));
  return snap;
}

/** 依名稱排序，同主題的 agent 會排在一起；沒名稱的放最後。 */
function sorted(items) {
  return items.sort((a, b) => (a.name === null) - (b.name === null)
    || String(a.name ?? a.cwd).localeCompare(String(b.name ?? b.cwd), 'zh-Hant'));
}

const shq = (s) => `'${s.replace(/'/g, `'\\''`)}'`;

/** 先設好分頁標題：title hook 要等 Claude 下次有活動才會更新。 */
const setTitle = (name) => (name ? `printf '\\033]1;%s\\007' ${shq(name)}; ` : '');

/** 活著的 bg agent 不需要 resume，但分頁關掉後要有 claude agents 才看得到。 */
function hasAgentsViewer() {
  const r = spawnSync('ps', ['-axo', 'command='], { encoding: 'utf8' });
  return /(^|\/)claude agents(\s|$)/m.test(r.stdout ?? '');
}

/** 算出還原要做的事，不動手。 */
export function plan(snap, live) {
  const open = [], running = [], missing = [], empty = [];
  for (const i of snap.items) {
    if (live.has(i.sid)) running.push(i);
    else if (!existsSync(i.cwd)) missing.push(i);
    else if (!hasTranscript(i)) empty.push(i);
    else open.push({ ...i, cmd: `${setTitle(i.name)}cd ${shq(i.cwd)} && claude --resume ${i.sid}` });
  }
  // 看現在的狀態：快照時是 bg，resume 過就變成一般 session 了
  const bg = running.find((i) => live.get(i.sid).kind === 'bg');
  const viewer = bg && !hasAgentsViewer()
    ? { ...bg, name: 'claude agents', cmd: `cd ${shq(bg.cwd)} && claude agents` } : null;
  return { open: viewer ? [...open, viewer] : open, running, missing, empty };
}

export function openTabs(cmds) {
  if (!cmds.length) return;
  const r = spawnSync('osascript', ['-', ...cmds], { input: OPEN_TABS, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`開分頁失敗：${(r.stderr ?? '').trim()}`);
}

function launchctl(...args) {
  return spawnSync('launchctl', args, { encoding: 'utf8' });
}

/** 裝 launchd 定時跑 ccs snap。直接呼叫目前的 node，launchd 的環境沒有 volta。 */
export function install() {
  const bin = realpathSync(join(dirname(fileURLToPath(import.meta.url)), '../bin/ccs'));
  mkdirSync(dirname(PLIST), { recursive: true });
  writeFileSync(PLIST, `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${process.execPath}</string>
    <string>${bin}</string>
    <string>snap</string>
  </array>
  <key>StartInterval</key><integer>${INTERVAL_SEC}</integer>
  <key>RunAtLoad</key><true/>
  <key>StandardOutPath</key><string>/dev/null</string>
  <key>StandardErrorPath</key><string>${LOG}</string>
</dict>
</plist>
`);
  const domain = `gui/${process.getuid()}`;
  launchctl('bootout', `${domain}/${LABEL}`);      // 重裝時先卸載，沒裝過會失敗，無妨
  const r = launchctl('bootstrap', domain, PLIST);
  if (r.status !== 0) throw new Error(`launchctl 載入失敗：${(r.stderr ?? '').trim()}`);
  return { plist: PLIST, intervalMin: INTERVAL_SEC / 60 };
}

export function uninstall() {
  launchctl('bootout', `gui/${process.getuid()}/${LABEL}`);
  rmSync(PLIST, { force: true });
  return PLIST;
}
