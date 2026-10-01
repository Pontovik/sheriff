'use strict';
// Сценарии: урезанный режим вне git.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const h = require('./helpers');

test.after(h.cleanupAll);

function plainDir() {
  const dir = h.tmpdir('sheriff-plain-');
  h.write(dir, 'src/a.js', 'one\ntwo\n');
  h.write(dir, 'src/b.js', 'b\n');
  h.write(dir, 'notes.md', '# notes\n');
  h.write(dir, 'node_modules/lib/index.js', 'lib\n');
  h.write(dir, 'bin/out.js', 'out\n');
  return dir;
}

test('вне git: режим включается, база содержит только влияющие файлы вне исключённых каталогов', () => {
  const dir = plainDir();
  const s = new h.Session(dir);
  const r = s.toggle();
  assert.match(r.stdout, /^SHERIFF-MODE on generation=1 base=no-git mode=no-git/);
  assert.deepStrictEqual(Object.keys(s.baseIndex()).sort(), ['src/a.js', 'src/b.js']);
  assert.strictEqual(s.stop().stdout, '');
});

test('вне git: правка блокирует, дифф строится, ревью пропускает', () => {
  const dir = plainDir();
  const s = new h.Session(dir);
  s.toggle();
  h.write(dir, 'src/a.js', 'one\nTWO\n');
  assert.strictEqual(s.blocked(), true);
  const call = s.review();
  const diff = s.diffOf(call.snapshotId);
  assert.match(diff, /-two/);
  assert.match(diff, /\+TWO/);
  assert.strictEqual(s.blocked({ stop_hook_active: true }), false);
});

test('вне git: новый и удалённый файл являются изменениями', () => {
  const dir = plainDir();
  const s = new h.Session(dir);
  s.toggle();
  h.write(dir, 'src/new.js', 'n\n');
  fs.rmSync(path.join(dir, 'src/b.js'));
  const r = s.stop();
  assert.match(r.json.reason, /- src\/new\.js/);
  assert.match(r.json.reason, /- src\/b\.js \(удалён\)/);
  const diff = s.diffOf(s.callReviewer().snapshotId);
  assert.match(diff, /diff --sheriff a\/src\/b\.js[^\n]*\n# удалён/);
  assert.match(diff, /-b\n/);
});

test('вне git: исключённые каталоги и документация не трогаются', () => {
  const dir = plainDir();
  const s = new h.Session(dir);
  s.toggle();
  h.write(dir, 'node_modules/lib/index.js', 'changed\n');
  h.write(dir, 'bin/out.js', 'changed\n');
  h.write(dir, 'notes.md', '# changed\n');
  assert.strictEqual(s.stop().stdout, '');
});

test('вне git: excludeDirs из .sheriff.json дополняет список', () => {
  const dir = plainDir();
  h.write(dir, 'generated/x.js', 'g\n');
  h.write(dir, '.sheriff.json', JSON.stringify({ excludeDirs: ['generated'] }));
  const s = new h.Session(dir);
  s.toggle();
  h.write(dir, 'generated/x.js', 'changed\n');
  assert.strictEqual(s.stop().stdout, '');
});

test('вне git: больше лимита, режим не включается с объяснением', () => {
  const dir = plainDir();
  h.write(dir, '.sheriff.json', JSON.stringify({ noGitLimitMB: 0.00001 }));
  const s = new h.Session(dir);
  const r = s.toggle();
  assert.match(r.stdout, /^SHERIFF-MODE off reason=папка вне git, влияющих файлов/);
  assert.match(r.stdout, /лимите/);
  assert.strictEqual(fs.existsSync(s.statePath()), false);
  assert.strictEqual(s.stop().stdout, '');
});

test('вне git: рост сверх лимита после включения работу не останавливает', () => {
  const dir = plainDir();
  h.write(dir, '.sheriff.json', JSON.stringify({ noGitLimitMB: 0.001 }));
  const s = new h.Session(dir);
  assert.match(s.toggle().stdout, /^SHERIFF-MODE on/);
  h.write(dir, 'src/huge.js', 'x'.repeat(5000) + '\n');
  assert.strictEqual(s.blocked(), true);
  s.review();
  assert.strictEqual(s.blocked({ stop_hook_active: true }), false);
});

test('вне git: --rebase берёт новое состояние, --from-head не применим', () => {
  const dir = plainDir();
  const s = new h.Session(dir);
  s.toggle();
  h.write(dir, 'src/a.js', 'changed\n');
  assert.strictEqual(s.blocked(), true);
  s.newPrompt();
  const r = s.toggle('--from-head');
  assert.match(r.stdout, /generation=2 base=no-git mode=no-git/);
  assert.match(r.stdout, /--from-head не применим/);
  assert.strictEqual(s.stop().stdout, '');
});

test('вне git: символические ссылки не обходятся', (t) => {
  const dir = plainDir();
  const outside = h.tmpdir('sheriff-outside-');
  h.write(outside, 'secret.js', 's\n');
  try {
    fs.symlinkSync(outside, path.join(dir, 'link'), 'junction');
  } catch {
    t.skip('ссылки недоступны в этом окружении');
    return;
  }
  const s = new h.Session(dir);
  s.toggle();
  assert.ok(!Object.keys(s.baseIndex()).some((p) => p.startsWith('link/')));
  h.write(outside, 'secret.js', 'changed\n');
  assert.strictEqual(s.stop().stdout, '');
});
