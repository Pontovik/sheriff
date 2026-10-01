'use strict';
// Запуск всех тестов одной командой на любой версии Node и в любой оболочке: node test/run.js
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const files = fs
  .readdirSync(__dirname)
  .filter((f) => f.endsWith('.test.js'))
  .sort()
  .map((f) => path.join(__dirname, f));
const r = spawnSync(process.execPath, ['--test', ...files], { stdio: 'inherit' });
process.exit(r.status === null ? 1 : r.status);
