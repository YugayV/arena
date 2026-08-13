/**
 * Разбор котировок из CSV — один код для дашборда и для бэктестера.
 *
 * Автор: Vitaliy Yugay · vamp.09.94@gmail.com · https://github.com/YugayV
 *
 * Зачем отдельный модуль. Позиционный разбор («первое поле — время, дальше
 * O,H,L,C») ломается на реальных выгрузках, причём молча. Пример —
 * investing.com: у него порядок колонок
 *
 *     Date, Price, Open, High, Low, Vol., Change %
 *
 * то есть ЗАКРЫТИЕ идёт вторым, до открытия. Позиционный парсер прочитает
 * close как open, open как high, high как low — и построит структуру по
 * несуществующему графику, не выдав ни одной ошибки. Поэтому здесь колонки
 * определяются по заголовку, а позиционный разбор остаётся только запасным
 * вариантом для файлов без шапки.
 *
 * Поддерживаются выгрузки:
 *   investing.com   "Date","Price","Open","High","Low","Vol.","Change %"
 *   TradingView     time,open,high,low,close,Volume
 *   MetaTrader 5    <DATE>\t<TIME>\t<OPEN>\t<HIGH>\t<LOW>\t<CLOSE>\t...
 *   Dukascopy       Gmt time,Open,High,Low,Close,Volume
 *   произвольный    время,O,H,L,C без заголовка
 */

/* --------------------------------------------------------------- поля строки */

/**
 * Деление строки на поля по правилам CSV: разделитель внутри кавычек —
 * это данные, а не разделитель. Без этого "3,412.50" превращается в два поля.
 */
function csvSplit(line, sep) {
  const out = [];
  let cur = '';
  let quoted = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; }   // экранированная кавычка
        else quoted = false;
      } else cur += ch;
    } else if (ch === '"') {
      quoted = true;
    } else if (ch === sep) {
      out.push(cur.trim()); cur = '';
    } else cur += ch;
  }
  out.push(cur.trim());
  return out;
}

/** Разделитель определяем по всему файлу, а не по одной строке. */
function detectSep(lines) {
  const cands = [',', ';', '\t', '|'];
  let best = ',', bestScore = -1;
  for (const sep of cands) {
    const counts = lines.slice(0, 30).map((l) => csvSplit(l, sep).length);
    const min = Math.min(...counts);
    if (min < 2) continue;
    // ровный файл: во всех строках одинаковое число полей
    const even = counts.every((n) => n === counts[0]);
    const score = min * (even ? 10 : 1);
    if (score > bestScore) { bestScore = score; best = sep; }
  }
  if (bestScore < 0) return /\s{2,}|\t/.test(lines[0] || '') ? /\s+/ : ',';
  return best;
}

/* -------------------------------------------------------------------- числа */

/**
 * Число из ячейки. Разделитель тысяч и десятичный разделитель различаем по
 * позиции: тот, что стоит последним, — десятичный. "3,412.50" -> 3412.5,
 * "3.412,50" -> 3412.5, "3 412,50" -> 3412.5.
 */
function toNum(raw) {
  if (raw === null || raw === undefined) return NaN;
  let s = String(raw).trim().replace(/^["']|["']$/g, '').replace(/ |\s/g, '');
  if (!s || s === '-' || s === '—' || s === 'null' || s === 'n/a') return NaN;

  s = s.replace(/%$/, '');

  const lastComma = s.lastIndexOf(',');
  const lastDot = s.lastIndexOf('.');

  if (lastComma >= 0 && lastDot >= 0) {
    // есть оба: последний — десятичный, первый — разделитель групп
    if (lastComma > lastDot) s = s.replace(/\./g, '').replace(',', '.');
    else s = s.replace(/,/g, '');
  } else if (lastComma >= 0) {
    // только запятая: группы (1,234 / 1,234,567) или десятичная (1,5)
    s = /^-?\d{1,3}(,\d{3})+$/.test(s) ? s.replace(/,/g, '') : s.replace(',', '.');
  }

  const n = Number(s);
  return Number.isFinite(n) ? n : NaN;
}

/* --------------------------------------------------------------------- даты */

const MONTHS = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
  jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
  янв: 0, фев: 1, мар: 2, апр: 3, ма: 4, июн: 5,
  июл: 6, авг: 7, сен: 8, окт: 9, ноя: 10, дек: 11,
};

/** Разбор дня/месяца/года в известном порядке. Время — отдельным аргументом. */
function buildTime(y, m, d, timeStr) {
  let hh = 0, mm = 0, ss = 0;
  if (timeStr) {
    const p = String(timeStr).match(/(\d{1,2}):(\d{2})(?::(\d{2}))?/);
    if (p) { hh = +p[1]; mm = +p[2]; ss = +(p[3] || 0); }
  }
  if (y < 100) y += y < 70 ? 2000 : 1900;
  const t = Date.UTC(y, m, d, hh, mm, ss);
  // Date.UTC не проверяет переполнение: 31 февраля молча станет 3 марта
  const back = new Date(t);
  if (back.getUTCFullYear() !== y || back.getUTCMonth() !== m || back.getUTCDate() !== d) return NaN;
  return t;
}

/**
 * Определение порядка day/month по всему файлу.
 * Возвращает 'dmy', 'mdy' или 'ambiguous' — когда обе первые группы <= 12
 * во всех строках и различить нельзя.
 */
function detectDayMonthOrder(tokens) {
  let seen = 0;
  let sawFirstOver12 = false;
  let sawSecondOver12 = false;
  for (const tok of tokens) {
    const m = String(tok).match(/^(\d{1,2})[./-](\d{1,2})[./-](\d{2,4})/);
    if (!m) continue;
    seen++;
    if (+m[1] > 12) sawFirstOver12 = true;
    if (+m[2] > 12) sawSecondOver12 = true;
  }
  // формата с косыми в файле нет вовсе (ISO, YYYY.MM.DD, текстовый месяц)
  if (!seen) return 'n/a';
  if (sawFirstOver12 && !sawSecondOver12) return 'dmy';
  if (sawSecondOver12 && !sawFirstOver12) return 'mdy';
  if (sawFirstOver12 && sawSecondOver12) return 'broken';
  return 'ambiguous';
}

/**
 * Время свечи из одной или двух ячеек.
 * order — результат detectDayMonthOrder, нужен только для формата с косыми.
 */
function parseTime(dateCell, timeCell, order) {
  let s = String(dateCell === null || dateCell === undefined ? '' : dateCell)
    .trim().replace(/^["']|["']$/g, '');
  if (!s) return NaN;

  // unix
  if (/^\d{9,14}$/.test(s) && !timeCell) {
    const n = parseInt(s, 10);
    return s.length > 11 ? n : n * 1000;
  }

  // ISO целиком: 2026-08-13T04:00:00Z / 2026-08-13 04:00
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})(?:[T ](.+))?$/);
  if (m) return buildTime(+m[1], +m[2] - 1, +m[3], m[4] || timeCell);

  // 2026.08.13 — MetaTrader и TradingView
  m = s.match(/^(\d{4})[./](\d{1,2})[./](\d{1,2})(?:[T ](.+))?$/);
  if (m) return buildTime(+m[1], +m[2] - 1, +m[3], m[4] || timeCell);

  // "Aug 13, 2026" / "13 авг 2026" — текстовый месяц
  m = s.match(/^([A-Za-zА-Яа-я]{3,})\.?\s+(\d{1,2}),?\s+(\d{4})/);
  if (m) {
    const mon = MONTHS[m[1].slice(0, 3).toLowerCase()];
    if (mon !== undefined) return buildTime(+m[3], mon, +m[2], timeCell);
  }
  m = s.match(/^(\d{1,2})\s+([A-Za-zА-Яа-я]{3,})\.?,?\s+(\d{4})/);
  if (m) {
    const mon = MONTHS[m[2].slice(0, 3).toLowerCase()];
    if (mon !== undefined) return buildTime(+m[3], mon, +m[1], timeCell);
  }

  // 08/13/2026 или 13.08.2026 — порядок берём из разведки по файлу
  m = s.match(/^(\d{1,2})[./-](\d{1,2})[./-](\d{2,4})(?:[T ](.+))?$/);
  if (m) {
    const a = +m[1], b = +m[2];
    const dmy = order === 'dmy' || (order === 'ambiguous' && false);
    const day = dmy ? a : b;
    const mon = dmy ? b : a;
    return buildTime(+m[3], mon - 1, day, m[4] || timeCell);
  }

  const t = Date.parse(s.replace(' ', 'T'));
  return Number.isFinite(t) ? t : NaN;
}

/* ------------------------------------------------------------------ колонки */

const ALIASES = {
  time: ['time', 'date', 'datetime', 'date time', 'gmt time', 'timestamp', 'local time',
    'дата', 'время', 'дата и время', '<date>'],
  clock: ['<time>'],
  open: ['open', 'откр', 'откр.', 'открытие', '<open>', 'o'],
  high: ['high', 'макс', 'макс.', 'максимум', '<high>', 'h'],
  low: ['low', 'мин', 'мин.', 'минимум', '<low>', 'l'],
  close: ['close', 'price', 'last', 'adj close', 'закр', 'закр.', 'закрытие', 'цена',
    'последняя', '<close>', 'c'],
  vol: ['vol', 'vol.', 'volume', 'объем', 'объём', '<vol>', '<tickvol>'],
};

function normHeader(h) {
  return String(h).trim().toLowerCase()
    .replace(/^["']|["']$/g, '')
    .replace(/ /g, ' ')
    .trim();
}

/** Сопоставление шапки с ролями колонок. null — шапки нет. */
function mapColumns(cells) {
  const idx = {};
  let hits = 0;

  cells.forEach((raw, i) => {
    const h = normHeader(raw);
    if (!h) return;
    for (const [role, names] of Object.entries(ALIASES)) {
      if (idx[role] !== undefined) continue;
      if (names.includes(h)) { idx[role] = i; hits++; return; }
    }
  });

  // шапкой считаем строку только если нашли и время, и минимум high/low/close
  const enough = idx.time !== undefined && idx.high !== undefined &&
    idx.low !== undefined && idx.close !== undefined;
  return enough ? { idx, hits } : null;
}

/* ------------------------------------------------------------------- разбор */

/**
 * @param {string} text содержимое файла
 * @returns {{candles: Array, errors: string[], meta: object}}
 */
function parseCandles(text) {
  const errors = [];
  const rawLines = String(text).split(/\r?\n/);
  const lines = rawLines.filter((l) => {
    const t = l.trim();
    return t && !t.startsWith('#') && !t.startsWith('//');
  });

  if (!lines.length) {
    return { candles: [], errors: ['файл пуст'], meta: { layout: 'none' } };
  }

  const sep = detectSep(lines);
  const rows = lines.map((l) => (sep instanceof RegExp
    ? l.trim().split(sep).map((x) => x.trim())
    : csvSplit(l, sep)));

  // шапка
  const mapped = mapColumns(rows[0]);
  const body = mapped ? rows.slice(1) : rows;
  const layout = mapped ? 'header' : 'positional';

  if (!mapped) {
    // без шапки первая строка может всё равно быть подписями — отсеется ниже
    const looksTextual = rows[0].some((c) => /[a-zA-Zа-яА-Я]{3,}/.test(c));
    if (looksTextual && rows.length > 1) {
      errors.push('шапка не распознана — колонки читаются по порядку время,O,H,L,C');
    }
  }

  // порядок день/месяц — по всему столбцу дат сразу
  const timeCol = mapped ? mapped.idx.time : 0;
  const order = detectDayMonthOrder(body.map((r) => r[timeCol]));
  if (order === 'broken') errors.push('в столбце дат смешаны разные форматы');

  const out = [];
  let bad = 0;

  body.forEach((p, i) => {
    if (p.length < 2) return;
    const lineNo = i + (mapped ? 2 : 1);

    let t, o, h, l, c, v;

    if (mapped) {
      const clock = mapped.idx.clock !== undefined ? p[mapped.idx.clock] : null;
      t = parseTime(p[mapped.idx.time], clock, order);
      o = mapped.idx.open !== undefined ? toNum(p[mapped.idx.open]) : NaN;
      h = toNum(p[mapped.idx.high]);
      l = toNum(p[mapped.idx.low]);
      c = toNum(p[mapped.idx.close]);
      v = mapped.idx.vol !== undefined ? toNum(p[mapped.idx.vol]) : NaN;
      // выгрузки без открытия встречаются: подставляем закрытие предыдущей
      if (!Number.isFinite(o)) o = out.length ? out[out.length - 1].c : c;
    } else {
      let f = p;
      // MetaTrader без шапки: дата и время отдельными полями
      if (f.length >= 6 && /^\d{1,2}:\d{2}/.test(f[1])) f = [f[0] + ' ' + f[1], ...f.slice(2)];
      if (f.length < 5) { bad++; return; }
      t = parseTime(f[0], null, order);
      o = toNum(f[1]); h = toNum(f[2]); l = toNum(f[3]); c = toNum(f[4]);
      v = f.length > 5 ? toNum(f[5]) : NaN;
    }

    if (!Number.isFinite(t) || ![o, h, l, c].every(Number.isFinite)) {
      if (i === 0 && !mapped) return;                    // это была шапка
      bad++;
      if (errors.length < 8) errors.push(`строка ${lineNo}: не распознаны дата или цены`);
      return;
    }
    if (h < l) {
      bad++;
      if (errors.length < 8) errors.push(`строка ${lineNo}: high < low`);
      return;
    }

    out.push({
      t,
      o, c,
      h: Math.max(h, o, c),
      l: Math.min(l, o, c),
      v: Number.isFinite(v) ? v : null,
    });
  });

  // investing.com отдаёт свежие сверху — сортировка обязательна
  out.sort((a, b) => a.t - b.t);

  const dedup = [];
  for (const k of out) {
    if (dedup.length && dedup[dedup.length - 1].t === k.t) dedup[dedup.length - 1] = k;
    else dedup.push(k);
  }

  if (order === 'ambiguous' && dedup.length) {
    errors.push('в датах вида 05/08/2026 день и месяц неразличимы — принят порядок ' +
      'месяц/день (как у investing.com). Если это не так, выгрузите файл с ISO-датами');
  }

  return {
    candles: dedup,
    errors,
    meta: {
      layout,
      separator: sep instanceof RegExp ? 'пробелы' : sep === '\t' ? 'таб' : sep,
      dateOrder: order,
      columns: mapped ? mapped.idx : null,
      rows: body.length,
      bad,
    },
  };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { parseCandles, toNum, parseTime, csvSplit, detectDayMonthOrder };
}
