'use strict';
// Раздел 12 ТЗ: ревью, снимки, запуски ревьюера, предохранитель, влияющие файлы.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const h = require('./helpers');

test.after(h.cleanupAll);

function setup() {
  const repo = h.gitRepo();
  h.write(repo, 'src/a.js', 'const a = 1;\nconst b = 2;\n');
  h.write(repo, 'src/b.js', 'module.exports = 1;\n');
  h.write(repo, 'README.md', '# readme\n');
  h.commitAll(repo);
  const s = new h.Session(repo);
  s.toggle();
  return { repo, s };
}

function edit(repo) {
  h.write(repo, 'src/a.js', 'const a = 1;\nconst b = 3;\n');
}

test('правка исходника без ревью блокируется, после COMPLETE пропускается', () => {
  const { repo, s } = setup();
  edit(repo);
  const r = s.stop();
  assert.strictEqual(r.json.decision, 'block');
  assert.match(r.json.reason, /запусти sheriff:reviewer/);
  assert.match(r.json.reason, /- src\/a\.js/);
  s.review();
  assert.strictEqual(s.stop({ stop_hook_active: true }).stdout, '');
});

test('вызов ревьюера: снимок есть, вход инструмента не меняется и явно не разрешается', () => {
  const { repo, s } = setup();
  edit(repo);
  const call = s.callReviewer();
  assert.strictEqual(call.allowed, true);
  assert.strictEqual(call.silent, true, 'ни решения о разрешении, ни нового входа');
  assert.ok(call.snapshotId);
  assert.match(s.diffOf(call.snapshotId), /\+const b = 3;/);
});

test('данные ревью приходят в контекст субагента при старте: снимок, рубрика, дифф, строка отчёта', () => {
  const { repo, s } = setup();
  edit(repo);
  const call = s.callReviewer();
  const { context } = s.bind('ag1');
  assert.ok(context.includes(`Идентификатор снимка: ${call.snapshotId}`));
  assert.ok(context.includes('# Рубрика ревью sheriff'), 'рубрика целиком');
  assert.doesNotMatch(context, /Прочитай рубрику целиком из файла/);
  assert.match(context, /-const b = 2;/);
  assert.match(context, /\+const b = 3;/);
  assert.ok(context.includes(`SHERIFF-REVIEW ${call.snapshotId} COMPLETE`));
});

test('ревьюер в фоне запрещён, запуск не резервируется', () => {
  const { repo, s } = setup();
  edit(repo);
  const call = s.callReviewer({ run_in_background: true });
  assert.strictEqual(call.denied, true);
  assert.match(call.reason, /в переднем плане/);
  assert.strictEqual(s.state().activeRun, null);
  assert.strictEqual(s.callReviewer({ run_in_background: false }).allowed, true);
});

test('контекст не длиннее лимита платформы: большой дифф уходит путём к файлу, строка отчёта в начале', () => {
  const { repo, s } = setup();
  h.write(repo, 'src/a.js', Array.from({ length: 2000 }, (_, i) => `const value${i} = ${i};`).join('\n') + '\n');
  const call = s.callReviewer();
  const { context } = s.bind('ag1');
  assert.ok(context.length <= 10000, `длина ${context.length}`);
  assert.ok(context.includes(path.join(s.sessionDir(), 'snapshots', call.snapshotId, 'diff.patch')));
  assert.doesNotMatch(context, /const value1000 = 1000;/);
  // Claude Code показывает от слишком длинного контекста только первые 2 КБ: обязательное должно быть там.
  assert.ok(context.slice(0, 2000).includes(`SHERIFF-REVIEW ${call.snapshotId} COMPLETE`));
});

test('дифф помещается только без рубрики: дифф в контексте, рубрика путём к файлу', () => {
  const { repo, s } = setup();
  h.write(repo, 'src/a.js', Array.from({ length: 300 }, (_, i) => `const v${i} = ${i};`).join('\n') + '\n');
  const call = s.callReviewer();
  const { context } = s.bind('ag1');
  assert.ok(context.length <= 10000, `длина ${context.length}`);
  assert.match(context, /const v299 = 299;/);
  assert.ok(context.includes(path.join(h.ROOT, 'core', 'review-rubric.md')));
  assert.ok(call.snapshotId);
});

test('данные ревью получает только привязанный субагент, повторный старт того же получает их снова', () => {
  const { repo, s } = setup();
  edit(repo);
  assert.strictEqual(s.bind('ag-early').context, undefined, 'до вызова ревьюера данных нет');
  s.callReviewer();
  assert.ok(s.bind('ag1').context);
  assert.strictEqual(s.bind('ag2').context, undefined);
  assert.ok(s.bind('ag1').context);
});

test('INCOMPLETE для текущего состояния: Stop пропускает с предупреждением без блокировки', () => {
  const { repo, s } = setup();
  edit(repo);
  s.review('INCOMPLETE');
  const r = s.stop();
  assert.strictEqual(r.json.decision, undefined);
  assert.match(r.json.systemMessage, /не смог проверить/);
  assert.match(r.json.systemMessage, /дифф не читается/);
});

test('отчёт без маркера: одна попытка вернуть к протоколу, затем нарушение и блокировка', () => {
  const { repo, s } = setup();
  edit(repo);
  const call = s.callReviewer();
  s.bind('ag1');
  const first = s.done('ag1', 'всё хорошо, замечаний нет');
  assert.strictEqual(first.json.decision, 'block');
  assert.ok(first.json.reason.includes(`SHERIFF-REVIEW ${call.snapshotId} COMPLETE`));
  assert.ok(s.state().activeRun, 'запуск остаётся активным на время повтора');
  s.done('ag1', 'всё хорошо', { stop_hook_active: true });
  assert.strictEqual(s.state().activeRun, null);
  assert.strictEqual(s.state().snapshots[call.snapshotId].status, 'violation');
  const r = s.stop();
  assert.strictEqual(r.json.decision, 'block');
  assert.match(r.json.reason, /не закончился строкой SHERIFF-REVIEW/);
  assert.strictEqual(s.callReviewer().allowed, true, 'повторный запуск разрешён');
});

test('отчёт с чужим идентификатором снимка: нарушение протокола', () => {
  const { repo, s } = setup();
  edit(repo);
  const call = s.callReviewer();
  s.bind('ag1');
  s.done('ag1', 'SHERIFF-REVIEW s0000000000 COMPLETE', { stop_hook_active: true });
  assert.strictEqual(s.state().snapshots[call.snapshotId].status, 'violation');
  assert.strictEqual(s.blocked(), true);
});

test('маркер в обрамлении кода засчитывается', () => {
  const { repo, s } = setup();
  edit(repo);
  const call = s.callReviewer();
  s.bind('ag1');
  s.done('ag1', 'замечаний нет\n\n`SHERIFF-REVIEW ' + call.snapshotId + ' COMPLETE`\n');
  assert.strictEqual(s.state().snapshots[call.snapshotId].status, 'complete');
});

test('запасной путь: отчёт читается из транскрипта субагента', () => {
  const { repo, s } = setup();
  edit(repo);
  const call = s.callReviewer();
  s.bind('ag1');
  const transcript = path.join(h.tmpdir('sheriff-tr-'), 'agent.jsonl');
  fs.writeFileSync(
    transcript,
    [
      JSON.stringify({ type: 'user', message: { role: 'user', content: 'бриф' } }),
      JSON.stringify({
        type: 'assistant',
        message: { role: 'assistant', content: [{ type: 'text', text: `замечаний нет\nSHERIFF-REVIEW ${call.snapshotId} COMPLETE` }] },
      }),
    ].join('\n') + '\n'
  );
  s.done('ag1', undefined, { agent_transcript_path: transcript });
  assert.strictEqual(s.state().snapshots[call.snapshotId].status, 'complete');
});

test('правка, новый файл, удаление файла после ревью блокируют', () => {
  for (const change of ['edit', 'new', 'delete']) {
    const { repo, s } = setup();
    edit(repo);
    s.review();
    assert.strictEqual(s.blocked(), false, change);
    if (change === 'edit') h.write(repo, 'src/a.js', 'const a = 1;\nconst b = 4;\n');
    if (change === 'new') h.write(repo, 'src/new.js', 'new\n');
    if (change === 'delete') fs.rmSync(path.join(repo, 'src/b.js'));
    const r = s.stop();
    assert.strictEqual(r.json.decision, 'block', change);
    assert.match(r.json.reason, /После последнего ревью файлы изменились/, change);
  }
});

test('возврат файла к проверенным байтам снова проходит', () => {
  const { repo, s } = setup();
  edit(repo);
  s.review();
  h.write(repo, 'src/a.js', 'const a = 1;\nconst b = 4;\n');
  assert.strictEqual(s.blocked(), true);
  edit(repo);
  s.newPrompt();
  assert.strictEqual(s.blocked(), false);
});

test('файл изменён между снимком и завершением: блокировка', () => {
  const { repo, s } = setup();
  edit(repo);
  const call = s.callReviewer();
  s.bind('ag1');
  h.write(repo, 'src/a.js', 'const a = 1;\nconst b = 5;\n');
  s.done('ag1', `SHERIFF-REVIEW ${call.snapshotId} COMPLETE`);
  assert.strictEqual(s.state().snapshots[call.snapshotId].status, 'complete');
  assert.strictEqual(s.blocked(), true);
});

test('дифф строится из байтов снимка, а не из диска на момент чтения', () => {
  const { repo, s } = setup();
  edit(repo);
  const call = s.callReviewer();
  h.write(repo, 'src/a.js', 'совсем другое\n');
  const diff = s.diffOf(call.snapshotId);
  assert.match(diff, /\+const b = 3;/);
  assert.doesNotMatch(diff, /совсем другое/);
});

test('второй ревьюер при активном первом заблокирован', () => {
  const { repo, s } = setup();
  edit(repo);
  const first = s.callReviewer();
  s.bind('ag1');
  const second = s.callReviewer();
  assert.strictEqual(second.denied, true);
  assert.match(second.reason, /один ревьюер на сессию/);
  assert.strictEqual(s.state().activeRun.snapshotId, first.snapshotId);
});

test('два параллельных вызова ревьюера: проходит ровно один', async () => {
  const { repo, s } = setup();
  edit(repo);
  const results = await Promise.all([
    s.hookAsync('review-snapshot', s.reviewerInput()),
    s.hookAsync('review-snapshot', s.reviewerInput()),
    s.hookAsync('review-snapshot', s.reviewerInput()),
  ]);
  const described = results.map(h.describeCall);
  assert.strictEqual(described.filter((d) => d.allowed).length, 1);
  assert.strictEqual(described.filter((d) => d.denied).length, 2);
  // Проигравшие отказаны до снимка: на диске ровно снимок активного запуска.
  const snapshots = fs.readdirSync(path.join(s.sessionDir(), 'snapshots'));
  assert.deepStrictEqual(snapshots, [s.state().activeRun.snapshotId]);
});

test('незапустившийся ревьюер: следующий запуск разрешён через 15 секунд', () => {
  const { repo, s } = setup();
  edit(repo);
  s.callReviewer();
  assert.strictEqual(s.callReviewer().denied, true, 'сразу после вызова второй запуск закрыт');
  s.patchState((st) => (st.activeRun.startedAt -= 16 * 1000));
  const next = s.callReviewer();
  assert.strictEqual(next.allowed, true);
  assert.ok(s.state().journal.some((j) => j.event === 'run-never-started'));
});

test('сбой выполнения ревьюера снимает запуск, чужой сбой запуск не трогает', () => {
  const { repo, s } = setup();
  edit(repo);
  const call = s.callReviewer();
  s.bind('ag1');
  s.failed('toolu_other');
  assert.ok(s.state().activeRun, 'сбой другого вызова не снимает активный запуск');
  s.failed(call.toolUseId);
  assert.strictEqual(s.state().activeRun, null);
  assert.strictEqual(s.callReviewer().allowed, true);
});

test('активный запуск старше 30 минут: следующий разрешён', () => {
  const { repo, s } = setup();
  edit(repo);
  s.callReviewer();
  s.bind('ag1');
  s.patchState((st) => (st.activeRun.startedAt -= 31 * 60 * 1000));
  assert.strictEqual(s.callReviewer().allowed, true);
  assert.ok(s.state().journal.some((j) => j.event === 'run-timeout'));
});

test('завершение субагента с чужим agent_id игнорируется', () => {
  const { repo, s } = setup();
  edit(repo);
  const call = s.callReviewer();
  s.bind('ag-new');
  s.done('ag-old', `SHERIFF-REVIEW ${call.snapshotId} COMPLETE`);
  const st = s.state();
  assert.strictEqual(st.activeRun.agentId, 'ag-new');
  assert.strictEqual(st.snapshots[call.snapshotId].status, 'pending');
  assert.ok(st.journal.some((j) => j.event === 'stop-ignored'));
});

test('позднее завершение старого запуска новый не закрывает и не засчитывает', () => {
  const { repo, s } = setup();
  edit(repo);
  const old = s.callReviewer();
  s.bind('ag-old');
  s.patchState((st) => (st.activeRun.startedAt -= 31 * 60 * 1000));
  const fresh = s.callReviewer();
  s.bind('ag-new');
  s.done('ag-old', `SHERIFF-REVIEW ${old.snapshotId} COMPLETE`);
  const st = s.state();
  assert.strictEqual(st.activeRun.snapshotId, fresh.snapshotId);
  assert.strictEqual(st.snapshots[old.snapshotId].status, 'pending');
  assert.strictEqual(s.blocked(), true);
});

test('второй субагент не перехватывает привязку', () => {
  const { repo, s } = setup();
  edit(repo);
  s.callReviewer();
  s.bind('ag1');
  s.bind('ag2');
  assert.strictEqual(s.state().activeRun.agentId, 'ag1');
});

test('возобновление сессии с висящим запуском: запуск снят', () => {
  const { repo, s } = setup();
  edit(repo);
  s.callReviewer();
  s.bind('ag1');
  const r = s.sessionStart('resume');
  assert.strictEqual(s.state().activeRun, null);
  assert.match(r.stdout, /SHERIFF-MODE on/);
  assert.strictEqual(s.callReviewer().allowed, true);
});

test('вызов ревьюера при пустых изменениях заблокирован', () => {
  const { s } = setup();
  const call = s.callReviewer();
  assert.strictEqual(call.denied, true);
  assert.match(call.reason, /ревьюить нечего/);
  assert.strictEqual(s.state().activeRun, null);
});

test('цикл «ревью, починил всё, ревью»: два запуска, ход завершается', () => {
  const { repo, s } = setup();
  edit(repo);
  assert.strictEqual(s.blocked(), true);
  s.review();
  h.write(repo, 'src/a.js', 'const a = 1;\nconst b = 30;\n');
  assert.strictEqual(s.blocked({ stop_hook_active: true }), true);
  s.review();
  assert.strictEqual(s.stop({ stop_hook_active: true }).stdout, '');
  assert.strictEqual(Object.keys(s.state().snapshots).length, 2);
});

test('три попытки завершить без ревьюера: две блокировки, третья по предохранителю', () => {
  const { repo, s } = setup();
  edit(repo);
  assert.strictEqual(s.blocked(), true);
  assert.strictEqual(s.blocked({ stop_hook_active: true }), true);
  const third = s.stop({ stop_hook_active: true });
  assert.strictEqual(third.json.decision, undefined);
  assert.match(third.json.systemMessage, /предохранитель/);
  s.newPrompt();
  assert.strictEqual(s.blocked(), true, 'в новом ходе счётчик начинается заново');
});

test('предохранитель без prompt_id: ход определяется по stop_hook_active', () => {
  const { repo, s } = setup();
  edit(repo);
  const noId = { prompt_id: undefined };
  assert.strictEqual(s.blocked(noId), true);
  assert.strictEqual(s.blocked({ prompt_id: undefined, stop_hook_active: true }), true);
  const third = s.stop({ prompt_id: undefined, stop_hook_active: true });
  assert.match(third.json.systemMessage, /предохранитель/);
  assert.strictEqual(s.blocked(noId), true, 'первый Stop нового хода обнуляет счётчик');
});

test('влияющие файлы: md не блокирует, csproj, CI и lock-файл блокируют', () => {
  const { repo, s } = setup();
  h.write(repo, 'README.md', '# readme changed\n');
  h.write(repo, 'docs/guide.rst', 'guide\n');
  h.write(repo, 'LICENSE', 'license text\n');
  h.write(repo, 'logo.png', Buffer.from([137, 80, 78, 71, 0, 1]));
  assert.strictEqual(s.stop().stdout, '', 'документация и картинки ревью не требуют');
  const affecting = [
    'app/App.csproj', '.gitlab-ci.yml', 'package-lock.json', 'Dockerfile', 'db/init.sql', 'appsettings.json',
    // имена, похожие на документацию, но это код и файлы сборки
    'requirements.txt', 'CMakeLists.txt', 'src/Licensing/License.cs', 'web/Changelog.tsx', 'src/authors',
  ];
  for (const rel of affecting) {
    s.newPrompt();
    h.write(repo, rel, 'x\n');
    const r = s.stop();
    assert.strictEqual(r.json && r.json.decision, 'block', rel);
    fs.rmSync(path.join(repo, rel));
  }
});

test('файлы с секретами не требуют ревью и не попадают в дифф', () => {
  const { repo, s } = setup();
  const secrets = ['.env', 'config/.env.local', 'certs/server.pem', 'certs/server.key', '.ssh/id_rsa', '.npmrc'];
  for (const rel of secrets) h.write(repo, rel, 'TOKEN=secret-value\n');
  assert.strictEqual(s.stop().stdout, '', 'одни секреты ревью не требуют');
  edit(repo);
  const call = s.callReviewer();
  assert.doesNotMatch(s.diffOf(call.snapshotId), /secret-value/);
  assert.doesNotMatch(s.bind('ag1').context, /secret-value/);
});

test('секрет, явно включённый через include, требует ревью', () => {
  const { repo, s } = setup();
  h.write(repo, '.sheriff.json', JSON.stringify({ include: ['.env.example'] }));
  s.toggle('--rebase');
  h.write(repo, '.env.example', 'TOKEN=\n');
  assert.strictEqual(s.blocked(), true);
});

test('правка только пробелов в исходнике блокирует', () => {
  const { repo, s } = setup();
  h.write(repo, 'src/a.js', 'const a = 1;\nconst b = 2;  \n');
  assert.strictEqual(s.blocked(), true);
});

test('файл сверх лимита диффа: в диффе заголовок без тела, блокировка работает', () => {
  const { repo, s } = setup();
  h.write(repo, '.sheriff.json', JSON.stringify({ maxFileDiffBytes: 200 }));
  s.toggle('--rebase');
  const big = Array.from({ length: 200 }, (_, i) => `"dep${i}": "1.0.${i}"`).join(',\n');
  h.write(repo, 'package-lock.json', `{\n${big}\n}\n`);
  h.write(repo, 'src/a.js', 'const a = 1;\nconst b = 7;\n');
  assert.strictEqual(s.blocked(), true);
  const call = s.callReviewer();
  const diff = s.diffOf(call.snapshotId);
  assert.match(diff, /diff --sheriff a\/package-lock\.json[^\n]*\n# добавлен[^\n]*\n# тело опущено: дифф больше лимита размера/);
  assert.match(diff, /\+const b = 7;/);
  assert.match(s.bind('ag1').context, /Файлы без тела диффа \(1\)/);
});

test('дифф больше лимита промпта из настроек передаётся путём к файлу', () => {
  const { repo, s } = setup();
  h.write(repo, '.sheriff.json', JSON.stringify({ maxPromptDiffBytes: 100 }));
  s.toggle('--rebase');
  h.write(repo, 'src/a.js', Array.from({ length: 50 }, (_, i) => `const v${i} = ${i};`).join('\n') + '\n');
  const call = s.callReviewer();
  const { context } = s.bind('ag1');
  assert.match(context, /Прочитай дифф целиком из файла/);
  assert.ok(context.includes(path.join(s.sessionDir(), 'snapshots', call.snapshotId, 'diff.patch')));
  assert.doesNotMatch(context, /const v10 = 10;/);
});

test('бинарный влияющий файл: заголовок без тела', () => {
  const { repo, s } = setup();
  h.write(repo, 'tool.bin', Buffer.from([1, 2, 0, 3, 4]));
  const call = s.callReviewer();
  assert.match(s.diffOf(call.snapshotId), /# тело опущено: бинарный файл/);
});

test('хранится не больше пяти снимков', () => {
  const { repo, s } = setup();
  for (let i = 0; i < 7; i++) {
    h.write(repo, 'src/a.js', `const a = ${i + 10};\n`);
    s.review();
  }
  assert.strictEqual(Object.keys(s.state().snapshots).length, 5);
  assert.strictEqual(fs.readdirSync(path.join(s.sessionDir(), 'snapshots')).length, 5);
  assert.strictEqual(s.blocked(), false);
});
