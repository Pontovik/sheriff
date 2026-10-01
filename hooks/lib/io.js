'use strict';
// Ввод и вывод хука: чтение JSON со stdin, ответ в stdout, отладочный журнал.
const fs = require('fs');
const os = require('os');
const path = require('path');

const REVIEWER = 'sheriff:reviewer';

function dataDir() {
  return process.env.CLAUDE_PLUGIN_DATA || path.join(os.homedir(), '.claude', 'sheriff-data');
}

function pluginRoot() {
  return process.env.CLAUDE_PLUGIN_ROOT || path.resolve(__dirname, '..', '..');
}

function readInput() {
  let raw = '';
  try {
    raw = fs.readFileSync(0, 'utf8');
  } catch {
    return {};
  }
  if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1);
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

// SHERIFF_DEBUG=1 пишет вход и выход каждого хука в debug.jsonl. Нужен для пробы платформы.
function debug(kind, payload) {
  if (!process.env.SHERIFF_DEBUG) return;
  try {
    const dir = dataDir();
    fs.mkdirSync(dir, { recursive: true });
    const line = JSON.stringify({ t: new Date().toISOString(), kind, payload }) + '\n';
    fs.appendFileSync(path.join(dir, 'debug.jsonl'), line);
  } catch {
    // отладка не должна ломать хук
  }
}

function emitJson(obj) {
  debug('output', obj);
  process.stdout.write(JSON.stringify(obj));
}

function emitText(text) {
  debug('output-text', text);
  process.stdout.write(text);
}

function warn(message) {
  emitJson({ systemMessage: 'sheriff: ' + message });
}

// Обёртка хука. Внутренняя ошибка не должна останавливать работу пользователя:
// по умолчанию хук предупреждает и пропускает. onError позволяет хуку закрыться иначе.
function run(name, handler, onError) {
  let input = {};
  try {
    input = readInput();
    debug(name, input);
    handler(input);
  } catch (err) {
    debug(name + ':error', { message: String(err && err.message), stack: String(err && err.stack) });
    try {
      if (onError) onError(err, input);
      else warn(`внутренняя ошибка хука ${name}: ${err && err.message}. Хук пропущен.`);
    } catch {
      // последняя линия обороны: молча выходим с нулём
    }
  }
}

function isReviewerCall(input) {
  const ti = input && input.tool_input;
  return !!ti && ti.subagent_type === REVIEWER;
}

module.exports = { REVIEWER, dataDir, pluginRoot, readInput, debug, emitJson, emitText, warn, run, isReviewerCall };
