/**
 * Разбор скриншота графика на свечи.
 *
 * Модель на сервере читает подписи ценовой шкалы — это текст, и она с ним
 * справляется. Координаты она оценивает плохо, поэтому пиксели считаем здесь:
 * цена одной свечи должна быть точной до пикселя, иначе стоп поедет.
 *
 * Алгоритм без магии:
 *   1. классифицируем каждый пиксель как «тело свечи» по насыщенности цвета;
 *   2. колонки с телами группируем в свечи — между свечами есть зазор;
 *   3. внутри свечи берём верх и низ окрашенных пикселей: это high и low,
 *      границы плотной части — open и close;
 *   4. цвет тела задаёт направление, а значит порядок open / close;
 *   5. пиксели переводим в цену по калибровке от ценовой шкалы.
 *
 * Что этот подход не умеет: читать графики линиями и барами (нужны свечи),
 * различать наложенные индикаторы поверх свечей и восстанавливать время свечей —
 * оно берётся из таймфрейма и времени последней свечи.
 */

/** Насыщенный ли пиксель — фон и сетка обычно серые. */
function isVivid(r, g, b) {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  return max - min > 28 && max > 45;
}

/** К какому классу отнести пиксель: рост, падение или фон. */
function classify(r, g, b) {
  if (!isVivid(r, g, b)) return 0;
  if (g > r + 16 && g > b) return 1;                  // зелёный — рост
  if (r > g + 16 && (r > b || b > g)) return -1;       // красный / малиновый — падение
  return 0;
}

/**
 * Найти свечи на изображении.
 * @param {ImageData} img данные всей картинки
 * @param {{x0:number,x1:number,y0:number,y1:number}} area область поиска в пикселях
 * @returns {{columns:Array, candles:Array}}
 */
function scanCandles(img, area) {
  const { width, data } = img;
  const x0 = Math.max(0, Math.floor(area.x0));
  const x1 = Math.min(img.width, Math.ceil(area.x1));
  const y0 = Math.max(0, Math.floor(area.y0));
  const y1 = Math.min(img.height, Math.ceil(area.y1));

  // по каждой колонке: границы окрашенных пикселей и преобладающий класс
  const columns = [];
  for (let x = x0; x < x1; x++) {
    let top = -1, bottom = -1, up = 0, down = 0;
    for (let y = y0; y < y1; y++) {
      const p = (y * width + x) * 4;
      if (data[p + 3] < 128) continue;
      const cls = classify(data[p], data[p + 1], data[p + 2]);
      if (!cls) continue;
      if (top < 0) top = y;
      bottom = y;
      if (cls > 0) up++; else down++;
    }
    columns.push({ x, top, bottom, up, down, filled: up + down });
  }

  // группируем соседние непустые колонки — это тела свечей вместе с тенями
  const groups = [];
  let cur = null;
  for (const col of columns) {
    if (col.filled > 0) {
      if (!cur) cur = { cols: [] };
      cur.cols.push(col);
    } else if (cur) {
      groups.push(cur);
      cur = null;
    }
  }
  if (cur) groups.push(cur);

  // ширина свечи — медиана ширин групп: по ней отсекаем мусор и склейки
  const widths = groups.map((g) => g.cols.length).sort((a, b) => a - b);
  const medianW = widths.length ? widths[Math.floor(widths.length / 2)] : 0;

  const candles = [];
  for (const g of groups) {
    // слишком узкие группы — это сетка или подписи, а не свеча
    if (medianW >= 3 && g.cols.length < Math.max(2, medianW * 0.4)) continue;

    const wickTop = Math.min(...g.cols.map((k) => (k.top < 0 ? Infinity : k.top)));
    const wickBottom = Math.max(...g.cols.map((k) => k.bottom));
    if (!Number.isFinite(wickTop) || wickBottom < 0) continue;

    // Тело — это то, что ШИРОКОЕ, а не то, что высокое. Считаем ширину каждой
    // строки внутри свечи: у тени это один-два пикселя, у тела — вся свеча.
    const gx0 = g.cols[0].x;
    const gx1 = g.cols[g.cols.length - 1].x;
    const rowWidth = new Int32Array(wickBottom - wickTop + 1);
    for (let y = wickTop; y <= wickBottom; y++) {
      let w = 0;
      for (let x = gx0; x <= gx1; x++) {
        const p = (y * width + x) * 4;
        if (data[p + 3] >= 128 && classify(data[p], data[p + 1], data[p + 2])) w++;
      }
      rowWidth[y - wickTop] = w;
    }

    const maxRow = Math.max(...rowWidth);
    const bodyMin = Math.max(2, maxRow * 0.6);
    let bodyTop = -1, bodyBottom = -1;
    for (let k = 0; k < rowWidth.length; k++) {
      if (rowWidth[k] >= bodyMin) {
        if (bodyTop < 0) bodyTop = wickTop + k;
        bodyBottom = wickTop + k;
      }
    }
    // доджи: тела нет вовсе — открытие и закрытие совпадают
    if (bodyTop < 0) { bodyTop = wickTop; bodyBottom = wickBottom; }

    const up = g.cols.reduce((a, k) => a + k.up, 0);
    const down = g.cols.reduce((a, k) => a + k.down, 0);
    const bull = up >= down;

    candles.push({
      xCenter: (g.cols[0].x + g.cols[g.cols.length - 1].x) / 2,
      wickTop, wickBottom, bodyTop, bodyBottom, bull,
      width: g.cols.length,
    });
  }

  return { columns, candles, medianWidth: medianW };
}

/**
 * Калибровка «пиксель → цена» по двум подписям ценовой шкалы.
 * @returns {(y:number)=>number} функция перевода, или null
 */
function priceMapper(labels, imageHeight) {
  if (!labels || labels.length < 2) return null;

  // берём самую верхнюю и самую нижнюю подписи — так шаг максимален,
  // а значит ошибка в один пиксель меньше искажает цену
  const sorted = [...labels].sort((a, b) => a.y_fraction - b.y_fraction);
  const a = sorted[0];
  const b = sorted[sorted.length - 1];

  const ya = a.y_fraction * imageHeight;
  const yb = b.y_fraction * imageHeight;
  if (Math.abs(yb - ya) < 4 || a.price === b.price) return null;

  const k = (b.price - a.price) / (yb - ya);       // цена на пиксель, обычно < 0
  return (y) => a.price + (y - ya) * k;
}

/**
 * Свечи в пикселях → свечи в ценах и времени.
 * @param {Array} candles результат scanCandles
 * @param {(y:number)=>number} toPrice калибровка
 * @param {number} lastTime время последней свечи, мс
 * @param {number} stepMs шаг таймфрейма, мс
 */
function candlesToSeries(candles, toPrice, lastTime, stepMs) {
  const n = candles.length;
  return candles.map((k, i) => {
    const high = toPrice(k.wickTop);
    const low = toPrice(k.wickBottom);
    const bodyHi = toPrice(k.bodyTop);
    const bodyLo = toPrice(k.bodyBottom);
    return {
      t: lastTime - (n - 1 - i) * stepMs,
      o: k.bull ? bodyLo : bodyHi,
      h: high,
      l: low,
      c: k.bull ? bodyHi : bodyLo,
      fromImage: true,
    };
  });
}

/** Оценка качества чтения — её видит пользователь до того, как поверит цифрам. */
function readQuality(series, medianWidth) {
  const problems = [];
  if (series.length < 10) problems.push(`распознано всего ${series.length} свечей`);
  if (medianWidth < 3) problems.push('свечи уже 3 пикселей — цены будут грубыми');

  const broken = series.filter((k) =>
    !(k.h >= Math.max(k.o, k.c) && k.l <= Math.min(k.o, k.c))).length;
  if (broken) problems.push(`${broken} свечей с противоречивыми OHLC`);

  return problems;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { scanCandles, priceMapper, candlesToSeries, readQuality, classify };
}
