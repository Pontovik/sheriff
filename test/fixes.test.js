'use strict';
// Сценарии, найденные независимым ревью кода плагина.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const h = require('./helpers');

test.after(h.cleanupAll);

function changedLines(diff) {
  const lines = diff.split('\n');
  return {
    removed: lines.filter((l) => l.startsWith('-') && !l.startsWith('---')).length,
    added: lines.filter((l) => l.startsWith('+') && !l.startsWith('+++')).length,
  };
}

function simpleRepo() {
  const repo = h.gitRepo();
  h.write(repo, 'src/a.js', 'const a = 1;\nconst b = 2;\n');
  h.commitAll(repo);
  return repo;
}

function withSubmodule() {
  const sub = h.gitRepo();
  h.write(sub, 'lib.js', 'lib\n');
  h.commitAll(sub);
  const repo = simpleRepo();
  h.git(repo, '-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', sub, 'vendor/sub');
  h.commitAll(repo, 'add submodule');
  return repo;
}

test('autocrlf и LF в рабочем дереве: дифф показывает одну правку, а не весь файл', () => {
  const repo = h.gitRepo({ autocrlf: true });
  const body = Array.from({ length: 20 }, (_, i) => `line${i}`);
  // Файл записан с LF и закоммичен: в репозитории LF, в рабочем дереве тоже LF.
  h.write(repo, 'src/a.cs', body.join('\n') + '\n');
  h.commitAll(repo);
  const s = new h.Session(repo);
  s.toggle();
  body[7] = 'CHANGED';
  h.write(repo, 'src/a.cs', body.join('\n') + '\n');
  assert.strictEqual(s.blocked(), true);
  assert.deepStrictEqual(changedLines(s.diffOf(s.callReviewer().snapshotId)), { removed: 1, added: 1 });
});

test('autocrlf=input и CRLF в рабочем дереве: дифф показывает одну правку', () => {
  const repo = h.gitRepo();
  h.git(repo, 'config', 'core.autocrlf', 'input');
  const body = Array.from({ length: 20 }, (_, i) => `line${i}`);
  h.write(repo, 'src/a.cs', body.join('\r\n') + '\r\n');
  h.commitAll(repo);
  const s = new h.Session(repo);
  s.toggle();
  body[3] = 'CHANGED';
  h.write(repo, 'src/a.cs', body.join('\r\n') + '\r\n');
  assert.deepStrictEqual(changedLines(s.diffOf(s.callReviewer().snapshotId)), { removed: 1, added: 1 });
});

test('исходно грязный файл со сменой только окончаний строк: изменение с пометкой, без стены строк', () => {
  const repo = simpleRepo();
  h.write(repo, 'src/a.js', 'const a = 1;\r\nconst b = 3;\r\n');
  const s = new h.Session(repo);
  s.toggle();
  h.write(repo, 'src/a.js', 'const a = 1;\nconst b = 3;\n');
  assert.strictEqual(s.blocked(), true);
  const diff = s.diffOf(s.callReviewer().snapshotId);
  assert.match(diff, /# окончания строк: были CRLF, стали LF/);
  assert.deepStrictEqual(changedLines(diff), { removed: 0, added: 0 });
});

test('прерванный ревьюер не блокирует ревью в следующем ходе', () => {
  const repo = simpleRepo();
  const s = new h.Session(repo);
  s.toggle();
  h.write(repo, 'src/a.js', 'const a = 1;\nconst b = 3;\n');
  const first = Object.assign(s.reviewerInput(), { prompt_id: s.promptId });
  assert.strictEqual(h.describeCall(s.hook('review-snapshot', first)).allowed, true);
  s.bind('ag-interrupted');
  // Пользователь прервал ход: SubagentStop не пришёл. Новый ход, новый prompt_id.
  s.newPrompt();
  const input = Object.assign(s.reviewerInput(), { prompt_id: s.promptId });
  const next = h.describeCall(s.hook('review-snapshot', input));
  assert.strictEqual(next.allowed, true);
  assert.ok(s.state().journal.some((j) => j.event === 'run-abandoned'));
});

test('в том же ходе привязанный запуск по-прежнему закрывает второй вызов', () => {
  const repo = simpleRepo();
  const s = new h.Session(repo);
  s.toggle();
  h.write(repo, 'src/a.js', 'const a = 1;\nconst b = 3;\n');
  const first = Object.assign(s.reviewerInput(), { prompt_id: s.promptId });
  assert.strictEqual(h.describeCall(s.hook('review-snapshot', first)).allowed, true);
  s.bind('ag1');
  const second = Object.assign(s.reviewerInput(), { prompt_id: s.promptId });
  assert.strictEqual(h.describeCall(s.hook('review-snapshot', second)).denied, true);
});

test('Stop снимает запуск, которого нет среди фоновых задач, и оставляет живой', () => {
  const repo = simpleRepo();
  const s = new h.Session(repo);
  s.toggle();
  h.write(repo, 'src/a.js', 'const a = 1;\nconst b = 3;\n');
  s.callReviewer();
  s.bind('ag1');
  const alive = s.stop({ background_tasks: [{ id: 't1', type: 'subagent', status: 'running', agent_type: h.REVIEWER }] });
  assert.match(alive.json.reason, /Ревьюер ещё работает в фоне/);
  assert.ok(s.state().activeRun, 'живой фоновый ревьюер не снимается');
  const dead = s.stop({ stop_hook_active: true, background_tasks: [] });
  assert.strictEqual(dead.json.decision, 'block');
  assert.strictEqual(s.state().activeRun, null);
  assert.ok(s.state().journal.some((j) => j.event === 'run-dead-at-stop'));
  assert.strictEqual(s.callReviewer().allowed, true);
});

test('отчёт сдан через SubagentHandback: строка протокола находится в транскрипте', () => {
  const repo = simpleRepo();
  const s = new h.Session(repo);
  s.toggle();
  h.write(repo, 'src/a.js', 'const a = 1;\nconst b = 3;\n');
  const call = s.callReviewer();
  s.bind('ag1');
  const transcript = path.join(h.tmpdir('sheriff-tr-'), 'agent.jsonl');
  fs.writeFileSync(
    transcript,
    [
      JSON.stringify({
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [
            {
              type: 'tool_use',
              name: 'SubagentHandback',
              input: { message: `замечаний нет\nSHERIFF-REVIEW ${call.snapshotId} COMPLETE` },
            },
          ],
        },
      }),
      JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Отчёт передан.' }] } }),
    ].join('\n') + '\n'
  );
  const r = s.done('ag1', 'Отчёт передан.', { agent_transcript_path: transcript });
  assert.strictEqual(r.stdout, '', 'повтор не нужен: строка найдена');
  assert.strictEqual(s.state().snapshots[call.snapshotId].status, 'complete');
});

test('правка .sheriff.json посреди сессии не отключает проверку', () => {
  const repo = simpleRepo();
  const s = new h.Session(repo);
  s.toggle();
  h.write(repo, 'src/a.js', 'const a = 1;\nconst b = 3;\n');
  assert.strictEqual(s.blocked(), true);
  h.write(repo, '.sheriff.json', JSON.stringify({ ignore: ['*'] }));
  s.newPrompt();
  const r = s.stop();
  assert.strictEqual(r.json.decision, 'block');
  assert.match(r.json.reason, /- \.sheriff\.json/, 'сам файл настроек тоже требует ревью');
  assert.match(r.json.reason, /- src\/a\.js/);
});

test('новые настройки .sheriff.json применяются после смены базы', () => {
  const repo = simpleRepo();
  const s = new h.Session(repo);
  s.toggle();
  h.write(repo, '.sheriff.json', JSON.stringify({ ignore: ['*.gen.js'] }));
  h.write(repo, 'src/x.gen.js', 'x\n');
  assert.match(s.stop().json.reason, /- src\/x\.gen\.js/);
  s.toggle('--rebase');
  h.write(repo, 'src/y.gen.js', 'y\n');
  s.newPrompt();
  assert.strictEqual(s.stop().stdout, '');
});

test('git-режим: копии исходно грязных файлов ограничены лимитом, бинарные не копируются', () => {
  const repo = simpleRepo();
  h.write(repo, '.sheriff.json', JSON.stringify({ noGitLimitMB: 0.001 }));
  h.write(repo, 'src/big1.js', 'x'.repeat(800) + '\n');
  h.write(repo, 'src/big2.js', 'y'.repeat(800) + '\n');
  h.write(repo, 'tool.bin', Buffer.from([1, 0, 2, 3]));
  const s = new h.Session(repo);
  s.toggle();
  const index = s.baseIndex();
  assert.strictEqual(index['tool.bin'].copy, false);
  const copies = ['src/big1.js', 'src/big2.js'].filter((p) => index[p].copy);
  assert.strictEqual(copies.length, 1, 'вторая копия не помещается в лимит');
  assert.strictEqual(s.stop().stdout, '', 'нетронутые грязные файлы изменениями не считаются');
  const uncopied = ['src/big1.js', 'src/big2.js'].find((p) => !index[p].copy);
  h.write(repo, uncopied, 'changed\n');
  assert.strictEqual(s.blocked(), true);
  const diff = s.diffOf(s.callReviewer().snapshotId);
  assert.match(diff, /# тело опущено: исходный файл не сохранён/);
});

test('изменения в подмодуле не теряются молча: Stop называет путь', () => {
  const repo = withSubmodule();
  const s = new h.Session(repo);
  s.toggle();
  assert.strictEqual(s.stop().stdout, '');
  h.write(repo, 'vendor/sub/lib.js', 'changed\n');
  const r = s.stop();
  assert.ok(r.json && r.json.systemMessage, 'ожидалось предупреждение');
  assert.match(r.json.systemMessage, /vendor\/sub/);
  assert.strictEqual(r.json.decision, undefined);
});

test('подмодуль, грязный до включения, предупреждений не даёт', () => {
  const repo = withSubmodule();
  h.write(repo, 'vendor/sub/lib.js', 'dirty before enable\n');
  const s = new h.Session(repo);
  s.toggle();
  assert.strictEqual(s.stop().stdout, '');
});

test('сбой переключения печатает настоящее состояние режима', () => {
  const repo = simpleRepo();
  const s = new h.Session(repo, { env: { SHERIFF_LOCK_WAIT_MS: '300' } });
  s.toggle();
  // Лок держит другой процесс: команда off не может выполниться.
  fs.writeFileSync(path.join(s.sessionDir(), 'state.lock'), 'foreign-token');
  const r = s.toggle('off');
  assert.match(r.stdout, /^SHERIFF-MODE on generation=1/);
  assert.match(r.stdout, /Команда не выполнена/);
  assert.strictEqual(s.state().mode, 'on');
  assert.ok(fs.existsSync(path.join(s.sessionDir(), 'state.lock')), 'чужой лок не снят');
});

test('ожидание лока ограничено и тогда, когда лок-файл создать нельзя', () => {
  const repo = simpleRepo();
  const s = new h.Session(repo, { env: { SHERIFF_LOCK_WAIT_MS: '300' } });
  s.toggle();
  // Каталог на месте лок-файла: открыть его на запись нельзя.
  fs.mkdirSync(path.join(s.sessionDir(), 'state.lock'));
  const started = Date.now();
  const r = s.toggle('off');
  assert.ok(Date.now() - started < 10000, 'хук не должен крутиться бесконечно');
  assert.match(r.stdout, /Команда не выполнена/);
});
