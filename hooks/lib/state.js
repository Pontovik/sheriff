'use strict';
// Состояние сессии: файл по session_id, лок-файл, поколения базы, журнал, уборка.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { dataDir } = require('./io');

const STATE_FILE = 'state.json';
const LOCK_FILE = 'state.lock';
const LOCK_WAIT_MS = Number(process.env.SHERIFF_LOCK_WAIT_MS) || 15000; // переменная нужна тестам
const JOURNAL_LIMIT = 200;
const DEFAULT_LOCK_STALE_MS = 60000;

function sessionsRoot() {
  return path.join(dataDir(), 'sessions');
}

function sessionDir(sessionId) {
  const safe = String(sessionId || 'unknown').replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 120) || 'unknown';
  return path.join(sessionsRoot(), safe);
}

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function newId(prefix) {
  return prefix + crypto.randomBytes(5).toString('hex');
}

function newState() {
  return {
    version: 1,
    mode: 'off',
    generation: 0,
    base: null,
    activeRun: null,
    snapshots: {},
    turn: { key: null, blocks: 0 },
    journal: [],
  };
}

function journal(state, event, data) {
  if (!Array.isArray(state.journal)) state.journal = [];
  state.journal.push(Object.assign({ t: new Date().toISOString(), event }, data || {}));
  if (state.journal.length > JOURNAL_LIMIT) state.journal = state.journal.slice(-JOURNAL_LIMIT);
}

// Брошенный лок перезахватывается переименованием: из двух процессов
// переименовать один и тот же файл сможет только один.
function trySteal(lock, staleMs) {
  let st;
  try {
    st = fs.statSync(lock);
  } catch {
    return;
  }
  if (Date.now() - st.mtimeMs <= staleMs) return;
  const grave = `${lock}.stale.${process.pid}.${Date.now()}`;
  try {
    fs.renameSync(lock, grave);
  } catch {
    return;
  }
  // Между проверкой и переименованием лок мог перезахватить другой процесс.
  // Переименование сохраняет время файла: свежий лок возвращаем владельцу.
  try {
    if (Date.now() - fs.statSync(grave).mtimeMs <= staleMs) {
      try {
        fs.linkSync(grave, lock);
      } catch {
        // место уже занято новым локом
      }
    }
  } catch {
    // могилу уже убрали
  }
  fs.rmSync(grave, { force: true });
}

function acquire(dir, staleMs) {
  fs.mkdirSync(dir, { recursive: true });
  const lock = path.join(dir, LOCK_FILE);
  const token = `${process.pid}-${crypto.randomBytes(6).toString('hex')}`;
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    let code;
    try {
      const fd = fs.openSync(lock, 'wx');
      try {
        fs.writeSync(fd, token);
      } finally {
        fs.closeSync(fd);
      }
      return { lock, token };
    } catch (err) {
      if (err.code !== 'EEXIST' && err.code !== 'EPERM' && err.code !== 'EACCES') throw err;
      code = err.code;
    }
    trySteal(lock, staleMs);
    if (Date.now() > deadline) throw new Error(`не удалось захватить лок состояния за ${Math.round(LOCK_WAIT_MS / 1000)} с (${code})`);
    sleep(20 + Math.floor(Math.random() * 30));
  }
}

// Снимаем только свой лок: если его перезахватили как брошенный, чужой не трогаем.
function release(held) {
  try {
    if (fs.readFileSync(held.lock, 'utf8') === held.token) fs.rmSync(held.lock, { force: true });
  } catch {
    // лока уже нет или он станет брошенным и будет перезахвачен по сроку
  }
}

// status: ok | missing | corrupt
function read(dir) {
  const file = path.join(dir, STATE_FILE);
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return { status: 'missing', state: null };
    return { status: 'corrupt', state: null };
  }
  try {
    const state = JSON.parse(raw);
    if (!state || typeof state !== 'object' || state.version !== 1 || typeof state.mode !== 'string') {
      return { status: 'corrupt', state: null };
    }
    return { status: 'ok', state };
  } catch {
    return { status: 'corrupt', state: null };
  }
}

function write(dir, state) {
  const file = path.join(dir, STATE_FILE);
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  state.updatedAt = new Date().toISOString();
  fs.writeFileSync(tmp, JSON.stringify(state, null, 1));
  for (let attempt = 0; ; attempt++) {
    try {
      fs.renameSync(tmp, file);
      return;
    } catch (err) {
      // На Windows переименование может временно не пройти, пока файл читает другой процесс.
      if (attempt >= 60) {
        fs.rmSync(tmp, { force: true });
        throw err;
      }
      sleep(10 + attempt * 2);
    }
  }
}

// Операция «прочитать, проверить, записать» под локом.
// fn получает ctx { dir, status, state } и может заменить ctx.state и выставить ctx.dirty.
function transact(sessionId, fn, opts) {
  const dir = sessionDir(sessionId);
  const held = acquire(dir, (opts && opts.staleMs) || DEFAULT_LOCK_STALE_MS);
  try {
    const r = read(dir);
    const ctx = { dir, status: r.status, state: r.state, dirty: false };
    const out = fn(ctx);
    if (ctx.dirty && ctx.state) write(dir, ctx.state);
    return out;
  } finally {
    release(held);
  }
}

// Чтение без лока: запись идёт через переименование, читатель видит целый файл.
function peek(sessionId) {
  const dir = sessionDir(sessionId);
  const r = read(dir);
  return { dir, status: r.status, state: r.state };
}

// Удаляет данные сессий, которые не трогали дольше срока хранения.
function cleanup(retentionDays, keepSessionId) {
  const root = sessionsRoot();
  const keep = path.basename(sessionDir(keepSessionId));
  const limit = Date.now() - retentionDays * 24 * 3600 * 1000;
  let removed = 0;
  let entries;
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const e of entries) {
    if (!e.isDirectory() || e.name === keep) continue;
    const dir = path.join(root, e.name);
    let mtime;
    try {
      mtime = fs.statSync(path.join(dir, STATE_FILE)).mtimeMs;
    } catch {
      try {
        mtime = fs.statSync(dir).mtimeMs;
      } catch {
        continue;
      }
    }
    if (mtime < limit) {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
        removed++;
      } catch {
        // попробуем в следующий раз
      }
    }
  }
  return removed;
}

module.exports = {
  sessionDir, sessionsRoot, newState, newId, journal, transact, peek, cleanup, read, write, sleep,
  DEFAULT_LOCK_STALE_MS,
};
