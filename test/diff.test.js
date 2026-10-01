'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { unifiedDiff, isBinary, splitLines } = require('../hooks/lib/diff');

// Применяет тело unified diff к старому тексту. Так проверяется, что дифф верен, а не просто похож.
function applyPatch(oldText, patch) {
  const oldLines = splitLines(oldText);
  const out = [];
  let cursor = 0;
  const lines = patch.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const header = /^@@ -(\d+),(\d+) \+(\d+),(\d+) @@$/.exec(line);
    if (header) {
      const start = Number(header[2]) === 0 ? Number(header[1]) : Number(header[1]) - 1;
      while (cursor < start) out.push(oldLines[cursor++]);
      continue;
    }
    if (line === '' && i === lines.length - 1) break;
    const noNewline = lines[i + 1] === '\\ No newline at end of file';
    const text = line.slice(1) + (noNewline ? '' : '\n');
    if (line[0] === ' ') {
      assert.strictEqual(oldLines[cursor], text, 'контекст не совпал со старым текстом');
      out.push(oldLines[cursor++]);
    } else if (line[0] === '-') {
      assert.strictEqual(oldLines[cursor], text, 'удаляемая строка не совпала со старым текстом');
      cursor++;
    } else if (line[0] === '+') {
      out.push(text);
    }
    if (noNewline) i++;
  }
  while (cursor < oldLines.length) out.push(oldLines[cursor++]);
  return out.join('');
}

test('одинаковые тексты дают пустой дифф', () => {
  assert.strictEqual(unifiedDiff('a\nb\n', 'a\nb\n'), '');
});

test('замена одной строки', () => {
  const d = unifiedDiff('a\nb\nc\n', 'a\nB\nc\n');
  assert.match(d, /^@@ -1,3 \+1,3 @@\n a\n-b\n\+B\n c\n$/);
});

test('добавление в пустой файл и удаление всего', () => {
  assert.strictEqual(unifiedDiff('', 'x\ny\n'), '@@ -0,0 +1,2 @@\n+x\n+y\n');
  assert.strictEqual(unifiedDiff('x\ny\n', ''), '@@ -1,2 +0,0 @@\n-x\n-y\n');
});

test('отсутствие перевода строки в конце помечается', () => {
  const d = unifiedDiff('a\nb', 'a\nb\n');
  assert.ok(d.includes('-b\n\\ No newline at end of file\n+b\n'));
});

test('окончания строк различаются как содержимое', () => {
  const d = unifiedDiff('a\r\nb\r\n', 'a\r\nB\r\n');
  assert.strictEqual(d.split('\n').filter((l) => l.startsWith('-')).length, 1);
});

test('далёкие правки дают отдельные ханки', () => {
  const lines = Array.from({ length: 40 }, (_, i) => 'line' + i);
  const changed = lines.slice();
  changed[2] = 'X';
  changed[35] = 'Y';
  const d = unifiedDiff(lines.join('\n') + '\n', changed.join('\n') + '\n');
  assert.strictEqual((d.match(/^@@/gm) || []).length, 2);
});

test('дифф применяется к старому тексту и даёт новый: случайные правки', () => {
  let seed = 12345;
  const rnd = (n) => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed % n;
  };
  for (let round = 0; round < 300; round++) {
    const oldLines = Array.from({ length: rnd(30) }, () => 'l' + rnd(8));
    const newLines = oldLines.slice();
    for (let e = rnd(6); e > 0; e--) {
      const pos = rnd(newLines.length + 1);
      const kind = rnd(3);
      if (kind === 0) newLines.splice(pos, 0, 'n' + rnd(8));
      else if (kind === 1) newLines.splice(pos, 1);
      else newLines.splice(pos, 1, 'c' + rnd(8));
    }
    const oldText = oldLines.join('\n') + (oldLines.length && rnd(4) ? '\n' : '');
    const newText = newLines.join('\n') + (newLines.length && rnd(4) ? '\n' : '');
    const patch = unifiedDiff(oldText, newText);
    assert.strictEqual(applyPatch(oldText, patch), newText, `раунд ${round}`);
  }
});

test('очень большое число правок не ломает дифф', () => {
  const a = Array.from({ length: 3000 }, (_, i) => 'a' + i).join('\n') + '\n';
  const b = Array.from({ length: 3000 }, (_, i) => 'b' + i).join('\n') + '\n';
  const patch = unifiedDiff(a, b);
  assert.strictEqual(applyPatch(a, patch), b);
});

test('бинарность определяется по нулевому байту', () => {
  assert.strictEqual(isBinary(Buffer.from([1, 2, 0, 3])), true);
  assert.strictEqual(isBinary(Buffer.from('текст')), false);
});
