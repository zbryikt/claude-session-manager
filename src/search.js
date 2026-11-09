/**
 * transcript 的全文索引與檔案操作紀錄（ccs grep / ccs who）。
 *
 * 放在獨立的 search.db：體積比統計資料庫大得多，又能從 transcript 重建，不需要備份。
 * 只收 prompt、助理文字與工具輸入；tool_result 和圖片不收（大型 transcript 九成是 base64）。
 * offset 也自己記一份，ccs sync --rescan 重掃統計時才不會讓索引重複。
 */
import { DatabaseSync } from 'node:sqlite';
import { statSync } from 'node:fs';
import { basename, dirname, join, sep } from 'node:path';
import { DB_PATH } from './db.js';
import { listTranscripts, readDelta, SKIP_PREFIX, textOf, tsOf } from './scan.js';
import { bashPaths } from './shellpaths.js';

const WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);
const DETAIL_MAX = 200;

// trigram：中文沒有空白可斷詞，且能比對任意子字串（路徑片段、指令名）
const SCHEMA = `
CREATE TABLE IF NOT EXISTS indexed (
  fid  INTEGER PRIMARY KEY,
  path TEXT UNIQUE NOT NULL,
  size INTEGER NOT NULL
);
CREATE VIRTUAL TABLE IF NOT EXISTS docs USING fts5(
  body, fid UNINDEXED, sid UNINDEXED, ts UNINDEXED, role UNINDEXED, tool UNINDEXED,
  tokenize='trigram'
);
CREATE TABLE IF NOT EXISTS ops (
  fid    INTEGER NOT NULL,
  sid    TEXT NOT NULL,
  ts     REAL,
  tool   TEXT NOT NULL,
  action TEXT NOT NULL,            -- write | read
  path   TEXT NOT NULL,
  detail TEXT
);
CREATE INDEX IF NOT EXISTS idx_ops_path ON ops(path);
CREATE INDEX IF NOT EXISTS idx_ops_fid ON ops(fid);
`;

export function connect(mainDb = DB_PATH) {
  const idx = new DatabaseSync(join(dirname(mainDb), 'search.db'));
  idx.exec('PRAGMA journal_mode=WAL');
  idx.exec('PRAGMA synchronous=NORMAL');
  idx.exec('PRAGMA busy_timeout=60000');   // 另一個 ccs 正在建索引時等它，不要直接報錯
  idx.exec(SCHEMA);
  return idx;
}

/** 子代理的紀錄在 <sid>/subagents/ 底下，算在父 session 頭上。 */
function sidOf(path) {
  const parts = path.split(sep);
  const at = parts.indexOf('subagents');
  return at > 0 ? parts[at - 1] : basename(path, '.jsonl');
}

const toolBody = (input) => Object.values(input)
  .map((v) => (typeof v === 'string' ? v : JSON.stringify(v)))
  .join('\n');

function indexRecord(rec, sid, addDoc, addOp) {
  const ts = tsOf(rec);
  const content = rec.message?.content;
  if (rec.type === 'user') {
    if (rec.userType !== 'external' || rec.isMeta || rec.isCompactSummary) return;
    const s = textOf(content).trim();
    if (s && !SKIP_PREFIX.some((p) => s.startsWith(p))) addDoc(s, sid, ts, 'user', null);
    return;
  }
  if (rec.type !== 'assistant' || !Array.isArray(content)) return;
  for (const b of content) {
    if (b?.type === 'text' && b.text) addDoc(b.text, sid, ts, 'assistant', null);
    if (b?.type !== 'tool_use' || !b.input) continue;
    addDoc(toolBody(b.input), sid, ts, 'tool', b.name);
    const file = b.input.file_path ?? b.input.notebook_path;
    if (WRITE_TOOLS.has(b.name) && file) addOp(sid, ts, b.name, 'write', file, null);
    else if (b.name === 'Read' && file) addOp(sid, ts, b.name, 'read', file, null);
    else if (b.name === 'Bash' && b.input.command && rec.cwd) {
      const detail = b.input.command.slice(0, DETAIL_MAX);
      for (const { path, action } of bashPaths(b.input.command, rec.cwd)) {
        addOp(sid, ts, b.name, action, path, detail);
      }
    }
  }
}

function indexFile(idx, path, stmts) {
  idx.exec('BEGIN IMMEDIATE');
  try {
    let row = stmts.get.get(path);
    if (row && Number(row.size) > statSync(path).size) {
      // 檔案縮短 = 被改寫，這個檔案的內容重來
      stmts.delDocs.run(row.fid);
      stmts.delOps.run(row.fid);
      stmts.setSize.run(0, row.fid);
      row = { ...row, size: 0 };
    }
    const { lines, offset } = readDelta(path, row ? Number(row.size) : 0);
    const fid = row ? row.fid : stmts.add.run(path, 0).lastInsertRowid;
    const addDoc = (body, sid, ts, role, tool) => stmts.doc.run(body, fid, sid, ts, role, tool);
    const addOp = (sid, ts, tool, action, p, detail) => stmts.op.run(fid, sid, ts, tool, action, p, detail);
    const sid = sidOf(path);
    for (const line of lines) {
      if (!line) continue;
      let rec;
      try { rec = JSON.parse(line); } catch { continue; }
      indexRecord(rec, sid, addDoc, addOp);
    }
    stmts.setSize.run(offset, fid);
    idx.exec('COMMIT');
  } catch (e) {
    idx.exec('ROLLBACK');
    throw e;
  }
}

/** 增量更新索引，每個檔案一個 transaction，中斷了下次接著做。 */
export function sync(idx, { rescan = false, verbose = false } = {}) {
  if (rescan) idx.exec('DELETE FROM indexed; DELETE FROM docs; DELETE FROM ops');
  const sizes = new Map(idx.prepare('SELECT path, size FROM indexed').all().map((r) => [r.path, Number(r.size)]));
  const changed = (p) => { try { return statSync(p).size !== sizes.get(p); } catch { return false; } };
  const todo = listTranscripts(undefined, { subagents: true }).filter(changed);
  if (todo.length > 20) console.error(`更新索引（${todo.length} 個檔案）…`);

  const stmts = {
    get: idx.prepare('SELECT fid, size FROM indexed WHERE path=?'),
    add: idx.prepare('INSERT INTO indexed (path, size) VALUES (?,?)'),
    setSize: idx.prepare('UPDATE indexed SET size=? WHERE fid=?'),
    delDocs: idx.prepare('DELETE FROM docs WHERE fid=?'),
    delOps: idx.prepare('DELETE FROM ops WHERE fid=?'),
    doc: idx.prepare('INSERT INTO docs (body, fid, sid, ts, role, tool) VALUES (?,?,?,?,?,?)'),
    op: idx.prepare('INSERT INTO ops (fid, sid, ts, tool, action, path, detail) VALUES (?,?,?,?,?,?,?)'),
  };
  for (const path of todo) {
    try {
      indexFile(idx, path, stmts);
    } catch (e) {
      if (verbose) console.error(`  略過 ${basename(path)}: ${e.message}`);
    }
  }
}

/** 三個字以上走 FTS；trigram 比對不了更短的詞，退回 LIKE 全掃。多個詞是 AND。 */
function matcher(terms) {
  const isLong = (t) => [...t].length >= 3;
  const long = terms.filter(isLong);
  const where = [], params = [];
  if (long.length) {
    where.push('docs MATCH ?');
    params.push(long.map((t) => `"${t.replaceAll('"', '""')}"`).join(' '));
  }
  for (const t of terms.filter((x) => !isLong(x))) {
    where.push("body LIKE ? ESCAPE '\\'");
    params.push(`%${t.replace(/[\\%_]/g, '\\$&')}%`);
  }
  return { where: where.join(' AND '), params };
}

/** 依 session 彙總：[{ sid, n, first, last }]，最近提到的在前。 */
export function grep(idx, terms) {
  const { where, params } = matcher(terms);
  return idx.prepare(`SELECT sid, COUNT(*) n, MIN(ts) first, MAX(ts) last FROM docs
                      WHERE ${where} GROUP BY sid ORDER BY last DESC`).all(...params);
}

/** 該 session 最早提到的那一則。 */
export function firstHit(idx, terms, sid) {
  const { where, params } = matcher(terms);
  return idx.prepare(`SELECT ts, role, tool, body FROM docs
                      WHERE ${where} AND sid=? ORDER BY ts LIMIT 1`).get(...params, sid);
}

/** 動過 path 或其底下任何檔案的操作，依時間排序。'0' 是 '/' 的下一個字元。 */
export function ops(idx, path) {
  return idx.prepare(`SELECT sid, ts, tool, action, path, detail FROM ops
                      WHERE path=? OR (path>=? AND path<?) ORDER BY ts`).all(path, `${path}/`, `${path}0`);
}

/** 第一個命中詞前後的一小段，換行壓成空白。 */
export function snippet(body, terms, around = 30) {
  const lower = body.toLowerCase();
  const at = Math.max(0, Math.min(...terms.map((t) => lower.indexOf(t.toLowerCase())).filter((i) => i >= 0)));
  return body.slice(Math.max(0, at - around), at + around * 3).replace(/\s+/g, ' ').trim();
}
