'use strict';
// UserPromptExpansion для команд /sheriff:on, /sheriff:off, /sheriff:status:
// включение, смена базы, выключение, статус.
// Срабатывает только на команду, набранную пользователем. Печатает строку статуса в контекст.
const fs = require('fs');
const path = require('path');
const io = require('./lib/io');
const st = require('./lib/state');
const cfgLib = require('./lib/config');
const ch = require('./lib/changes');
const { statusLine } = require('./lib/status');

// Действие задаёт имя команды. Аргументы есть только у /sheriff:on.
const ACTIONS = { 'sheriff:on': 'on', 'sheriff:off': 'off', 'sheriff:status': 'status' };
const ON_FLAGS = new Set(['--from-head', '--rebase']);
const USAGE =
  'Команды: /sheriff:on, /sheriff:on --rebase, /sheriff:on --from-head, /sheriff:off, /sheriff:status.';

function parseArgs(input, action) {
  let raw = typeof input.command_args === 'string' ? input.command_args : null;
  if (raw === null && typeof input.prompt === 'string') raw = input.prompt.replace(/^\s*\/\S+/, '');
  const tokens = String(raw || '').trim().split(/\s+/).filter(Boolean);
  return {
    unknown: tokens.filter((t) => action !== 'on' || !ON_FLAGS.has(t)),
    off: action === 'off',
    status: action === 'status',
    fromHead: tokens.includes('--from-head'),
    rebase: tokens.includes('--rebase'),
  };
}

function currentLine(sid) {
  const cur = st.peek(sid);
  if (cur.status === 'corrupt') return statusLine(null, 'состояние сессии не читается');
  return statusLine(cur.state);
}

// Папки прошлых поколений больше не нужны: снимки недействительны, база заменена.
function dropOldGenerations(dir, keepBaseDir) {
  let entries = [];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return;
  }
  for (const name of entries) {
    if ((name.startsWith('base-') && name !== keepBaseDir) || name === 'snapshots') {
      fs.rmSync(path.join(dir, name), { recursive: true, force: true });
    }
  }
}

io.run(
  'mode-toggle',
  (input) => {
    const action = ACTIONS[String(input.command_name || '')];
    if (!action) return; // чужая команда
    const sid = input.session_id;
    if (!sid) {
      io.emitText('SHERIFF-MODE off reason=во входе хука нет session_id');
      return;
    }
    const args = parseArgs(input, action);

    if (args.unknown.length) {
      io.emitText(`${currentLine(sid)}\nНеизвестный аргумент: ${args.unknown.join(' ')}. ${USAGE} Ничего не изменено.`);
      return;
    }
    if (args.status) {
      io.emitText(`${currentLine(sid)}\nЗапрошен только статус, ничего не изменено.`);
      return;
    }
    if (args.off) {
      st.transact(sid, (ctx) => {
        if (ctx.status !== 'ok') return;
        ctx.state.mode = 'off';
        ctx.state.activeRun = null;
        st.journal(ctx.state, 'disable');
        ctx.dirty = true;
      });
      io.emitText('SHERIFF-MODE off reason=выключено командой');
      return;
    }

    const cur = st.peek(sid);
    const wasOn = cur.status === 'ok' && cur.state.mode === 'on' && !!cur.state.base;
    if (wasOn && !args.fromHead && !args.rebase) {
      io.emitText(`${statusLine(cur.state)}\nРежим уже включён, база прежняя.`);
      return;
    }

    const notes = [];
    let created;
    let frozen;
    try {
      const repo = ch.detectRepo(wasOn ? cur.state.base.root : input.cwd || process.cwd());
      const loaded = cfgLib.load(repo.root);
      notes.push(...loaded.warnings);
      if (args.fromHead && repo.kind !== 'git') {
        notes.push('Папка вне git: --from-head не применим, база = текущее состояние файлов.');
      }
      frozen = cfgLib.freeze(loaded.config);
      created = ch.createBase(cur.dir, repo, loaded.config, { fromHead: args.fromHead });
    } catch (err) {
      const reason = err instanceof ch.RefuseError ? err.message : `база не создана: ${err.message}`;
      if (wasOn) io.emitText(`${statusLine(cur.state)}\nБаза не изменена: ${reason}`);
      else io.emitText(`SHERIFF-MODE off reason=${reason}`);
      return;
    }

    const state = st.transact(sid, (ctx) => {
      const s = ctx.status === 'ok' ? ctx.state : st.newState();
      if (ctx.status === 'corrupt') st.journal(s, 'state-recreated');
      s.generation = (s.generation || 0) + 1;
      s.mode = 'on';
      s.base = created.base;
      s.config = frozen;
      s.activeRun = null;
      s.snapshots = {};
      s.turn = { key: null, blocks: 0 };
      st.journal(s, wasOn ? 'rebase' : 'enable', {
        generation: s.generation,
        kind: created.base.kind,
        fromHead: created.base.fromHead,
        dirty: created.dirtyCount,
      });
      dropOldGenerations(ctx.dir, created.base.dir);
      ctx.state = s;
      ctx.dirty = true;
      return s;
    });

    const lines = [statusLine(state)];
    if (created.base.kind === 'nogit') {
      lines.push(`Папка вне git: урезанный режим, в базе ${created.dirtyCount} файлов.`);
    } else if (created.base.fromHead) {
      lines.push('База = дерево коммита HEAD: всё, чем рабочее дерево отличается от коммита, считается изменениями сессии.');
    } else {
      lines.push(`Путей с правками до включения: ${created.dirtyCount}. Они в ревью не попадут, пока не изменятся снова.`);
    }
    lines.push(...notes);
    io.emitText(lines.join('\n'));
  },
  (err, input) => {
    // Строка статуса должна говорить правду: при сбое печатаем состояние, которое осталось на диске.
    let line = 'SHERIFF-MODE off reason=состояние режима неизвестно';
    try {
      if (input && input.session_id) line = currentLine(input.session_id);
    } catch {
      // оставляем строку по умолчанию
    }
    io.emitText(`${line}
Команда не выполнена, состояние режима не изменилось: ${err && err.message}`);
  }
);
