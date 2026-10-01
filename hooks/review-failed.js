'use strict';
// PostToolUseFailure(Agent) для sheriff:reviewer: сбой выполнения снимает активный запуск.
// Отказ в разрешении и отмена это событие не вызывают. Незапустившийся ревьюер снимается правилом 15 секунд,
// прерванный на ходу снимается в review-snapshot (запуск из прошлого хода) и в require-review (нет среди фоновых задач).
const io = require('./lib/io');
const st = require('./lib/state');

io.run('review-failed', (input) => {
  if (!io.isReviewerCall(input)) return;
  const sid = input.session_id;
  if (!sid) return;
  const cur = st.peek(sid);
  if (cur.status !== 'ok' || !cur.state.activeRun) return;

  st.transact(sid, (ctx) => {
    if (ctx.status !== 'ok' || !ctx.state.activeRun) return;
    const s = ctx.state;
    const ar = s.activeRun;
    // Сбой другого вызова не должен снять чужой запуск: сверяем tool_use_id,
    // а без него снимаем только запуск, к которому субагент ещё не привязался.
    const same = ar.toolUseId && input.tool_use_id ? ar.toolUseId === input.tool_use_id : !ar.agentId;
    ctx.dirty = true;
    if (!same) {
      st.journal(s, 'failure-ignored', { run: ar.id });
      return;
    }
    st.journal(s, 'run-failed', {
      run: ar.id,
      interrupt: !!input.is_interrupt,
      error: String(input.error || '').slice(0, 200),
    });
    s.activeRun = null;
  });
});
