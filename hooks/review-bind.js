'use strict';
// SubagentStart для sheriff:reviewer: привязка agent_id к активному запуску.
const io = require('./lib/io');
const st = require('./lib/state');

io.run('review-bind', (input) => {
  if (input.agent_type !== io.REVIEWER) return;
  const sid = input.session_id;
  if (!sid) return;
  const cur = st.peek(sid);
  if (cur.status !== 'ok' || cur.state.mode !== 'on') return;

  st.transact(sid, (ctx) => {
    if (ctx.status !== 'ok') return;
    const s = ctx.state;
    const ar = s.activeRun;
    const agent = input.agent_id || null;
    if (!ar || !ar.snapshotId) {
      st.journal(s, 'bind-ignored', { agent, reason: 'no-active-run' });
    } else if (ar.agentId) {
      if (ar.agentId === agent) return; // повторный старт того же субагента
      st.journal(s, 'bind-ignored', { agent, reason: 'already-bound', run: ar.id });
    } else if (!agent) {
      st.journal(s, 'bind-ignored', { reason: 'no-agent-id', run: ar.id });
    } else {
      ar.agentId = agent;
      st.journal(s, 'bound', { agent, run: ar.id });
    }
    ctx.dirty = true;
  });
});
