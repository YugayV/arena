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

/* ------------------------------------------------- расчёт площади и сделки */

function computeZone() {
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
    const a = seq[seq.length - 2], b = seq[seq.length - 1];
    hi = a.type === 'high' ? a : b;
    lo = a.type === 'low' ? a : b;
    legDir = b.type === 'high' ? 'up' : 'down';
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

  const high = useManual ? manualHigh : hi.price;
  const low = useManual ? manualLow : lo.price;
  const R = high - low;
  if (!(R > 0)) return null;

  const bias = legDir === 'up' ? 'long' : 'short';
  const eq = low + R / 2;
  const last = c[c.length - 1];

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

  const posInRange = (last.c - low) / R;
  const location = Math.abs(last.c - eq) / R < 0.02 ? 'equilibrium'
    : (last.c > eq ? 'premium' : 'discount');

  const fibs = [0, 0.236, 0.382, 0.5, 0.618, 0.705, 0.79, 1, 1.272].map((f) => ({
    f, price: lvl(f), ote: f >= 0.618 && f <= 0.79, eq: f === 0.5,
  }));

  return {
    symbol: $('symbol').value.trim() || 'UNKNOWN',
    bars: c.length,
    from: c[0].t, to: last.t,
    high, low, range: R,
    highPivot: useManual ? null : hi,
    lowPivot: useManual ? null : lo,
    manual: useManual,
    bias, legDir, eq, last,
    entry, entryF, stop, tp1, tp2,
    riskPerUnit, riskMoney, qty, rr1, rr2,
    invalidation: bias === 'long' ? low : high,
    posInRange, location, atr: a, minMoveAtr, minMoveAbs, fibs,
    outsideZone: last.c > high || last.c < low,
    premium: [eq, high], discount: [low, eq],
    ote: bias === 'long' ? [lvl(0.79), lvl(0.618)] : [lvl(0.618), lvl(0.79)],
  };
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
    $('payloadBox').textContent = '— рассчитайте зону, чтобы получить payload —';
    $('promptBox').textContent = '— рассчитайте зону, чтобы получить промпт —';
    return;
  }

  badge.className = 'bias ' + z.bias;
  badge.textContent = z.bias === 'long' ? '↑ bias: LONG (откат в discount)' : '↓ bias: SHORT (откат в premium)';

  $('tHigh').textContent = fmt(z.high);
  $('tLow').textContent = fmt(z.low);
  $('tHighDate').textContent = z.manual ? 'задано вручную' : fmtDate(z.highPivot.t);
  $('tLowDate').textContent = z.manual ? 'задано вручную' : fmtDate(z.lowPivot.t);
  $('tRange').textContent = fmt(z.range);
  $('tRangePct').textContent = ((z.range / z.low) * 100).toFixed(2) + '% от нижней границы';
  $('tEq').textContent = fmt(z.eq);
  $('tLast').textContent = fmt(z.last.c);
  $('tLastZone').textContent =
    `${z.location} · ${(z.posInRange * 100).toFixed(1)}% диапазона`;
  $('tAtr').textContent = fmt(z.atr);
  $('tAtrPct').textContent = Number.isFinite(z.atr)
    ? ((z.atr / z.range) * 100).toFixed(1) + '% от высоты зоны' : '—';

  $('pEntry').textContent = fmt(z.entry);
  $('pEntryFib').textContent = `фибо ${z.entryF.toFixed(3)} · ${pct(((z.entry - z.last.c) / z.last.c) * 100)} от цены`;
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
    const dist = ((f.price - z.last.c) / z.last.c) * 100;
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
  if (z.outsideZone) {
    warns.push(z.last.c > z.high
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

  const payload = buildPayload(z);
  $('payloadBox').innerHTML = highlightJson(JSON.stringify(payload, null, 2));
  $('promptBox').textContent = buildPrompt(z, payload);
  $('promptBox').dataset.raw = $('promptBox').textContent;
  $('payloadBox').dataset.raw = JSON.stringify(payload, null, 2);
}

/* ------------------------------------------------------------------ payload */

function buildPayload(z) {
  const d = digits();
  const iso = (ms) => new Date(ms).toISOString();

  return {
    schema: 'swing-zone/v1',
    generated_at: new Date().toISOString(),
    source: 'swing-zone-dashboard',
    symbol: z.symbol,
    timeframe: '4h',
    window: {
      from: iso(z.from),
      to: iso(z.to),
      candles: z.bars,
    },
    swing: {
      high: {
        price: round(z.high, d),
        time: z.manual ? null : iso(z.highPivot.t),
        source: z.manual ? 'manual' : 'fractal',
      },
      low: {
        price: round(z.low, d),
        time: z.manual ? null : iso(z.lowPivot.t),
        source: z.manual ? 'manual' : 'fractal',
      },
      leg_direction: z.legDir,
      strength_bars: Math.round(num('strength', 2)),
      min_impulse_atr: z.minMoveAtr,
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
      last_close: round(z.last.c, d),
      last_candle_time: iso(z.last.t),
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

function buildPrompt(z, payload) {
  return `Ты — торговый ИИ-агент. Работаешь по структуре рынка на таймфрейме H4.
Тебе передана размеченная «площадь работы» между свинг-хай и свинг-лоу.

ДАННЫЕ СЕТАПА:
${JSON.stringify(payload, null, 2)}

ПРАВИЛА:
1. Направление сделки задаётся полем bias и не меняется тобой: ${z.bias.toUpperCase()}.
2. Вход разрешён только по лимитной цене trade.entry внутри зоны OTE ${fmt(z.ote[0])} – ${fmt(z.ote[1])}.
3. Стоп trade.stop_loss не двигать. Сделка отменяется при пробое trade.invalidation.
4. Отклоняй сетап (skip), если R:R первой цели < 2.0, риск > 2% или данные старше 8 часов.
5. Если цена ещё не дошла до зоны входа — ответ wait, укажи ценовой триггер.
6. Считай, что бот исполняет решение автоматически: не предлагай действий вне схемы ответа.

ФОРМАТ ОТВЕТА — строго JSON, без markdown:
{
  "decision": "enter" | "wait" | "skip",
  "confidence": 0.0-1.0,
  "side": "buy" | "sell" | null,
  "entry": number | null,
  "stop_loss": number | null,
  "take_profit": [number, ...],
  "position_size": number | null,
  "trigger": "условие, при котором ордер активируется (для wait)",
  "reasons": ["краткие аргументы по чек-листу"],
  "risks": ["что может сломать сетап"]
}`;
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

function drawChart() {
  const dpr = window.devicePixelRatio || 1;
  const cssW = canvas.clientWidth || 800;
  const cssH = canvas.clientHeight || 400;
  canvas.width = Math.round(cssW * dpr);
  canvas.height = Math.round(cssH * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, cssW, cssH);

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
  applyWindow();
  state.zone = computeZone();
  renderZone(state.zone);
  drawChart();

  const z = state.zone;
  $('chartTitle').textContent = `${$('symbol').value.trim() || 'Инструмент'} · H4`;
  $('chartSub').textContent = z
    ? `${z.bars} свечей · зона ${fmt(z.low)} – ${fmt(z.high)} · высота ${fmt(z.range)}`
    : 'Недостаточно данных в выбранном окне';
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

  const errNote = errors.length ? ` · пропущено строк: ${errors.length}` : '';
  setStatus('parseStatus', `Загружено ${final.length} свечей${note}${errNote}`,
    errors.length ? 'info' : 'ok');
  if (errors.length) console.warn('Пропущенные строки:', errors.slice(0, 20));

  recalc();
  return true;
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
  let price = 96000;
  // фазы: рост → коррекция → импульс вверх → откат в зону OTE
  const phases = [
    { bars: 45, drift: 260, vol: 420 },
    { bars: 25, drift: -180, vol: 380 },
    { bars: 40, drift: 300, vol: 460 },
    { bars: 18, drift: -150, vol: 330 },
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

$('btnCopyPrompt').addEventListener('click', async () => {
  const raw = $('promptBox').dataset.raw;
  if (!raw) return;
  try {
    await navigator.clipboard.writeText(raw);
    setStatus('sendStatus', 'Промпт для ИИ-агента скопирован.', 'ok');
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
