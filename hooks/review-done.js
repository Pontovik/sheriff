'use strict';
// SubagentStop для sheriff:reviewer: разбор последней строки отчёта и запись результата снимка.
const fs = require('fs');
const os = require('os');
const path = require('path');
const io = require('./lib/io');
const st = require('./lib/state');

const MARK = /^SHERIFF-REVIEW\s+(\S+)\s+(COMPLETE|INCOMPLETE)(?:\s+(.*))?$/;

// Последняя непустая строка. Обрамление кодом или выделением не считается нарушением.
function lastLine(text) {
  const lines = String(text || '')
    .split(/\r?\n/)
    .map((l) => l.trim().replace(/^[`*>\s]+/, '').replace(/[`*\s]+$/, ''))
    .filter(Boolean);
  return lines.length ? lines[lines.length - 1] : '';
}

function markOf(text) {
  return MARK.exec(lastLine(text));
}

// Тексты отчёта из транскрипта субагента, от последнего к первому.
// Отчёт может уйти не последним сообщением, а через инструмент SubagentHandback:
// тогда last_assistant_message содержит только завершающую фразу.
function reportsFromTranscript(file) {
  if (!file || typeof file !== 'string') return [];
  const resolved = file.startsWith('~') ? path.join(os.homedir(), file.slice(1)) : file;
  let lines;
  try {
    lines = fs.readFileSync(resolved, 'utf8').split('\n');
  } catch {
    return [];
  }
  const out = [];
  for (let i = lines.length - 1; i >= 0 && out.length < 6; i--) {
    if (!lines[i].trim()) continue;
    let entry;
    try {
      entry = JSON.parse(lines[i]);
    } catch {
      continue;
    }
    const msg = entry.message || entry;
    if (entry.type !== 'assistant' && msg.role !== 'assistant') continue;
    const content = msg.content;
    if (typeof content === 'string') {
      if (content.trim()) out.push(content);
      continue;
    }
    if (!Array.isArray(content)) continue;
    const text = content.filter((b) => b && b.type === 'text').map((b) => b.text).join('\n');
    if (text.trim()) out.push(text);
    for (const b of content) {
      if (b && b.type === 'tool_use' && b.name === 'SubagentHandback' && b.input && typeof b.input.message === 'string') {
        out.push(b.input.message);
      }
    }
  }
  return out;
}

// Строка протокола: сначала из last_assistant_message, затем из транскрипта.
function findMark(input, snapshotId) {
  const direct = markOf(input.last_assistant_message);
  if (direct && direct[1] === snapshotId) return direct;
  let fallback = direct;
  for (const text of reportsFromTranscript(input.agent_transcript_path)) {
    const m = markOf(text);
    if (!m) continue;
    if (m[1] === snapshotId) return m;
    if (!fallback) fallback = m;
  }
  return fallback;
}

io.run('review-done', (input) => {
  if (input.agent_type !== io.REVIEWER) return;
  const sid = input.session_id;
  if (!sid) return;
  const cur = st.peek(sid);
  if (cur.status !== 'ok' || cur.state.mode !== 'on') return;

  const expected = cur.state.activeRun ? cur.state.activeRun.snapshotId : null;
  const mark = findMark(input, expected);
  const agent = input.agent_id || null;

  const result = st.transact(sid, (ctx) => {
    if (ctx.status !== 'ok') return {};
    const s = ctx.state;
    const ar = s.activeRun;
    ctx.dirty = true;
    if (!ar || !ar.snapshotId) {
      st.journal(s, 'stop-ignored', { agent, reason: 'no-active-run' });
      return {};
    }
    // Событие относится к активному запуску, если совпал agent_id.
    // Пока привязки нет, запуск опознаётся по идентификатору снимка в отчёте.
    const mine = ar.agentId && agent ? ar.agentId === agent : !!mark && mark[1] === ar.snapshotId;
    if (!mine) {
      st.journal(s, 'stop-ignored', { agent, reason: 'foreign-agent', run: ar.id });
      return {};
    }
    const valid = !!mark && mark[1] === ar.snapshotId;
    if (!valid && !input.stop_hook_active) {
      // Одна попытка вернуть ревьюера к протоколу, прежде чем считать отчёт нарушением.
      st.journal(s, 'marker-retry', { run: ar.id });
      return { retry: ar.snapshotId };
    }
    const snap = s.snapshots[ar.snapshotId] || (s.snapshots[ar.snapshotId] = { generation: s.generation });
    if (valid && mark[2] === 'COMPLETE') {
      snap.status = 'complete';
    } else if (valid) {
      snap.status = 'incomplete';
      snap.reason = String(mark[3] || 'причина не указана').slice(0, 300);
    } else {
      snap.status = 'violation';
    }
    snap.finishedAt = new Date().toISOString();
    st.journal(s, 'review-' + snap.status, { run: ar.id, snapshot: ar.snapshotId });
    s.activeRun = null;
    return {};
  });

  if (result && result.retry) {
    io.emitJson({
      decision: 'block',
      reason:
        'sheriff: отчёт не закончен строкой протокола. Повтори итог отчёта и закончи его последней строкой, ровно одной из двух: ' +
        `«SHERIFF-REVIEW ${result.retry} COMPLETE» или «SHERIFF-REVIEW ${result.retry} INCOMPLETE <причина>».`,
    });
  }
});
