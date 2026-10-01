'use strict';
// Построчный unified diff без внешних зависимостей (алгоритм Майерса).
// Один движок для git-режима и режима вне git.

const CONTEXT = 3;
const MAX_D = 2000; // предел числа правок, после него середина считается заменённой целиком

// Строка хранится вместе с переводом строки: "x" и "x\n" разные строки.
function splitLines(text) {
  return text.match(/[^\n]*\n|[^\n]+$/g) || [];
}

function isBinary(buf) {
  const n = Math.min(buf.length, 8000);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}

function intern(aLines, bLines) {
  const ids = new Map();
  const toIds = (lines) => {
    const out = new Int32Array(lines.length);
    for (let i = 0; i < lines.length; i++) {
      let id = ids.get(lines[i]);
      if (id === undefined) {
        id = ids.size;
        ids.set(lines[i], id);
      }
      out[i] = id;
    }
    return out;
  };
  return [toIds(aLines), toIds(bLines)];
}

// Операции для a[aLo..aHi) против b[bLo..bHi): 0 равно, 1 удалено, 2 добавлено.
// null, если правок больше MAX_D.
function myers(a, b, aLo, aHi, bLo, bHi) {
  const N = aHi - aLo;
  const M = bHi - bLo;
  if (N === 0) return new Array(M).fill(2);
  if (M === 0) return new Array(N).fill(1);
  const max = Math.min(N + M, MAX_D);
  const off = max + 1;
  const v = new Int32Array(2 * max + 3);
  const trace = [];
  let found = -1;
  outer: for (let d = 0; d <= max; d++) {
    // Снимок перед раундом d: нужны диагонали от -d-1 до d+1.
    trace.push(v.slice(off - d - 1, off + d + 2));
    for (let k = -d; k <= d; k += 2) {
      let x;
      if (k === -d || (k !== d && v[off + k - 1] < v[off + k + 1])) x = v[off + k + 1];
      else x = v[off + k - 1] + 1;
      let y = x - k;
      while (x < N && y < M && a[aLo + x] === b[bLo + y]) {
        x++;
        y++;
      }
      v[off + k] = x;
      if (x >= N && y >= M) {
        found = d;
        break outer;
      }
    }
  }
  if (found < 0) return null;
  const ops = [];
  let x = N;
  let y = M;
  for (let d = found; d >= 0; d--) {
    const vd = trace[d];
    const at = (k) => vd[k + d + 1];
    const k = x - y;
    const prevK = k === -d || (k !== d && at(k - 1) < at(k + 1)) ? k + 1 : k - 1;
    const prevX = at(prevK);
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      ops.push(0);
      x--;
      y--;
    }
    if (d > 0) ops.push(x === prevX ? 2 : 1);
    x = prevX;
    y = prevY;
  }
  return ops.reverse();
}

function diffOps(a, b) {
  const N = a.length;
  const M = b.length;
  let p = 0;
  while (p < N && p < M && a[p] === b[p]) p++;
  let s = 0;
  while (s < N - p && s < M - p && a[N - 1 - s] === b[M - 1 - s]) s++;
  let mid = myers(a, b, p, N - s, p, M - s);
  if (mid === null) mid = new Array(N - s - p).fill(1).concat(new Array(M - s - p).fill(2));
  const ops = new Uint8Array(p + mid.length + s);
  for (let i = 0; i < mid.length; i++) ops[p + i] = mid[i];
  return ops;
}

function formatLine(prefix, line) {
  if (line.endsWith('\n')) return prefix + line;
  return prefix + line + '\n\\ No newline at end of file\n';
}

// Возвращает тело unified diff (только ханки) или пустую строку, если тексты равны.
function unifiedDiff(oldText, newText, context) {
  if (oldText === newText) return '';
  const ctx = context === undefined ? CONTEXT : context;
  const A = splitLines(oldText);
  const B = splitLines(newText);
  const [a, b] = intern(A, B);
  const ops = diffOps(a, b);
  const n = ops.length;
  const aPos = new Int32Array(n + 1);
  const bPos = new Int32Array(n + 1);
  for (let i = 0; i < n; i++) {
    aPos[i + 1] = aPos[i] + (ops[i] !== 2 ? 1 : 0);
    bPos[i + 1] = bPos[i] + (ops[i] !== 1 ? 1 : 0);
  }
  let out = '';
  let i = 0;
  while (i < n) {
    if (ops[i] === 0) {
      i++;
      continue;
    }
    const start = i;
    let end = i;
    let equalRun = 0;
    for (let j = i + 1; j < n; j++) {
      if (ops[j] !== 0) {
        end = j;
        equalRun = 0;
      } else if (++equalRun > 2 * ctx) {
        break;
      }
    }
    const hStart = Math.max(0, start - ctx);
    const hEnd = Math.min(n, end + 1 + ctx);
    const aCount = aPos[hEnd] - aPos[hStart];
    const bCount = bPos[hEnd] - bPos[hStart];
    const aStart = aCount === 0 ? aPos[hStart] : aPos[hStart] + 1;
    const bStart = bCount === 0 ? bPos[hStart] : bPos[hStart] + 1;
    out += `@@ -${aStart},${aCount} +${bStart},${bCount} @@\n`;
    for (let j = hStart; j < hEnd; j++) {
      if (ops[j] === 0) out += formatLine(' ', A[aPos[j]]);
      else if (ops[j] === 1) out += formatLine('-', A[aPos[j]]);
      else out += formatLine('+', B[bPos[j]]);
    }
    i = end + 1;
  }
  return out;
}

module.exports = { unifiedDiff, isBinary, splitLines };
