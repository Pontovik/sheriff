'use strict';
// База сессии, кандидаты, изменения сессии, сырой хеш, дифф.
// Сравнение дерева с базовым коммитом делегируется git. Собственный хеш один: SHA-256 от байтов файла.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const { unifiedDiff, isBinary } = require('./diff');
const { walk } = require('./fs-walk');

class GitError extends Error {}
class RefuseError extends Error {} // режим не включается, причина в сообщении

// Запас времени против правки файла в ту же секунду, что и включение режима.
const RACY_MS = 2000;

function git(root, args, opts) {
  const o = opts || {};
  const bin = process.env.SHERIFF_GIT_BIN || 'git';
  const r = spawnSync(bin, ['-c', 'core.quotepath=off', '-C', root, ...args], {
    input: o.input,
    maxBuffer: 1024 * 1024 * 1024,
    windowsHide: true,
    env: Object.assign({}, process.env, { GIT_OPTIONAL_LOCKS: '0' }),
  });
  if (r.error) throw new GitError(`git ${args[0]}: ${r.error.message}`);
  if (!(o.ok || [0]).includes(r.status)) {
    const err = String(r.stderr || '').trim().slice(0, 300);
    throw new GitError(`git ${args[0]} завершился с кодом ${r.status}: ${err}`);
  }
  return r.stdout;
}

function splitZ(buf) {
  return buf.toString('utf8').split('\0').filter(Boolean);
}

function hasGitMarker(dir) {
  for (let d = path.resolve(dir); ; ) {
    if (fs.existsSync(path.join(d, '.git'))) return true;
    const parent = path.dirname(d);
    if (parent === d) return false;
    d = parent;
  }
}

// Корень проекта: git rev-parse --show-toplevel, вне git рабочая папка хука.
function detectRepo(cwd) {
  if (!hasGitMarker(cwd)) return { kind: 'nogit', root: path.resolve(cwd) };
  const top = git(cwd, ['rev-parse', '--show-toplevel']).toString('utf8').trim();
  return { kind: 'git', root: path.resolve(top) };
}

function headOf(root) {
  const out = git(root, ['rev-parse', '--verify', '-q', 'HEAD'], { ok: [0, 1] }).toString('utf8').trim();
  return out || null;
}

function emptyTree(root) {
  return git(root, ['hash-object', '-t', 'tree', '--stdin'], { input: '' }).toString('utf8').trim();
}

// Все списки путей: из корня, с -z, без детекта переименований.
// Подмодули из списка не убираются: их путь попадёт в кандидаты и будет назван среди пропущенных.
function listDiff(root, commit) {
  return splitZ(git(root, ['diff', '--name-only', '--no-renames', '--no-ext-diff', '-z', commit, '--']));
}

function listUntracked(root) {
  return splitZ(git(root, ['ls-files', '--others', '--exclude-standard', '-z']));
}

// path -> режим файла в базовом коммите
function listTree(root, commit) {
  const map = new Map();
  for (const entry of splitZ(git(root, ['ls-tree', '-r', '-z', commit]))) {
    const tab = entry.indexOf('\t');
    if (tab < 0) continue;
    map.set(entry.slice(tab + 1), entry.slice(0, entry.indexOf(' ')));
  }
  return map;
}

// Содержимое базового коммита. Сначала с фильтрами рабочего дерева (smudge, LFS),
// при сбое фильтра как есть в репозитории.
function catBase(root, commit, rel) {
  try {
    return git(root, ['cat-file', '--filters', `${commit}:${rel}`]);
  } catch (err) {
    if (!(err instanceof GitError)) throw err;
    return git(root, ['cat-file', 'blob', `${commit}:${rel}`]);
  }
}

function sha(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function shaFile(abs) {
  const hash = crypto.createHash('sha256');
  const fd = fs.openSync(abs, 'r');
  try {
    const chunk = Buffer.allocUnsafe(1024 * 1024);
    for (;;) {
      const n = fs.readSync(fd, chunk, 0, chunk.length, null);
      if (n === 0) break;
      hash.update(chunk.subarray(0, n));
    }
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest('hex');
}

function probe(abs) {
  let st;
  try {
    st = fs.lstatSync(abs);
  } catch (err) {
    if (err.code === 'ENOENT' || err.code === 'ENOTDIR') return { kind: 'absent' };
    throw err;
  }
  if (st.isSymbolicLink()) return { kind: 'link' };
  if (st.isDirectory()) return { kind: 'dir' };
  if (st.isFile()) return { kind: 'file', size: st.size, mtimeMs: st.mtimeMs };
  return { kind: 'other' };
}

function storeBlob(blobsDir, hash, buf) {
  const blob = path.join(blobsDir, hash);
  if (!fs.existsSync(blob)) fs.writeFileSync(blob, buf);
}

// Запись исходного состояния одного пути.
// Копия нужна только как старая сторона диффа: большой или бинарный файл хранится одним хешем.
// budget ограничивает суммарный размер копий.
function captureBase(root, rel, blobsDir, cfg, budget) {
  const abs = path.join(root, rel);
  const p = probe(abs);
  if (p.kind === 'absent') return { present: false };
  if (p.kind !== 'file') return { present: true, skip: true }; // ссылка, каталог, подмодуль
  const entry = { present: true, size: p.size, mtimeMs: p.mtimeMs, copy: false };
  if (p.size > cfg.maxFileBytes || p.size > budget.left) {
    entry.hash = shaFile(abs);
    return entry;
  }
  const buf = fs.readFileSync(abs);
  entry.hash = sha(buf);
  if (isBinary(buf)) return entry;
  storeBlob(blobsDir, entry.hash, buf);
  budget.left -= buf.length;
  entry.copy = true;
  return entry;
}

// Создаёт базу нового поколения в папке сессии. Возвращает { base, dirtyCount }.
function createBase(sessionDir, repo, cfg, opts) {
  const dirName = `base-${Date.now().toString(36)}-${process.pid}`;
  const baseDir = path.join(sessionDir, dirName);
  const blobsDir = path.join(baseDir, 'blobs');
  fs.mkdirSync(blobsDir, { recursive: true });
  const files = {};
  const limit = cfg.noGitLimitMB * 1024 * 1024;
  const budget = { left: limit };
  const base = {
    kind: repo.kind,
    root: repo.root,
    dir: dirName,
    fromHead: false,
    commit: null,
    head: null,
    unborn: false,
    createdAt: new Date().toISOString(),
  };
  try {
    if (repo.kind === 'git') {
      const head = headOf(repo.root);
      base.head = head;
      base.unborn = !head;
      base.commit = head || emptyTree(repo.root);
      base.fromHead = !!(opts && opts.fromHead);
      if (!base.fromHead) {
        const dirty = new Set([...listDiff(repo.root, base.commit), ...listUntracked(repo.root)]);
        for (const rel of dirty) {
          if (!cfg.isAffecting(rel)) continue;
          files[rel] = captureBase(repo.root, rel, blobsDir, cfg, budget);
        }
      }
    } else {
      const all = walk(repo.root, cfg.excludeDirSet).filter(cfg.isAffecting);
      let total = 0;
      for (const rel of all) {
        const p = probe(path.join(repo.root, rel));
        if (p.kind === 'file') total += p.size;
      }
      if (total > limit) {
        const mb = (total / 1024 / 1024).toFixed(1);
        throw new RefuseError(
          `папка вне git, влияющих файлов ${mb} МБ при лимите ${cfg.noGitLimitMB} МБ. ` +
            'Запусти из подпапки, добавь excludeDirs в .sheriff.json или подними noGitLimitMB'
        );
      }
      for (const rel of all) files[rel] = captureBase(repo.root, rel, blobsDir, cfg, budget);
    }
    fs.writeFileSync(path.join(baseDir, 'index.json'), JSON.stringify({ files }));
  } catch (err) {
    fs.rmSync(baseDir, { recursive: true, force: true });
    throw err;
  }
  return { base, dirtyCount: Object.keys(files).length };
}

function loadBaseIndex(sessionDir, base) {
  const raw = fs.readFileSync(path.join(sessionDir, base.dir, 'index.json'), 'utf8');
  return JSON.parse(raw).files || {};
}

// Читает текущее содержимое один раз. Большой файл в память не берётся.
// captureDir задан: содержимое большого файла сначала копируется, хеш считается по копии.
function readCurrent(abs, size, cfg, captureDir) {
  if (size > cfg.maxFileBytes) {
    if (!captureDir) return { hash: shaFile(abs), size, bytes: null, big: true };
    const tmp = path.join(captureDir, `tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`);
    fs.copyFileSync(abs, tmp);
    const hash = shaFile(tmp);
    const finalPath = path.join(captureDir, hash);
    if (fs.existsSync(finalPath)) fs.rmSync(tmp, { force: true });
    else fs.renameSync(tmp, finalPath);
    return { hash, size: fs.statSync(finalPath).size, bytes: null, big: true };
  }
  const bytes = fs.readFileSync(abs);
  return { hash: sha(bytes), size: bytes.length, bytes, big: false };
}

// Изменения сессии. captureDir задан: байты каждого изменённого файла сохраняются туда (снимок ревью).
// Возвращает { changes, skipped, headChanged }.
// skipped: изменённые пути, которые sheriff не читает (подмодули, ссылки). Они остаются вне ревью.
function computeChanges(sessionDir, base, cfg, captureDir) {
  const index = loadBaseIndex(sessionDir, base);
  const root = base.root;
  const isGit = base.kind === 'git';
  const baseTime = Date.parse(base.createdAt) || 0;
  let candidates;
  let headChanged = false;
  if (isGit) {
    candidates = new Set([...listDiff(root, base.commit), ...listUntracked(root), ...Object.keys(index)]);
    headChanged = headOf(root) !== base.head;
  } else {
    candidates = new Set([...walk(root, cfg.excludeDirSet), ...Object.keys(index)]);
  }
  let tree = null;
  const baseTree = () => {
    if (!tree) tree = isGit && !base.unborn ? listTree(root, base.commit) : new Map();
    return tree;
  };
  const changes = [];
  const skipped = [];
  for (const rel of [...candidates].sort()) {
    if (!cfg.isAffecting(rel)) continue;
    const known = index[rel];
    if (known && known.skip) continue; // нечитаемый путь был таким уже при включении
    const abs = path.join(root, rel);
    const p = probe(abs);
    if (p.kind !== 'file' && p.kind !== 'absent') {
      skipped.push(rel);
      continue;
    }
    let present = p.kind === 'file';
    let oldPresent;
    if (known) {
      oldPresent = known.present;
      // Размер и время правки те же, что при включении: файл не менялся, читать его незачем.
      if (
        present &&
        known.present &&
        known.size === p.size &&
        known.mtimeMs === p.mtimeMs &&
        known.mtimeMs < baseTime - RACY_MS
      ) {
        continue;
      }
    } else {
      const mode = baseTree().get(rel);
      if (mode === '160000' || mode === '120000') {
        skipped.push(rel);
        continue;
      }
      oldPresent = mode !== undefined;
    }
    let cur = null;
    if (present) {
      try {
        cur = readCurrent(abs, p.size, cfg, captureDir);
      } catch (err) {
        if (err.code !== 'ENOENT') throw err;
        present = false; // файл исчез между проверкой и чтением
      }
    }
    if (!present && !oldPresent) continue;
    if (cur && known && known.present && known.hash === cur.hash) continue;
    if (cur && captureDir && cur.bytes) storeBlob(captureDir, cur.hash, cur.bytes);
    changes.push({
      path: rel,
      present,
      oldPresent,
      hash: cur ? cur.hash : null,
      size: cur ? cur.size : 0,
      bytes: cur ? cur.bytes : null,
      big: cur ? cur.big : false,
    });
  }
  return { changes, skipped, headChanged };
}

// Набор для сравнения снимка с текущим состоянием: пути, присутствие, сырые хеши.
function fingerprint(changes) {
  const out = {};
  for (const c of changes) out[c.path] = { p: c.present, h: c.hash };
  return out;
}

function sameFingerprint(a, b) {
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  for (const k of ka) {
    const x = a[k];
    const y = b[k];
    if (!y || x.p !== y.p || x.h !== y.h) return false;
  }
  return true;
}

function normEol(text) {
  return text.replace(/\r\n/g, '\n');
}

function eolStyle(text) {
  const crlf = (text.match(/\r\n/g) || []).length;
  const lf = (text.match(/\n/g) || []).length - crlf;
  if (!crlf && !lf) return null;
  return crlf && lf ? 'смешанные' : crlf ? 'CRLF' : 'LF';
}

const STATUS_RU = { added: 'добавлен', deleted: 'удалён', modified: 'изменён' };

// Замороженный дифф из байтов снимка. Возвращает { text, omitted }.
// Строки сравниваются без учёта окончаний: иначе при autocrlf любая правка выглядела бы
// заменой всего файла. Смена окончаний строк называется отдельной пометкой.
function buildDiff(sessionDir, base, cfg, changes) {
  const index = loadBaseIndex(sessionDir, base);
  const blobsDir = path.join(sessionDir, base.dir, 'blobs');
  const empty = Buffer.alloc(0);
  let text = '';
  const omitted = [];
  for (const ch of changes) {
    const rel = ch.path;
    const status = !ch.oldPresent ? 'added' : !ch.present ? 'deleted' : 'modified';
    let note = null;
    let oldBuf = empty;
    let oldKnown = true;
    let fromCommit = false;
    if (ch.oldPresent) {
      const known = index[rel];
      if (known) {
        if (known.copy) {
          oldBuf = fs.readFileSync(path.join(blobsDir, known.hash));
        } else {
          note = 'исходный файл не сохранён: он большой или бинарный';
          oldKnown = false;
        }
      } else {
        oldBuf = catBase(base.root, base.commit, rel);
        fromCommit = true;
      }
    }
    const newBuf = ch.present ? ch.bytes || empty : empty;
    if (!note && ch.present && ch.big) note = 'файл больше лимита размера';
    if (!note && oldBuf.length > cfg.maxFileBytes) note = 'исходный файл больше лимита размера';
    if (!note && (isBinary(oldBuf) || isBinary(newBuf))) note = 'бинарный файл';
    let body = '';
    let eolNote = '';
    if (!note) {
      const oldText = oldBuf.toString('utf8');
      const newText = newBuf.toString('utf8');
      body = unifiedDiff(normEol(oldText), normEol(newText));
      if (Buffer.byteLength(body) > cfg.maxFileDiffBytes) {
        note = 'дифф больше лимита размера';
      } else if (status === 'modified' && !fromCommit) {
        // Против копии сравниваются сырые байты, поэтому смена окончаний видна точно.
        // Против коммита git уже нормализовал окончания, пометка была бы ложной.
        const before = eolStyle(oldText);
        const after = eolStyle(newText);
        if (before && after && before !== after) eolNote = `# окончания строк: были ${before}, стали ${after}\n`;
      }
    }
    const oldSize = oldKnown ? `${oldBuf.length} байт` : 'размер не сохранён';
    text += `diff --sheriff a/${rel} b/${rel}\n`;
    text += `# ${STATUS_RU[status]}; было: ${oldSize}, стало: ${ch.present ? ch.size : 0} байт\n`;
    text += eolNote;
    if (note) {
      omitted.push(rel);
      text += `# тело опущено: ${note}. Новое содержимое читай из репозитория.\n`;
    } else if (!body) {
      if (!eolNote) text += '# различий в тексте нет: отличаются только окончания строк или фильтры git\n';
    } else {
      text += `--- ${status === 'added' ? '/dev/null' : 'a/' + rel}\n`;
      text += `+++ ${status === 'deleted' ? '/dev/null' : 'b/' + rel}\n`;
      text += body;
    }
  }
  return { text, omitted };
}

module.exports = {
  GitError, RefuseError, detectRepo, headOf, createBase, computeChanges, fingerprint, sameFingerprint, buildDiff, sha,
};
