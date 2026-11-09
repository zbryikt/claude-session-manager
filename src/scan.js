/**
 * 掃描 ~/.claude/projects 的 transcript 進資料庫。
 *
 * 核心是增量：transcript 是 append-only 的 jsonl，所以只要記住上次讀到第幾個
 * 位元組，下次 seek 過去讀新增的部分就好。不需要算檔案 hash——對 400MB 的資料
 * 來說，每次重算只是為了確認「沒變」，成本比直接讀新增內容還高。
 *
 * 唯一要防的是檔案被改寫（長度變短）：這時 offset 失效，整檔重讀。
 */
import { readFileSync } from 'node:fs';
import { getConfig, setConfig } from './db.js';
import { readdirSync, statSync, openSync, readSync, closeSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join, sep } from 'node:path';
import { localDay } from './util.js';
import { pathLabel } from './pathlabel.js';

export const PROJECTS = join(homedir(), '.claude/projects');

const SKIP_PREFIX = ['<task-notification>', '<local-command', '<system-reminder>'];

/** 所有 transcript 路徑；子代理的紀錄不是獨立 session，略過。 */
export function listTranscripts(root = PROJECTS) {
  let entries;
  try {
    entries = readdirSync(root, { recursive: true, withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((e) => e.isFile() && e.name.endsWith('.jsonl'))
    .map((e) => join(e.parentPath ?? e.path, e.name))
    .filter((p) => !p.split(sep).includes('subagents'));
}

/** 把 message.content 攤成純文字，丟掉 tool_use / tool_result 區塊。 */
export function textOf(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.filter((b) => b && b.type === 'text').map((b) => b.text || '').join('\n');
  }
  return '';
}

function tsOf(rec) {
  if (!rec.timestamp) return null;
  const ms = Date.parse(rec.timestamp);
  return Number.isNaN(ms) ? null : ms / 1000;
}

/** 從 offset 讀到最後一個完整的行。回傳 { lines, offset }。 */
export function readDelta(path, offset) {
  const size = statSync(path).size;
  if (offset > size) offset = 0;            // 檔案被改寫過，重來
  if (offset === size) return { lines: [], offset };

  const fd = openSync(path, 'r');
  let buf;
  try {
    buf = Buffer.allocUnsafe(size - offset);
    readSync(fd, buf, 0, buf.length, offset);
  } finally {
    closeSync(fd);
  }

  // 尾巴若不是完整一行就留著，下次連同後續內容一起讀
  const cut = buf.lastIndexOf(0x0a);
  if (cut < 0) return { lines: [], offset };
  return {
    lines: buf.subarray(0, cut).toString('utf8').split('\n'),
    offset: offset + cut + 1,
  };
}

/** 掃一個 transcript 的新增部分。回傳新增行數。 */
export function scanFile(db, path) {
  const sid = basename(path, '.jsonl');
  const prev = db.prepare('SELECT size FROM files WHERE path=?').get(path);
  let offset = prev ? Number(prev.size) : 0;

  if (offset && offset > statSync(path).size) {
    // 檔案縮短 = 被改寫，該 session 的累計數字重來
    db.prepare('DELETE FROM usage WHERE sid=?').run(sid);
    db.prepare('UPDATE sessions SET n_user=0, n_assistant=0 WHERE sid=?').run(sid);
    offset = 0;
  }

  const { lines, offset: newOffset } = readDelta(path, offset);
  if (!lines.length) return 0;

  let cwd = null, branch = null, lastPrompt = null;
  let started = null, last = null, nUser = 0, nAsst = 0;
  // claude -p（headless）自己也會留下 transcript。摘要功能已用
  // --no-session-persistence 從源頭關掉，這裡再認一次當防呆：舊資料、
  // 或別處跑的 headless 呼叫，都會被標成 sdk 而不混進列表與統計。
  let kind = null;
  let name = null;
  const usageRows = [];

  for (const line of lines) {
    if (!line) continue;
    let rec;
    try { rec = JSON.parse(line); } catch { continue; }

    const ts = tsOf(rec);
    if (ts !== null) {
      started = started === null ? ts : Math.min(started, ts);
      last = last === null ? ts : Math.max(last, ts);
    }

    if (rec.entrypoint === 'sdk-cli' || rec.promptSource === 'sdk') kind = 'sdk';
    if (rec.type === 'custom-title') name = rec.customTitle || name;

    if (rec.type === 'user') {
      cwd = rec.cwd || cwd;
      branch = rec.gitBranch || branch;
      if (rec.userType === 'external' && !rec.isMeta) {
        const s = textOf(rec.message?.content).trim();
        if (s && !SKIP_PREFIX.some((p) => s.startsWith(p))) {
          nUser++;
          lastPrompt = s;
        }
      }
    } else if (rec.type === 'assistant') {
      nAsst++;
      const u = rec.message?.usage || {};
      if (rec.uuid) {
        usageRows.push([
          rec.uuid, sid, ts, ts === null ? null : localDay(ts),
          rec.message?.model ?? null,
          u.input_tokens || 0, u.output_tokens || 0,
          u.cache_read_input_tokens || 0, u.cache_creation_input_tokens || 0,
        ]);
      }
    } else if (rec.type === 'last-prompt') {
      lastPrompt = rec.lastPrompt || lastPrompt;
    }
  }

  // 檔尾沒有 user 記錄時，從目錄名還原路徑
  if (!cwd) {
    const dir = basename(path.slice(0, path.lastIndexOf(sep)));
    cwd = '/' + dir.replace(/^-/, '').replaceAll('-', '/');
  }
  const project = cwd.split('/').filter(Boolean).pop() ?? null;
  // 路徑最後一段會撞名（server 可能是 makechart/server 或別的），統計一律用標籤
  const label = pathLabel(cwd);

  db.prepare(`
    INSERT INTO sessions (sid, path, cwd, project, label, branch, started_at, last_at,
                          n_user, n_assistant, last_prompt, kind, name)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(sid) DO UPDATE SET
      path=excluded.path,
      cwd=COALESCE(excluded.cwd, sessions.cwd),
      project=COALESCE(excluded.project, sessions.project),
      label=COALESCE(excluded.label, sessions.label),
      branch=COALESCE(excluded.branch, sessions.branch),
      started_at=MIN(COALESCE(sessions.started_at, excluded.started_at),
                     COALESCE(excluded.started_at, sessions.started_at)),
      last_at=MAX(COALESCE(sessions.last_at, 0), COALESCE(excluded.last_at, 0)),
      n_user=sessions.n_user + excluded.n_user,
      n_assistant=sessions.n_assistant + excluded.n_assistant,
      last_prompt=COALESCE(excluded.last_prompt, sessions.last_prompt),
      kind=CASE WHEN excluded.kind='sdk' THEN 'sdk' ELSE sessions.kind END,
      name=COALESCE(excluded.name, sessions.name)
  `).run(sid, path, cwd, project, label, branch, started, last, nUser, nAsst, lastPrompt,
         kind ?? 'interactive', name);

  if (usageRows.length) {
    const ins = db.prepare(`INSERT OR IGNORE INTO usage
      (uuid,sid,ts,day,model,input,output,cache_read,cache_create)
      VALUES (?,?,?,?,?,?,?,?,?)`);
    for (const r of usageRows) ins.run(...r);
  }

  db.prepare(`
    INSERT INTO files (path, sid, size, mtime, scanned_at) VALUES (?,?,?,?,?)
    ON CONFLICT(path) DO UPDATE SET
      size=excluded.size, mtime=excluded.mtime, scanned_at=excluded.scanned_at
  `).run(path, sid, newOffset, statSync(path).mtimeMs / 1000, Math.floor(Date.now() / 1000));

  return lines.length;
}

/**
 * 舊資料補上 name，只跑一次。掃描是增量的，已讀過的部分不會再看到 custom-title；
 * 不用 --rescan，因為它會清掉 transcript 已被刪除的 session 的統計。
 */
export function backfillNames(db) {
  if (getConfig(db, 'names_backfilled')) return;
  const set = db.prepare('UPDATE sessions SET name=? WHERE sid=?');
  db.exec('BEGIN');
  for (const { sid, path } of db.prepare('SELECT sid, path FROM sessions WHERE path IS NOT NULL').all()) {
    try {
      const text = readFileSync(path, 'utf8');
      const at = text.lastIndexOf('"type":"custom-title"');
      if (at < 0) continue;
      const rec = JSON.parse(text.slice(text.lastIndexOf('\n', at) + 1, text.indexOf('\n', at)));
      if (rec.type === 'custom-title' && rec.customTitle) set.run(rec.customTitle, sid);
    } catch { /* 檔案不見或那行不完整，略過 */ }
  }
  setConfig(db, 'names_backfilled', '1');
  db.exec('COMMIT');
}

/** 掃過所有 transcript。回傳 { files, lines }。 */
export function sync(db, { root = PROJECTS, verbose = false, rescan = false } = {}) {
  let files = 0, lines = 0;
  db.exec('BEGIN');
  if (rescan) {
    // 重新分類需要重讀，把 offset 與衍生資料清掉重來（全量約 2 秒）
    db.exec('DELETE FROM files; DELETE FROM usage; DELETE FROM sessions');
  }
  try {
    for (const path of listTranscripts(root)) {
      let got = 0;
      try {
        got = scanFile(db, path);
      } catch (e) {
        if (verbose) console.error(`  略過 ${basename(path)}: ${e.message}`);
        continue;
      }
      if (got) { files++; lines += got; }
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  return { files, lines };
}
