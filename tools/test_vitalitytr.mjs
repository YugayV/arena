#!/usr/bin/env node
/**
 * Тесты движка структуры VitalityTr SM PRO.
 *
 * Автор: Vitaliy Yugay · vamp.09.94@gmail.com · https://github.com/YugayV
 *
 * Запуск: node tools/test_vitalitytr.mjs
 */

import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { runVitalityTr } = require('../web/vitalitytr.js');

const H4 = 4 * 3600e3;
const T0 = Date.UTC(2026, 5, 1);
const bar = (i, o, h, l, c) => ({ t: T0 + i * H4, o, h, l, c });
const OPTS = { fib50: 50, fib618: 50 };
const ev = (r) => r.events.map((e) => `${e.type}@${e.price}`).join(' | ');

let pass = 0, fail = 0;
const check = (name, got, want) => {
  const ok = String(got) === String(want);
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${name}: ${got}${ok ? '' : ` (ожидалось ${want})`}`);
  ok ? pass++ : fail++;
};

/* ------------------------------------------------------------------------- */
console.log('\n=== 1. Коррекция координат старта ===');
// Якорь SH ставим на свечу 0 (high 120), но между якорями есть свеча с high 140.
// Якорь SL — свеча 4 (low 100), а между ними есть свеча с low 80.
// Обе стороны должны исправиться от ОРИГИНАЛЬНЫХ значений.
const corr = [
  bar(0, 115, 120, 112, 118),
  bar(1, 118, 140, 116, 130),   // максимум выше якоря SH
  bar(2, 130, 132, 80, 90),     // минимум ниже якоря SL
  bar(3, 90, 95, 88, 92),
  bar(4, 92, 99, 100, 96),      // якорь SL: low 100 (намеренно выше 80)
];
const rc = runVitalityTr(corr, 0, 4, OPTS);
check('SH исправлен на 140', rc.manualSH, 140);
check('SL исправлен на 80', rc.manualSL, 80);
check('бар SH', rc.manualSHBar, 1);
check('бар SL', rc.manualSLBar, 2);
console.log('       события:', ev(rc));

/* ------------------------------------------------------------------------- */
console.log('\n=== 2. Коррекция не срабатывает, когда не нужна ===');
const noCorr = [
  bar(0, 115, 120, 112, 118),   // SH = 120
  bar(1, 118, 119, 114, 116),
  bar(2, 116, 118, 100, 105),   // SL = 100
];
const rn = runVitalityTr(noCorr, 0, 2, OPTS);
check('SH не тронут', rn.manualSH, 120);
check('SL не тронут', rn.manualSL, 100);

/* ------------------------------------------------------------------------- */
console.log('\n=== 3. Нисходящий путь ===');
// SH=0 (high 120), SL=1 (low 100) -> FIB1 = 110.
// ВАЖНО: свеча якоря SL сама касается FIB1 сверху (её close[1] = закрытие
// свечи SH, оно выше FIB1, а её low = manualSL, он ниже). Поэтому нисходящий
// путь стартует сразу на якоре SL, кандидатом становится сам manualSL,
// и на этой же свече STATE 1 видит low <= manualSL и уходит в STATE 2.
const down = [
  bar(0, 115, 120, 112, 118),
  bar(1, 118, 119, 100, 112),
  bar(2, 112, 116, 111, 115),
  bar(3, 115, 116, 108, 109),   // касание FIB1 сверху -> STATE 1, cand=108
  bar(4, 109, 110, 105, 106),   // cand=105
  bar(5, 106, 121, 106, 120),   // бычья, close>FIB1, high>=manualSH -> CSL=105
];
const rd = runVitalityTr(down, 0, 1, OPTS);
check('confirmedCSL = сам якорь SL', rd.confirmedCSL, 100);
check('состояние INITIAL', rd.firstState, 4);
check('замок ещё не защёлкнут', rd.initialProcessLocked, false);
console.log('       события:', ev(rd));

/* ------------------------------------------------------------------------- */
console.log('\n=== 4. Полный цикл INITIAL -> BEARISH (STATE 3) ===');
// Продолжаем сценарий 3: после CSL цена не пробивает manualSH, разворачивается
// вниз до FIB1 и ломает CSL -> максимум становится CSH, направление BEARISH.
const bearish = [
  ...down,
  bar(6, 120, 122, 118, 119),
  bar(7, 119, 120, 108, 109),   // медвежья, откат ниже FIB1
  bar(8, 109, 110, 99, 100),    // пробой CSL -> максимум становится CSH
];
const rb = runVitalityTr(bearish, 0, 1, OPTS);
console.log('       состояние:', rb.firstState, '| направление:', rb.direction);
console.log('       события:', ev(rb));

/* ------------------------------------------------------------------------- */
console.log('\n=== 5. Восходящий путь: якорь SH позже якоря SL ===');
// Чтобы стартовал ВОСХОДЯЩИЙ путь, к FIB1 надо подойти снизу. Это возможно,
// когда якорь SH стоит позже якоря SL: на свече SH предыдущее закрытие ниже
// FIB1, а её high = manualSH выше.
const up = [
  bar(0, 105, 108, 100, 102),   // якорь SL: low 100
  bar(1, 102, 106, 101, 104),   // закрытие 104 ниже будущего FIB1 110
  bar(2, 104, 120, 103, 118),   // якорь SH: high 120 -> FIB1 = 110, подход снизу
  bar(3, 118, 119, 112, 114),
  bar(4, 114, 115, 99, 100),    // медвежья, low<=FIB1 и low<=manualSL -> CSH
];
const ru = runVitalityTr(up, 2, 0, OPTS);
console.log('       состояние:', ru.firstState, '| CSH:', ru.confirmedCSH,
  '| направление:', ru.direction);
check('восходящий путь дошёл до CSH', ru.confirmedCSH !== null, true);
console.log('       события:', ev(ru));

/* ------------------------------------------------------------------------- */
console.log('\n=== 6. Мастер не стартует до защёлкивания замка ===');
// В сценарии 3 замок не защёлкнут -> bullState/bearState обязаны остаться 0.
check('bullState', rd.bullState, 0);
check('bearState', rd.bearState, 0);
check('направление не задано', rd.direction, 0);

/* ------------------------------------------------------------------------- */
console.log('\n=== 7. Защита от мусора ===');
check('пустой массив', runVitalityTr([], 0, 1), null);
check('нет якорей', runVitalityTr(down, null, 1, OPTS), null);
check('якорь вне диапазона', runVitalityTr(down, 99, 1, OPTS), null);

console.log(`\nитого: ${pass} ok, ${fail} fail`);
process.exit(fail ? 1 : 0);
