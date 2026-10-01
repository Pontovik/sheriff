'use strict';
// PreToolUse(Agent) для sheriff:reviewer: резерв запуска, снимок изменений, замороженный дифф
// и данные ревью в файле снимка. Вход инструмента хук не меняет: данные ревью передаёт субагенту
// хук SubagentStart (review-bind.js), а запуск в фоне хук запрещает.
const fs = require('fs');
const path = require('path');
const io = require('./lib/io');
const st = require('./lib/state');
const cfgLib = require('./lib/config');
const ch = require('./lib/changes');

const KEEP_SNAPSHOTS = 5;
// Контекст хука длиннее 10 000 символов Claude Code заменяет превью на 2 КБ и ссылкой на файл.
const CONTEXT_BUDGET_CHARS = 9000;
const HEAD_WARNING =
  'HEAD сменился с момента включения режима: изменения сессии включают разницу веток, при необходимости /sheriff:on --rebase.';

function deny(reason) {
  io.emitJson({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: 'sheriff: ' + reason,
    },
  });
}

function pruneSnapshots(state, sessionDir) {
  const ids = Object.keys(state.snapshots).sort((a, b) =>
    String(state.snapshots[a].createdAt).localeCompare(String(state.snapshots[b].createdAt))
  );
  for (const id of ids.slice(0, Math.max(0, ids.length - KEEP_SNAPSHOTS))) {
    delete state.snapshots[id];
    fs.rmSync(path.join(sessionDir, 'snapshots', id), { recursive: true, force: true });
  }
}

// Данные ревью для контекста субагента. Снимок и строка отчёта идут первыми: от слишком длинного
// контекста Claude Code показывает только первые 2 КБ. Дифф и рубрика встают целиком,
// пока помещаются в бюджет, иначе передаются путём к файлу.
function reviewContext(snapId, rubricFile, diff, diffFile, cfg, headChanged, omitted, skipped) {
  const head = [
    'Данные ревью, добавлены хуком плагина sheriff.',
    '',
    `Идентификатор снимка: ${snapId}`,
    '',
    'Последняя строка отчёта обязана быть ровно одной из двух:',
    `SHERIFF-REVIEW ${snapId} COMPLETE`,
    `SHERIFF-REVIEW ${snapId} INCOMPLETE <причина>`,
  ];
  if (headChanged) head.push('', 'Предупреждение: ' + HEAD_WARNING);
  if (omitted.length) {
    head.push('', `Файлы без тела диффа (${omitted.length}): новое содержимое читай из репозитория.`);
  }
  if (skipped.length) {
    head.push('', `Вне диффа остались изменённые пути, которые sheriff не читает (подмодули, ссылки): ${skipped.join(', ')}`);
  }

  const section = (title, body) => [title, '', body].join('\n');
  const compose = (rubric, diffPart) => [...head, '', rubric, '', diffPart].join('\n');
  const rubricInline = section('# Рубрика', fs.readFileSync(rubricFile, 'utf8').trim());
  const rubricByFile = section('# Рубрика', `Прочитай рубрику целиком из файла: ${rubricFile}`);
  const diffInline = section('# Замороженный дифф', diff.trimEnd());
  const diffByFile = section('# Замороженный дифф', `Прочитай дифф целиком из файла: ${diffFile}`);

  // По убыванию полноты: первый вариант, который помещается в бюджет. Дифф важнее рубрики.
  const variants = [];
  if (Buffer.byteLength(diff) <= cfg.maxPromptDiffBytes) variants.push([rubricInline, diffInline], [rubricByFile, diffInline]);
  variants.push([rubricInline, diffByFile]);
  const fit = variants.find(([r, d]) => compose(r, d).length <= CONTEXT_BUDGET_CHARS);
  return fit ? compose(fit[0], fit[1]) : compose(rubricByFile, diffByFile);
}

io.run(
  'review-snapshot',
  (input) => {
    if (!io.isReviewerCall(input)) return;
    const sid = input.session_id;
    if (!sid) return;
    const cur = st.peek(sid);
    // Режим выключен или состояние нечитаемо: хук не вмешивается.
    if (cur.status !== 'ok' || cur.state.mode !== 'on' || !cur.state.base) return;
    // Фоновый ревьюер переживает свой ход, а запуск из другого хода считается брошенным.
    if (input.tool_input.run_in_background === true) {
      return deny('запусти sheriff:reviewer в переднем плане, run_in_background: false');
    }

    const base = cur.state.base;
    const generation = cur.state.generation;
    const cfg = cfgLib.fromState(cur.state);
    const lockOpts = { staleMs: cfg.lockStaleSeconds * 1000 };
    const runId = st.newId('r');

    // Шаг 1. Под локом: проверка активного запуска и резерв нового.
    const reserve = st.transact(
      sid,
      (ctx) => {
        if (ctx.status !== 'ok' || ctx.state.mode !== 'on') return { skip: true };
        const s = ctx.state;
        const ar = s.activeRun;
        const now = Date.now();
        if (ar) {
          const age = now - ar.startedAt;
          const busy = `один ревьюер на сессию, активный запуск ${ar.id}. Дождись его результата`;
          if (ar.agentId) {
            // Ревьюер работает в переднем плане и не переживает свой ход.
            // Запуск из другого хода остался от прерванного ревью: считаем его брошенным.
            const otherTurn = !!ar.promptId && !!input.prompt_id && ar.promptId !== input.prompt_id;
            if (otherTurn) st.journal(s, 'run-abandoned', { run: ar.id });
            else if (age < cfg.reviewTimeoutMinutes * 60000) return { deny: busy };
            else st.journal(s, 'run-timeout', { run: ar.id });
          } else {
            if (age < cfg.unboundRunSeconds * 1000) return { deny: busy };
            st.journal(s, 'run-never-started', { run: ar.id });
          }
        }
        s.activeRun = {
          id: runId,
          startedAt: now,
          snapshotId: null,
          agentId: null,
          toolUseId: input.tool_use_id || null,
          promptId: input.prompt_id || null,
        };
        ctx.dirty = true;
        return {};
      },
      lockOpts
    );
    if (reserve.skip) return;
    if (reserve.deny) return deny(reserve.deny);

    const release = (reason) => {
      try {
        st.transact(
          sid,
          (ctx) => {
            if (ctx.status !== 'ok' || !ctx.state.activeRun || ctx.state.activeRun.id !== runId) return;
            ctx.state.activeRun = null;
            st.journal(ctx.state, 'run-released', { run: runId, reason });
            ctx.dirty = true;
          },
          lockOpts
        );
      } catch {
        // непривязанный резерв снимется сам по правилу 15 секунд
      }
    };

    let snapDir = null;
    try {
      // Шаги 2 и 3. Вне лока: изменения сессии и снимок. Содержимое читается один раз.
      const snapId = st.newId('s');
      snapDir = path.join(cur.dir, 'snapshots', snapId);
      const blobsDir = path.join(snapDir, 'blobs');
      fs.mkdirSync(blobsDir, { recursive: true });
      const res = ch.computeChanges(cur.dir, base, cfg, blobsDir);
      if (!res.changes.length) {
        fs.rmSync(snapDir, { recursive: true, force: true });
        release('empty');
        return deny('ревьюить нечего: изменений сессии во влияющих файлах нет');
      }
      const diff = ch.buildDiff(cur.dir, base, cfg, res.changes);
      const diffFile = path.join(snapDir, 'diff.patch');
      fs.writeFileSync(diffFile, diff.text);
      const createdAt = new Date().toISOString();
      fs.writeFileSync(
        path.join(snapDir, 'meta.json'),
        JSON.stringify({ id: snapId, generation, createdAt, files: ch.fingerprint(res.changes) })
      );

      // Данные ревью для хука SubagentStart (review-bind.js).
      const rubricFile = path.join(io.pluginRoot(), 'core', 'review-rubric.md');
      fs.writeFileSync(
        path.join(snapDir, 'context.md'),
        reviewContext(snapId, rubricFile, diff.text, diffFile, cfg, res.headChanged, diff.omitted, res.skipped)
      );

      // Шаг 4. Под локом: привязка снимка к резерву.
      const bound = st.transact(
        sid,
        (ctx) => {
          if (ctx.status !== 'ok') return false;
          const s = ctx.state;
          if (s.mode !== 'on' || s.generation !== generation) return false;
          if (!s.activeRun || s.activeRun.id !== runId) return false;
          s.activeRun.snapshotId = snapId;
          s.activeRun.startedAt = Date.now();
          s.snapshots[snapId] = { generation, status: 'pending', createdAt };
          pruneSnapshots(s, ctx.dir);
          st.journal(s, 'snapshot', { run: runId, snapshot: snapId, files: res.changes.length });
          ctx.dirty = true;
          return true;
        },
        lockOpts
      );
      if (!bound) {
        fs.rmSync(snapDir, { recursive: true, force: true });
        release('lost-reservation');
        return deny('резерв запуска снят или база сменилась, повтори вызов ревьюера');
      }

      // Шаг 5. Вход инструмента не меняется: данные ревью субагенту передаёт хук SubagentStart.
      if (res.headChanged) io.emitJson({ systemMessage: 'sheriff: ' + HEAD_WARNING });
    } catch (err) {
      // Шаг 6. Ошибка: резерв снимается, вызов блокируется с причиной.
      if (snapDir) fs.rmSync(snapDir, { recursive: true, force: true });
      release('error');
      deny(`снимок ревью не построен: ${err && err.message}`);
    }
  },
  (err, input) => {
    if (io.isReviewerCall(input)) deny(`внутренняя ошибка хука снимка: ${err && err.message}`);
  }
);
