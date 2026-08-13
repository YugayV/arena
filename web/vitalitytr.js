/**
 * VitalityTr SM PRO — движок структуры рынка.
 *
 * Автор логики и разметки: Vitaliy Yugay · vamp.09.94@gmail.com
 * GitHub: https://github.com/YugayV
 *
 * Построчный перенос одноимённого индикатора Pine v6 на JS. Порядок вычислений
 * внутри свечи сохранён ровно таким, каким его исполняет Pine: блоки идут сверху
 * вниз, и если состояние сменилось в верхнем блоке, нижний блок отработает на
 * этой же свече. От этого зависят результаты, поэтому состояния разложены
 * последовательными if, а не switch.
 *
 * Схема работы:
 *
 *   ручные SH / SL
 *        ↓  одноразовая коррекция координат старта
 *   INITIAL ENGINE (состояния 0–10)  ← строит первую пару CSH + CSL по FIB 1
 *        ↓  последний подтверждённый свинг задаёт направление
 *   MASTER STRUCTURE                 ← bullish либо bearish, подтверждение по FIB 2
 *        ↓
 *   TSH / TSL                        ← временные экстремумы до подтверждения
 *        ↓
 *   AUTO SWING ENGINE                ← необязательный, по умолчанию выключен
 *
 * Возвращает состояние на последней свече плюс журнал событий.
 */

const VT_NA = null;
const vtIsNa = (v) => v === null || v === undefined || (typeof v === 'number' && Number.isNaN(v));

function runVitalityTr(c, shIdx, slIdx, opts = {}) {
  if (!Array.isArray(c) || c.length === 0) return null;
  if (shIdx == null || slIdx == null) return null;
  if (shIdx < 0 || slIdx < 0 || shIdx >= c.length || slIdx >= c.length) return null;

  const fib1Pct = (opts.fib50 ?? 51) / 100;
  const fib2Pct = (opts.fib618 ?? 50) / 100;
  const enableTSHTSL = opts.enableTSHTSL !== false;
  const enableAuto = opts.enableAuto === true;

  const s = {
    // --- 01 исходные данные -------------------------------------------------
    manualSH: VT_NA, manualSHBar: VT_NA, manualSHTime: VT_NA,
    manualSL: VT_NA, manualSLBar: VT_NA, manualSLTime: VT_NA,
    correctionDone: false, correctedSH: false, correctedSL: false,

    currentSH: VT_NA, currentSHBar: VT_NA, currentSHTime: VT_NA,
    currentSL: VT_NA, currentSLBar: VT_NA, currentSLTime: VT_NA,

    confirmedCSH: VT_NA, confirmedCSHBar: VT_NA, confirmedCSHTime: VT_NA,
    confirmedCSL: VT_NA, confirmedCSLBar: VT_NA, confirmedCSLTime: VT_NA,

    analysisStartBar: VT_NA,
    fib1: VT_NA, fib1Stopped: false, fib1EndBar: VT_NA,

    // --- замки жизненного цикла ---------------------------------------------
    manualInitialActive: true,
    initialProcessLocked: false,
    initialMasterHandoffDone: false,
    direction: 0,                 // 1 = BULLISH, -1 = BEARISH

    // --- INITIAL ENGINE -----------------------------------------------------
    firstState: 0,
    firstCSL: VT_NA, firstCSLBar: VT_NA, firstCSLTime: VT_NA, firstCSLRev: false,
    firstCSH: VT_NA, firstCSHBar: VT_NA, firstCSHTime: VT_NA, firstCSHRev: false,
    upAttemptBeforeFib1: false,
    downAttemptBeforeFib1: false,

    // --- master: bullish ----------------------------------------------------
    bullState: 0,
    bullCSHExt: VT_NA, bullCSHExtBar: VT_NA, bullCSHExtTime: VT_NA,
    bullCSHFib2: VT_NA, bullCSHRev: false, bullCSHFib2Reached: false,
    bullCSHWasBrokenForCSL: false,
    bullCSLExt: VT_NA, bullCSLExtBar: VT_NA, bullCSLExtTime: VT_NA,
    bullCSLFib2: VT_NA, bullCSLRev: false, bullCSLFib2Reached: false,

    // --- master: bearish ----------------------------------------------------
    bearState: 0,
    bearCSLExt: VT_NA, bearCSLExtBar: VT_NA, bearCSLExtTime: VT_NA,
    bearCSLFib2: VT_NA, bearCSLRev: false, bearCSLFib2Reached: false,
    bearCSHExt: VT_NA, bearCSHExtBar: VT_NA, bearCSHExtTime: VT_NA,
    bearCSHFib2: VT_NA, bearCSHRev: false, bearCSHFib2Reached: false,
    bearCSLWasBrokenForCSH: false,

    // --- временные экстремумы ------------------------------------------------
    initTSH: VT_NA, initTSHBar: VT_NA, initTSL: VT_NA, initTSLBar: VT_NA,
    tsh: VT_NA, tshBar: VT_NA, tshTime: VT_NA, tshActive: false, tshFib2Triggered: false,
    tsl: VT_NA, tslBar: VT_NA, tslTime: VT_NA, tslActive: false, tslFib2Triggered: false,

    // --- автоматические свинги ----------------------------------------------
    autoState: 0, autoDir: 0,
    autoSH: VT_NA, autoSHBar: VT_NA, autoSHTime: VT_NA,
    autoSL: VT_NA, autoSLBar: VT_NA, autoSLTime: VT_NA,
    autoFib1: VT_NA, autoFib1Stopped: false,

    confirmSH: VT_NA, confirmSHBar: VT_NA, confirmSHTime: VT_NA,
    confirmSL: VT_NA, confirmSLBar: VT_NA, confirmSLTime: VT_NA,
    confirmHighCand: VT_NA, confirmHighCandBar: VT_NA, confirmHighCandTime: VT_NA,
    confirmLowCand: VT_NA, confirmLowCandBar: VT_NA, confirmLowCandTime: VT_NA,
    confirmHighDone: false, confirmLowDone: false,

    marketTrend: 'WAITING',
    events: [],
    // снимок уровней на каждой свече: нужен бэктестеру, чтобы знать, какой
    // была зона в прошлом, а не только на последнем баре
    trace: opts.trace ? [] : null,
  };

  const log = (i, type, price, note) =>
    s.events.push({ i, t: c[i].t, type, price, note });

  const analysisStart = Math.min(shIdx, slIdx);

  /* ------------------------------------------------- служебные операции -- */

  const clearCSL = () => {
    s.firstCSL = VT_NA; s.firstCSLBar = VT_NA; s.firstCSLTime = VT_NA; s.firstCSLRev = false;
  };
  const clearCSH = () => {
    s.firstCSH = VT_NA; s.firstCSHBar = VT_NA; s.firstCSHTime = VT_NA; s.firstCSHRev = false;
  };
  const setCSL = (price, barIdx) => {
    s.confirmedCSL = price; s.confirmedCSLBar = barIdx; s.confirmedCSLTime = c[barIdx].t;
    s.currentSL = price; s.currentSLBar = barIdx; s.currentSLTime = c[barIdx].t;
  };
  const setCSH = (price, barIdx) => {
    s.confirmedCSH = price; s.confirmedCSHBar = barIdx; s.confirmedCSHTime = c[barIdx].t;
    s.currentSH = price; s.currentSHBar = barIdx; s.currentSHTime = c[barIdx].t;
  };
  /** Первая пара CSH + CSL собрана: последний свинг задаёт направление навсегда. */
  const lockInitial = (dir) => {
    s.initialProcessLocked = true;
    s.manualInitialActive = false;
    s.direction = dir;
    s.firstState = 0;
    s.upAttemptBeforeFib1 = false;
    s.downAttemptBeforeFib1 = false;
    clearCSL(); clearCSH();
  };

  for (let i = 0; i < c.length; i++) {
    const bar = c[i];
    const { o, h, l } = bar;
    const cl = bar.c;
    const prevClose = i > 0 ? c[i - 1].c : VT_NA;

    // флаги «подтверждено на этой свече» — живут ровно одну свечу
    let bullCSLConfirmedNow = false;
    let bearCSHConfirmedNow = false;

    /* ============================================ 01 — ручные SH / SL ===== */

    if (i === shIdx) {
      s.manualSH = h; s.manualSHBar = i; s.manualSHTime = bar.t;
      s.currentSH = h; s.currentSHBar = i; s.currentSHTime = bar.t;
    }
    if (i === slIdx) {
      s.manualSL = l; s.manualSLBar = i; s.manualSLTime = bar.t;
      s.currentSL = l; s.currentSLBar = i; s.currentSLTime = bar.t;
    }
    if (i === analysisStart) s.analysisStartBar = i;

    /* ================================ коррекция координат старта ========== */
    //
    // Одноразовая правка ТОЛЬКО стартовых координат. Между исходными ручными
    // свечами ищется максимальный high и минимальный low. Обе стороны считаются
    // от ОРИГИНАЛЬНЫХ значений и применяются вместе: правка SH не должна влиять
    // на поиск SL и наоборот. Структурных CSH / CSL здесь не создаётся.

    if (!s.correctionDone && !vtIsNa(s.manualSH) && !vtIsNa(s.manualSL)) {
      const origSH = s.manualSH;
      const origSL = s.manualSL;
      const first = Math.min(s.manualSHBar, s.manualSLBar);
      const last = Math.max(s.manualSHBar, s.manualSLBar);

      let hiP = origSH, hiBar = s.manualSHBar;
      let loP = origSL, loBar = s.manualSLBar;

      for (let k = first; k <= last; k++) {
        if (c[k].h > hiP) { hiP = c[k].h; hiBar = k; }
        if (c[k].l < loP) { loP = c[k].l; loBar = k; }
      }

      if (hiP > origSH) {
        s.manualSH = hiP; s.manualSHBar = hiBar; s.manualSHTime = c[hiBar].t;
        s.currentSH = hiP; s.currentSHBar = hiBar; s.currentSHTime = c[hiBar].t;
        s.correctedSH = true;
      }
      if (loP < origSL) {
        s.manualSL = loP; s.manualSLBar = loBar; s.manualSLTime = c[loBar].t;
        s.currentSL = loP; s.currentSLBar = loBar; s.currentSLTime = c[loBar].t;
        s.correctedSL = true;
      }

      log(s.manualSHBar, 'SH', s.manualSH,
        s.correctedSH ? 'якорь · коррекция старта' : 'ручной якорь');
      log(s.manualSLBar, 'SL', s.manualSL,
        s.correctedSL ? 'якорь · коррекция старта' : 'ручной якорь');

      s.correctionDone = true;
    }

    const zoneActive = !vtIsNa(s.analysisStartBar) && i >= s.analysisStartBar;
    const ready = !vtIsNa(s.manualSH) && !vtIsNa(s.manualSL) &&
      !vtIsNa(s.analysisStartBar) && s.manualInitialActive && !s.initialProcessLocked;

    /* ========================================================= FIB 1 ====== */

    if (ready) s.fib1 = s.manualSL + (s.manualSH - s.manualSL) * fib1Pct;

    if (zoneActive && !s.fib1Stopped && !vtIsNa(s.fib1) && h >= s.fib1 && l <= s.fib1) {
      s.fib1Stopped = true;
      s.fib1EndBar = i;
      log(i, 'FIB1', s.fib1, 'цена коснулась уровня');
    }

    /* ================================= подход к FIB 1 и предпопытки ======= */

    const wasAbove = !vtIsNa(s.fib1) && !vtIsNa(prevClose) && prevClose > s.fib1;
    const wasBelow = !vtIsNa(s.fib1) && !vtIsNa(prevClose) && prevClose < s.fib1;
    const touchFromAbove = wasAbove && l <= s.fib1;
    const touchFromBelow = wasBelow && h >= s.fib1;

    if (ready && s.firstState === 0) {
      if (i > s.manualSLBar && h > s.manualSL && h < s.fib1) s.upAttemptBeforeFib1 = true;
      if (i > s.manualSHBar && l < s.manualSH && l > s.fib1) s.downAttemptBeforeFib1 = true;
    }

    /* ============================== INITIAL: старт нисходящего пути ======= */

    if (!s.initialProcessLocked && s.manualInitialActive && s.firstState === 0 &&
        ready && zoneActive && !vtIsNa(s.fib1) && touchFromAbove) {
      s.firstState = 1;
      s.upAttemptBeforeFib1 = false;
      s.downAttemptBeforeFib1 = false;
      s.firstCSL = l; s.firstCSLBar = i; s.firstCSLTime = bar.t; s.firstCSLRev = false;
      clearCSH();
    }

    // предпопытка вверх, а затем новый минимум ниже ручного SL
    if (s.upAttemptBeforeFib1 && l <= s.manualSL && s.firstState === 0 && ready) {
      s.firstState = 2;
      s.firstCSL = l; s.firstCSLBar = i; s.firstCSLTime = bar.t; s.firstCSLRev = false;
      clearCSH();
      s.upAttemptBeforeFib1 = false;
      s.downAttemptBeforeFib1 = false;
      s.fib1Stopped = false; s.fib1EndBar = VT_NA;
    }

    /* --------------------- STATE 1 — нисходящий путь после FIB 1 --------- */

    if (s.firstState === 1) {
      if (l < s.firstCSL) { s.firstCSL = l; s.firstCSLBar = i; s.firstCSLTime = bar.t; }

      const slBreak = l <= s.manualSL;
      const shBreak = h >= s.manualSH;
      const upReversal = cl > o && cl > s.fib1;

      if (slBreak) {
        s.firstState = 2;
        s.firstCSLRev = false;
        s.fib1Stopped = false; s.fib1EndBar = VT_NA;
      } else if (shBreak && upReversal) {
        setCSL(s.firstCSL, s.firstCSLBar);
        log(s.confirmedCSLBar, 'CSL', s.confirmedCSL, 'initial · пробой SH');
        s.firstState = 3;
        clearCSH();
        s.fib1 = s.confirmedCSL + (s.manualSH - s.confirmedCSL) * fib1Pct;
        s.fib1Stopped = false; s.fib1EndBar = VT_NA;
      }
    }

    /* --------------------- STATE 2 — поиск минимума после пробоя SL ------ */

    if (s.firstState === 2) {
      if (l < s.firstCSL) { s.firstCSL = l; s.firstCSLBar = i; s.firstCSLTime = bar.t; }

      s.fib1 = s.firstCSL + (s.manualSH - s.firstCSL) * fib1Pct;
      s.fib1Stopped = false; s.fib1EndBar = VT_NA;

      if (cl > o && h >= s.fib1) s.firstCSLRev = true;

      if (s.firstCSLRev && h >= s.fib1) {
        setCSL(s.firstCSL, s.firstCSLBar);
        s.fib1Stopped = true; s.fib1EndBar = i;
        log(s.confirmedCSLBar, 'CSL', s.confirmedCSL, 'initial · реакция до FIB 1');
        s.firstState = 3;
        clearCSH();
      }
    }

    /* --------------------- STATE 3 — после CSL строим CSH ---------------- */

    if (s.firstState === 3 && !vtIsNa(s.confirmedCSL) && i > s.confirmedCSLBar) {
      if (vtIsNa(s.firstCSH) || h > s.firstCSH) {
        s.firstCSH = h; s.firstCSHBar = i; s.firstCSHTime = bar.t;
      }

      if (h >= s.manualSH) {
        s.firstState = 4;
        s.firstCSHRev = false;
        s.fib1Stopped = false; s.fib1EndBar = VT_NA;
      } else {
        s.fib1 = s.confirmedCSL + (s.manualSH - s.confirmedCSL) * fib1Pct;

        if (cl < o && cl < s.firstCSH) s.firstCSHRev = true;

        const fibReached = s.firstCSHRev && l <= s.fib1;
        if (fibReached) { s.fib1Stopped = true; s.fib1EndBar = i; }

        if (fibReached && l <= s.confirmedCSL && !vtIsNa(s.firstCSH)) {
          setCSH(s.firstCSH, s.firstCSHBar);
          log(s.confirmedCSHBar, 'CSH', s.confirmedCSH, 'initial · пробой CSL');
          log(i, 'STRUCTURE BEARISH', s.confirmedCSH, 'первая пара завершена');
          lockInitial(-1);
        }
      }
    }

    /* --------------------- STATE 4 — бычья ветка после пробоя SH --------- */

    if (s.firstState === 4) {
      if (vtIsNa(s.firstCSH) || h > s.firstCSH) {
        s.firstCSH = h; s.firstCSHBar = i; s.firstCSHTime = bar.t;
      }

      s.fib1 = s.confirmedCSL + (s.firstCSH - s.confirmedCSL) * fib1Pct;
      s.fib1Stopped = false; s.fib1EndBar = VT_NA;

      if (cl < o && cl < s.firstCSH) s.firstCSHRev = true;

      if (s.firstCSHRev && l <= s.fib1 && i > s.firstCSHBar) {
        setCSH(s.firstCSH, s.firstCSHBar);
        s.fib1Stopped = true; s.fib1EndBar = i;
        log(s.confirmedCSHBar, 'CSH', s.confirmedCSH, 'initial · реакция до FIB 1');
        s.firstState = 5;
        s.firstCSL = l; s.firstCSLBar = i; s.firstCSLTime = bar.t; s.firstCSLRev = false;
        clearCSH();
      }
    }

    /* --------------------- STATE 5 — после CSH ищем новый CSL ------------ */

    if (s.firstState === 5) {
      if (l < s.firstCSL) { s.firstCSL = l; s.firstCSLBar = i; s.firstCSLTime = bar.t; }

      s.fib1 = s.confirmedCSL + (s.confirmedCSH - s.confirmedCSL) * fib1Pct;

      if (cl > o && h >= s.fib1) s.firstCSLRev = true;

      const fibReached = s.firstCSLRev && h >= s.fib1;
      const cshBreak = fibReached && h >= s.confirmedCSH && i > s.confirmedCSHBar;

      if (cshBreak && !vtIsNa(s.firstCSL)) {
        setCSL(s.firstCSL, s.firstCSLBar);
        s.fib1Stopped = true; s.fib1EndBar = i;
        log(s.confirmedCSLBar, 'CSL', s.confirmedCSL, 'initial · пробой CSH');
        log(i, 'STRUCTURE BULLISH', s.confirmedCSL, 'первая пара завершена');
        lockInitial(1);
      } else if (l <= s.confirmedCSL) {
        // ожидаемого пробоя не случилось — новый минимум продолжает тот же поиск
        s.firstState = 2;
        s.firstCSL = l; s.firstCSLBar = i; s.firstCSLTime = bar.t; s.firstCSLRev = false;
        s.fib1Stopped = false; s.fib1EndBar = VT_NA;
      }
    }

    /* ============================== INITIAL: старт восходящего пути ====== */

    if (!s.initialProcessLocked && s.manualInitialActive && s.firstState === 0 &&
        ready && zoneActive && !vtIsNa(s.fib1) && touchFromBelow) {
      s.firstState = 6;
      s.upAttemptBeforeFib1 = false;
      s.downAttemptBeforeFib1 = false;
      s.firstCSH = h; s.firstCSHBar = i; s.firstCSHTime = bar.t; s.firstCSHRev = false;
      clearCSL();
    }

    // предпопытка вниз, а затем новый максимум выше ручного SH
    if (s.downAttemptBeforeFib1 && h >= s.manualSH && s.firstState === 0 && ready) {
      s.firstState = 7;
      s.firstCSH = h; s.firstCSHBar = i; s.firstCSHTime = bar.t; s.firstCSHRev = false;
      clearCSL();
      s.upAttemptBeforeFib1 = false;
      s.downAttemptBeforeFib1 = false;
      s.fib1Stopped = false; s.fib1EndBar = VT_NA;
    }

    /* --------------------- STATE 6 — восходящий путь после FIB 1 --------- */

    if (s.firstState === 6) {
      if (h > s.firstCSH) { s.firstCSH = h; s.firstCSHBar = i; s.firstCSHTime = bar.t; }

      const shBreakUp = h >= s.manualSH;
      const slBreakUp = l <= s.manualSL;
      const downReversal = cl < o && l <= s.fib1;

      if (shBreakUp) {
        s.firstState = 7;
        s.firstCSHRev = false;
        s.fib1Stopped = false; s.fib1EndBar = VT_NA;
      } else if (slBreakUp && downReversal) {
        setCSH(s.firstCSH, s.firstCSHBar);
        log(s.confirmedCSHBar, 'CSH', s.confirmedCSH, 'initial · пробой SL');
        s.firstState = 8;
        s.firstCSL = l; s.firstCSLBar = i; s.firstCSLTime = bar.t; s.firstCSLRev = false;
      }
    }

    /* --------------------- STATE 7 — поиск CSH после пробоя SH ----------- */

    if (s.firstState === 7) {
      if (h > s.firstCSH) { s.firstCSH = h; s.firstCSHBar = i; s.firstCSHTime = bar.t; }

      s.fib1 = s.manualSL + (s.firstCSH - s.manualSL) * fib1Pct;
      s.fib1Stopped = false; s.fib1EndBar = VT_NA;

      if (cl < o && l <= s.fib1) s.firstCSHRev = true;

      if (s.firstCSHRev && l <= s.fib1 && i > s.firstCSHBar) {
        setCSH(s.firstCSH, s.firstCSHBar);
        s.fib1Stopped = true; s.fib1EndBar = i;
        log(s.confirmedCSHBar, 'CSH', s.confirmedCSH, 'initial · реакция до FIB 1');
        s.firstState = 8;
        s.firstCSL = l; s.firstCSLBar = i; s.firstCSLTime = bar.t; s.firstCSLRev = false;
        clearCSH();
      }
    }

    /* --------------------- STATE 8 — после CSH ищем CSL ------------------ */

    if (s.firstState === 8) {
      if (l < s.firstCSL) { s.firstCSL = l; s.firstCSLBar = i; s.firstCSLTime = bar.t; }

      s.fib1 = s.manualSL + (s.confirmedCSH - s.manualSL) * fib1Pct;

      if (cl > o && h >= s.fib1) s.firstCSLRev = true;

      const fibReached = s.firstCSLRev && h >= s.fib1;
      const cshBreak = fibReached && h >= s.confirmedCSH && i > s.confirmedCSHBar;

      if (cshBreak && !vtIsNa(s.firstCSL)) {
        setCSL(s.firstCSL, s.firstCSLBar);
        s.fib1Stopped = true; s.fib1EndBar = i;
        log(s.confirmedCSLBar, 'CSL', s.confirmedCSL, 'initial · пробой CSH');
        log(i, 'STRUCTURE BULLISH', s.confirmedCSL, 'первая пара завершена');
        lockInitial(1);
      } else if (l <= s.manualSL) {
        s.firstState = 9;
        s.firstCSL = l; s.firstCSLBar = i; s.firstCSLTime = bar.t; s.firstCSLRev = false;
        s.fib1Stopped = false; s.fib1EndBar = VT_NA;
      }
    }

    /* --------------------- STATE 9 — поиск минимума после пробоя SL ------ */

    if (s.firstState === 9) {
      if (l < s.firstCSL) { s.firstCSL = l; s.firstCSLBar = i; s.firstCSLTime = bar.t; }

      s.fib1 = s.confirmedCSH + (s.firstCSL - s.confirmedCSH) * fib1Pct;
      s.fib1Stopped = false; s.fib1EndBar = VT_NA;

      if (cl > o && h >= s.fib1) s.firstCSLRev = true;

      if (s.firstCSLRev && h >= s.fib1) {
        setCSL(s.firstCSL, s.firstCSLBar);
        s.fib1Stopped = true; s.fib1EndBar = i;
        log(s.confirmedCSLBar, 'CSL', s.confirmedCSL, 'initial · реакция до FIB 1');
        s.firstState = 10;
        s.firstCSH = h; s.firstCSHBar = i; s.firstCSHTime = bar.t; s.firstCSHRev = false;
      }
    }

    /* --------------------- STATE 10 — после CSL ищем CSH ----------------- */

    if (s.firstState === 10 && !vtIsNa(s.confirmedCSL) && i > s.confirmedCSLBar) {
      if (h > s.firstCSH) { s.firstCSH = h; s.firstCSHBar = i; s.firstCSHTime = bar.t; }

      if (h >= s.manualSH) {
        s.firstState = 4;
        s.firstCSHRev = false;
        s.fib1Stopped = false; s.fib1EndBar = VT_NA;
      } else {
        s.fib1 = s.confirmedCSL + (s.manualSH - s.confirmedCSL) * fib1Pct;

        if (cl < o && l <= s.fib1) s.firstCSHRev = true;

        const fibReached = s.firstCSHRev && l <= s.fib1;

        if (fibReached && l <= s.confirmedCSL && !vtIsNa(s.firstCSH)) {
          setCSH(s.firstCSH, s.firstCSHBar);
          s.fib1Stopped = true; s.fib1EndBar = i;
          log(s.confirmedCSHBar, 'CSH', s.confirmedCSH, 'initial · пробой CSL');
          log(i, 'STRUCTURE BEARISH', s.confirmedCSH, 'первая пара завершена');
          lockInitial(-1);
        }
      }
    }

    /* ====================== временные экстремумы стадии INITIAL =========== */

    if (enableTSHTSL && !s.initialProcessLocked && s.manualInitialActive) {
      const cslTemp = !vtIsNa(s.firstCSL) &&
        (vtIsNa(s.confirmedCSLBar) || s.firstCSLBar !== s.confirmedCSLBar);
      s.initTSL = cslTemp ? s.firstCSL : VT_NA;
      s.initTSLBar = cslTemp ? s.firstCSLBar : VT_NA;

      const cshTemp = !vtIsNa(s.firstCSH) &&
        (vtIsNa(s.confirmedCSHBar) || s.firstCSHBar !== s.confirmedCSHBar);
      s.initTSH = cshTemp ? s.firstCSH : VT_NA;
      s.initTSHBar = cshTemp ? s.firstCSHBar : VT_NA;
    }
    if (s.initialProcessLocked) {
      s.initTSL = VT_NA; s.initTSLBar = VT_NA;
      s.initTSH = VT_NA; s.initTSHBar = VT_NA;
    }

    /* ================================= INITIAL → BULLISH MASTER =========== */

    if (s.initialProcessLocked && !s.initialMasterHandoffDone && s.direction === 1) {
      s.bullState = 0;
      s.bullCSHExt = VT_NA; s.bullCSHExtBar = VT_NA; s.bullCSHExtTime = VT_NA;
      s.bullCSHFib2 = VT_NA; s.bullCSHRev = false; s.bullCSHFib2Reached = false;
      s.bullCSHWasBrokenForCSL = false;
      s.bullCSLExt = VT_NA; s.bullCSLExtBar = VT_NA; s.bullCSLExtTime = VT_NA;
      s.bullCSLFib2 = VT_NA; s.bullCSLRev = false; s.bullCSLFib2Reached = false;
      s.initialMasterHandoffDone = true;
    }

    /* ============================================ MASTER: BULLISH ========= */
    //
    // Мастер не имеет права стартовать, пока строится первая пара: только после
    // initialProcessLocked. Свеча пробоя CSH сразу становится кандидатом.

    if (s.initialProcessLocked && s.bullState === 0 && !vtIsNa(s.confirmedCSL) &&
        !vtIsNa(s.currentSH) && !vtIsNa(s.currentSL) && h > s.currentSH) {
      s.bullState = 1;
      s.bullCSHExt = h; s.bullCSHExtBar = i; s.bullCSHExtTime = bar.t;
      s.bullCSHFib2 = VT_NA;
      s.bullCSHRev = false;
      s.bullCSHFib2Reached = false;
      s.bullCSHWasBrokenForCSL = false;
    }

    // STATE 1 — поиск нового CSH
    if (s.bullState === 1) {
      if (l <= s.currentSL) {
        s.manualInitialActive = false;
        s.bullState = 0;
        s.bullCSHExt = VT_NA; s.bullCSHExtBar = VT_NA; s.bullCSHExtTime = VT_NA;
        s.bullCSHFib2 = VT_NA; s.bullCSHRev = false; s.bullCSHFib2Reached = false;
      } else {
        // сначала максимум, только потом FIB 2 и проверка касания
        if (vtIsNa(s.bullCSHExt) || h > s.bullCSHExt) {
          s.bullCSHExt = h; s.bullCSHExtBar = i; s.bullCSHExtTime = bar.t;
        }
        s.bullCSHFib2 = s.currentSL + (s.bullCSHExt - s.currentSL) * fib2Pct;

        if (cl < o && cl < s.bullCSHExt) s.bullCSHRev = true;

        if (s.bullCSHRev && l <= s.bullCSHFib2) {
          s.bullCSHFib2Reached = true;
          setCSH(s.bullCSHExt, s.bullCSHExtBar);
          log(s.confirmedCSHBar, 'CSH', s.confirmedCSH, 'bullish master');

          s.bullState = 2;
          s.bullCSLExt = VT_NA; s.bullCSLExtBar = VT_NA; s.bullCSLExtTime = VT_NA;
          s.bullCSLFib2 = VT_NA; s.bullCSLFib2Reached = false; s.bullCSLRev = false;

          s.bullCSHExt = VT_NA; s.bullCSHExtBar = VT_NA; s.bullCSHExtTime = VT_NA;
          s.bullCSHFib2 = VT_NA; s.bullCSHRev = false;
        }
      }
    }

    // STATE 2 — поиск нового CSL
    if (s.bullState === 2) {
      if (l <= s.currentSL) {
        s.manualInitialActive = false;
        s.bullState = 0;
        s.bullCSLExt = VT_NA; s.bullCSLExtBar = VT_NA; s.bullCSLExtTime = VT_NA;
        s.bullCSLFib2 = VT_NA; s.bullCSLFib2Reached = false; s.bullCSLRev = false;
      } else {
        s.bullCSLFib2 = s.currentSL + (s.confirmedCSH - s.currentSL) * fib2Pct;

        if (l <= s.bullCSLFib2) s.bullCSLFib2Reached = true;

        if (s.bullCSLFib2Reached) {
          if (vtIsNa(s.bullCSLExt) || l < s.bullCSLExt) {
            s.bullCSLExt = l; s.bullCSLExtBar = i; s.bullCSLExtTime = bar.t;
          }
        }

        if (s.bullCSLFib2Reached && cl > o && cl > s.bullCSLFib2) s.bullCSLRev = true;

        // пробой CSH запоминается, даже если случился до касания FIB 2
        if (h >= s.confirmedCSH) s.bullCSHWasBrokenForCSL = true;

        if (s.bullCSLRev && s.bullCSHWasBrokenForCSL && !vtIsNa(s.bullCSLExt)) {
          setCSL(s.bullCSLExt, s.bullCSLExtBar);
          bullCSLConfirmedNow = true;
          log(s.confirmedCSLBar, 'CSL', s.confirmedCSL, 'bullish master');

          s.bullState = 0;
          s.bullCSHWasBrokenForCSL = false;

          // краевой случай: свеча подтверждения уже пробила текущий CSH —
          // её high обязан стать первым кандидатом, иначе следующая свеча
          // с меньшим максимумом займёт его место
          if (h > s.currentSH) {
            s.bullCSHWasBrokenForCSL = true;
            s.bullState = 1;
            s.bullCSHExt = h; s.bullCSHExtBar = i; s.bullCSHExtTime = bar.t;
            s.bullCSHFib2 = VT_NA; s.bullCSHRev = false; s.bullCSHFib2Reached = false;
          }

          s.bullCSLExt = VT_NA; s.bullCSLExtBar = VT_NA; s.bullCSLExtTime = VT_NA;
          s.bullCSLFib2 = VT_NA; s.bullCSLFib2Reached = false; s.bullCSLRev = false;
        }
      }
    }

    /* ================================================= рыночный тренд ===== */

    if (s.direction === 1) s.marketTrend = 'BULLISH';
    else if (s.direction === -1) s.marketTrend = 'BEARISH';
    else if (ready) s.marketTrend = 'READY';
    else s.marketTrend = 'WAITING';

    /* ================================= INITIAL → BEARISH MASTER =========== */

    const bearActive = s.direction === -1;

    if (s.initialProcessLocked && !s.initialMasterHandoffDone && s.direction === -1) {
      s.bearState = 0;
      s.bearCSLExt = VT_NA; s.bearCSLExtBar = VT_NA; s.bearCSLExtTime = VT_NA;
      s.bearCSLFib2 = VT_NA; s.bearCSLRev = false; s.bearCSLFib2Reached = false;
      s.bearCSHExt = VT_NA; s.bearCSHExtBar = VT_NA; s.bearCSHExtTime = VT_NA;
      s.bearCSHFib2 = VT_NA; s.bearCSHRev = false; s.bearCSHFib2Reached = false;
      s.bearCSLWasBrokenForCSH = false;
      s.initialMasterHandoffDone = true;
    }

    /* ============================================ MASTER: BEARISH ========= */

    if (s.initialProcessLocked && bearActive && s.bearState === 0 &&
        !vtIsNa(s.confirmedCSH) && !vtIsNa(s.currentSL) && l < s.currentSL) {
      s.bearState = 1;
      s.bearCSLExt = l; s.bearCSLExtBar = i; s.bearCSLExtTime = bar.t;
      s.bearCSLFib2 = VT_NA; s.bearCSLRev = false; s.bearCSLFib2Reached = false;
    }

    // STATE 1 — поиск нового CSL
    if (bearActive && s.bearState === 1) {
      if (h >= s.confirmedCSH) {
        s.manualInitialActive = false;
        s.bearState = 0;
        s.bearCSLExt = VT_NA; s.bearCSLExtBar = VT_NA; s.bearCSLExtTime = VT_NA;
        s.bearCSLFib2 = VT_NA; s.bearCSLRev = false; s.bearCSLFib2Reached = false;
      } else {
        if (vtIsNa(s.bearCSLExt) || l < s.bearCSLExt) {
          s.bearCSLExt = l; s.bearCSLExtBar = i; s.bearCSLExtTime = bar.t;
        }
        s.bearCSLFib2 = s.confirmedCSH - (s.confirmedCSH - s.bearCSLExt) * fib2Pct;

        if (cl > o && cl > s.bearCSLExt) s.bearCSLRev = true;

        if (s.bearCSLRev && h >= s.bearCSLFib2) {
          s.bearCSLFib2Reached = true;
          setCSL(s.bearCSLExt, s.bearCSLExtBar);
          log(s.confirmedCSLBar, 'CSL', s.confirmedCSL, 'bearish master');

          s.bearCSLExt = VT_NA; s.bearCSLExtBar = VT_NA; s.bearCSLExtTime = VT_NA;
          s.bearCSLFib2 = VT_NA; s.bearCSLFib2Reached = false; s.bearCSLRev = false;

          s.bearState = 2;
          s.bearCSLWasBrokenForCSH = false;
          s.bearCSHExt = VT_NA; s.bearCSHExtBar = VT_NA; s.bearCSHExtTime = VT_NA;
          s.bearCSHFib2 = VT_NA; s.bearCSHFib2Reached = false; s.bearCSHRev = false;
        }
      }
    }

    // STATE 2 — поиск нового CSH.
    // Пробой текущего CSL здесь НЕ сбрасывает поиск: он запоминается и является
    // обязательным условием подтверждения CSH.
    if (bearActive && s.bearState === 2) {
      if (l <= s.currentSL) {
        s.bearCSLWasBrokenForCSH = true;
        s.manualInitialActive = false;
      }

      if (vtIsNa(s.bearCSHExt) || h > s.bearCSHExt) {
        s.bearCSHExt = h; s.bearCSHExtBar = i; s.bearCSHExtTime = bar.t;
      }
      s.bearCSHFib2 = s.currentSL + (s.bearCSHExt - s.currentSL) * fib2Pct;

      if (cl < o && cl < s.bearCSHExt) s.bearCSHRev = true;

      if (s.bearCSHRev && s.bearCSLWasBrokenForCSH && l <= s.bearCSHFib2) {
        s.bearCSHFib2Reached = true;
        setCSH(s.bearCSHExt, s.bearCSHExtBar);
        bearCSHConfirmedNow = true;
        s.bearCSLWasBrokenForCSH = false;
        log(s.confirmedCSHBar, 'CSH', s.confirmedCSH, 'bearish master');

        s.bearCSHExt = VT_NA; s.bearCSHExtBar = VT_NA; s.bearCSHExtTime = VT_NA;
        s.bearCSHFib2 = VT_NA; s.bearCSHFib2Reached = false; s.bearCSHRev = false;

        s.bearState = 0;

        // та же свеча уже пробила текущий CSL — её low открывает новый цикл
        if (l < s.currentSL) {
          s.bearState = 1;
          s.bearCSLExt = l; s.bearCSLExtBar = i; s.bearCSLExtTime = bar.t;
          s.bearCSLFib2 = VT_NA; s.bearCSLRev = false; s.bearCSLFib2Reached = false;
        }
      }
    }

    /* ============================================ TSH / TSL (master) ====== */

    if (enableTSHTSL) {
      if (s.direction === 1 && s.bullState === 2) {
        if (!s.tslFib2Triggered && !vtIsNa(s.bullCSLFib2) && l <= s.bullCSLFib2) {
          s.tslFib2Triggered = true; s.tslActive = true;
          s.tsl = l; s.tslBar = i; s.tslTime = bar.t;
        }
        if (s.tslActive && l < s.tsl) { s.tsl = l; s.tslBar = i; s.tslTime = bar.t; }
      }
      if (s.direction === -1 && s.bearState === 2) {
        if (!s.tshFib2Triggered && !vtIsNa(s.bearCSHFib2) && h >= s.bearCSHFib2) {
          s.tshFib2Triggered = true; s.tshActive = true;
          s.tsh = h; s.tshBar = i; s.tshTime = bar.t;
        }
        if (s.tshActive && h > s.tsh) { s.tsh = h; s.tshBar = i; s.tshTime = bar.t; }
      }
    }

    if (bullCSLConfirmedNow) {
      s.tslFib2Triggered = false; s.tslActive = false;
      s.tsl = VT_NA; s.tslBar = VT_NA; s.tslTime = VT_NA;
    }
    if (bearCSHConfirmedNow) {
      s.tshFib2Triggered = false; s.tshActive = false;
      s.tsh = VT_NA; s.tshBar = VT_NA; s.tshTime = VT_NA;
    }
    if (s.tslActive && s.direction !== 1) {
      s.tslFib2Triggered = false; s.tslActive = false;
      s.tsl = VT_NA; s.tslBar = VT_NA; s.tslTime = VT_NA;
    }
    if (s.tshActive && s.direction !== -1) {
      s.tshFib2Triggered = false; s.tshActive = false;
      s.tsh = VT_NA; s.tshBar = VT_NA; s.tshTime = VT_NA;
    }
    if (!enableTSHTSL) {
      s.tslActive = false; s.tshActive = false;
      s.tsl = VT_NA; s.tsh = VT_NA; s.tslBar = VT_NA; s.tshBar = VT_NA;
      s.tslFib2Triggered = false; s.tshFib2Triggered = false;
    }

    /* ================================ АВТОМАТИЧЕСКИЕ СВИНГИ (опция) ======= */

    if (!enableAuto) {
      s.autoState = 0; s.autoDir = 0;
      s.autoSH = VT_NA; s.autoSHBar = VT_NA; s.autoSHTime = VT_NA;
      s.autoSL = VT_NA; s.autoSLBar = VT_NA; s.autoSLTime = VT_NA;
      s.autoFib1 = VT_NA; s.autoFib1Stopped = false;
    } else {
      // старт bullish-ветки
      if (s.autoState === 0 && s.direction === 1 &&
          !vtIsNa(s.confirmedCSH) && !vtIsNa(s.confirmedCSL) &&
          l < s.confirmedCSL && i > s.confirmedCSLBar) {
        s.autoDir = 1; s.autoState = 1;
        s.autoSH = s.confirmedCSH; s.autoSHBar = s.confirmedCSHBar;
        s.autoSHTime = s.confirmedCSHTime;
        log(s.autoSHBar, 'AUTO SH', s.autoSH, 'последний CSH');
        s.autoSL = l; s.autoSLBar = i; s.autoSLTime = bar.t;
        s.autoFib1 = VT_NA; s.autoFib1Stopped = false;
      }

      if (s.autoState === 1 && s.autoDir === 1) {
        if (vtIsNa(s.autoSL) || l < s.autoSL) {
          s.autoSL = l; s.autoSLBar = i; s.autoSLTime = bar.t;
        }
        s.autoFib1 = s.autoSL + (s.autoSH - s.autoSL) * fib1Pct;
        if (cl > o && h >= s.autoFib1) {
          s.autoFib1Stopped = true;
          log(s.autoSLBar, 'AUTO SL', s.autoSL, 'реакция до FIB 1');
          s.autoState = 2; s.autoFib1 = VT_NA;
        }
      }

      if (s.autoState === 2 && s.autoDir === 1) {
        if (!vtIsNa(s.autoSH) && h > s.autoSH) {
          s.autoState = 5;
          s.autoSH = h; s.autoSHBar = i; s.autoSHTime = bar.t;
          s.autoFib1 = VT_NA; s.autoFib1Stopped = false;
        }
      }

      if (s.autoState === 5 && s.autoDir === 1) {
        if (h > s.autoSH) { s.autoSH = h; s.autoSHBar = i; s.autoSHTime = bar.t; }
        s.autoFib1 = s.autoSL + (s.autoSH - s.autoSL) * fib1Pct;
        if (cl < o && l <= s.autoFib1) {
          s.autoFib1Stopped = true;
          log(s.autoSHBar, 'AUTO SH', s.autoSH, 'реакция до FIB 1');
          s.autoState = 1; s.autoFib1 = VT_NA;
        }
      }

      // старт bearish-ветки
      if (s.autoState === 0 && s.direction === -1 &&
          !vtIsNa(s.confirmedCSH) && !vtIsNa(s.confirmedCSL) &&
          h > s.confirmedCSH && i > s.confirmedCSHBar) {
        s.autoDir = -1; s.autoState = 3;
        s.autoSL = s.confirmedCSL; s.autoSLBar = s.confirmedCSLBar;
        s.autoSLTime = s.confirmedCSLTime;
        log(s.autoSLBar, 'AUTO SL', s.autoSL, 'последний CSL');
        s.autoSH = h; s.autoSHBar = i; s.autoSHTime = bar.t;
        s.autoFib1 = VT_NA; s.autoFib1Stopped = false;
      }

      if (s.autoState === 3 && s.autoDir === -1) {
        if (vtIsNa(s.autoSH) || h > s.autoSH) {
          s.autoSH = h; s.autoSHBar = i; s.autoSHTime = bar.t;
        }
        s.autoFib1 = s.autoSL + (s.autoSH - s.autoSL) * fib1Pct;
        if (cl < o && l <= s.autoFib1) {
          s.autoFib1Stopped = true;
          log(s.autoSHBar, 'AUTO SH', s.autoSH, 'реакция до FIB 1');
          s.autoState = 4; s.autoFib1 = VT_NA;
        }
      }

      if (s.autoState === 4 && s.autoDir === -1) {
        if (!vtIsNa(s.autoSL) && l < s.autoSL) {
          s.autoState = 6;
          s.autoSL = l; s.autoSLBar = i; s.autoSLTime = bar.t;
          s.autoFib1 = VT_NA; s.autoFib1Stopped = false;
        }
      }

      if (s.autoState === 6 && s.autoDir === -1) {
        if (l < s.autoSL) { s.autoSL = l; s.autoSLBar = i; s.autoSLTime = bar.t; }
        s.autoFib1 = s.autoSL + (s.autoSH - s.autoSL) * fib1Pct;
        if (cl > o && h >= s.autoFib1) {
          s.autoFib1Stopped = true;
          log(s.autoSLBar, 'AUTO SL', s.autoSL, 'реакция до FIB 1');
          // как в оригинале: медвежий цикл уходит в состояние 2
          s.autoState = 2; s.autoFib1 = VT_NA;
        }
      }
    }

    /* ==================================== CONFIRM SH / SL (авто-цикл) ===== */

    if (s.autoDir === 1 && s.autoState === 1) {
      s.confirmHighDone = false;
      s.confirmHighCand = VT_NA; s.confirmHighCandBar = VT_NA; s.confirmHighCandTime = VT_NA;
    }
    if (s.autoDir === -1 && s.autoState === 3) {
      s.confirmLowDone = false;
      s.confirmLowCand = VT_NA; s.confirmLowCandBar = VT_NA; s.confirmLowCandTime = VT_NA;
    }

    if (s.autoDir === 1 && s.autoState === 2 && !s.confirmHighDone &&
        !vtIsNa(s.autoSH) && !vtIsNa(s.autoSL)) {
      if (vtIsNa(s.confirmHighCand) || h > s.confirmHighCand) {
        s.confirmHighCand = h; s.confirmHighCandBar = i; s.confirmHighCandTime = bar.t;
      }
    }

    if (s.autoDir === 1 && s.autoState === 2 && !s.confirmHighDone &&
        !vtIsNa(s.autoSL) && !vtIsNa(s.confirmHighCand) && l < s.autoSL) {
      s.confirmSH = s.confirmHighCand;
      s.confirmSHBar = s.confirmHighCandBar;
      s.confirmSHTime = s.confirmHighCandTime;
      log(s.confirmSHBar, 'CONFIRM SH', s.confirmSH, 'пробой авто-SL');
      s.confirmHighDone = true;
      s.confirmHighCand = VT_NA; s.confirmHighCandBar = VT_NA; s.confirmHighCandTime = VT_NA;
    }

    if (s.autoDir === -1 && s.autoState === 4 && !s.confirmLowDone &&
        !vtIsNa(s.autoSH) && !vtIsNa(s.autoSL)) {
      if (vtIsNa(s.confirmLowCand) || l < s.confirmLowCand) {
        s.confirmLowCand = l; s.confirmLowCandBar = i; s.confirmLowCandTime = bar.t;
      }
    }

    if (s.autoDir === -1 && s.autoState === 4 && !s.confirmLowDone &&
        !vtIsNa(s.autoSH) && !vtIsNa(s.confirmLowCand) && h > s.autoSH) {
      s.confirmSL = s.confirmLowCand;
      s.confirmSLBar = s.confirmLowCandBar;
      s.confirmSLTime = s.confirmLowCandTime;
      log(s.confirmSLBar, 'CONFIRM SL', s.confirmSL, 'пробой авто-SH');
      s.confirmLowDone = true;
      s.confirmLowCand = VT_NA; s.confirmLowCandBar = VT_NA; s.confirmLowCandTime = VT_NA;
    }

    // Мост «авто-confirm → master» в оригинале отключён намеренно: направление
    // задаёт только завершённая первая пара INITIAL. Здесь он тоже не подключён.

    if (s.trace) {
      s.trace.push({
        i, t: bar.t, sh: s.currentSH, sl: s.currentSL, dir: s.direction,
        trend: s.marketTrend, locked: s.initialProcessLocked,
      });
    }
  }

  /* ------------------------------------------------------------- итог ---- */

  s.trend = s.direction === 1 ? 'BULLISH' : s.direction === -1 ? 'BEARISH' : s.marketTrend;

  // совместимость с остальным дашбордом
  s.shPrice = s.currentSH; s.shBar = s.currentSHBar; s.shTime = s.currentSHTime;
  s.slPrice = s.currentSL; s.slBar = s.currentSLBar; s.slTime = s.currentSLTime;

  return s;
}

if (typeof module !== 'undefined' && module.exports) module.exports = { runVitalityTr };
