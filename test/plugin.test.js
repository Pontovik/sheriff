'use strict';
// Целостность самого плагина: манифесты, события хуков, тексты ядра и обёрток.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { ROOT } = require('./helpers');

const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const json = (rel) => JSON.parse(read(rel));

function frontmatter(rel) {
  const m = /^---\n([\s\S]*?)\n---\n/.exec(read(rel));
  assert.ok(m, `${rel}: нет frontmatter`);
  const out = {};
  for (const line of m[1].split('\n')) {
    const i = line.indexOf(':');
    if (i > 0) out[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return out;
}

test('манифесты: имя плагина совпадает с записью marketplace', () => {
  const plugin = json('.claude-plugin/plugin.json');
  const market = json('.claude-plugin/marketplace.json');
  assert.strictEqual(plugin.name, 'sheriff');
  assert.strictEqual(market.plugins.length, 1);
  assert.strictEqual(market.plugins[0].name, plugin.name);
});

test('hooks.json: все события плагина на месте, скрипты существуют, таймауты заданы', () => {
  const hooks = json('hooks/hooks.json').hooks;
  const expected = {
    SessionStart: 30,
    UserPromptExpansion: 120,
    PreToolUse: 120,
    SubagentStart: 30,
    SubagentStop: 30,
    PostToolUseFailure: 30,
    Stop: 60,
  };
  assert.deepStrictEqual(Object.keys(hooks).sort(), Object.keys(expected).sort());
  for (const [event, timeout] of Object.entries(expected)) {
    for (const group of hooks[event]) {
      for (const hook of group.hooks) {
        assert.strictEqual(hook.type, 'command');
        assert.strictEqual(hook.command, 'node');
        assert.strictEqual(hook.timeout, timeout, event);
        const script = hook.args[0].replace('${CLAUDE_PLUGIN_ROOT}', ROOT);
        assert.ok(fs.existsSync(script), `${event}: нет файла ${hook.args[0]}`);
      }
    }
  }
  assert.strictEqual(hooks.UserPromptExpansion[0].matcher, '^sheriff:(on|off|status)$');
  assert.strictEqual(hooks.SubagentStart[0].matcher, '^sheriff:reviewer$');
  assert.strictEqual(hooks.SubagentStop[0].matcher, '^sheriff:reviewer$');
});

test('принципы: до 100 строк и в пределах лимита вывода хука', () => {
  const text = read('core/principles.md');
  assert.ok(text.split('\n').length <= 100, 'принципы короткие: до 100 строк');
  assert.ok(text.length < 9000, 'вывод SessionStart ограничен 10 000 символов, нужен запас на напоминание');
  for (const heading of ['Уровни и порядок конфликтов', 'Остановка', 'Обсуждение', 'Тесты', 'Сборка и прогон']) {
    assert.ok(text.includes('## ' + heading), heading);
  }
});

test('рубрика: уровни, тесты, раздел .NET, строка протокола', () => {
  const text = read('core/review-rubric.md');
  for (const part of ['Уровень 1', 'Уровень 2', 'Уровень 3', 'Уровень 4', 'Уровень 5', '## Тесты', '## Раздел для .NET']) {
    assert.ok(text.includes(part), part);
  }
  assert.ok(text.includes('SHERIFF-REVIEW <идентификатор снимка> COMPLETE'));
});

test('скиллы on, off, status: агент не может вызвать их сам', () => {
  for (const name of ['on', 'off', 'status']) {
    const file = `skills/${name}/SKILL.md`;
    const fm = frontmatter(file);
    assert.strictEqual(fm.name, name);
    assert.strictEqual(fm['disable-model-invocation'], 'true', name);
    assert.ok(read(file).includes('SHERIFF-MODE'), name);
  }
});

test('скилл debate: агент может вызвать его по форме запроса', () => {
  const fm = frontmatter('skills/debate/SKILL.md');
  assert.strictEqual(fm.name, 'debate');
  assert.strictEqual(fm['disable-model-invocation'], undefined);
  assert.match(fm.description, /как лучше/);
});

test('ревьюер: только инструменты чтения', () => {
  const fm = frontmatter('agents/reviewer.md');
  assert.strictEqual(fm.name, 'reviewer');
  assert.deepStrictEqual(fm.tools.split(',').map((t) => t.trim()).sort(), ['Glob', 'Grep', 'Read']);
});

test('каталог плагинов: лицензия и иконка по его требованиям', () => {
  assert.strictEqual(json('.claude-plugin/plugin.json').license, 'MIT');
  assert.match(read('LICENSE'), /^MIT License/);
  const icon = fs.readFileSync(path.join(ROOT, '.claude-plugin', 'icon.png'));
  assert.ok(icon.subarray(1, 4).toString('ascii') === 'PNG', 'иконка в PNG');
  const width = icon.readUInt32BE(16);
  const height = icon.readUInt32BE(20);
  assert.strictEqual(width, height, 'иконка квадратная');
  assert.ok(width >= 512 && width <= 2048, `сторона ${width}: нужно от 512 до 2048`);
  assert.ok(icon.length < 2 * 1024 * 1024, 'иконка меньше 2 МБ');
});

test('каталог плагинов: хуки не разрешают вызовы и не меняют вход инструмента', () => {
  for (const file of fs.readdirSync(path.join(ROOT, 'hooks')).filter((f) => f.endsWith('.js'))) {
    const text = read('hooks/' + file);
    assert.doesNotMatch(text, /permissionDecision:\s*'(allow|ask)'/, file);
    assert.doesNotMatch(text, /updatedInput/, file);
  }
});

test('зависимостей npm нет', () => {
  assert.strictEqual(fs.existsSync(path.join(ROOT, 'package.json')), false);
  assert.strictEqual(fs.existsSync(path.join(ROOT, 'node_modules')), false);
});
