/**
 * 從一段 shell 指令估出它碰了哪些路徑，給 ccs who 用。
 *
 * 這是啟發式的，不是真的 shell：看不懂變數展開與 python -c 裡的路徑。
 * 目標是抓到 cd x && git init、mkdir、mv、重導向這些常見的寫入。
 */
import { homedir } from 'node:os';
import { resolve } from 'node:path';

const FILE_VERBS = new Set(['mkdir', 'rmdir', 'rm', 'mv', 'cp', 'touch', 'ln', 'tee', 'rsync']);
const GIT_WRITES = new Set(['init', 'clone', 'commit', 'add', 'mv', 'rm']);
const WRAPPERS = new Set(['sudo', 'command', 'time', 'env']);
const HEREDOC = /<<-?[ \t]*(['"]?)([\w.-]+)\1([^\n]*)\n[\s\S]*?\n[ \t]*\2[ \t]*(?=\n|$)/g;
const STRICT_PATH = /^(\/|~\/|\.\.?\/|\$HOME\/)/;

/** 切成一段段指令：{ words, redirects }（引號內的內容不切）。 */
function parse(command) {
  const cmd = command.replace(HEREDOC, '$3');
  const segs = [];
  let words = [], redirects = [], w = null, quote = null, toRedirect = false;
  const endWord = () => {
    if (w === null) return;
    (toRedirect ? redirects : words).push(w);
    toRedirect = false;
    w = null;
  };
  const endSeg = () => {
    endWord();
    if (words.length || redirects.length) segs.push({ words, redirects });
    words = [];
    redirects = [];
    toRedirect = false;
  };

  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i];
    if (quote) {
      if (c === quote) quote = null;
      else if (c === '\\' && quote === '"' && i + 1 < cmd.length) w += cmd[++i];
      else w += c;
    } else if (c === "'" || c === '"') {
      quote = c;
      w ??= '';
    } else if (c === '\\') {
      if (cmd[i + 1] === '\n') i++;
      else if (i + 1 < cmd.length) w = (w ?? '') + cmd[++i];
    } else if (c === ' ' || c === '\t') {
      endWord();
    } else if (';|&()\n'.includes(c)) {
      endSeg();
    } else if (c === '>') {
      if (w !== null && /^\d+$/.test(w)) w = null;    // 2> 的 2 不是參數
      else endWord();
      if (cmd[i + 1] === '>') i++;
      if (cmd[i + 1] === '&') {                       // 2>&1 沒有目標檔
        i++;
        while (/[\d-]/.test(cmd[i + 1] ?? '')) i++;
      } else {
        toRedirect = true;
      }
    } else if (c === '<') {
      endWord();
    } else {
      w = (w ?? '') + c;
    }
  }
  endSeg();
  return segs;
}

/** 轉成絕對路徑；glob 取固定的前綴，看起來不是路徑的回傳 null。 */
function toPath(token, dir) {
  const t = token.replace(/^\$HOME(?=\/|$)/, homedir()).replace(/^~(?=\/|$)/, homedir());
  if (!t || t.startsWith('-') || /[$`<>\n]|:\/\//.test(t)) return null;
  const head = t.split(/[*?[{]/)[0];
  if (!head) return null;
  const p = resolve(dir, head);
  return p === '/' || p.startsWith('/dev/') ? null : p;
}

/** 回傳 [{ path, action: 'write' | 'read' }]，同一路徑同一動作只留一筆。 */
export function bashPaths(command, cwd) {
  const found = new Map();
  const add = (path, action) => { if (path) found.set(`${action}:${path}`, { path, action }); };
  let dir = cwd;

  for (const { words, redirects } of parse(command)) {
    for (const r of redirects) add(toPath(r, dir), 'write');

    const cmd = words.filter((w, i) => !/^\w+=/.test(w) || words.slice(0, i).some((x) => !/^\w+=/.test(x)));
    while (WRAPPERS.has(cmd[0])) cmd.shift();
    const [verb, ...rest] = cmd;
    if (!verb) continue;
    if (verb === 'cd') {
      dir = toPath(rest[0] ?? '~', dir) ?? dir;
      continue;
    }

    let args = rest, here = dir;
    if (verb === 'git' && args[0] === '-C' && args[1]) {
      here = toPath(args[1], dir) ?? dir;
      args = args.slice(2);
    }
    const gitWrite = verb === 'git' && GIT_WRITES.has(args[0]);
    const fileVerb = FILE_VERBS.has(verb);
    const write = fileVerb || gitWrite || (verb === 'sed' && args.some((a) => a.startsWith('-i')));
    const paths = args
      .filter((a) => fileVerb || STRICT_PATH.test(a))
      .map((a) => toPath(a, here))
      .filter(Boolean);
    for (const p of paths) add(p, write ? 'write' : 'read');
    if (gitWrite && !paths.length) add(here, 'write');   // cd x && git init 動到的是 x
  }
  return [...found.values()];
}
