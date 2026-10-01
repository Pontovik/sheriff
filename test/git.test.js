'use strict';
// Раздел 12 ТЗ: файлы и база в git-режиме.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const h = require('./helpers');

test.after(h.cleanupAll);

function reasonOf(s, extra) {
  const r = s.stop(extra);
  return r.json && r.json.decision === 'block' ? r.json.reason : null;
}

test('CRLF при autocrlf: файл не грязный относительно HEAD, дифф показывает только настоящую правку', () => {
  const repo = h.gitRepo({ autocrlf: true });
  h.write(repo, 'src/a.cs', 'line1\r\nline2\r\nline3\r\n');
  h.commitAll(repo);
  // В репозитории LF, в рабочем дереве CRLF.
  assert.ok(!h.git(repo, 'cat-file', '-p', 'HEAD:src/a.cs').includes('\r'), 'блоб должен хранить LF');
  const s = new h.Session(repo);
  s.toggle();
  assert.deepStrictEqual(s.baseIndex(), {}, 'CRLF-файл не должен попасть в исходно грязный набор');
  assert.strictEqual(s.stop().stdout, '');

  h.write(repo, 'src/a.cs', 'line1\r\nCHANGED\r\nline3\r\n');
  assert.strictEqual(s.blocked(), true);
  const call = s.callReviewer();
  const diff = s.diffOf(call.snapshotId);
  const removed = diff.split('\n').filter((l) => l.startsWith('-') && !l.startsWith('---'));
  const added = diff.split('\n').filter((l) => l.startsWith('+') && !l.startsWith('+++'));
  assert.strictEqual(removed.length, 1, 'удалена одна строка, а не весь файл:\n' + diff);
  assert.strictEqual(added.length, 1);
});

test('CRLF против LF при autocrlf: смена только окончаний строк изменением не считается', () => {
  const repo = h.gitRepo({ autocrlf: true });
  h.write(repo, 'src/a.cs', 'line1\r\nline2\r\n');
  h.commitAll(repo);
  for (const mode of ['', '--from-head']) {
    const s = new h.Session(repo);
    s.toggle(mode);
    h.write(repo, 'src/a.cs', 'line1\nline2\n');
    assert.strictEqual(s.stop().stdout, '', 'режим ' + (mode || 'normal'));
    h.write(repo, 'src/a.cs', 'line1\r\nline2\r\n');
  }
});

test('без autocrlf смена окончаний строк является изменением', () => {
  const repo = h.gitRepo();
  h.write(repo, 'src/a.cs', 'line1\nline2\n');
  h.commitAll(repo);
  const s = new h.Session(repo);
  s.toggle();
  h.write(repo, 'src/a.cs', 'line1\r\nline2\r\n');
  assert.strictEqual(s.blocked(), true);
});

test('переименование через git mv с коммитом: старый путь удалён, новый добавлен', () => {
  const repo = h.gitRepo();
  h.write(repo, 'src/old.js', 'const x = 1;\nconst y = 2;\nconst z = 3;\n');
  h.commitAll(repo);
  const s = new h.Session(repo);
  s.toggle();
  h.git(repo, 'mv', 'src/old.js', 'src/new.js');
  h.commitAll(repo, 'rename');
  const reason = reasonOf(s);
  assert.ok(reason);
  assert.match(reason, /- src\/new\.js/);
  assert.match(reason, /- src\/old\.js \(удалён\)/);
  const call = s.callReviewer();
  const diff = s.diffOf(call.snapshotId);
  assert.match(diff, /diff --sheriff a\/src\/old\.js[^\n]*\n# удалён/);
  assert.match(diff, /diff --sheriff a\/src\/new\.js[^\n]*\n# добавлен/);
});

test('файл с кириллицей и пробелом в имени попадает в изменения и в дифф', () => {
  const repo = h.gitRepo();
  h.write(repo, 'src/a.js', '1\n');
  h.write(repo, 'модуль/старый файл.js', 'было\n');
  h.commitAll(repo);
  const s = new h.Session(repo);
  s.toggle();
  h.write(repo, 'модуль/старый файл.js', 'стало\n');
  h.write(repo, 'модуль/новый файл.js', 'новое\n');
  const reason = reasonOf(s);
  assert.match(reason, /- модуль\/старый файл\.js/);
  assert.match(reason, /- модуль\/новый файл\.js/);
  const diff = s.diffOf(s.callReviewer().snapshotId);
  assert.match(diff, /-было/);
  assert.match(diff, /\+стало/);
  assert.match(diff, /\+новое/);
});

test('запуск из подпапки репозитория: изменения в соседних папках видны', () => {
  const repo = h.gitRepo();
  h.write(repo, 'api/a.js', '1\n');
  h.write(repo, 'web/b.js', '1\n');
  h.commitAll(repo);
  const s = new h.Session(path.join(repo, 'api'));
  s.toggle();
  assert.strictEqual(path.resolve(s.state().base.root), path.resolve(repo));
  h.write(repo, 'web/b.js', '2\n');
  h.write(repo, 'web/new.js', '3\n');
  const reason = reasonOf(s);
  assert.match(reason, /- web\/b\.js/);
  assert.match(reason, /- web\/new\.js/);
});

test('shell-правка и коммит посреди сессии: изменения видны', () => {
  const repo = h.gitRepo();
  h.write(repo, 'src/a.js', '1\n');
  h.commitAll(repo);
  const s = new h.Session(repo);
  s.toggle();
  fs.appendFileSync(path.join(repo, 'src/a.js'), '2\n');
  h.commitAll(repo, 'mid-session commit');
  const r = s.stop();
  assert.strictEqual(r.json.decision, 'block');
  assert.match(r.json.reason, /HEAD сменился/);
  s.review();
  const after = s.stop({ stop_hook_active: true });
  assert.strictEqual(after.json.decision, undefined);
  assert.match(after.json.systemMessage, /HEAD сменился/);
});

test('смена ветки: изменения видны, предупреждение с подсказкой --rebase', () => {
  const repo = h.gitRepo();
  h.write(repo, 'src/a.js', 'main\n');
  h.commitAll(repo);
  h.git(repo, 'checkout', '-q', '-b', 'feature');
  h.write(repo, 'src/a.js', 'feature\n');
  h.write(repo, 'src/only-feature.js', 'x\n');
  h.commitAll(repo, 'feature');
  h.git(repo, 'checkout', '-q', 'main');
  const s = new h.Session(repo);
  s.toggle();
  h.git(repo, 'checkout', '-q', 'feature');
  const reason = reasonOf(s);
  assert.match(reason, /- src\/a\.js/);
  assert.match(reason, /- src\/only-feature\.js/);
  assert.match(reason, /--rebase/);
  s.newPrompt();
  s.toggle('--rebase');
  assert.strictEqual(s.stop().stdout, '');
});

test('грязное дерево до включения: старые правки не в ревью, новые поверх них в ревью', () => {
  const repo = h.gitRepo();
  h.write(repo, 'src/a.js', 'one\ntwo\nthree\n');
  h.write(repo, 'src/gone.js', 'x\n');
  h.commitAll(repo);
  h.write(repo, 'src/a.js', 'one\nTWO\nthree\n');
  h.write(repo, 'src/untracked.js', 'u\n');
  fs.rmSync(path.join(repo, 'src/gone.js'));
  const s = new h.Session(repo);
  assert.match(s.toggle().stdout, /Путей с правками до включения: 3/);
  assert.strictEqual(s.stop().stdout, '', 'правки до включения ревью не требуют');

  h.write(repo, 'src/a.js', 'one\nTWO\nTHREE\n');
  assert.strictEqual(s.blocked(), true);
  const diff = s.diffOf(s.callReviewer().snapshotId);
  assert.match(diff, /-three/);
  assert.match(diff, /\+THREE/);
  assert.doesNotMatch(diff, /-two/, 'старая сторона диффа это копия на момент включения, а не коммит');
});

test('исходно грязный файл, возвращённый к HEAD, является изменением сессии', () => {
  const repo = h.gitRepo();
  h.write(repo, 'src/a.js', 'committed\n');
  h.commitAll(repo);
  h.write(repo, 'src/a.js', 'dirty\n');
  const s = new h.Session(repo);
  s.toggle();
  h.git(repo, 'checkout', '--', 'src/a.js');
  assert.strictEqual(s.blocked(), true);
});

test('исходно удалённый файл, восстановленный в сессии, является изменением', () => {
  const repo = h.gitRepo();
  h.write(repo, 'src/a.js', 'x\n');
  h.commitAll(repo);
  fs.rmSync(path.join(repo, 'src/a.js'));
  const s = new h.Session(repo);
  s.toggle();
  assert.strictEqual(s.stop().stdout, '');
  h.write(repo, 'src/a.js', 'x\n');
  const diff = s.diffOf(s.callReviewer().snapshotId);
  assert.match(diff, /# добавлен/);
});

test('--from-head: старые правки, новые и удалённые файлы в ревью без новых правок', () => {
  const repo = h.gitRepo();
  h.write(repo, 'src/a.js', 'a\n');
  h.write(repo, 'src/gone.js', 'x\n');
  h.commitAll(repo);
  h.write(repo, 'src/a.js', 'a changed\n');
  h.write(repo, 'src/untracked.js', 'u\n');
  fs.rmSync(path.join(repo, 'src/gone.js'));
  const s = new h.Session(repo);
  assert.match(s.toggle('--from-head').stdout, /mode=from-head/);
  const reason = reasonOf(s);
  assert.match(reason, /- src\/a\.js/);
  assert.match(reason, /- src\/untracked\.js/);
  assert.match(reason, /- src\/gone\.js \(удалён\)/);
  s.review();
  assert.strictEqual(s.blocked({ stop_hook_active: true }), false);
});

test('сбой git: предупреждение, пропуск', () => {
  const repo = h.gitRepo();
  h.write(repo, 'src/a.js', 'a\n');
  h.commitAll(repo);
  const s = new h.Session(repo);
  s.toggle();
  h.write(repo, 'src/a.js', 'b\n');
  const r = s.stop({}, { SHERIFF_GIT_BIN: 'git-binary-that-does-not-exist' });
  assert.strictEqual(r.json.decision, undefined);
  assert.match(r.json.systemMessage, /не вычислены/);
  assert.strictEqual(s.blocked(), true, 'с рабочим git блокировка возвращается');
});

test('сбой git при включении: режим не включается с объяснением', () => {
  const repo = h.gitRepo();
  h.write(repo, 'src/a.js', 'a\n');
  h.commitAll(repo);
  const s = new h.Session(repo, { env: { SHERIFF_GIT_BIN: 'git-binary-that-does-not-exist' } });
  assert.match(s.toggle().stdout, /^SHERIFF-MODE off reason=база не создана/);
});

test('игнорируемые git файлы в ревью не попадают', () => {
  const repo = h.gitRepo();
  h.write(repo, '.gitignore', 'out/\n');
  h.write(repo, 'src/a.js', 'a\n');
  h.commitAll(repo);
  const s = new h.Session(repo);
  s.toggle();
  h.write(repo, 'out/generated.js', 'x\n');
  assert.strictEqual(s.stop().stdout, '');
});

test('включение не пишет в репозиторий', () => {
  const repo = h.gitRepo();
  h.write(repo, 'src/a.js', 'a\n');
  h.commitAll(repo);
  h.write(repo, 'src/a.js', 'b\n');
  const before = h.git(repo, 'status', '--porcelain');
  const objectsBefore = h.git(repo, 'count-objects', '-v');
  const s = new h.Session(repo);
  s.toggle();
  s.stop();
  s.callReviewer();
  assert.strictEqual(h.git(repo, 'status', '--porcelain'), before);
  assert.strictEqual(h.git(repo, 'count-objects', '-v'), objectsBefore);
});
