'use strict';
// Строка статуса режима шерифа и напоминание о его правилах.

function statusLine(state, offReason) {
  if (!state || state.mode !== 'on' || !state.base) {
    return `SHERIFF-MODE off reason=${offReason || 'режим не включён'}`;
  }
  const b = state.base;
  const baseText = b.kind !== 'git' ? 'no-git' : b.unborn ? 'empty-tree' : String(b.commit).slice(0, 12);
  const mode = b.kind !== 'git' ? 'no-git' : b.fromHead ? 'from-head' : 'normal';
  return `SHERIFF-MODE on generation=${state.generation} base=${baseText} mode=${mode}`;
}

const REMINDER = [
  'Режим шерифа включён, его правила действуют до команды /sheriff:off.',
  'До кода: при новом классе, новой зависимости между модулями или новой таблице найди похожее в репозитории и напиши абзац «что нашёл, что выбрал, почему». Новое поведение сдаётся с тестами.',
  'Перед завершением хода с правками: запусти субагента sheriff:reviewer с брифом, почини все замечания сразу, запусти ревью повторно.',
].join('\n');

module.exports = { statusLine, REMINDER };
