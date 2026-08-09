/* =========================================================================
   Swing Zone Dashboard — H4
   Определение свинг-хай / свинг-лоу, расчёт «площади работы» и генерация
   payload для торгового бота с ИИ-агентом.
   ========================================================================= */

'use strict';

const H4_MS = 4 * 60 * 60 * 1000;
const LS_KEY = 'swingzone.v1';

const state = {
  raw: [],        // все распарсенные свечи (после агрегации)
  window: [],     // свечи внутри выбранного окна дат
  pivots: [],     // подтверждённые свинги зигзага в окне
  zone: null,     // результат расчёта
  hover: -1,
  srcSpacing: 0,      // медианный шаг входных данных, мс
  manualEdited: false, // пользователь сам задал границы зоны
  mode: 'candles',    // 'candles' | 'screenshot'
  rules: null,        // результат прогона правил 01-07
  shot: {
    img: null,        // HTMLImageElement скриншота
    fit: null,        // преобразование картинка -> канвас
    pts: {},          // отмеченные точки в координатах картинки
    active: 'calA',   // какой маркер ставит следующий клик
  },
};

/* ---------------------------------------------------------------- helpers */

const $ = (id) => document.getElementById(id);

const num = (id, dflt = 0) => {
  const v = parseFloat($(id).value);
  return Number.isFinite(v) ? v : dflt;
};

const digits = () => Math.max(0, Math.min(8, parseInt($('digits').value, 10) || 0));

function fmt(x, d = digits()) {
  if (!Number.isFinite(x)) return '—';
  return x.toLocaleString('ru-RU', { minimumFractionDigits: d, maximumFractionDigits: d });
}

function round(x, d = digits()) {
  if (!Number.isFinite(x)) return null;
  const p = Math.pow(10, d);
  return Math.round(x * p) / p;
}

function pct(x, d = 2) {
  if (!Number.isFinite(x)) return '—';
  return (x >= 0 ? '+' : '') + x.toFixed(d) + '%';
}

function fmtDate(ms) {
  if (!Number.isFinite(ms)) return '—';
  return new Date(ms).toLocaleString('ru-RU', {
    day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit',
  });
}

function toLocalInput(ms) {
  const d = new Date(ms - new Date(ms).getTimezoneOffset() * 60000);
  return d.toISOString().slice(0, 16);
}

function fromLocalInput(v) {
  if (!v) return NaN;
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : NaN;
}

function setStatus(id, text, kind = 'info') {
  const el = $(id);
  el.textContent = text;
  el.className = 'status ' + kind;
}

/* ------------------------------------------------------------- парсинг CSV */

function parseTime(token) {
  let s = String(token).trim().replace(/^["']|["']$/g, '');
  if (!s) return NaN;

  // unix timestamp
  if (/^\d{9,14}$/.test(s)) {
    const n = parseInt(s, 10);
    return s.length > 11 ? n : n * 1000;
  }
  // 2024.01.05 -> 2024-01-05 ; 05/01/2024 не поддерживаем (двусмысленно)
  s = s.replace(/^(\d{4})[./](\d{2})[./](\d{2})/, '$1-$2-$3');
  // "2024-01-05 04:00" -> ISO-подобный вид
  s = s.replace(' ', 'T');
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) s += 'T00:00';
  const t = Date.parse(s);
  return Number.isFinite(t) ? t : NaN;
}

function splitLine(line) {
  let parts = /[;,\t]/.test(line) ? line.split(/\s*[;,\t]\s*/) : line.trim().split(/\s+/);
  parts = parts.map((p) => p.trim()).filter((p) => p !== '');
  // формат MetaTrader: дата и время отдельными полями
  if (parts.length >= 6 && /^\d{1,2}:\d{2}(:\d{2})?$/.test(parts[1])) {
    parts = [parts[0] + ' ' + parts[1], ...parts.slice(2)];
  }
  return parts;
}

function parseCandles(text) {
  const out = [];
  const errors = [];
  const lines = text.split(/\r?\n/);

  lines.forEach((line, idx) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('//')) return;

    const p = splitLine(trimmed);
    if (p.length < 5) {
      if (idx > 0 || out.length) errors.push(`строка ${idx + 1}: нужно минимум 5 полей`);
      return;
    }

    const t = parseTime(p[0]);
    const o = parseFloat(p[1]), h = parseFloat(p[2]), l = parseFloat(p[3]), c = parseFloat(p[4]);
    const v = p.length > 5 ? parseFloat(p[5]) : NaN;

    if (!Number.isFinite(t) || ![o, h, l, c].every(Number.isFinite)) {
      if (out.length === 0 && idx < 2) return;         // это заголовок
      errors.push(`строка ${idx + 1}: не распознаны дата или цены`);
      return;
    }
    if (h < l) { errors.push(`строка ${idx + 1}: high < low`); return; }

    out.push({
      t,
      o, c,
      h: Math.max(h, o, c),
      l: Math.min(l, o, c),
      v: Number.isFinite(v) ? v : null,
    });
  });

  out.sort((a, b) => a.t - b.t);

  // дедупликация по времени — оставляем последнюю запись
  const dedup = [];
  for (const k of out) {
    if (dedup.length && dedup[dedup.length - 1].t === k.t) dedup[dedup.length - 1] = k;
    else dedup.push(k);
  }
  return { candles: dedup, errors };
}

function medianSpacing(candles) {
  if (candles.length < 3) return 0;
  const diffs = [];
  for (let i = 1; i < candles.length; i++) diffs.push(candles[i].t - candles[i - 1].t);
  diffs.sort((a, b) => a - b);
  return diffs[Math.floor(diffs.length / 2)];
}

function aggregateH4(candles) {
  const buckets = new Map();
  for (const k of candles) {
    const key = Math.floor(k.t / H4_MS) * H4_MS;
    const b = buckets.get(key);
    if (!b) {
      buckets.set(key, { t: key, o: k.o, h: k.h, l: k.l, c: k.c, v: k.v });
    } else {
      b.h = Math.max(b.h, k.h);
      b.l = Math.min(b.l, k.l);
      b.c = k.c;
      if (Number.isFinite(k.v)) b.v = (b.v || 0) + k.v;
    }
  }
  return [...buckets.values()].sort((a, b) => a.t - b.t);
}

/* ------------------------------------------------------- свинги и структура */

/** Фрактальные экстремумы: бар сильнее k соседей слева и справа. */
function findPivots(c, k) {
  const piv = [];
  for (let i = k; i < c.length - k; i++) {
    let isHigh = true, isLow = true;
    for (let j = i - k; j <= i + k; j++) {
      if (j === i) continue;
      if (c[j].h > c[i].h || (c[j].h === c[i].h && j < i)) isHigh = false;
      if (c[j].l < c[i].l || (c[j].l === c[i].l && j < i)) isLow = false;
      if (!isHigh && !isLow) break;
    }
    if (isHigh) piv.push({ i, t: c[i].t, price: c[i].h, type: 'high' });
    if (isLow) piv.push({ i, t: c[i].t, price: c[i].l, type: 'low' });
  }
  return piv.sort((a, b) => a.i - b.i || (a.type === 'low' ? -1 : 1));
}

/** Зигзаг: чередующиеся свинги, мелкие колебания отсекаются. */
function buildZigzag(pivots, minMoveAbs) {
  const seq = [];
  for (const p of pivots) {
    if (!seq.length) { seq.push({ ...p }); continue; }
    const last = seq[seq.length - 1];

    if (p.type === last.type) {
      const better = p.type === 'high' ? p.price > last.price : p.price < last.price;
      if (better) seq[seq.length - 1] = { ...p };
      continue;
    }
    if (Math.abs(p.price - last.price) < minMoveAbs) continue;
    seq.push({ ...p });
  }
  return seq;
}

function atr(candles, period = 14) {
  if (candles.length < 2) return NaN;
  const trs = [];
  for (let i = 1; i < candles.length; i++) {
    const p = candles[i - 1], k = candles[i];
    trs.push(Math.max(k.h - k.l, Math.abs(k.h - p.c), Math.abs(k.l - p.c)));
  }
  const slice = trs.slice(-period);
  return slice.reduce((a, b) => a + b, 0) / slice.length;
}

/* ------------------------------------------- движок правил 01-07 (expH4) */

/**
 * Порт логики expH4 на JS: ручные якоря SH / SL, подтверждение свингов
 * через 50% и переворот структуры по главным уровням.
 *
 * Правила прогоняются по каждому бару в том же порядке, что и в Pine,
 * и мутируют общее состояние — поведение совпадает с индикатором.
 */
function runRules(c, shIdx, slIdx) {
  if (shIdx == null || slIdx == null) return null;

  const st = {
    shPrice: c[shIdx].h, shBar: shIdx, shTime: c[shIdx].t,
    slPrice: c[slIdx].l, slBar: slIdx, slTime: c[slIdx].t,
    r01: 0, r01Mid: NaN, r01Low: NaN, r01LowBar: NaN, r01High: NaN, r01HighBar: NaN,
    r02: 0, r02SL: NaN, r02SLBar: NaN, r02SH: NaN, r02SHBar: NaN, r02Mid: NaN,
    r03: 0, r03SH: NaN, r03SHBar: NaN, r03SL: NaN, r03SLBar: NaN, r03Mid: NaN,
    r04: 0, r04SL: NaN, r04SLBar: NaN, r04SH: NaN, r04SHBar: NaN,
    r04TempSH: NaN, r04TempSHBar: NaN, r04TempMid: NaN,
    r05: 0, r05SH: NaN, r05SHBar: NaN, r05PrevSL: NaN, r05PrevSLBar: NaN,
    r05Mid: NaN, r05TempSL: NaN, r05TempSLBar: NaN,
    structure: 0, mainSH: NaN, mainSHBar: NaN, mainSL: NaN, mainSLBar: NaN,
    events: [],
  };

  const log = (i, type, price, note) =>
    st.events.push({ i, t: c[i].t, type, price, note });

  const start = Math.max(shIdx, slIdx);
  const isNa = (v) => !Number.isFinite(v);

  // первичная структура: что было раньше, то и задаёт направление
  if (st.slBar < st.shBar) { st.r01 = 1; st.r02 = 1; st.structure = 1; }
  else if (st.shBar < st.slBar) { st.r01 = 3; st.r02 = 3; st.structure = 2; }
  st.r01Mid = (st.shPrice + st.slPrice) / 2;
  st.mainSH = st.shPrice; st.mainSHBar = st.shBar;
  st.mainSL = st.slPrice; st.mainSLBar = st.slBar;
  st.r04SL = st.slPrice; st.r04SLBar = st.slBar;
  st.r04SH = st.shPrice; st.r04SHBar = st.shBar;
  st.r05SH = st.shPrice; st.r05SHBar = st.shBar;
  st.r05PrevSL = st.slPrice; st.r05PrevSLBar = st.slBar;
  st.r03 = st.slBar < st.shBar ? 1 : 3;

  for (let i = start + 1; i < c.length; i++) {
    const { h, l } = c[i];

    /* ---- RULE 01 ---- */
    if (st.r01 === 1 && i > st.shBar) {
      if (l <= st.slPrice) { st.r01 = 0; st.r01Low = NaN; st.r01LowBar = NaN; }
      else if (l <= st.r01Mid) { st.r01Low = l; st.r01LowBar = i; st.r01 = 2; }
    }
    if (st.r01 === 2) {
      if (l <= st.slPrice) { st.r01 = 0; st.r01Low = NaN; st.r01LowBar = NaN; }
      else {
        if (isNa(st.r01Low) || l < st.r01Low) { st.r01Low = l; st.r01LowBar = i; }
        if (h >= st.shPrice) {
          st.slPrice = st.r01Low; st.slBar = st.r01LowBar; st.slTime = c[st.r01LowBar].t;
          log(st.r01LowBar, 'NEW SL', st.slPrice, 'RULE 01');
          st.r01 = 5;
        }
      }
    }
    if (st.r01 === 3 && i > st.slBar) {
      if (h >= st.shPrice) { st.r01 = 0; st.r01High = NaN; st.r01HighBar = NaN; }
      else if (h >= st.r01Mid) { st.r01High = h; st.r01HighBar = i; st.r01 = 4; }
    }
    if (st.r01 === 4) {
      if (h >= st.shPrice) { st.r01 = 0; st.r01High = NaN; st.r01HighBar = NaN; }
      else {
        if (isNa(st.r01High) || h > st.r01High) { st.r01High = h; st.r01HighBar = i; }
        if (l <= st.slPrice) {
          st.shPrice = st.r01High; st.shBar = st.r01HighBar; st.shTime = c[st.r01HighBar].t;
          log(st.r01HighBar, 'NEW SH', st.shPrice, 'RULE 01');
          st.r01 = 5;
        }
      }
    }

    /* ---- RULE 02 ---- */
    if (st.r02 === 1 && !isNa(st.r01Mid) && i > st.shBar && l <= st.slPrice) {
      st.r02SL = l; st.r02SLBar = i;
      st.r02Mid = (st.shPrice + st.r02SL) / 2;
      st.r02 = 2;
    }
    if (st.r02 === 2) {
      if (l < st.r02SL) {
        st.r02SL = l; st.r02SLBar = i;
        st.r02Mid = (st.shPrice + st.r02SL) / 2;
      }
      if (h >= st.r02Mid) {
        st.slPrice = st.r02SL; st.slBar = st.r02SLBar; st.slTime = c[st.r02SLBar].t;
        log(st.r02SLBar, 'CONFIRMED SL', st.slPrice, 'RULE 02');
        st.r02 = 0; st.r02SL = NaN; st.r02SLBar = NaN; st.r02Mid = NaN;
      }
    }
    if (st.r02 === 3 && !isNa(st.r01Mid) && i > st.slBar && h >= st.shPrice) {
      st.r02SH = h; st.r02SHBar = i;
      st.r02Mid = (st.slPrice + st.r02SH) / 2;
      st.r02 = 4;
    }
    if (st.r02 === 4) {
      if (h > st.r02SH) {
        st.r02SH = h; st.r02SHBar = i;
        st.r02Mid = (st.slPrice + st.r02SH) / 2;
      }
      if (l <= st.r02Mid) {
        st.shPrice = st.r02SH; st.shBar = st.r02SHBar; st.shTime = c[st.r02SHBar].t;
        log(st.r02SHBar, 'CONFIRMED SH', st.shPrice, 'RULE 02');
        st.r02 = 0; st.r02SH = NaN; st.r02SHBar = NaN; st.r02Mid = NaN;
      }
    }

    /* ---- RULE 03: неудачный поход к 50% ---- */
    if (st.r03 === 1 && i > st.shBar && h >= st.shPrice && l > st.r01Mid) {
      st.r03SH = h; st.r03SHBar = i;
      st.r03Mid = (st.slPrice + st.r03SH) / 2;
      st.r03 = 2;
    }
    if (st.r03 === 2) {
      if (h > st.r03SH) {
        st.r03SH = h; st.r03SHBar = i;
        st.r03Mid = (st.slPrice + st.r03SH) / 2;
      }
      if (l <= st.r03Mid) {
        st.shPrice = st.r03SH; st.shBar = st.r03SHBar; st.shTime = c[st.r03SHBar].t;
        log(st.r03SHBar, 'CONFIRMED SH', st.shPrice, 'RULE 03');
        st.r03 = 0; st.r03SH = NaN; st.r03SHBar = NaN; st.r03Mid = NaN;
      }
    }
    if (st.r03 === 3 && i > st.slBar && l <= st.slPrice && h < st.r01Mid) {
      st.r03SL = l; st.r03SLBar = i;
      st.r03Mid = (st.shPrice + st.r03SL) / 2;
      st.r03 = 4;
    }
    if (st.r03 === 4) {
      if (l < st.r03SL) {
        st.r03SL = l; st.r03SLBar = i;
        st.r03Mid = (st.shPrice + st.r03SL) / 2;
      }
      if (h >= st.r03Mid) {
        st.slPrice = st.r03SL; st.slBar = st.r03SLBar; st.slTime = c[st.r03SLBar].t;
        log(st.r03SLBar, 'CONFIRMED SL', st.slPrice, 'RULE 03');
        st.r03 = 0; st.r03SL = NaN; st.r03SLBar = NaN; st.r03Mid = NaN;
      }
    }

    /* ---- RULE 04: CONFIRMED SL -> TEMP SH -> CONFIRMED SH ---- */
    const newSL04 = st.slPrice !== st.r04SL || st.slBar !== st.r04SLBar;
    if (newSL04 && st.r04 !== 2) {
      st.r04SL = st.slPrice; st.r04SLBar = st.slBar;
      st.r04TempSH = NaN; st.r04TempSHBar = NaN; st.r04TempMid = NaN;
      st.r04 = 1;
    }
    if (st.r04 === 1 && !isNa(st.r04SL) && !isNa(st.r04SH)) {
      const mid = (st.r04SL + st.r04SH) / 2;
      if (i > st.r04SLBar && h >= mid && h < st.r04SH) {
        st.r04TempSH = h; st.r04TempSHBar = i;
        st.r04TempMid = (st.r04SL + st.r04TempSH) / 2;
        st.r04 = 2;
      }
    }
    if (st.r04 === 2 && !isNa(st.r04TempSH)) {
      if (h > st.r04TempSH) { st.r04TempSH = h; st.r04TempSHBar = i; }
      st.r04TempMid = (st.r04SL + st.r04TempSH) / 2;

      if (i > st.r04TempSHBar && l <= st.r04TempMid) {
        st.r04SH = st.r04TempSH; st.r04SHBar = st.r04TempSHBar;
        st.shPrice = st.r04TempSH; st.shBar = st.r04TempSHBar;
        st.shTime = c[st.r04TempSHBar].t;
        log(st.r04TempSHBar, 'CONFIRMED SH', st.shPrice, 'RULE 04');
        st.r04TempSH = NaN; st.r04TempSHBar = NaN; st.r04TempMid = NaN;
        st.r04 = 9;
      }
    }

    /* ---- RULE 05: CONFIRMED SH -> TEMP SL -> CONFIRMED SL ---- */
    if (st.r04 === 9 && st.r04SHBar !== st.r05SHBar) {
      st.r05SH = st.r04SH; st.r05SHBar = st.r04SHBar;
      st.r05PrevSL = st.slPrice; st.r05PrevSLBar = st.slBar;
      st.r05TempSL = NaN; st.r05TempSLBar = NaN; st.r05Mid = NaN;
      st.r05 = 1;
    }
    if (st.r05 === 1 && !isNa(st.r05PrevSL) && !isNa(st.r05SH)) {
      st.r05Mid = (st.r05PrevSL + st.r05SH) / 2;
      if (i > st.r05SHBar && l <= st.r05Mid && l > st.r05PrevSL) {
        st.r05TempSL = l; st.r05TempSLBar = i;
        st.r05 = 2;
      }
    }
    if (st.r05 === 2 && !isNa(st.r05TempSL)) {
      if (l > st.r05PrevSL && l < st.r05TempSL) { st.r05TempSL = l; st.r05TempSLBar = i; }
      if (h > st.r05SH) {
        st.slPrice = st.r05TempSL; st.slBar = st.r05TempSLBar;
        st.slTime = c[st.r05TempSLBar].t;
        st.r05PrevSL = st.r05TempSL; st.r05PrevSLBar = st.r05TempSLBar;
        log(st.r05TempSLBar, 'CONFIRMED SL', st.slPrice, 'RULE 05');
        st.r05TempSL = NaN; st.r05TempSLBar = NaN; st.r05Mid = NaN;
        st.r05 = 3;
      }
    }

    /* ---- RULE 06 / 07: главные уровни и разворот структуры ---- */
    let flipped = null;
    if (st.structure === 1 && !isNa(st.mainSH) && h > st.mainSH) {
      st.structure = 2; flipped = 'BULLISH';
    } else if (st.structure === 2 && !isNa(st.mainSL) && l < st.mainSL) {
      st.structure = 1; flipped = 'BEARISH';
    }
    if (flipped) {
      log(i, 'STRUCTURE ' + flipped, flipped === 'BULLISH' ? st.mainSH : st.mainSL,
        'RULE 07');
      // зеркальный сброс временных состояний
      st.r02 = 0; st.r02SL = NaN; st.r02SLBar = NaN; st.r02SH = NaN;
      st.r02SHBar = NaN; st.r02Mid = NaN;
      st.r03 = 0; st.r03SH = NaN; st.r03SHBar = NaN; st.r03SL = NaN;
      st.r03SLBar = NaN; st.r03Mid = NaN;
      st.r04 = 0; st.r04TempSH = NaN; st.r04TempSHBar = NaN; st.r04TempMid = NaN;
      st.r05 = 0; st.r05TempSL = NaN; st.r05TempSLBar = NaN; st.r05Mid = NaN;
    }
  }

  return st;
}

/** Бар, внутрь которого попадает метка времени. */
function barAt(c, ms) {
  if (!Number.isFinite(ms) || !c.length) return null;
  for (let i = 0; i < c.length; i++) {
    const end = i + 1 < c.length ? c[i + 1].t : c[i].t + H4_MS;
    if (ms >= c[i].t && ms < end) return i;
  }
  return null;
}

/* ------------------------------------------------- расчёт площади и сделки */

/**
 * Общая математика плана. Источник данных неважен: свечи или отмеченные
 * на скриншоте точки — дальше всё считается одинаково.
 */
function planFromLevels(o) {
  const { high, low, legDir, lastClose } = o;
  const R = high - low;
  if (!(R > 0)) return null;

  const bias = legDir === 'up' ? 'long' : 'short';
  const eq = low + R / 2;

  // цена уровня по коэффициенту отката (0 = экстремум импульса, 1 = его начало)
  const lvl = (f) => (bias === 'long' ? high - f * R : low + f * R);

  const entryF = num('entryFib', 0.705);
  const bufferAbs = (num('buffer', 5) / 100) * R;

  const entry = lvl(entryF);
  const stop = bias === 'long' ? low - bufferAbs : high + bufferAbs;
  const tp1 = bias === 'long' ? high : low;
  const tp2 = bias === 'long' ? high + 0.272 * R : low - 0.272 * R;

  const riskPerUnit = Math.abs(entry - stop);
  const riskMoney = num('deposit', 0) * (num('riskPct', 1) / 100);
  const qty = riskPerUnit > 0 ? riskMoney / riskPerUnit : 0;
  const rr1 = riskPerUnit > 0 ? Math.abs(tp1 - entry) / riskPerUnit : 0;
  const rr2 = riskPerUnit > 0 ? Math.abs(tp2 - entry) / riskPerUnit : 0;

  const hasLast = Number.isFinite(lastClose);
  const posInRange = hasLast ? (lastClose - low) / R : NaN;
  const location = !hasLast ? null
    : (Math.abs(lastClose - eq) / R < 0.02 ? 'equilibrium' : (lastClose > eq ? 'premium' : 'discount'));

  const fibs = [0, 0.236, 0.382, 0.5, 0.618, 0.705, 0.79, 1, 1.272].map((f) => ({
    f, price: lvl(f), ote: f >= 0.618 && f <= 0.79, eq: f === 0.5,
  }));

  return {
    ...o,
    high, low, range: R, bias, eq, lastClose,
    entry, entryF, stop, tp1, tp2,
    riskPerUnit, riskMoney, qty, rr1, rr2,
    invalidation: bias === 'long' ? low : high,
    posInRange, location, fibs,
    outsideZone: hasLast && (lastClose > high || lastClose < low),
    premium: [eq, high], discount: [low, eq],
    ote: bias === 'long' ? [lvl(0.79), lvl(0.618)] : [lvl(0.618), lvl(0.79)],
  };
}

/** Свечи + правила 01-07: структура строится от ручных якорей SH / SL. */
function computeZoneRules() {
  const c = state.window;
  if (c.length < 5) return null;

  const shIdx = barAt(c, fromLocalInput($('shAnchor').value));
  const slIdx = barAt(c, fromLocalInput($('slAnchor').value));
  if (shIdx == null || slIdx == null) {
    state.rules = null;
    return null;
  }

  const r = runRules(c, shIdx, slIdx);
  state.rules = r;
  state.pivots = [
    { i: r.shBar, t: r.shTime, price: r.shPrice, type: 'high' },
    { i: r.slBar, t: r.slTime, price: r.slPrice, type: 'low' },
  ];

  // направление сделки задаёт структура RULE 07, а не порядок свингов
  const legDir = r.structure === 2 ? 'up' : 'down';
  const last = c[c.length - 1];

  const manualHigh = parseFloat($('swingHigh').value);
  const manualLow = parseFloat($('swingLow').value);
  const useManual = state.manualEdited &&
    Number.isFinite(manualHigh) && Number.isFinite(manualLow) && manualHigh > manualLow;

  return planFromLevels({
    source: 'rules',
    symbol: $('symbol').value.trim() || 'UNKNOWN',
    high: useManual ? manualHigh : r.shPrice,
    low: useManual ? manualLow : r.slPrice,
    legDir,
    lastClose: last.c,
    lastTime: last.t,
    bars: c.length,
    from: c[0].t, to: last.t,
    highTime: r.shTime, lowTime: r.slTime,
    highPivot: null, lowPivot: null,
    manual: useManual,
    atr: atr(c, 14),
    structure: r.structure === 2 ? 'BULLISH' : r.structure === 1 ? 'BEARISH' : 'WAITING',
    events: r.events,
    anchors: { shIdx, slIdx },
  });
}

/** Свечи + автодетект: свинги ищутся фракталами и зигзагом. */
function computeZoneCandles() {
  const c = state.window;
  if (c.length < 5) return null;

  const strength = Math.max(1, Math.round(num('strength', 2)));
  const winHigh = Math.max(...c.map((k) => k.h));
  const winLow = Math.min(...c.map((k) => k.l));
  const winRange = winHigh - winLow;
  const a = atr(c, 14);

  // порог значимого импульса: кратно ATR (самонастраивается под инструмент),
  // с запасным вариантом от высоты окна, если ATR посчитать нельзя
  const minMoveAtr = num('minMove', 2.5);
  const minMoveAbs = Number.isFinite(a) && a > 0 ? minMoveAtr * a : winRange * 0.02;

  const pivots = findPivots(c, strength);
  const seq = buildZigzag(pivots, minMoveAbs);
  state.pivots = seq;

  // последняя нога структуры: два последних чередующихся свинга
  let hi = null, lo = null, legDir = null;
  if (seq.length >= 2) {
    const x = seq[seq.length - 2], y = seq[seq.length - 1];
    hi = x.type === 'high' ? x : y;
    lo = x.type === 'low' ? x : y;
    legDir = y.type === 'high' ? 'up' : 'down';
  } else {
    const iH = c.reduce((best, k, i) => (k.h > c[best].h ? i : best), 0);
    const iL = c.reduce((best, k, i) => (k.l < c[best].l ? i : best), 0);
    hi = { i: iH, t: c[iH].t, price: c[iH].h, type: 'high' };
    lo = { i: iL, t: c[iL].t, price: c[iL].l, type: 'low' };
    legDir = iH > iL ? 'up' : 'down';
  }

  // ручное переопределение границ — только если пользователь правил поля сам
  const manualHigh = parseFloat($('swingHigh').value);
  const manualLow = parseFloat($('swingLow').value);
  const useManual = state.manualEdited &&
    Number.isFinite(manualHigh) && Number.isFinite(manualLow) && manualHigh > manualLow;

  const last = c[c.length - 1];

  return planFromLevels({
    source: 'candles',
    symbol: $('symbol').value.trim() || 'UNKNOWN',
    high: useManual ? manualHigh : hi.price,
    low: useManual ? manualLow : lo.price,
    legDir,
    lastClose: last.c,
    lastTime: last.t,
    bars: c.length,
    from: c[0].t, to: last.t,
    highPivot: useManual ? null : hi,
    lowPivot: useManual ? null : lo,
    highTime: useManual ? null : hi.t,
    lowTime: useManual ? null : lo.t,
    manual: useManual,
    atr: a, minMoveAtr, minMoveAbs,
  });
}

/**
 * Источник 2: скриншот. Цена берётся из калибровки вертикальной оси по двум
 * опорным уровням, направление ноги — из порядка точек по горизонтали:
 * что правее, то сформировалось позже.
 */
function computeZoneShot() {
  const sh = state.shot;
  if (!sh.img) return null;

  const pA = parseFloat($('calPriceA').value);
  const pB = parseFloat($('calPriceB').value);
  const { calA, calB, high, low, last } = sh.pts;
  if (!calA || !calB || !high || !low) return null;
  if (!Number.isFinite(pA) || !Number.isFinite(pB)) return null;
  if (calA.y === calB.y) return null;   // калибровка вырождена

  const priceAt = (y) => pA + ((y - calA.y) * (pB - pA)) / (calB.y - calA.y);

  const hPrice = priceAt(high.y);
  const lPrice = priceAt(low.y);
  if (!(hPrice > lPrice)) return null;  // точки перепутаны местами

  // клик попадает в пиксель, а пиксель стоит денег — цену можно уточнить руками
  const manualHigh = parseFloat($('swingHigh').value);
  const manualLow = parseFloat($('swingLow').value);
  const useManual = state.manualEdited &&
    Number.isFinite(manualHigh) && Number.isFinite(manualLow) && manualHigh > manualLow;

  const legDir = high.x > low.x ? 'up' : 'down';
  const lastTime = fromLocalInput($('shotTime').value);

  return planFromLevels({
    source: 'screenshot',
    symbol: $('symbol').value.trim() || 'UNKNOWN',
    high: useManual ? manualHigh : hPrice,
    low: useManual ? manualLow : lPrice,
    markedHigh: hPrice,
    markedLow: lPrice,
    pricePerPixel: Math.abs((pB - pA) / (calB.y - calA.y)),
    legDir,
    lastClose: last ? priceAt(last.y) : NaN,
    lastTime: Number.isFinite(lastTime) ? lastTime : Date.now(),
    bars: null,
    from: null, to: null,
    highPivot: null, lowPivot: null,
    highTime: null, lowTime: null,
    manual: useManual,
    atr: NaN,
    priceAt,
  });
}

function computeZone() {
  if (state.mode === 'screenshot') return computeZoneShot();
  return $('method').value === 'rules' ? computeZoneRules() : computeZoneCandles();
}

/* ---------------------------------------------------------------- рендеринг */

function renderZone(z) {
  const badge = $('biasBadge');
  if (!z) {
    badge.className = 'bias flat';
    badge.textContent = 'bias: —';
    ['tHigh', 'tLow', 'tRange', 'tEq', 'tLast', 'tAtr', 'pEntry', 'pStop', 'pTp1', 'pTp2', 'pQty', 'pInval']
      .forEach((id) => ($(id).textContent = '—'));
    $('zoneWarn').textContent = '';
    $('zoneWarn').className = 'status info';
    $('fibTable').querySelector('tbody').innerHTML = '';
    $('payloadBox').textContent = '— рассчитайте зону —';
    $('eventsCard').hidden = true;
    $('structBadge').textContent = 'структура: —';
    return;
  }

  badge.className = 'bias ' + z.bias;
  badge.textContent = z.bias === 'long' ? '↑ bias: LONG (откат в discount)' : '↓ bias: SHORT (откат в premium)';

  $('tHigh').textContent = fmt(z.high);
  $('tLow').textContent = fmt(z.low);
  $('tHighDate').textContent = z.highTime ? fmtDate(z.highTime)
    : (z.source === 'screenshot' ? 'отмечено на скриншоте' : 'задано вручную');
  $('tLowDate').textContent = z.lowTime ? fmtDate(z.lowTime)
    : (z.source === 'screenshot' ? 'отмечено на скриншоте' : 'задано вручную');
  $('tRange').textContent = fmt(z.range);
  $('tRangePct').textContent = ((z.range / z.low) * 100).toFixed(2) + '% от нижней границы';
  $('tEq').textContent = fmt(z.eq);
  const hasLast = Number.isFinite(z.lastClose);
  $('tLast').textContent = hasLast ? fmt(z.lastClose) : '—';
  $('tLastZone').textContent = hasLast
    ? `${z.location} · ${(z.posInRange * 100).toFixed(1)}% диапазона`
    : 'отметьте текущую цену на скриншоте';
  $('tAtr').textContent = fmt(z.atr);
  $('tAtrPct').textContent = Number.isFinite(z.atr)
    ? ((z.atr / z.range) * 100).toFixed(1) + '% от высоты зоны' : '—';

  $('pEntry').textContent = fmt(z.entry);
  $('pEntryFib').textContent = hasLast
    ? `фибо ${z.entryF.toFixed(3)} · ${pct(((z.entry - z.lastClose) / z.lastClose) * 100)} от цены`
    : `фибо ${z.entryF.toFixed(3)}`;
  $('pStop').textContent = fmt(z.stop);
  $('pStopDist').textContent = `риск ${fmt(z.riskPerUnit)} (${((z.riskPerUnit / z.entry) * 100).toFixed(2)}%)`;
  $('pTp1').textContent = fmt(z.tp1);
  $('pTp1R').textContent = `R:R ${z.rr1.toFixed(2)}`;
  $('pTp2').textContent = fmt(z.tp2);
  $('pTp2R').textContent = `R:R ${z.rr2.toFixed(2)} · ext 1.272`;
  $('pQty').textContent = z.qty > 0 ? z.qty.toPrecision(6).replace(/\.?0+$/, '') : '—';
  $('pRiskMoney').textContent = `риск ${fmt(z.riskMoney, 2)} на сделку`;
  $('pInval').textContent = fmt(z.invalidation);

  // таблица фибо
  const tb = $('fibTable').querySelector('tbody');
  tb.innerHTML = z.fibs.map((f) => {
    const zoneLbl = Math.abs(f.price - z.eq) / z.range < 0.02 ? 'equilibrium'
      : (f.price > z.eq ? 'premium' : 'discount');
    const dist = hasLast ? ((f.price - z.lastClose) / z.lastClose) * 100 : NaN;
    const cls = f.ote ? 'ote' : (f.eq ? 'eq-row' : '');
    return `<tr class="${cls}"><td class="k">${f.f.toFixed(3)}</td><td class="v">${fmt(f.price)}</td>` +
      `<td class="k">${zoneLbl}</td><td class="k">${pct(dist)}</td></tr>`;
  }).join('');

  // пока границы не правили вручную — держим их синхронными с детектором
  if (!state.manualEdited) {
    $('swingHigh').value = round(z.high);
    $('swingLow').value = round(z.low);
  }

  // предупреждения о качестве структуры
  const warns = [];
  if (!hasLast) warns.push('не отмечена текущая цена — payload для бота не собрать');
  if (z.outsideZone) {
    warns.push(z.lastClose > z.high
      ? 'цена ушла выше площади работы — новый свинг-хай ещё не подтверждён'
      : 'цена ушла ниже площади работы — новый свинг-лоу ещё не подтверждён');
  }
  if (Number.isFinite(z.atr) && z.atr / z.range > 0.4) {
    warns.push(`ATR ${((z.atr / z.range) * 100).toFixed(0)}% от высоты зоны — зона узкая для текущей волатильности`);
  }
  if (z.rr1 < 2) warns.push(`R:R первой цели ${z.rr1.toFixed(2)} — бот отклонит сигнал (минимум 2.0)`);

  const warnEl = $('zoneWarn');
  if (warns.length) {
    warnEl.className = 'status err';
    warnEl.textContent = '⚠ ' + warns.join(' · ');
  } else {
    warnEl.className = 'status ok';
    warnEl.textContent = '✓ структура подтверждена, цена внутри площади работы';
  }

  if (!hasLast) {
    $('payloadBox').textContent = '— отметьте текущую цену на скриншоте —';
    delete $('payloadBox').dataset.raw;
    return;
  }

  $('structBadge').textContent = z.structure
    ? 'структура: ' + z.structure
    : 'разметка: ' + (z.source === 'screenshot' ? 'скриншот' : 'автодетект');

  renderEvents(z);

  const payload = buildPayload(z);
  $('payloadBox').innerHTML = highlightJson(JSON.stringify(payload, null, 2));
  $('payloadBox').dataset.raw = JSON.stringify(payload, null, 2);
}

/* ------------------------------------------------------------------ payload */

function swingSource(z) {
  if (z.source === 'screenshot') return 'screenshot';
  if (z.manual) return 'manual';
  return z.source === 'rules' ? 'rules' : 'fractal';
}

function buildPayload(z) {
  const d = digits();
  const iso = (ms) => new Date(ms).toISOString();

  return {
    schema: 'swing-zone/v1',
    generated_at: new Date().toISOString(),
    source: z.source === 'screenshot' ? 'swing-zone-dashboard/screenshot' : 'swing-zone-dashboard',
    symbol: z.symbol,
    timeframe: '4h',
    window: {
      from: z.from ? iso(z.from) : null,
      to: z.to ? iso(z.to) : null,
      candles: z.bars,
    },
    swing: {
      high: {
        price: round(z.high, d),
        time: z.highTime ? iso(z.highTime) : null,
        source: swingSource(z),
      },
      low: {
        price: round(z.low, d),
        time: z.lowTime ? iso(z.lowTime) : null,
        source: swingSource(z),
      },
      leg_direction: z.legDir,
      // на скриншоте свинги отмечены вручную — параметров детектора нет
      strength_bars: z.source === 'screenshot' ? undefined : Math.round(num('strength', 2)),
      min_impulse_atr: z.source === 'screenshot' ? undefined : z.minMoveAtr,
    },
    zone: {
      upper: round(z.high, d),
      lower: round(z.low, d),
      height: round(z.range, d),
      height_pct: round((z.range / z.low) * 100, 2),
      equilibrium: round(z.eq, d),
      premium: [round(z.eq, d), round(z.high, d)],
      discount: [round(z.low, d), round(z.eq, d)],
      ote: [round(z.ote[0], d), round(z.ote[1], d)],
      fib: Object.fromEntries(z.fibs.map((f) => [f.f.toFixed(3), round(f.price, d)])),
    },
    bias: z.bias,
    structure: z.structure || null,
    structure_events: z.events
      ? z.events.slice(-12).map((e) => ({
        time: new Date(e.t).toISOString(),
        type: e.type,
        price: round(e.price, d),
        rule: e.note,
      }))
      : null,
    trade: {
      side: z.bias === 'long' ? 'buy' : 'sell',
      order_type: 'limit',
      entry: round(z.entry, d),
      entry_fib: z.entryF,
      stop_loss: round(z.stop, d),
      take_profit: [round(z.tp1, d), round(z.tp2, d)],
      rr: [round(z.rr1, 2), round(z.rr2, 2)],
      risk_pct: num('riskPct', 1),
      risk_amount: round(z.riskMoney, 2),
      position_size: z.qty > 0 ? Number(z.qty.toPrecision(8)) : 0,
      invalidation: round(z.invalidation, d),
    },
    context: {
      last_close: round(z.lastClose, d),
      last_candle_time: iso(z.lastTime),
      price_location: z.location,
      position_in_range_pct: round(z.posInRange * 100, 1),
      atr14: round(z.atr, d),
      atr_pct_of_zone: Number.isFinite(z.atr) ? round((z.atr / z.range) * 100, 1) : null,
      price_outside_zone: z.outsideZone,
      price_digits: d,
    },
    agent: {
      task: 'Оценить сетап и вернуть решение enter / wait / skip.',
      decision_enum: ['enter', 'wait', 'skip'],
      checklist: [
        'Цена находится в зоне входа или подходит к ней (не убежала за стоп).',
        'Направление сетапа совпадает с последней ногой структуры (leg_direction).',
        'R:R по первой цели не ниже 2.0.',
        'Высота зоны адекватна волатильности: atr_pct_of_zone в пределах 8–60%.',
        'Свежесть данных: last_candle_time не старше 8 часов.',
      ],
      hard_limits: {
        min_rr: 2,
        max_risk_pct: 2,
        max_data_age_hours: 8,
      },
    },
  };
}

function highlightJson(str) {
  return str
    .replace(/[&<>]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[ch]))
    .replace(/("(\\u[a-zA-Z0-9]{4}|\\[^u]|[^\\"])*"(\s*:)?|\b(true|false|null)\b|-?\d+(\.\d+)?([eE][+-]?\d+)?)/g,
      (m) => {
        let cls = 'j-num';
        if (/^"/.test(m)) cls = /:$/.test(m) ? 'j-key' : 'j-str';
        else if (/true|false/.test(m)) cls = 'j-bool';
        else if (/null/.test(m)) cls = 'j-null';
        return `<span class="${cls}">${m}</span>`;
      });
}

/* ------------------------------------------------------------------ график */

const canvas = $('chart');
const ctx = canvas.getContext('2d');
const M = { l: 12, r: 84, t: 16, b: 26 };

/* ---- режим скриншота: картинка + отметки + уровни поверх ---- */

const SHOT_LABELS = {
  calA: '① уровень A', calB: '② уровень B',
  high: 'SWING HIGH', low: 'SWING LOW', last: 'текущая цена',
};

/** Пересчёт координат: картинка -> канвас (вписываем целиком, с полями). */
function shotFit(cssW, cssH) {
  const img = state.shot.img;
  const scale = Math.min(cssW / img.naturalWidth, cssH / img.naturalHeight);
  return {
    scale,
    ox: (cssW - img.naturalWidth * scale) / 2,
    oy: (cssH - img.naturalHeight * scale) / 2,
  };
}

const toCanvas = (pt) => {
  const f = state.shot.fit;
  return { x: f.ox + pt.x * f.scale, y: f.oy + pt.y * f.scale };
};

const toImage = (x, y) => {
  const f = state.shot.fit;
  return { x: (x - f.ox) / f.scale, y: (y - f.oy) / f.scale };
};

function drawShot(cssW, cssH) {
  const sh = state.shot;
  ctx.drawImage(sh.img, sh.fit.ox, sh.fit.oy,
    sh.img.naturalWidth * sh.fit.scale, sh.img.naturalHeight * sh.fit.scale);

  const z = state.zone;
  const left = sh.fit.ox;
  const right = sh.fit.ox + sh.img.naturalWidth * sh.fit.scale;

  // уровни плана — только когда калибровка и оба свинга уже отмечены
  if (z && z.priceAt) {
    const pA = num('calPriceA'), pB = num('calPriceB');
    const yOf = (price) => toCanvas({
      x: 0,
      y: sh.pts.calA.y + ((price - pA) * (sh.pts.calB.y - sh.pts.calA.y)) / (pB - pA),
    }).y;

    const oteTop = yOf(Math.max(z.ote[0], z.ote[1]));
    const oteBot = yOf(Math.min(z.ote[0], z.ote[1]));
    ctx.fillStyle = 'rgba(124,92,255,.22)';
    ctx.fillRect(left, Math.min(oteTop, oteBot), right - left, Math.abs(oteBot - oteTop));

    const lines = [
      { p: z.high, col: '#ff5ec4', label: 'SWING HIGH', dash: [6, 3] },
      { p: z.low, col: '#ff5ec4', label: 'SWING LOW', dash: [6, 3] },
      { p: z.eq, col: '#ffb84d', label: 'EQ 50%', dash: [2, 4] },
      { p: z.entry, col: '#3ddcff', label: 'ENTRY', dash: [8, 4] },
      { p: z.stop, col: '#ff5c7a', label: 'STOP', dash: [8, 4] },
      { p: z.tp1, col: '#26d0a0', label: 'TP1', dash: [8, 4] },
      { p: z.tp2, col: '#26d0a0', label: 'TP2', dash: [3, 5] },
    ];
    ctx.font = '10px "JetBrains Mono", monospace';
    lines.forEach((ln, idx) => {
      if (!Number.isFinite(ln.p)) return;
      const yy = yOf(ln.p);
      if (!Number.isFinite(yy)) return;
      ctx.strokeStyle = ln.col; ctx.lineWidth = 1.5;
      ctx.setLineDash(ln.dash);
      ctx.beginPath(); ctx.moveTo(left, yy); ctx.lineTo(right, yy); ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = ln.col;
      ctx.textAlign = 'left';
      ctx.fillText(`${ln.label} ${fmt(ln.p)}`, left + 6 + (idx % 3) * 130, yy - 6);
    });
  }

  // отметки пользователя
  ctx.font = '10px "JetBrains Mono", monospace';
  for (const [key, pt] of Object.entries(sh.pts)) {
    const c = toCanvas(pt);
    const isCal = key === 'calA' || key === 'calB';
    const col = isCal ? '#ffb84d' : (key === 'high' ? '#ff5ec4' : key === 'low' ? '#7c5cff' : '#3ddcff');

    if (isCal || key === 'last') {
      ctx.strokeStyle = col; ctx.lineWidth = 1;
      ctx.setLineDash([2, 3]);
      ctx.beginPath(); ctx.moveTo(left, c.y); ctx.lineTo(right, c.y); ctx.stroke();
      ctx.setLineDash([]);
    }
    ctx.fillStyle = col;
    ctx.beginPath(); ctx.arc(c.x, c.y, 5, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = '#0a0a12'; ctx.lineWidth = 1.5; ctx.stroke();
    ctx.textAlign = 'left';
    ctx.fillText(SHOT_LABELS[key], c.x + 9, c.y - 8);
  }
}

function drawChart() {
  const dpr = window.devicePixelRatio || 1;
  const cssW = canvas.clientWidth || 800;
  const cssH = canvas.clientHeight || 400;
  canvas.width = Math.round(cssW * dpr);
  canvas.height = Math.round(cssH * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, cssW, cssH);

  if (state.mode === 'screenshot') {
    if (!state.shot.img) {
      ctx.fillStyle = '#6d6d84';
      ctx.font = '13px Inter, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('Загрузите скриншот графика', cssW / 2, cssH / 2);
      return;
    }
    state.shot.fit = shotFit(cssW, cssH);
    drawShot(cssW, cssH);
    return;
  }

  const c = state.window;
  if (!c.length) {
    ctx.fillStyle = '#6d6d84';
    ctx.font = '13px Inter, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('Нет данных для отображения', cssW / 2, cssH / 2);
    return;
  }

  const z = state.zone;
  const plotW = cssW - M.l - M.r;
  const plotH = cssH - M.t - M.b;

  let min = Math.min(...c.map((k) => k.l));
  let max = Math.max(...c.map((k) => k.h));
  if (z) {
    for (const p of [z.high, z.low, z.entry, z.stop, z.tp1, z.tp2]) {
      if (Number.isFinite(p)) { min = Math.min(min, p); max = Math.max(max, p); }
    }
  }
  const pad = (max - min) * 0.06 || 1;
  min -= pad; max += pad;

  const y = (p) => M.t + ((max - p) / (max - min)) * plotH;
  const step = plotW / c.length;
  const x = (i) => M.l + (i + 0.5) * step;

  // сетка + шкала цен
  ctx.font = '10px "JetBrains Mono", monospace';
  ctx.textBaseline = 'middle';
  for (let i = 0; i <= 4; i++) {
    const p = min + ((max - min) * i) / 4;
    const yy = y(p);
    ctx.strokeStyle = 'rgba(38,38,58,.55)';
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(M.l, yy); ctx.lineTo(M.l + plotW, yy); ctx.stroke();
    ctx.fillStyle = '#6d6d84';
    ctx.textAlign = 'left';
    ctx.fillText(fmt(p), M.l + plotW + 8, yy);
  }

  // зона OTE + equilibrium
  if (z) {
    const yTop = y(Math.max(z.ote[0], z.ote[1]));
    const yBot = y(Math.min(z.ote[0], z.ote[1]));
    ctx.fillStyle = 'rgba(124,92,255,.16)';
    ctx.fillRect(M.l, yTop, plotW, Math.max(1, yBot - yTop));
    ctx.strokeStyle = 'rgba(124,92,255,.5)';
    ctx.setLineDash([4, 4]); ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(M.l, yTop); ctx.lineTo(M.l + plotW, yTop);
    ctx.moveTo(M.l, yBot); ctx.lineTo(M.l + plotW, yBot); ctx.stroke();
    ctx.setLineDash([]);
  }

  // свечи
  const bw = Math.max(1.5, Math.min(step * 0.66, 13));
  c.forEach((k, i) => {
    const up = k.c >= k.o;
    const col = up ? '#26d0a0' : '#ff5c7a';
    const cx = x(i);
    ctx.strokeStyle = col; ctx.fillStyle = col; ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(Math.round(cx) + 0.5, y(k.h));
    ctx.lineTo(Math.round(cx) + 0.5, y(k.l));
    ctx.stroke();
    const yo = y(k.o), yc = y(k.c);
    ctx.fillRect(cx - bw / 2, Math.min(yo, yc), bw, Math.max(1.5, Math.abs(yc - yo)));
  });

  // уровни плана
  if (z) {
    const lines = [
      { p: z.high, col: '#ff5ec4', label: 'SWING HIGH', dash: [6, 3] },
      { p: z.low, col: '#ff5ec4', label: 'SWING LOW', dash: [6, 3] },
      { p: z.eq, col: '#ffb84d', label: 'EQ 50%', dash: [2, 4] },
      { p: z.entry, col: '#3ddcff', label: 'ENTRY', dash: [8, 4] },
      { p: z.stop, col: '#ff5c7a', label: 'STOP', dash: [8, 4] },
      { p: z.tp1, col: '#26d0a0', label: 'TP1', dash: [8, 4] },
      { p: z.tp2, col: '#26d0a0', label: 'TP2', dash: [3, 5] },
    ];
    ctx.font = '10px "JetBrains Mono", monospace';
    lines.forEach((ln, idx) => {
      if (!Number.isFinite(ln.p)) return;
      const yy = y(ln.p);
      ctx.strokeStyle = ln.col; ctx.lineWidth = 1.5;
      ctx.setLineDash(ln.dash);
      ctx.beginPath(); ctx.moveTo(M.l, yy); ctx.lineTo(M.l + plotW, yy); ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = ln.col;
      ctx.textAlign = 'left';
      // подписи разносим по горизонтали, чтобы близкие уровни не наезжали друг на друга
      ctx.fillText(ln.label, M.l + 6 + (idx % 4) * 78, yy - 6);
    });

    // маркеры свингов
    for (const p of state.pivots) {
      const cx = x(p.i), cy = y(p.price);
      ctx.fillStyle = p.type === 'high' ? '#ff5ec4' : '#7c5cff';
      ctx.beginPath(); ctx.arc(cx, cy, 3.5, 0, Math.PI * 2); ctx.fill();
    }
  }

  // курсор
  if (state.hover >= 0 && state.hover < c.length) {
    const cx = x(state.hover);
    ctx.strokeStyle = 'rgba(242,242,247,.25)';
    ctx.setLineDash([3, 3]); ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(cx, M.t); ctx.lineTo(cx, M.t + plotH); ctx.stroke();
    ctx.setLineDash([]);
  }
}

canvas.addEventListener('mousemove', (e) => {
  const rect = canvas.getBoundingClientRect();
  const tipEl = $('tooltip');

  if (state.mode === 'screenshot') {
    const sh = state.shot;
    if (!sh.img || !sh.fit) { tipEl.style.opacity = '0'; return; }
    const im = toImage(e.clientX - rect.left, e.clientY - rect.top);
    const pA = num('calPriceA'), pB = num('calPriceB');
    const ready = sh.pts.calA && sh.pts.calB && sh.pts.calA.y !== sh.pts.calB.y &&
      Number.isFinite(pA) && Number.isFinite(pB);
    const price = ready
      ? pA + ((im.y - sh.pts.calA.y) * (pB - pA)) / (sh.pts.calB.y - sh.pts.calA.y)
      : NaN;
    tipEl.innerHTML = ready
      ? `<span class="t-date">цена под курсором</span><b>${fmt(price)}</b>`
      : '<span class="t-date">отметьте два опорных уровня</span>задайте их цены слева';
    tipEl.style.opacity = '1';
    tipEl.style.left = Math.min(e.clientX - rect.left + 14, rect.width - tipEl.offsetWidth - 6) + 'px';
    tipEl.style.top = Math.max(e.clientY - rect.top - tipEl.offsetHeight - 10, 4) + 'px';
    return;
  }

  const c = state.window;
  if (!c.length) return;
  const plotW = rect.width - M.l - M.r;
  const step = plotW / c.length;
  const i = Math.floor((e.clientX - rect.left - M.l) / step);
  const tip = $('tooltip');

  if (i < 0 || i >= c.length) {
    tip.style.opacity = '0';
    if (state.hover !== -1) { state.hover = -1; drawChart(); }
    return;
  }
  if (i !== state.hover) { state.hover = i; drawChart(); }

  const k = c[i];
  tip.innerHTML =
    `<span class="t-date">${fmtDate(k.t)}</span>` +
    `O <b>${fmt(k.o)}</b>  H <b>${fmt(k.h)}</b><br>` +
    `L <b>${fmt(k.l)}</b>  C <b>${fmt(k.c)}</b>` +
    (k.v !== null ? `<br>V <b>${k.v.toLocaleString('ru-RU')}</b>` : '');
  tip.style.opacity = '1';
  const tw = tip.offsetWidth, th = tip.offsetHeight;
  let left = e.clientX - rect.left + 14;
  if (left + tw > rect.width) left = e.clientX - rect.left - tw - 14;
  let top = e.clientY - rect.top - th - 10;
  if (top < 0) top = e.clientY - rect.top + 14;
  tip.style.left = left + 'px';
  tip.style.top = top + 'px';
});

canvas.addEventListener('mouseleave', () => {
  $('tooltip').style.opacity = '0';
  state.hover = -1;
  drawChart();
});

window.addEventListener('resize', drawChart);

/* ------------------------------------------------------------ разбор агента */

/** Куда стучаться за разбором: свой origin, иначе — база из адреса вебхука. */
function apiBase() {
  if (location.protocol.startsWith('http')) return location.origin;
  const wh = $('webhookUrl').value.trim();
  return wh ? wh.replace(/\/signal\b.*$/, '') : '';
}

/** Картинка графика — то же, что видит пользователь, вместе с разметкой. */
function chartImage() {
  try {
    const png = canvas.toDataURL('image/png');
    // очень большие скриншоты пережимаем, чтобы не упереться в лимит запроса
    return png.length > 3.5 * 1024 * 1024 ? canvas.toDataURL('image/jpeg', 0.85) : png;
  } catch (_) {
    return null;   // канвас «испачкан» сторонней картинкой — идём без неё
  }
}

function renderAnalysis(a) {
  $('analysisBox').hidden = false;

  const v = $('aVerdict');
  v.className = 'verdict ' + a.verdict;
  v.textContent = { enter: 'ВХОДИТЬ', wait: 'ЖДАТЬ', skip: 'ПРОПУСТИТЬ' }[a.verdict] || a.verdict;
  $('aConf').textContent = `уверенность ${Math.round((a.confidence || 0) * 100)}%`;

  $('aSummary').textContent = a.summary || '';
  $('aStructure').textContent = a.structure_read || '—';
  $('aInval').textContent = a.invalidation || '—';

  const fill = (id, arr) => {
    $(id).innerHTML = (arr && arr.length)
      ? arr.map((x) => `<li>${String(x).replace(/[<>&]/g, (c) =>
        ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]))}</li>`).join('')
      : '<li>—</li>';
  };
  fill('aLevels', a.key_levels);
  fill('aRecs', a.recommendations);
  fill('aRisks', a.risks);

  const hasNotes = a.chart_notes && a.chart_notes.length;
  $('aChartBlock').hidden = !hasNotes;
  if (hasNotes) fill('aChart', a.chart_notes);
}

async function runAnalysis() {
  const raw = $('payloadBox').dataset.raw;
  if (!raw) {
    setStatus('analyzeStatus', 'Сначала постройте разметку — агенту нечего разбирать.', 'err');
    return;
  }
  const base = apiBase();
  if (!base) {
    setStatus('analyzeStatus',
      'Дашборд открыт из файла. Укажите адрес бота в «Отправка сигнала боту напрямую».', 'err');
    return;
  }

  const btn = $('btnAnalyze');
  btn.disabled = true;
  setStatus('analyzeStatus', '⟳ агент разбирает ситуацию…', 'info');

  const body = { signal: JSON.parse(raw) };
  if ($('sendImage').checked) {
    const img = chartImage();
    if (img) body.image = img;
  }

  const headers = { 'Content-Type': 'application/json' };
  const token = $('webhookToken').value.trim();
  if (token) headers['X-Auth-Token'] = token;

  try {
    const res = await fetch(base + '/analyze', {
      method: 'POST', headers, body: JSON.stringify(body),
    });
    const text = await res.text();
    if (!res.ok) {
      setStatus('analyzeStatus', `HTTP ${res.status} · ${text.slice(0, 300)}`, 'err');
      return;
    }
    renderAnalysis(JSON.parse(text));
    const withImg = body.image ? ' (со скриншотом)' : ' (только цифры)';
    setStatus('analyzeStatus', 'Разбор готов' + withImg + '.', 'ok');
  } catch (err) {
    setStatus('analyzeStatus',
      `Не удалось получить разбор: ${err.message}. Проверьте, что бот запущен.`, 'err');
  } finally {
    btn.disabled = false;
  }
}

/* ------------------------------------------------ журнал правил и TradingView */

function renderEvents(z) {
  const card = $('eventsCard');
  if (!z || !z.events) { card.hidden = true; return; }

  card.hidden = false;
  const tb = $('eventsTable').querySelector('tbody');
  if (!z.events.length) {
    tb.innerHTML = '<tr><td colspan="4" class="k">от якорей до последней свечи ' +
      'структура не менялась</td></tr>';
    return;
  }
  tb.innerHTML = z.events.slice(-40).reverse().map((e) => {
    const cls = e.type.startsWith('STRUCTURE') ? 'ev-flip'
      : (e.type.includes('SH') ? 'ev-sh' : 'ev-sl');
    return `<tr class="${cls}"><td>${fmtDate(e.t)}</td><td>${e.type}</td>` +
      `<td>${fmt(e.price)}</td><td>${e.note}</td></tr>`;
  }).join('');
}

function renderRulesStatus(z) {
  if ($('method').value !== 'rules' || state.mode !== 'candles') return;
  if (!z) {
    setStatus('rulesStatus',
      'Якоря не найдены в окне: проверьте, что даты попадают в загруженный диапазон.', 'err');
    return;
  }
  const n = z.events ? z.events.length : 0;
  setStatus('rulesStatus',
    `${z.structure} · SH ${fmt(z.high)} · SL ${fmt(z.low)} · событий структуры: ${n}`,
    z.structure === 'WAITING' ? 'info' : 'ok');
}

/** Виджет TradingView — только визуальный контекст, данные он наружу не отдаёт. */
function loadTradingView() {
  const host = $('tvHost');
  host.innerHTML = '<div class="tv-placeholder">загрузка виджета…</div>';

  const render = () => {
    host.innerHTML = '<div id="tvChart" style="height:100%"></div>';
    /* global TradingView */
    new TradingView.widget({
      container_id: 'tvChart',
      symbol: $('tvSymbol').value.trim() || 'OANDA:XAUUSD',
      interval: $('tvInterval').value,
      timezone: 'Etc/UTC',
      theme: 'dark',
      style: '1',
      locale: 'ru',
      autosize: true,
      hide_side_toolbar: false,
      allow_symbol_change: true,
      backgroundColor: '#12121e',
      gridColor: 'rgba(38,38,58,.6)',
    });
  };

  if (window.TradingView) { render(); return; }

  const sc = document.createElement('script');
  sc.src = 'https://s3.tradingview.com/tv.js';
  sc.onload = render;
  sc.onerror = () => {
    host.innerHTML = '<div class="tv-placeholder">Не удалось загрузить виджет TradingView. ' +
      'Проверьте доступ к tradingview.com — при открытии страницы с file:// скрипт тоже ' +
      'может блокироваться.</div>';
  };
  document.head.appendChild(sc);
}

function setMethod() {
  const rules = $('method').value === 'rules';
  $('ruleFields').hidden = !rules;
  $('detectFields').hidden = rules;
  recalc();
}

/* ------------------------------------------------------ скриншот как источник */

const SHOT_ORDER = ['calA', 'calB', 'high', 'low', 'last'];

function setActiveMarker(key) {
  state.shot.active = key;
  document.querySelectorAll('.marker').forEach((b) =>
    b.classList.toggle('active', b.dataset.point === key));
}

/** Следующая неотмеченная точка — чтобы не кликать по кнопкам после каждого шага. */
function advanceMarker() {
  const next = SHOT_ORDER.find((k) => !state.shot.pts[k]);
  setActiveMarker(next || 'last');
}

function shotProgress() {
  const pts = state.shot.pts;
  const missing = [];
  if (!pts.calA || !pts.calB) missing.push('опорные уровни');
  if (!Number.isFinite(num('calPriceA', NaN)) || !Number.isFinite(num('calPriceB', NaN)))
    missing.push('цены опорных уровней');
  if (!pts.high) missing.push('swing high');
  if (!pts.low) missing.push('swing low');
  if (!pts.last) missing.push('текущая цена');

  const z = state.zone;
  const step = z && Number.isFinite(z.pricePerPixel)
    ? ` · шаг разметки ${fmt(z.pricePerPixel)} на пиксель — при необходимости уточните цены в блоке «Площадь работы»`
    : '';

  if (!missing.length) {
    setStatus('shotStatus', '✓ все точки отмечены — структура посчитана' + step, 'ok');
  } else if (missing.length === 1 && missing[0] === 'текущая цена') {
    setStatus('shotStatus',
      'Зона построена. Отметьте текущую цену — без неё не собрать payload для бота.', 'info');
  } else {
    setStatus('shotStatus', 'Осталось отметить: ' + missing.join(', '), 'info');
  }
}

function loadShot(src) {
  const img = new Image();
  img.onload = () => {
    state.shot.img = img;
    state.shot.pts = {};
    state.manualEdited = false;
    $('swingHigh').value = '';
    $('swingLow').value = '';
    setActiveMarker('calA');
    $('dropzone').hidden = true;
    $('shotSteps').hidden = false;
    if (!$('shotTime').value) $('shotTime').value = toLocalInput(Date.now());
    $('dataBadge').textContent = `скриншот ${img.naturalWidth}×${img.naturalHeight}`;
    $('dataBadge').className = 'badge';
    recalc();
    shotProgress();
  };
  img.onerror = () => setStatus('shotStatus', 'Не удалось прочитать изображение.', 'err');
  img.src = src;
}

function readShotFile(file) {
  if (!file || !file.type.startsWith('image/')) {
    setStatus('shotStatus', 'Нужен файл-изображение (PNG или JPG).', 'err');
    return;
  }
  const r = new FileReader();
  r.onload = () => loadShot(r.result);
  r.onerror = () => setStatus('shotStatus', 'Не удалось прочитать файл.', 'err');
  r.readAsDataURL(file);
}

function setMode(mode) {
  state.mode = mode;
  document.querySelectorAll('#modeTabs .tab').forEach((t) =>
    t.classList.toggle('active', t.dataset.mode === mode));
  $('candlesPane').hidden = mode !== 'candles';
  $('shotPane').hidden = mode !== 'screenshot';
  $('windowCard').hidden = mode === 'screenshot';
  $('detectFields').hidden = mode === 'screenshot';

  if (mode === 'screenshot' && !state.shot.img) {
    $('dataBadge').textContent = 'нет скриншота';
    $('dataBadge').className = 'badge warn';
  } else if (mode === 'candles') {
    $('dataBadge').textContent = state.raw.length ? `${state.raw.length} свечей H4` : 'нет данных';
    $('dataBadge').className = state.raw.length ? 'badge' : 'badge warn';
  }
  recalc();
}

// клик по канвасу ставит активную отметку
canvas.addEventListener('click', (e) => {
  if (state.mode !== 'screenshot' || !state.shot.img || !state.shot.fit) return;
  const rect = canvas.getBoundingClientRect();
  const im = toImage(e.clientX - rect.left, e.clientY - rect.top);
  if (im.x < 0 || im.y < 0 ||
      im.x > state.shot.img.naturalWidth || im.y > state.shot.img.naturalHeight) return;

  if (state.shot.active === 'high' || state.shot.active === 'low') {
    state.manualEdited = false;      // отметили заново — снимаем ручную правку
    $('swingHigh').value = '';
    $('swingLow').value = '';
  }
  state.shot.pts[state.shot.active] = im;
  advanceMarker();
  recalc();
  shotProgress();
});

/* -------------------------------------------------------------- пайплайн UI */

function applyWindow() {
  const from = fromLocalInput($('dateFrom').value);
  const to = fromLocalInput($('dateTo').value);
  state.window = state.raw.filter((k) =>
    (!Number.isFinite(from) || k.t >= from) && (!Number.isFinite(to) || k.t <= to));

  if (state.window.length < 5) {
    setStatus('windowStatus', `В окне ${state.window.length} свечей — нужно минимум 5.`, 'err');
  } else {
    setStatus('windowStatus',
      `${state.window.length} свечей H4 · ${fmtDate(state.window[0].t)} → ${fmtDate(state.window[state.window.length - 1].t)}`,
      'ok');
  }
}

function recalc() {
  if (state.mode === 'candles') applyWindow();
  state.zone = computeZone();
  renderZone(state.zone);
  drawChart();

  const z = state.zone;
  renderRulesStatus(z);
  $('chartTitle').textContent = `${$('symbol').value.trim() || 'Инструмент'} · H4`;
  $('chartSub').textContent = z
    ? `${z.bars ? z.bars + ' свечей' : 'разметка по скриншоту'} · зона ${fmt(z.low)} – ${fmt(z.high)} · высота ${fmt(z.range)}`
    : (state.mode === 'screenshot'
      ? 'Отметьте на скриншоте опорные уровни и точки свингов'
      : 'Недостаточно данных в выбранном окне');
  saveCfg();
}

function loadData(text) {
  const { candles, errors } = parseCandles(text);
  if (!candles.length) {
    setStatus('parseStatus', 'Не удалось распознать ни одной свечи. Проверьте формат строк.', 'err');
    $('dataBadge').textContent = 'нет данных';
    return false;
  }

  const spacing = medianSpacing(candles);
  state.srcSpacing = spacing;

  let final = candles;
  let note = '';
  if ($('aggregate').checked && spacing > 0 && spacing < H4_MS) {
    final = aggregateH4(candles);
    note = ` · агрегировано из ${Math.round(spacing / 60000)}м в H4`;
  } else if (spacing > 0 && Math.abs(spacing - H4_MS) > 60000) {
    note = ` · внимание: шаг данных ${(spacing / 3600000).toFixed(1)}ч, а не 4ч`;
  }

  state.raw = final;
  $('dataBadge').textContent = `${final.length} свечей H4`;
  $('dataBadge').className = 'badge';

  $('dateFrom').value = toLocalInput(final[0].t);
  $('dateTo').value = toLocalInput(final[final.length - 1].t);
  state.manualEdited = false;
  $('swingHigh').value = '';
  $('swingLow').value = '';
  suggestAnchors(final);

  const errNote = errors.length ? ` · пропущено строк: ${errors.length}` : '';
  setStatus('parseStatus', `Загружено ${final.length} свечей${note}${errNote}`,
    errors.length ? 'info' : 'ok');
  if (errors.length) console.warn('Пропущенные строки:', errors.slice(0, 20));

  recalc();
  return true;
}

/**
 * Первичные якоря: берём последнюю пару чередующихся фракталов.
 * Это только стартовая подсказка — дальше пользователь ставит свои свечи.
 */
function suggestAnchors(candles) {
  if ($('shAnchor').value && $('slAnchor').value) return;
  const tail = candles.slice(-120);
  if (tail.length < 10) return;

  const a = atr(tail, 14);
  const piv = findPivots(tail, 2);
  const seq = buildZigzag(piv, Number.isFinite(a) && a > 0 ? 2.5 * a : 0);
  if (seq.length < 2) return;

  // берём САМУЮ РАННЮЮ пару: правилам нужен разбег после якорей,
  // с последней парой им просто негде отработать
  const x = seq[0], y = seq[1];
  const hi = x.type === 'high' ? x : y;
  const lo = x.type === 'low' ? x : y;
  $('shAnchor').value = toLocalInput(hi.t);
  $('slAnchor').value = toLocalInput(lo.t);
}

function lastNBars(n) {
  if (!state.raw.length) return;
  const slice = state.raw.slice(-n);
  $('dateFrom').value = toLocalInput(slice[0].t);
  $('dateTo').value = toLocalInput(state.raw[state.raw.length - 1].t);
  recalc();
}

/* ------------------------------------------------------------- демо-данные */

function demoData() {
  let seed = 20260806;
  const rnd = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };

  const n = 128;
  const end = Math.floor(Date.now() / H4_MS) * H4_MS;
  const rows = [];
  let price = 3820;
  // масштаб золота: H4-свеча ходит единицами, а не сотнями, как крипта
  const phases = [
    { bars: 45, drift: 2.6, vol: 4.2 },
    { bars: 25, drift: -1.8, vol: 3.8 },
    { bars: 40, drift: 3.0, vol: 4.6 },
    { bars: 18, drift: -1.5, vol: 3.3 },
  ];

  let i = 0;
  for (const ph of phases) {
    for (let b = 0; b < ph.bars && i < n; b++, i++) {
      const t = end - (n - 1 - i) * H4_MS;
      const o = price;
      const shock = (rnd() - 0.5) * ph.vol * 2;
      const c = o + ph.drift * (0.4 + rnd()) * 0.6 + shock;
      const wick = ph.vol * (0.3 + rnd() * 0.9);
      const h = Math.max(o, c) + wick * rnd();
      const l = Math.min(o, c) - wick * rnd();
      rows.push([
        new Date(t).toISOString().slice(0, 16).replace('T', ' '),
        o.toFixed(2), h.toFixed(2), l.toFixed(2), c.toFixed(2),
        Math.round(500 + rnd() * 2500),
      ].join(','));
      price = c;
    }
  }
  return 'datetime,open,high,low,close,volume\n' + rows.join('\n');
}

/* -------------------------------------------------------------- сохранение */

function saveCfg() {
  const cfg = {
    symbol: $('symbol').value, digits: $('digits').value,
    strength: $('strength').value, minMove: $('minMove').value,
    buffer: $('buffer').value, entryFib: $('entryFib').value,
    deposit: $('deposit').value, riskPct: $('riskPct').value,
    aggregate: $('aggregate').checked, autoRecalc: $('autoRecalc').checked,
    webhookUrl: $('webhookUrl').value, webhookToken: $('webhookToken').value,
    csv: $('csvInput').value.length < 400000 ? $('csvInput').value : '',
  };
  try { localStorage.setItem(LS_KEY, JSON.stringify(cfg)); } catch (_) { /* квота */ }
}

function loadCfg() {
  let cfg;
  try { cfg = JSON.parse(localStorage.getItem(LS_KEY) || 'null'); } catch (_) { return null; }
  if (!cfg) return null;
  const set = (id, v) => { if (v !== undefined && v !== null) $(id).value = v; };
  set('symbol', cfg.symbol); set('digits', cfg.digits);
  set('strength', cfg.strength); set('minMove', cfg.minMove);
  set('buffer', cfg.buffer); set('entryFib', cfg.entryFib);
  set('deposit', cfg.deposit); set('riskPct', cfg.riskPct);
  set('webhookUrl', cfg.webhookUrl); set('webhookToken', cfg.webhookToken);
  if (typeof cfg.aggregate === 'boolean') $('aggregate').checked = cfg.aggregate;
  if (typeof cfg.autoRecalc === 'boolean') $('autoRecalc').checked = cfg.autoRecalc;
  if (cfg.csv) $('csvInput').value = cfg.csv;
  return cfg;
}

/* ------------------------------------------------------------------ события */

$('btnParse').addEventListener('click', () => loadData($('csvInput').value));

$('btnDemo').addEventListener('click', () => {
  $('csvInput').value = demoData();
  $('symbol').value = $('symbol').value || 'BTCUSDT';
  loadData($('csvInput').value);
});

['swingHigh', 'swingLow'].forEach((id) =>
  $(id).addEventListener('input', () => { state.manualEdited = true; }));

$('btnResetZone').addEventListener('click', () => {
  state.manualEdited = false;
  $('swingHigh').value = '';
  $('swingLow').value = '';
  recalc();
});

$('btnClear').addEventListener('click', () => {
  $('csvInput').value = '';
  state.raw = []; state.window = []; state.zone = null; state.pivots = [];
  state.manualEdited = false;
  $('dataBadge').textContent = 'нет данных';
  $('dataBadge').className = 'badge warn';
  $('swingHigh').value = ''; $('swingLow').value = '';
  setStatus('parseStatus', 'Данные очищены.', 'info');
  setStatus('windowStatus', '—', 'info');
  renderZone(null);
  drawChart();
});

$('btnFile').addEventListener('click', () => $('fileInput').click());
$('fileInput').addEventListener('change', (e) => {
  const f = e.target.files[0];
  if (!f) return;
  const r = new FileReader();
  r.onload = () => { $('csvInput').value = r.result; loadData(r.result); };
  r.onerror = () => setStatus('parseStatus', 'Не удалось прочитать файл.', 'err');
  r.readAsText(f);
  e.target.value = '';
});

$('btnFullRange').addEventListener('click', () => {
  if (!state.raw.length) return;
  $('dateFrom').value = toLocalInput(state.raw[0].t);
  $('dateTo').value = toLocalInput(state.raw[state.raw.length - 1].t);
  recalc();
});

document.querySelectorAll('[data-bars]').forEach((b) =>
  b.addEventListener('click', () => lastNBars(parseInt(b.dataset.bars, 10))));

$('btnCalc').addEventListener('click', recalc);

['dateFrom', 'dateTo', 'strength', 'minMove', 'buffer', 'entryFib',
  'deposit', 'riskPct', 'digits', 'symbol', 'swingHigh', 'swingLow']
  .forEach((id) => $(id).addEventListener('change', () => {
    if ($('autoRecalc').checked && state.raw.length) recalc();
  }));

$('btnCopyPayload').addEventListener('click', async () => {
  const raw = $('payloadBox').dataset.raw;
  if (!raw) return;
  try {
    await navigator.clipboard.writeText(raw);
    setStatus('sendStatus', 'JSON скопирован в буфер обмена.', 'ok');
  } catch (_) {
    setStatus('sendStatus', 'Буфер обмена недоступен — скопируйте вручную.', 'err');
  }
});

$('btnSaveCfg').addEventListener('click', () => {
  saveCfg();
  setStatus('sendStatus', 'Настройки сохранены в localStorage этого браузера.', 'ok');
});

$('btnSend').addEventListener('click', async () => {
  const url = $('webhookUrl').value.trim();
  const raw = $('payloadBox').dataset.raw;
  if (!url) { setStatus('sendStatus', 'Укажите URL вебхука бота.', 'err'); return; }
  if (!raw) { setStatus('sendStatus', 'Сначала рассчитайте зону.', 'err'); return; }

  const btn = $('btnSend');
  btn.disabled = true;
  setStatus('sendStatus', 'Отправка…', 'info');
  saveCfg();

  const headers = { 'Content-Type': 'application/json' };
  const token = $('webhookToken').value.trim();
  if (token) headers['X-Auth-Token'] = token;

  try {
    const res = await fetch(url, { method: 'POST', headers, body: raw });
    const text = await res.text();
    setStatus('sendStatus', `HTTP ${res.status} · ответ: ${text.slice(0, 400) || '(пусто)'}`,
      res.ok ? 'ok' : 'err');
  } catch (err) {
    setStatus('sendStatus',
      `Ошибка сети: ${err.message}. Проверьте, что бот доступен по HTTPS и разрешает CORS для этого домена.`,
      'err');
  } finally {
    btn.disabled = false;
  }
});

$('btnAnalyze').addEventListener('click', runAnalysis);
$('method').addEventListener('change', setMethod);
['shAnchor', 'slAnchor'].forEach((id) =>
  $(id).addEventListener('change', () => { if (state.raw.length) recalc(); }));
$('btnTv').addEventListener('click', loadTradingView);
['tvSymbol', 'tvInterval'].forEach((id) =>
  $(id).addEventListener('change', () => { if (window.TradingView) loadTradingView(); }));

/* --- события режима скриншота --- */

document.querySelectorAll('#modeTabs .tab').forEach((t) =>
  t.addEventListener('click', () => setMode(t.dataset.mode)));

document.querySelectorAll('.marker').forEach((b) =>
  b.addEventListener('click', () => setActiveMarker(b.dataset.point)));

$('dropzone').addEventListener('click', () => $('shotFile').click());
$('shotFile').addEventListener('change', (e) => {
  readShotFile(e.target.files[0]);
  e.target.value = '';
});

['dragenter', 'dragover'].forEach((ev) =>
  $('dropzone').addEventListener(ev, (e) => {
    e.preventDefault();
    $('dropzone').classList.add('over');
  }));
['dragleave', 'drop'].forEach((ev) =>
  $('dropzone').addEventListener(ev, (e) => {
    e.preventDefault();
    $('dropzone').classList.remove('over');
  }));
$('dropzone').addEventListener('drop', (e) => readShotFile(e.dataTransfer.files[0]));

// вставка скриншота из буфера обмена — основной сценарий
window.addEventListener('paste', (e) => {
  if (state.mode !== 'screenshot') return;
  const item = [...(e.clipboardData?.items || [])].find((i) => i.type.startsWith('image/'));
  if (!item) return;
  e.preventDefault();
  readShotFile(item.getAsFile());
});

['calPriceA', 'calPriceB', 'shotTime'].forEach((id) =>
  $(id).addEventListener('change', () => {
    if (state.mode === 'screenshot') { recalc(); shotProgress(); }
  }));

$('btnShotReset').addEventListener('click', () => {
  state.shot.pts = {};
  setActiveMarker('calA');
  recalc();
  shotProgress();
});

$('btnShotClear').addEventListener('click', () => {
  state.shot.img = null;
  state.shot.pts = {};
  $('dropzone').hidden = false;
  $('shotSteps').hidden = true;
  $('dataBadge').textContent = 'нет скриншота';
  $('dataBadge').className = 'badge warn';
  setStatus('shotStatus', 'Скриншот убран.', 'info');
  recalc();
});

/* --------------------------------------------------------------- запуск */

(function init() {
  const cfg = loadCfg();

  // Дашборд и бот раздаются одним сервисом, поэтому вебхук по умолчанию
  // указывает на тот же origin — запрос идёт без CORS.
  if (!$('webhookUrl').value && location.protocol.startsWith('http')) {
    $('webhookUrl').value = location.origin + '/signal';
  }

  if (cfg && cfg.csv) {
    loadData(cfg.csv);
  } else {
    $('csvInput').value = demoData();
    loadData($('csvInput').value);
  }
})();
