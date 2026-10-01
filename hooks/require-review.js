'use strict';
// Stop: не даёт завершить ход с правками, пока то самое состояние изменений не прошло ревью.
const fs = require('fs');
const path = require('path');
const io = require('./lib/io');
const st = require('./lib/state');
const cfgLib = require('./lib/config');
const ch = require('./lib/changes');

const MAX_LISTED = 20;
const HEAD_WARNING =
  'HEAD сменился с момента включения режима: изменения сессии включают разницу веток, при необходимости /sheriff:on --rebase.';

function readMeta(sessionDir, id) {
  try {
    return JSON.parse(fs.readFileSync(path.join(sessionDir, 'snapshots', id, 'meta.json'), 'utf8'));
  } catch {
    return null;
  }
}

function listPaths(changes) {
  const shown = changes.slice(0, MAX_LISTED).map((c) => `- ${c.path}${c.present ? '' : ' (удалён)'}`);
  if (changes.length > MAX_LISTED) shown.push(`- и ещё ${changes.length - MAX_LISTED}`);
  return shown.join('\n');
}

// Ревьюер запускается в переднем плане, поэтому к моменту Stop основного агента его уже нет.
// Активный запуск, которого нет среди фоновых задач, остался от прерванного ревью: снимаем его.
function dropDeadRun(sid, input, lockOpts) {
  const tasks = Array.isArray(input.background_tasks) ? input.background_tasks : [];
  if (tasks.some((t) => t && t.agent_type === io.REVIEWER)) return true;
  st.transact(
    sid,
    (ctx) => {
      if (ctx.status !== 'ok' || !ctx.state.activeRun) return;
      st.journal(ctx.state, 'run-dead-at-stop', { run: ctx.state.activeRun.id });
      ctx.state.activeRun = null;
      ctx.dirty = true;
    },
    lockOpts
  );
  return false;
}

io.run('require-review', (input) => {
  const sid = input.session_id;
  if (!sid) return;
  const cur = st.peek(sid);

  // 1. Режим выключен или состояние нечитаемо: пропустить.
  if (cur.status === 'missing') return;
  if (cur.status === 'corrupt') {
    io.warn('состояние сессии не читается, режим шерифа считается выключенным. Включить заново: /sheriff:on');
    return;
  }
  const s = cur.state;
  if (s.mode !== 'on' || !s.base) return;

  // 2. Сбой при вычислении: пропустить с предупреждением.
  let res;
  let cfg;
  try {
    cfg = cfgLib.fromState(s);
    res = ch.computeChanges(cur.dir, s.base, cfg, null);
  } catch (err) {
    io.warn(`изменения сессии не вычислены (${err && err.message}). Ход завершён без проверки ревью.`);
    return;
  }
  const lockOpts = { staleMs: cfg.lockStaleSeconds * 1000 };
  const reviewerAlive = s.activeRun ? dropDeadRun(sid, input, lockOpts) : false;

  const notes = [];
  if (res.headChanged) notes.push(HEAD_WARNING);
  if (res.skipped.length) {
    notes.push(`Вне ревью остались изменённые пути, которые sheriff не читает (подмодули, ссылки): ${res.skipped.join(', ')}.`);
  }
  const tail = notes.length ? ' ' + notes.join(' ') : '';

  // 3. Изменений нет: пропустить.
  if (!res.changes.length) {
    if (res.skipped.length) io.warn(notes[notes.length - 1]);
    return;
  }

  const now = ch.fingerprint(res.changes);
  let complete = false;
  let incomplete = null;
  let violation = false;
  let stale = false;
  for (const [id, snap] of Object.entries(s.snapshots || {})) {
    if (snap.generation !== s.generation) continue;
    const meta = readMeta(cur.dir, id);
    if (!meta) continue;
    const same = ch.sameFingerprint(now, meta.files || {});
    if (same && snap.status === 'complete') complete = true;
    else if (same && snap.status === 'incomplete') incomplete = snap.reason || 'причина не указана';
    else if (same && snap.status === 'violation') violation = true;
    else if (!same && snap.status === 'complete') stale = true;
  }

  // 4. Проверенный снимок совпадает с текущим состоянием: пропустить.
  if (complete) {
    if (notes.length) io.warn(notes.join(' '));
    return;
  }
  // 5. Техническая невозможность для точно этого состояния: пропустить с предупреждением.
  if (incomplete) {
    io.warn(`ревьюер не смог проверить изменения (${incomplete}). Ход завершён без действительного ревью.${tail}`);
    return;
  }

  // 6 и 7. Предохранитель или блокировка. Счётчик ведётся на ход.
  const key = input.prompt_id || null;
  const verdict = st.transact(
    sid,
    (ctx) => {
      if (ctx.status !== 'ok' || ctx.state.mode !== 'on') return 'pass';
      const state = ctx.state;
      const turn = state.turn || (state.turn = { key: null, blocks: 0 });
      if (key) {
        if (turn.key !== key) {
          turn.key = key;
          turn.blocks = 0;
        }
      } else if (!input.stop_hook_active) {
        // Запасной путь без prompt_id: первый Stop в ходе приходит с stop_hook_active=false.
        turn.key = null;
        turn.blocks = 0;
      }
      ctx.dirty = true;
      if (turn.blocks >= 2) {
        st.journal(state, 'fuse', { files: res.changes.length });
        return 'fuse';
      }
      turn.blocks += 1;
      st.journal(state, 'block', { files: res.changes.length, n: turn.blocks });
      return 'block';
    },
    lockOpts
  );

  if (verdict === 'pass') return;
  if (verdict === 'fuse') {
    io.warn(
      `предохранитель: две блокировки в этом ходе, ход завершён без действительного ревью. Непроверенных файлов: ${res.changes.length}.${tail}`
    );
    return;
  }

  const why = violation
    ? 'Прошлый отчёт ревьюера не закончился строкой SHERIFF-REVIEW, он не засчитан.'
    : stale
      ? 'После последнего ревью файлы изменились, тот снимок больше не действителен.'
      : 'Эти изменения ещё не проходили ревью.';
  const waiting = reviewerAlive ? ' Ревьюер ещё работает в фоне: дождись его отчёта, второй не запускай.' : '';
  io.emitJson({
    decision: 'block',
    reason:
      `sheriff: изменения не проверены, запусти sheriff:reviewer. ${why}${waiting}\n` +
      'Вызови инструмент Agent с subagent_type "sheriff:reviewer" в переднем плане. В промпте дай бриф: задача, ограничения, принятые решения, что относится к текущей задаче. ' +
      'Дифф и рубрику передаст хук. После отчёта почини все замечания сразу и запусти ревью повторно.\n' +
      `Непроверенные файлы (${res.changes.length}):\n${listPaths(res.changes)}${notes.length ? '\n' + notes.join(' ') : ''}`,
  });
});
