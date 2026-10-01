'use strict';
// Раздел 12 ТЗ: переключение, отказы состояния, уборка.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const h = require('./helpers');

test.after(h.cleanupAll);

function repoWithCommit() {
  const repo = h.gitRepo();
  h.write(repo, 'src/a.js', 'const a = 1;\n');
  h.write(repo, 'README.md', '# readme\n');
  h.commitAll(repo);
  return repo;
}

test('включение печатает строку статуса и создаёт базу', () => {
  const s = new h.Session(repoWithCommit());
  const r = s.toggle();
  assert.match(r.stdout, /^SHERIFF-MODE on generation=1 base=[0-9a-f]{12} mode=normal/);
  assert.strictEqual(s.state().mode, 'on');
});

test('повторное включение базу не меняет', () => {
  const s = new h.Session(repoWithCommit());
  s.toggle();
  const before = s.state().base.dir;
  const r = s.toggle();
  assert.match(r.stdout, /generation=1/);
  assert.match(r.stdout, /база прежняя/);
  assert.strictEqual(s.state().base.dir, before);
});

test('off, затем включение: новая база, прошлые ревью недействительны', () => {
  const repo = repoWithCommit();
  const s = new h.Session(repo);
  s.toggle();
  h.write(repo, 'src/a.js', 'const a = 2;\n');
  s.review();
  assert.strictEqual(s.blocked(), false);
  assert.match(s.toggle('off').stdout, /^SHERIFF-MODE off/);
  const r = s.toggle();
  assert.match(r.stdout, /generation=2/);
  assert.deepStrictEqual(s.state().snapshots, {});
  assert.strictEqual(fs.existsSync(path.join(s.sessionDir(), 'snapshots')), false);
});

test('--rebase создаёт новое поколение и убирает старые правки из ревью', () => {
  const repo = repoWithCommit();
  const s = new h.Session(repo);
  s.toggle();
  h.write(repo, 'src/a.js', 'const a = 2;\n');
  assert.strictEqual(s.blocked(), true);
  s.newPrompt();
  assert.match(s.toggle('--rebase').stdout, /generation=2/);
  assert.strictEqual(s.blocked(), false);
});

test('--from-head без коммитов: каждый файл является изменением', () => {
  const repo = h.gitRepo();
  h.write(repo, 'a.js', '1\n');
  h.write(repo, 'b.js', '2\n');
  const s = new h.Session(repo);
  assert.match(s.toggle('--from-head').stdout, /base=empty-tree mode=from-head/);
  const r = s.stop();
  assert.strictEqual(r.json.decision, 'block');
  assert.match(r.json.reason, /- a\.js/);
  assert.match(r.json.reason, /- b\.js/);
});

test('обычное включение без коммитов: существующие файлы в ревью не попадают', () => {
  const repo = h.gitRepo();
  h.write(repo, 'a.js', '1\n');
  const s = new h.Session(repo);
  assert.match(s.toggle().stdout, /base=empty-tree mode=normal/);
  assert.strictEqual(s.blocked(), false);
  h.write(repo, 'a.js', '2\n');
  assert.strictEqual(s.blocked(), true);
});

test('status и неизвестный аргумент ничего не меняют', () => {
  const s = new h.Session(repoWithCommit());
  assert.match(s.toggle('status').stdout, /^SHERIFF-MODE off/);
  assert.strictEqual(fs.existsSync(s.statePath()), false);
  s.toggle();
  const before = JSON.stringify(s.state().base);
  assert.match(s.toggle('status').stdout, /^SHERIFF-MODE on generation=1/);
  const r = s.toggle('--wat');
  assert.match(r.stdout, /Неизвестный аргумент: --wat/);
  assert.strictEqual(JSON.stringify(s.state().base), before);
  // У /sheriff:off и /sheriff:status аргументов нет: лишнее слово ничего не меняет.
  const off = s.hook('mode-toggle', { command_name: 'sheriff:off', command_args: 'please' });
  assert.match(off.stdout, /^SHERIFF-MODE on generation=1/);
  assert.match(off.stdout, /Неизвестный аргумент: please/);
  assert.strictEqual(s.state().mode, 'on');
});

test('чужая команда хук не трогает', () => {
  const s = new h.Session(repoWithCommit());
  const r = s.hook('mode-toggle', { command_name: 'other:eng-like', command_args: '' });
  assert.strictEqual(r.stdout, '');
  assert.strictEqual(fs.existsSync(s.statePath()), false);
});

test('off молчит: Stop и вызов ревьюера не вмешиваются', () => {
  const repo = repoWithCommit();
  const s = new h.Session(repo);
  s.toggle();
  s.toggle('off');
  h.write(repo, 'src/a.js', 'const a = 3;\n');
  assert.strictEqual(s.stop().stdout, '');
  assert.strictEqual(s.callReviewer().silent, true);
});

test('без включения хуки молчат', () => {
  const repo = repoWithCommit();
  const s = new h.Session(repo);
  h.write(repo, 'src/a.js', 'const a = 3;\n');
  assert.strictEqual(s.stop().stdout, '');
  assert.strictEqual(s.callReviewer().silent, true);
});

test('повреждённое состояние: предупреждение, режим выключен, повторное включение работает', () => {
  const repo = repoWithCommit();
  const s = new h.Session(repo);
  s.toggle();
  fs.writeFileSync(s.statePath(), '{ это не json');
  h.write(repo, 'src/a.js', 'const a = 3;\n');
  const r = s.stop();
  assert.ok(r.json && r.json.systemMessage, 'ожидалось предупреждение');
  assert.match(r.json.systemMessage, /не читается/);
  assert.strictEqual(r.json.decision, undefined);
  assert.match(s.toggle('status').stdout, /^SHERIFF-MODE off reason=состояние сессии не читается/);
  assert.match(s.toggle().stdout, /^SHERIFF-MODE on generation=1/);
});

test('параллельные сессии не пересекаются', () => {
  const repo = repoWithCommit();
  const data = h.tmpdir('sheriff-data-');
  const a = new h.Session(repo, { data });
  const b = new h.Session(repo, { data });
  a.toggle();
  h.write(repo, 'src/a.js', 'const a = 4;\n');
  assert.strictEqual(a.blocked(), true);
  assert.strictEqual(b.stop().stdout, '');
});

test('брошенный лок старше срока перезахватывается', () => {
  const s = new h.Session(repoWithCommit());
  s.toggle();
  const lock = path.join(s.sessionDir(), 'state.lock');
  fs.writeFileSync(lock, '999999');
  const old = new Date(Date.now() - 5 * 60 * 1000);
  fs.utimesSync(lock, old, old);
  assert.match(s.toggle('off').stdout, /^SHERIFF-MODE off/);
  assert.strictEqual(s.state().mode, 'off');
  assert.strictEqual(fs.existsSync(lock), false);
});

test('SessionStart печатает принципы', () => {
  const s = new h.Session(repoWithCommit());
  const r = s.sessionStart('startup');
  assert.match(r.stdout, /sheriff: правила работы с кодом/);
  assert.ok(r.stdout.length < 10000, 'вывод хука ограничен 10 000 символов');
  assert.doesNotMatch(r.stdout, /SHERIFF-MODE/);
});

test('compaction: режим и база живут, в контексте строка статуса и напоминание', () => {
  const s = new h.Session(repoWithCommit());
  s.toggle();
  const r = s.sessionStart('compact');
  assert.match(r.stdout, /SHERIFF-MODE on generation=1/);
  assert.match(r.stdout, /sheriff:reviewer/);
  assert.strictEqual(s.state().mode, 'on');
  assert.ok(r.stdout.length < 10000);
});

test('уборка: состояние сессий старше срока удаляется при старте', () => {
  const repo = repoWithCommit();
  const data = h.tmpdir('sheriff-data-');
  const old = new h.Session(repo, { data });
  const fresh = new h.Session(repo, { data });
  old.toggle();
  fresh.toggle();
  const past = new Date(Date.now() - 20 * 24 * 3600 * 1000);
  fs.utimesSync(old.statePath(), past, past);
  const current = new h.Session(repo, { data });
  current.sessionStart('startup');
  assert.strictEqual(fs.existsSync(old.sessionDir()), false);
  assert.strictEqual(fs.existsSync(fresh.sessionDir()), true);
});

test('.sheriff.json: неизвестное поле даёт предупреждение, известные применяются', () => {
  const repo = repoWithCommit();
  h.write(repo, '.sheriff.json', JSON.stringify({ wat: 1, ignore: ['*.gen.js'] }));
  const s = new h.Session(repo);
  assert.match(s.toggle('--from-head').stdout, /неизвестное поле wat/);
  h.write(repo, 'src/x.gen.js', 'generated\n');
  s.toggle('--rebase');
  h.write(repo, 'src/y.gen.js', 'generated\n');
  assert.strictEqual(s.blocked(), false);
});
