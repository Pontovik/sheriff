'use strict';
// Настройки: значения по умолчанию плюс .sheriff.json из корня проекта.
// Настройки читаются при включении режима и смене базы и замораживаются в состоянии сессии:
// правка .sheriff.json посреди сессии не меняет правила до следующей команды /sheriff:on.
const fs = require('fs');
const path = require('path');

const DEFAULTS_FILE = path.resolve(__dirname, '..', 'default-paths.json');

const NUMERIC = {
  reviewTimeoutMinutes: 30,
  unboundRunSeconds: 15,
  lockStaleSeconds: 60,
  retentionDays: 14,
  maxFileBytes: 2 * 1024 * 1024,
  maxFileDiffBytes: 100 * 1024,
  maxPromptDiffBytes: 200 * 1024,
  noGitLimitMB: 50,
};
const LISTS = ['ignore', 'include', 'excludeDirs'];

function globToRegex(glob) {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        if (glob[i + 2] === '/') {
          re += '(?:.*/)?';
          i += 2;
        } else {
          re += '.*';
          i += 1;
        }
      } else {
        re += '[^/]*';
      }
    } else if (c === '?') {
      re += '[^/]';
    } else {
      re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp('^' + re + '$', 'i');
}

// Шаблон без '/' сравнивается с именем файла на любой глубине.
// Шаблон с '/' сравнивается с путём от корня. Ведущий '/' привязывает имя к корню.
function compile(patterns) {
  return patterns.map((p) => {
    let norm = String(p).replace(/\\/g, '/').replace(/^\.\//, '');
    const rooted = norm.startsWith('/');
    if (rooted) norm = norm.slice(1);
    return { regex: globToRegex(norm), byName: !rooted && !norm.includes('/') };
  });
}

function matches(compiled, rel) {
  const name = rel.slice(rel.lastIndexOf('/') + 1);
  return compiled.some((m) => m.regex.test(m.byName ? name : rel));
}

function defaults() {
  const d = JSON.parse(fs.readFileSync(DEFAULTS_FILE, 'utf8'));
  return Object.assign({ ignore: d.ignore || [], include: [], excludeDirs: d.excludeDirs || [] }, NUMERIC);
}

// Только данные, без функций: в таком виде настройки хранятся в состоянии.
function freeze(config) {
  const out = {};
  for (const key of LISTS) out[key] = config[key].slice();
  for (const key of Object.keys(NUMERIC)) out[key] = config[key];
  return out;
}

function hydrate(plain) {
  const config = Object.assign(defaults(), plain || {});
  const ignore = compile(config.ignore);
  const include = compile(config.include);
  config.isAffecting = (rel) => matches(include, rel) || !matches(ignore, rel);
  config.excludeDirSet = new Set(config.excludeDirs.map((d) => String(d).toLowerCase()));
  return config;
}

// Возвращает { config, warnings }. Неизвестное поле: предупреждение, поле не применяется.
// Нечитаемый файл: предупреждение, все значения по умолчанию.
function load(root) {
  const config = defaults();
  const warnings = [];
  const file = path.join(root, '.sheriff.json');
  let raw = null;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err.code !== 'ENOENT') warnings.push(`.sheriff.json не читается (${err.code}), взяты значения по умолчанию`);
  }
  if (raw !== null) {
    let user = null;
    let parsed = false;
    try {
      user = JSON.parse(raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw);
      parsed = true;
    } catch {
      warnings.push('.sheriff.json не разбирается как JSON, взяты значения по умолчанию');
    }
    if (parsed && user && typeof user === 'object' && !Array.isArray(user)) {
      for (const [key, value] of Object.entries(user)) {
        if (LISTS.includes(key)) {
          if (Array.isArray(value) && value.every((v) => typeof v === 'string')) {
            config[key] = config[key].concat(value);
          } else {
            warnings.push(`.sheriff.json: поле ${key} должно быть списком строк, взято значение по умолчанию`);
          }
        } else if (key in NUMERIC) {
          if (typeof value === 'number' && isFinite(value) && value > 0) config[key] = value;
          else warnings.push(`.sheriff.json: поле ${key} должно быть положительным числом, взято значение по умолчанию`);
        } else {
          warnings.push(`.sheriff.json: неизвестное поле ${key}, оно не применяется`);
        }
      }
    } else if (parsed) {
      warnings.push('.sheriff.json должен содержать объект, взяты значения по умолчанию');
    }
  }
  return { config: hydrate(freeze(config)), warnings };
}

// Настройки сессии: замороженные при включении. Состояние старого формата читает файл.
function fromState(state) {
  if (state && state.config) return hydrate(state.config);
  return load(state.base.root).config;
}

module.exports = { load, freeze, hydrate, fromState, globToRegex };
