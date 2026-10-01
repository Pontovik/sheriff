'use strict';
// Помощники тестов: временные репозитории и запуск хуков отдельными процессами
// с тем же входом, который им передаёт Claude Code.
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync, spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const REVIEWER = 'sheriff:reviewer';
const created = [];

function tmpdir(prefix) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  created.push(dir);
  return dir;
}

function cleanupAll() {
  for (const dir of created.splice(0)) {
    try {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
    } catch {
      // временная папка, не критично
    }
  }
}

function git(cwd, ...args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`);
  return r.stdout;
}

function gitRepo(opts) {
  const o = opts || {};
  const dir = tmpdir('sheriff-repo-');
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.email', 'test@example.com');
  git(dir, 'config', 'user.name', 'Test');
  git(dir, 'config', 'commit.gpgsign', 'false');
  git(dir, 'config', 'core.autocrlf', o.autocrlf ? 'true' : 'false');
  git(dir, 'config', 'core.safecrlf', 'false');
  return dir;
}

function write(dir, rel, content) {
  const abs = path.join(dir, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
}

function commitAll(dir, message) {
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', message || 'commit');
}

function parse(stdout) {
  const t = String(stdout || '').trim();
  if (!t.startsWith('{')) return null;
  try {
    return JSON.parse(t);
  } catch {
    return null;
  }
}

function hookArgs(name) {
  return [path.join(ROOT, 'hooks', name + '.js')];
}

class Session {
  constructor(cwd, opts) {
    const o = opts || {};
    this.cwd = cwd;
    this.data = o.data || tmpdir('sheriff-data-');
    this.sid = o.sid || 'sess-' + crypto.randomBytes(4).toString('hex');
    this.promptId = 'prompt-1';
    this.env = o.env || {};
    this.toolUse = 0;
  }

  environment(extra) {
    return Object.assign({}, process.env, { CLAUDE_PLUGIN_DATA: this.data, CLAUDE_PLUGIN_ROOT: ROOT }, this.env, extra || {});
  }

  hook(name, input, extraEnv) {
    const r = spawnSync(process.execPath, hookArgs(name), {
      input: JSON.stringify(Object.assign({ session_id: this.sid, cwd: this.cwd }, input)),
      encoding: 'utf8',
      env: this.environment(extraEnv),
    });
    return { code: r.status, stdout: r.stdout, stderr: r.stderr, json: parse(r.stdout) };
  }

  hookAsync(name, input) {
    return new Promise((resolve) => {
      const child = spawn(process.execPath, hookArgs(name), { env: this.environment() });
      let stdout = '';
      child.stdout.on('data', (d) => (stdout += d));
      child.on('close', (code) => resolve({ code, stdout, json: parse(stdout) }));
      child.stdin.end(JSON.stringify(Object.assign({ session_id: this.sid, cwd: this.cwd }, input)));
    });
  }

  toggle(args) {
    // 'off' и 'status' это отдельные команды, остальное идёт аргументами /sheriff:on.
    const a = args || '';
    const command = a === 'off' || a === 'status' ? a : 'on';
    const commandArgs = command === 'on' ? a : '';
    return this.hook('mode-toggle', {
      hook_event_name: 'UserPromptExpansion',
      expansion_type: 'slash_command',
      command_name: 'sheriff:' + command,
      command_args: commandArgs,
      command_source: 'plugin',
      prompt: ('/sheriff:' + command + ' ' + commandArgs).trim(),
    });
  }

  stop(extra, extraEnv) {
    return this.hook(
      'require-review',
      Object.assign({ hook_event_name: 'Stop', stop_hook_active: false, prompt_id: this.promptId }, extra),
      extraEnv
    );
  }

  blocked(extra) {
    const r = this.stop(extra);
    return !!r.json && r.json.decision === 'block';
  }

  newPrompt() {
    this.promptId = 'prompt-' + crypto.randomBytes(3).toString('hex');
  }

  reviewerInput() {
    this.toolUse += 1;
    return {
      hook_event_name: 'PreToolUse',
      tool_name: 'Agent',
      tool_use_id: 'toolu_' + this.toolUse,
      tool_input: { subagent_type: REVIEWER, description: 'review', prompt: 'Бриф: тестовая задача.' },
    };
  }

  callReviewer(toolInput) {
    const input = this.reviewerInput();
    Object.assign(input.tool_input, toolInput);
    const r = this.hook('review-snapshot', input);
    const call = describeCall(r);
    // Пропущенный вызов сам ничего не сообщает: снимок виден по активному запуску.
    const run = call.allowed && fs.existsSync(this.statePath()) ? this.state().activeRun : null;
    return Object.assign(r, call, { snapshotId: run ? run.snapshotId : null, toolUseId: input.tool_use_id });
  }

  // Старт субагента. context: данные ревью, которые хук передал в контекст субагента.
  bind(agentId) {
    const r = this.hook('review-bind', { hook_event_name: 'SubagentStart', agent_id: agentId, agent_type: REVIEWER });
    const out = r.json && r.json.hookSpecificOutput;
    return Object.assign(r, { context: out ? out.additionalContext : undefined });
  }

  done(agentId, message, extra) {
    return this.hook(
      'review-done',
      Object.assign(
        {
          hook_event_name: 'SubagentStop',
          stop_hook_active: false,
          agent_id: agentId,
          agent_type: REVIEWER,
          last_assistant_message: message,
        },
        extra
      )
    );
  }

  failed(toolUseId) {
    return this.hook('review-failed', {
      hook_event_name: 'PostToolUseFailure',
      tool_name: 'Agent',
      tool_use_id: toolUseId,
      tool_input: { subagent_type: REVIEWER, prompt: 'x' },
      error: 'boom',
    });
  }

  sessionStart(source) {
    return this.hook('session-start', { hook_event_name: 'SessionStart', source });
  }

  // Полный успешный цикл ревью: вызов, привязка, отчёт с маркером.
  review(outcome) {
    const call = this.callReviewer();
    if (!call.allowed) throw new Error('reviewer call denied: ' + call.reason);
    const agent = 'agent-' + crypto.randomBytes(3).toString('hex');
    this.bind(agent);
    const tail = outcome === 'INCOMPLETE' ? 'INCOMPLETE дифф не читается' : 'COMPLETE';
    this.done(agent, `замечаний нет\nSHERIFF-REVIEW ${call.snapshotId} ${tail}`);
    return call;
  }

  sessionDir() {
    return path.join(this.data, 'sessions', this.sid);
  }

  statePath() {
    return path.join(this.sessionDir(), 'state.json');
  }

  state() {
    return JSON.parse(fs.readFileSync(this.statePath(), 'utf8'));
  }

  patchState(fn) {
    const s = this.state();
    fn(s);
    fs.writeFileSync(this.statePath(), JSON.stringify(s));
  }

  baseIndex() {
    const s = this.state();
    return JSON.parse(fs.readFileSync(path.join(this.sessionDir(), s.base.dir, 'index.json'), 'utf8')).files;
  }

  diffOf(snapshotId) {
    return fs.readFileSync(path.join(this.sessionDir(), 'snapshots', snapshotId, 'diff.patch'), 'utf8');
  }
}

// Хук ревьюера не разрешает вызов явно и не меняет вход: только запрещает или молчит.
function describeCall(r) {
  const out = r.json && r.json.hookSpecificOutput;
  if (out && out.permissionDecision === 'deny') {
    return { allowed: false, denied: true, silent: false, reason: out.permissionDecisionReason };
  }
  return { allowed: true, denied: false, silent: String(r.stdout || '').trim() === '', reason: '' };
}

module.exports = { ROOT, REVIEWER, Session, tmpdir, cleanupAll, git, gitRepo, write, commitAll, describeCall };
