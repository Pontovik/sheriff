'use strict';
// PreToolUse(Agent) для sheriff:reviewer: резерв запуска, снимок изменений, замороженный дифф,
// рубрика и дифф в промпт субагента, запуск в переднем плане.
const fs = require('fs');
const path = require('path');
const io = require('./lib/io');
const st = require('./lib/state');
const cfgLib = require('./lib/config');
const ch = require('./lib/changes');

const KEEP_SNAPSHOTS = 5;
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

function appendix(snapId, rubric, diff, diffFile, cfg, headChanged, omitted, skipped) {
  const parts = ['', '---', 'Данные ревью, добавлены хуком плагина sheriff.', '', `Идентификатор снимка: ${snapId}`];
  if (headChanged) parts.push('', 'Предупреждение: ' + HEAD_WARNING);
  parts.push('', '# Рубрика', '', rubric.trim(), '', '# Замороженный дифф', '');
  if (Buffer.byteLength(diff) <= cfg.maxPromptDiffBytes) {
    parts.push(diff.trimEnd());
  } else {
    const kb = Math.round(Buffer.byteLength(diff) / 1024);
    parts.push(`Дифф занимает ${kb} КБ и в промпт не помещён. Прочитай его целиком из файла: ${diffFile}`);
  }
  if (skipped.length) {
    parts.push('', `Вне диффа остались изменённые пути, которые sheriff не читает (подмодули, ссылки): ${skipped.join(', ')}`);
  }
  if (omitted.length) {
    parts.push('', `Файлы без тела диффа (${omitted.length}): новое содержимое читай из репозитория.`);
  }
  parts.push(
    '',
    'Последняя строка отчёта обязана быть ровно одной из двух:',
    `SHERIFF-REVIEW ${snapId} COMPLETE`,
    `SHERIFF-REVIEW ${snapId} INCOMPLETE <причина>`
  );
  return parts.join('\n');
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

      // Шаг 5. Обновление входа инструмента.
      const rubric = fs.readFileSync(path.join(io.pluginRoot(), 'core', 'review-rubric.md'), 'utf8');
      const extra = appendix(snapId, rubric, diff.text, diffFile, cfg, res.headChanged, diff.omitted, res.skipped);
      const updatedInput = Object.assign({}, input.tool_input, {
        prompt: String(input.tool_input.prompt || '') + '\n' + extra,
        run_in_background: false,
      });
      const out = {
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'allow',
          permissionDecisionReason: `sheriff: снимок ревью ${snapId}`,
          updatedInput,
        },
      };
      if (res.headChanged) out.systemMessage = 'sheriff: ' + HEAD_WARNING;
      io.emitJson(out);
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
