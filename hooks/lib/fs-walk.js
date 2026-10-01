'use strict';
// Обход рабочей папки для режима вне git: без символических ссылок и исключённых каталогов.
const fs = require('fs');
const path = require('path');

// Возвращает пути файлов относительно root, с разделителем '/'.
function walk(root, excludeDirSet) {
  const out = [];
  const stack = [''];
  while (stack.length) {
    const relDir = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(path.join(root, relDir), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (e.isSymbolicLink()) continue;
      const rel = relDir ? relDir + '/' + e.name : e.name;
      if (e.isDirectory()) {
        if (!excludeDirSet.has(e.name.toLowerCase())) stack.push(rel);
      } else if (e.isFile()) {
        out.push(rel);
      }
    }
  }
  return out;
}

module.exports = { walk };
