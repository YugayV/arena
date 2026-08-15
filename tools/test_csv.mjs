#!/usr/bin/env node
/**
 * Тесты разбора котировок из CSV.
 *
 * Автор: Vitaliy Yugay · vamp.09.94@gmail.com · https://github.com/YugayV
 *
 * Запуск: node tools/test_csv.mjs
 *
 * Главное здесь — выгрузка investing.com, у которой close стоит ВТОРЫМ,
 * до open: позиционный разбор молча построил бы несуществующий график.
 */

import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { parseCandles, toNum } = require('../web/csv.js');

let pass = 0, fail = 0;
const check = (name, got, want) => {
  const ok = String(got) === String(want);
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${name}: ${got}${ok ? '' : ` (ожидалось ${want})`}`);
  ok ? pass++ : fail++;
};
const iso = (t) => new Date(t).toISOString().replace('.000Z', 'Z');

/* ------------------------------------------------------------------ числа */
console.log('\n=== числа ===');
check('3,412.50', toNum('3,412.50'), 3412.5);
check('3.412,50', toNum('3.412,50'), 3412.5);
check('1,234,567.89', toNum('1,234,567.89'), 1234567.89);
check('1,5 (десятичная запятая)', toNum('1,5'), 1.5);
check('"2 412,50"', toNum('2 412,50'), 2412.5);
check('0.45%', toNum('0.45%'), 0.45);
check('прочерк', toNum('-'), NaN);

/* --------------------------------------------------- investing.com дневные */
console.log('\n=== investing.com, дневные (Price идёт ДО Open) ===');
const investing = `"Date","Price","Open","High","Low","Vol.","Change %"
"08/13/2026","3,412.50","3,400.10","3,425.80","3,396.00","150.25K","0.37%"
"08/12/2026","3,400.00","3,380.20","3,405.40","3,375.10","141.02K","0.58%"
"08/11/2026","3,380.30","3,390.00","3,392.70","3,362.40","162.88K","-0.29%"`;
const ri = parseCandles(investing);
console.log('       meta:', JSON.stringify(ri.meta));
check('свечей', ri.candles.length, 3);
check('порядок дат восстановлен', iso(ri.candles[0].t), '2026-08-11T00:00:00Z');
check('close первой свечи', ri.candles[0].c, 3380.3);
check('open первой свечи', ri.candles[0].o, 3390);
check('high', ri.candles[0].h, 3392.7);
check('low', ri.candles[0].l, 3362.4);
check('MM/DD распознан', ri.meta.dateOrder, 'mdy');
check('последняя свеча 13 августа', iso(ri.candles[2].t), '2026-08-13T00:00:00Z');

/* ------------------------------------- то же, но позиционным парсером — мусор */
console.log('\n=== контроль: что было бы без разбора шапки ===');
const p = '"08/13/2026","3,412.50","3,400.10","3,425.80","3,396.00"'.split(',');
console.log('       позиционно open стал бы', p[1], '— это на самом деле close');

/* --------------------------------------------- investing.com, русский, часовые */
console.log('\n=== investing.com, русская локаль, внутридневные ===');
const investingRu = `"Дата","Цена","Откр.","Макс.","Мин.","Объём","Изм. %"
"13.08.2026 12:00","3.412,50","3.400,10","3.425,80","3.396,00","-","0,37%"
"13.08.2026 08:00","3.400,00","3.380,20","3.405,40","3.375,10","-","0,58%"`;
const rru = parseCandles(investingRu);
console.log('       meta:', JSON.stringify(rru.meta));
check('свечей', rru.candles.length, 2);
check('европейские числа', rru.candles[0].c, 3400);
check('время сохранено', iso(rru.candles[1].t), '2026-08-13T12:00:00Z');
check('DD.MM распознан', rru.meta.dateOrder, 'dmy');

/* ---------------------------------------------------------------- TradingView */
console.log('\n=== TradingView ===');
const tv = `time,open,high,low,close,Volume
2026-08-13T04:00:00Z,3400.10,3425.80,3396.00,3412.50,1502
2026-08-13T08:00:00Z,3412.50,3430.00,3410.00,3428.00,1310`;
const rtv = parseCandles(tv);
check('свечей', rtv.candles.length, 2);
check('close', rtv.candles[0].c, 3412.5);
check('время', iso(rtv.candles[1].t), '2026-08-13T08:00:00Z');

/* ---------------------------------------------------------------- MetaTrader 5 */
console.log('\n=== MetaTrader 5 ===');
const mt5 = `<DATE>\t<TIME>\t<OPEN>\t<HIGH>\t<LOW>\t<CLOSE>\t<TICKVOL>\t<VOL>\t<SPREAD>
2026.08.13\t04:00:00\t3400.10\t3425.80\t3396.00\t3412.50\t1502\t0\t30
2026.08.13\t05:00:00\t3412.50\t3430.00\t3410.00\t3428.00\t1310\t0\t28`;
const rmt = parseCandles(mt5);
console.log('       meta:', JSON.stringify(rmt.meta));
check('свечей', rmt.candles.length, 2);
check('дата+время из разных колонок', iso(rmt.candles[0].t), '2026-08-13T04:00:00Z');
check('close', rmt.candles[0].c, 3412.5);

/* ------------------------------------------------------------- без заголовка */
console.log('\n=== без заголовка (старый формат дашборда) ===');
const plain = `2026-07-28 00:00,118400,119250,117980,118910
2026-07-28 04:00,118910,119880,118600,119540`;
const rp = parseCandles(plain);
check('свечей', rp.candles.length, 2);
check('позиционный режим', rp.meta.layout, 'positional');
check('open', rp.candles[0].o, 118400);
check('close', rp.candles[1].c, 119540);

/* ------------------------------------------------------------- текстовый месяц */
console.log('\n=== текстовый месяц ===');
const named = `Date,Open,High,Low,Close
"Aug 13, 2026",3400.10,3425.80,3396.00,3412.50
"Aug 12, 2026",3380.20,3405.40,3375.10,3400.00`;
const rn = parseCandles(named);
check('свечей', rn.candles.length, 2);
check('12 августа первым', iso(rn.candles[0].t), '2026-08-12T00:00:00Z');

/* --------------------------------------------------------------- двусмысленность */
console.log('\n=== неразличимые день/месяц ===');
const amb = `"Date","Price","Open","High","Low"
"05/08/2026","3412.50","3400.10","3425.80","3396.00"
"04/08/2026","3400.00","3380.20","3405.40","3375.10"`;
const ra = parseCandles(amb);
check('порядок помечен как ambiguous', ra.meta.dateOrder, 'ambiguous');
check('предупреждение выдано', ra.errors.some((e) => /неразличимы/.test(e)), true);

/* ------------------------------------------------------------------- мусор */
console.log('\n=== защита ===');
check('пусто', parseCandles('').candles.length, 0);
check('битая дата не роняет разбор', parseCandles(
  'time,open,high,low,close\nне-дата,1,2,0.5,1.5\n2026-08-13T04:00:00Z,1,2,0.5,1.5'
).candles.length, 1);
check('31 февраля отбраковано', parseCandles(
  'time,open,high,low,close\n2026-02-31T00:00:00Z,1,2,0.5,1.5'
).candles.length, 0);

console.log(`\nитого: ${pass} ok, ${fail} fail`);
process.exit(fail ? 1 : 0);
