#!/usr/bin/env node
/**
 * Бэктест стратегии Swing Zone на движке VitalityTr SM PRO.
 *
 * Запуск:
 *   node tools/backtest.mjs data/XAUUSD_H1.csv
 *   node tools/backtest.mjs data/XAUUSD_H1.csv --fib1 51 --fib2 50 --spread 0.30
 *   node tools/backtest.mjs --selftest         # прогон на случайном блуждании
 *
 * Что считается сделкой. Сигнал — ровно тот же, что шлёт вебхук в TradingView:
 * движок сдвинул уровень (сменился currentSH или currentSL), направление
 * структуры определено. От новой зоны строится план: вход лимиткой на откате,
 * стоп за противоположный край с буфером, цель — экстремум зоны.
 *
 * Правила симуляции выбраны в пользу пессимизма — оптимистичный бэктест
 * бесполезен:
 *   - если внутри свечи достижимы и стоп, и цель, считаем, что сработал стоп;
 *   - стоп проверяется уже на свече исполнения;
 *   - спред вычитается из результата каждой сделки целиком;
 *   - пока сделка открыта, новые сигналы пропускаются, как это делает советник;
 *   - неисполненная за expiryBars свечей лимитка снимается.
 */

import { readFileSync } from 'fs';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { runVitalityTr } = require('../web/vitalitytr.js');

/* --------------------------------------------------------------- аргументы */

const argv = process.argv.slice(2);
const flag = (name, dflt) => {
  const i = argv.indexOf('--' + name);
  return i >= 0 && argv[i + 1] !== undefined ? Number(argv[i + 1]) : dflt;
};
const has = (name) => argv.includes('--' + name);

const CFG = {
  fib1: flag('fib1', 51),           // FIB 1, % — уровень подтверждения структуры
  fib2: flag('fib2', 50),           // FIB 2, % — подтверждение экстремума
  entryFib: flag('entry', 0.705),   // вход: доля отката от экстремума
  bufferPct: flag('buffer', 5),     // буфер стопа, % высоты зоны
  expiryBars: flag('expiry', 8),    // сколько свечей ждём исполнения лимитки
  maxHoldBars: flag('hold', 200),   // предохранитель от вечных сделок
  spread: flag('spread', 0.30),     // издержки на сделку в цене инструмента
  anchorWindow: flag('anchor', 100), // в каких первых свечах ищем якоря
  target: has('tp2') ? 'tp2' : 'tp1',
};

/* ------------------------------------------------------------------ данные */

/** Разбор CSV: те же форматы, что понимает дашборд. */
function parseCsv(text) {
  const out = [];
  const skipped = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || /^[a-zA-Zа-яА-Я"<]/.test(line)) continue;   // заголовок
    const p = line.split(/[,;\t]+|\s{2,}/).map((x) => x.trim()).filter(Boolean);
    if (p.length < 5) { skipped.push(line); continue; }

    // дата может быть одним полем или разбита на дату и время
    let t, rest;
    const asNum = Number(p[0]);
    if (p.length >= 6 && /[.\-/]/.test(p[0]) && /^\d{1,2}:\d{2}/.test(p[1])) {
      t = Date.parse(p[0].replace(/\./g, '-') + 'T' + p[1] + 'Z');
      rest = p.slice(2);
    } else if (Number.isFinite(asNum) && asNum > 1e8) {
      t = asNum > 1e11 ? asNum : asNum * 1000;
      rest = p.slice(1);
    } else if (/T\d{2}:/.test(p[0])) {
      // уже ISO — трогать нельзя: точки внутри «.000Z» не разделители даты
      t = Date.parse(p[0]);
      rest = p.slice(1);
    } else {
      t = Date.parse(p[0].replace(/\./g, '-').replace(' ', 'T') + 'Z');
      rest = p.slice(1);
    }

    const [o, h, l, c] = rest.slice(0, 4).map(Number);
    if (!Number.isFinite(t) || ![o, h, l, c].every(Number.isFinite)) {
      skipped.push(line); continue;
    }
    out.push({ t, o, h, l, c });
  }
  out.sort((a, b) => a.t - b.t);
  return { candles: out, skipped };
}

/** Случайное блуждание: данные, в которых преимущества нет по построению. */
function randomWalk(n, seed, drift = 0, start = 2400, vol = 4) {
  let s = seed >>> 0;
  const rnd = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
  const out = [];
  let price = start;
  for (let i = 0; i < n; i++) {
    const o = price;
    const c = o + (rnd() - 0.5 + drift) * vol * 2;
    out.push({
      t: Date.UTC(2020, 0, 1) + i * 3600e3,
      o, c,
      h: Math.max(o, c) + rnd() * vol,
      l: Math.min(o, c) - rnd() * vol,
    });
    price = c;
  }
  return out;
}

/* ------------------------------------------------------------------ якоря */

/**
 * Детерминированная замена ручному выбору якорей: в первом окне берём
 * самую высокую и самую низкую свечу. Это НЕ то же самое, что делает человек,
 * и результат от выбора якорей зависит — об этом сказано в отчёте.
 */
function pickAnchors(c, window) {
  const n = Math.min(window, c.length);
  let hi = 0, lo = 0;
  for (let i = 1; i < n; i++) {
    if (c[i].h > c[hi].h) hi = i;
    if (c[i].l < c[lo].l) lo = i;
  }
  return { shIdx: hi, slIdx: lo };
}

/* -------------------------------------------------------------- симуляция */

function backtest(c, cfg) {
  const { shIdx, slIdx } = pickAnchors(c, cfg.anchorWindow);
  const st = runVitalityTr(c, shIdx, slIdx, { fib50: cfg.fib1, fib618: cfg.fib2, trace: true });
  if (!st || !st.trace) return null;

  const trades = [];
  let open = null;
  let pending = null;
  let prevSH = null, prevSL = null, prevDir = 0;

  for (let i = 0; i < st.trace.length; i++) {
    const tr = st.trace[i];
    const bar = c[i];

    /* --- 1. ведём открытую сделку ------------------------------------- */
    if (open) {
      const dir = open.side === 'buy' ? 1 : -1;
      const hitStop = dir > 0 ? bar.l <= open.stop : bar.h >= open.stop;
      const hitTp = dir > 0 ? bar.h >= open.target : bar.l <= open.target;

      // внутри свечи порядок событий неизвестен — считаем худший
      if (hitStop) open.exit = { price: open.stop, bar: i, why: 'stop' };
      else if (hitTp) open.exit = { price: open.target, bar: i, why: 'target' };
      else if (i - open.fillBar >= cfg.maxHoldBars)
        open.exit = { price: bar.c, bar: i, why: 'timeout' };

      if (open.exit) {
        const gross = (open.exit.price - open.entry) * dir;
        open.r = (gross - cfg.spread) / open.risk;
        open.bars = i - open.fillBar;
        trades.push(open);
        open = null;
      }
    }

    /* --- 2. ждём исполнения лимитки ----------------------------------- */
    if (!open && pending) {
      if (i > pending.signalBar && bar.l <= pending.entry && bar.h >= pending.entry) {
        open = { ...pending, fillBar: i };
        pending = null;

        // стоп может сработать на той же свече, где произошло исполнение
        const dir = open.side === 'buy' ? 1 : -1;
        const hitStop = dir > 0 ? bar.l <= open.stop : bar.h >= open.stop;
        if (hitStop) {
          open.exit = { price: open.stop, bar: i, why: 'stop' };
          open.r = ((open.stop - open.entry) * dir - cfg.spread) / open.risk;
          open.bars = 0;
          trades.push(open);
          open = null;
        }
      } else if (i - pending.signalBar >= cfg.expiryBars) {
        trades.push({ ...pending, expired: true, r: 0 });
        pending = null;
      }
    }

    /* --- 3. новый сигнал: движок сдвинул уровень ---------------------- */
    const moved = prevSH !== null &&
      (tr.sh !== prevSH || tr.sl !== prevSL || tr.dir !== prevDir);
    prevSH = tr.sh; prevSL = tr.sl; prevDir = tr.dir;

    if (!moved || open || tr.dir === 0) continue;
    if (!Number.isFinite(tr.sh) || !Number.isFinite(tr.sl) || tr.sh <= tr.sl) continue;

    const R = tr.sh - tr.sl;
    const long = tr.dir === 1;
    const entry = long ? tr.sh - cfg.entryFib * R : tr.sl + cfg.entryFib * R;
    const stop = long ? tr.sl - (cfg.bufferPct / 100) * R : tr.sh + (cfg.bufferPct / 100) * R;
    const tp1 = long ? tr.sh : tr.sl;
    const tp2 = long ? tr.sh + 0.272 * R : tr.sl - 0.272 * R;
    const risk = Math.abs(entry - stop);
    if (!(risk > 0)) continue;

    pending = {
      signalBar: i, t: bar.t, side: long ? 'buy' : 'sell',
      zoneHigh: tr.sh, zoneLow: tr.sl,
      entry, stop, risk,
      target: cfg.target === 'tp2' ? tp2 : tp1,
    };
  }

  return { trades, state: st, anchors: { shIdx, slIdx } };
}

/* ---------------------------------------------------------------- метрики */

function stats(trades) {
  const filled = trades.filter((t) => !t.expired && t.exit);
  const expired = trades.filter((t) => t.expired).length;
  const wins = filled.filter((t) => t.r > 0);
  const losses = filled.filter((t) => t.r <= 0);

  const sum = (a) => a.reduce((x, y) => x + y, 0);
  const totalR = sum(filled.map((t) => t.r));
  const grossWin = sum(wins.map((t) => t.r));
  const grossLoss = -sum(losses.map((t) => t.r));

  // просадка по кривой в R
  let peak = 0, eq = 0, maxDD = 0;
  for (const t of filled) {
    eq += t.r;
    peak = Math.max(peak, eq);
    maxDD = Math.max(maxDD, peak - eq);
  }

  // самая длинная серия убытков
  let streak = 0, worstStreak = 0;
  for (const t of filled) {
    if (t.r <= 0) { streak++; worstStreak = Math.max(worstStreak, streak); }
    else streak = 0;
  }

  const n = filled.length;
  return {
    signals: trades.length, filled: n, expired,
    fillRate: trades.length ? n / trades.length : 0,
    winRate: n ? wins.length / n : 0,
    expectancy: n ? totalR / n : 0,
    totalR,
    profitFactor: grossLoss > 0 ? grossWin / grossLoss : Infinity,
    maxDD, worstStreak,
    avgBars: n ? sum(filled.map((t) => t.bars || 0)) / n : 0,
    byWhy: filled.reduce((a, t) => ({ ...a, [t.exit.why]: (a[t.exit.why] || 0) + 1 }), {}),
  };
}

function report(title, s, extra = '') {
  const pct = (x) => (x * 100).toFixed(1) + '%';
  console.log(`\n=== ${title} ===${extra}`);
  console.log(`сигналов                ${s.signals}`);
  console.log(`исполнено / не дождались ${s.filled} / ${s.expired}  (доля исполнения ${pct(s.fillRate)})`);
  if (!s.filled) { console.log('сделок нет — считать нечего'); return; }
  console.log(`винрейт                 ${pct(s.winRate)}`);
  console.log(`ожидание на сделку      ${s.expectancy >= 0 ? '+' : ''}${s.expectancy.toFixed(3)} R`);
  console.log(`итого                   ${s.totalR >= 0 ? '+' : ''}${s.totalR.toFixed(1)} R`);
  console.log(`профит-фактор           ${s.profitFactor.toFixed(2)}`);
  console.log(`макс. просадка          ${s.maxDD.toFixed(1)} R`);
  console.log(`худшая серия убытков    ${s.worstStreak}`);
  console.log(`средняя длительность    ${s.avgBars.toFixed(1)} свечей`);
  console.log(`выходы                  ${JSON.stringify(s.byWhy)}`);
}

/* -------------------------------------------------------------------- main */

const file = argv.find((a) => !a.startsWith('--') &&
  !argv[argv.indexOf(a) - 1]?.startsWith('--'));

if (has('selftest') || !file) {
  console.log('САМОПРОВЕРКА БЭКТЕСТЕРА');
  console.log('Данные — случайное блуждание: преимущества в них нет по построению.');
  console.log('Ожидание должно выйти около нуля минус издержки. Заметный плюс');
  console.log('означал бы ошибку в симуляции, а не работающую стратегию.\n');
  console.log('параметры:', JSON.stringify(CFG));

  const all = [];
  for (const seed of [1, 7, 13, 42, 99, 256, 777, 1024, 3141, 9001]) {
    const c = randomWalk(6000, seed);
    const res = backtest(c, CFG);
    if (res) all.push(...res.trades);
  }
  report('10 блужданий по 6000 свечей H1', stats(all));

  const free = [];
  for (const seed of [1, 7, 13, 42, 99, 256, 777, 1024, 3141, 9001]) {
    const c = randomWalk(6000, seed);
    const res = backtest(c, { ...CFG, spread: 0 });
    if (res) free.push(...res.trades);
  }
  report('то же самое без издержек', stats(free),
    '\n(проверка: ожидание должно подняться ровно на величину спреда)');
  process.exit(0);
}

const text = readFileSync(file, 'utf8');
const { candles, skipped } = parseCsv(text);
if (candles.length < 200) {
  console.error(`Разобрано всего ${candles.length} свечей — для бэктеста мало.`);
  if (skipped.length) console.error('Примеры пропущенных строк:', skipped.slice(0, 3));
  process.exit(1);
}

const spacingH = ((candles[candles.length - 1].t - candles[0].t) / (candles.length - 1)) / 3600e3;
console.log(`Файл: ${file}`);
console.log(`Свечей: ${candles.length}, пропущено строк: ${skipped.length}`);
console.log(`Период: ${new Date(candles[0].t).toISOString().slice(0, 10)} — ` +
  `${new Date(candles[candles.length - 1].t).toISOString().slice(0, 10)}`);
console.log(`Средний шаг: ${spacingH.toFixed(2)} ч`);
console.log(`Параметры: ${JSON.stringify(CFG)}`);

const res = backtest(candles, CFG);
if (!res) { console.error('Движок не смог построить структуру.'); process.exit(1); }

console.log(`Якоря: свечи #${res.anchors.shIdx} (SH) и #${res.anchors.slIdx} (SL)`);

const years = (candles[candles.length - 1].t - candles[0].t) / (365.25 * 864e5);
const s0 = stats(res.trades);
report('XAUUSD, базовые параметры', s0);
console.log(`\nчастота: ${(s0.signals / years).toFixed(1)} сигналов и ` +
  `${(s0.filled / years).toFixed(1)} сделок в год`);
if (s0.filled < 100) {
  console.log(`ВНИМАНИЕ: ${s0.filled} сделок — этого мало для вывода. Чтобы отличить ` +
    `преимущество\nот везения, нужно порядка 100 сделок, то есть ` +
    `${(100 / Math.max(s0.filled / years, 0.1)).toFixed(0)} лет истории.`);
}

// чувствительность: если результат скачет от мелких сдвигов — это подгонка
console.log('\n\n=== ЧУВСТВИТЕЛЬНОСТЬ К ПАРАМЕТРАМ ===');
console.log('Если соседние значения дают резко разный итог — это подгонка, а не преимущество.\n');
console.log('FIB1  FIB2  вход   сделок  винрейт  ожидание   итого R');
for (const fib1 of [50, 51, 52]) {
  for (const fib2 of [50, 61.8]) {
    for (const entry of [0.618, 0.705, 0.79]) {
      const s = stats(backtest(candles, { ...CFG, fib1, fib2, entryFib: entry }).trades);
      console.log(
        String(fib1).padEnd(6) + String(fib2).padEnd(6) + String(entry).padEnd(7) +
        String(s.filled).padStart(6) + '  ' +
        (s.winRate * 100).toFixed(1).padStart(6) + '%  ' +
        (s.expectancy >= 0 ? '+' : '') + s.expectancy.toFixed(3).padStart(6) + '  ' +
        (s.totalR >= 0 ? '+' : '') + s.totalR.toFixed(1).padStart(7));
    }
  }
}

// вне выборки: вторая половина истории, которую параметры не видели
const half = Math.floor(candles.length / 2);
console.log('\n\n=== ПРОВЕРКА ВНЕ ВЫБОРКИ ===');
report('первая половина истории', stats(backtest(candles.slice(0, half), CFG).trades));
report('вторая половина истории', stats(backtest(candles.slice(half), CFG).trades));
