#!/usr/bin/env node
/**
 * CSV -> JSON для загрузки истории в базу площадки.
 *
 * Автор: Vitaliy Yugay · vamp.09.94@gmail.com · https://github.com/YugayV
 *
 * Специально сделано на общем модуле web/csv.js, а не отдельным разбором на
 * Python: правило «investing.com кладёт close вторым» должно жить в одном
 * месте, иначе дашборд, бэктест и площадка рано или поздно прочитают один
 * файл по-разному.
 *
 *   node tools/csv2json.mjs data/XAUUSD_M1.csv > candles.json
 */

import { readFileSync } from 'fs';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { parseCandles } = require('../web/csv.js');

const file = process.argv[2];
if (!file) {
  console.error('использование: node tools/csv2json.mjs <файл.csv>');
  process.exit(1);
}

const { candles, errors, meta } = parseCandles(readFileSync(file, 'utf8'));
if (!candles.length) {
  console.error('Не разобрано ни одной свечи.', errors.slice(0, 3));
  process.exit(1);
}

// сообщения парсера идут в stderr, чтобы не попасть в JSON на stdout
console.error(`Разобрано: ${candles.length}, пропущено: ${meta.bad}, ` +
  `колонки: ${meta.layout === 'header' ? 'по заголовку' : 'по порядку'}`);
if (errors.length) console.error('Замечания:', errors.slice(0, 3));

process.stdout.write(JSON.stringify(
  candles.map((k) => ({ ts: k.t, o: k.o, h: k.h, l: k.l, c: k.c, v: k.v }))));
