'use strict';
// SessionStart: принципы в контекст, уборка старых сессий, снятие висящего запуска ревьюера,
// напоминание о включённом режиме после compaction и возобновления.
const fs = require('fs');
const path = require('path');
const io = require('./lib/io');
const st = require('./lib/state');
const cfgLib = require('./lib/config');
const { statusLine, REMINDER } = require('./lib/status');

io.run('session-start', (input) => {
  let out = '';
  try {
    out = fs.readFileSync(path.join(io.pluginRoot(), 'core', 'principles.md'), 'utf8').trim();
  } catch {
    out = 'sheriff: файл core/principles.md не найден, принципы не загружены.';
  }

  const sid = input.session_id;
  if (sid) {
    let retentionDays = 14;
    try {
      retentionDays = cfgLib.load(input.cwd || process.cwd()).config.retentionDays;
    } catch {
      // берём срок по умолчанию
    }
    try {
      st.cleanup(retentionDays, sid);
    } catch {
      // уборка не должна мешать старту
    }

    let cur = st.peek(sid);
    if (cur.status === 'ok' && cur.state.activeRun && input.source === 'resume') {
      st.transact(sid, (ctx) => {
        if (ctx.status !== 'ok' || !ctx.state.activeRun) return;
        st.journal(ctx.state, 'run-dropped-on-resume', { run: ctx.state.activeRun.id });
        ctx.state.activeRun = null;
        ctx.dirty = true;
      });
      cur = st.peek(sid);
    }
    if (cur.status === 'ok' && cur.state.mode === 'on') {
      out += '\n\n' + statusLine(cur.state) + '\n' + REMINDER;
    } else if (cur.status === 'corrupt') {
      out += '\n\nsheriff: состояние сессии не читается, режим шерифа считается выключенным.';
    }
  }
  io.emitText(out);
});
