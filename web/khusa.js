/**
 * KHUSA SM PRO — движок структуры рынка.
 *
 * Построчный перенос одноимённого индикатора Pine v6 на JS. Порядок вычислений
 * внутри бара сохранён ровно таким, каким его исполняет Pine: блоки идут сверху
 * вниз, и если состояние сменилось в верхнем блоке, нижний блок отработает на
 * этой же свече. От этого зависят результаты — например, свеча, подтвердившая
 * CSH, тут же начинает поиск CSL.
 *
 * Схема работы:
 *
 *   ручные SH / SL
 *        ↓  FIB 1
 *   первый CSL или CSH          ← кто подтвердился первым, тот задаёт направление
 *        ↓
 *   MASTER STRUCTURE            ← bullish либо bearish, подтверждение по FIB 2
 *        ↓
 *   AUTO SWING ENGINE           ← автоматические SH / SL по FIB 1
 *        ↓
 *   CONFIRM SH / SL             ← один confirm на цикл
 *        ↓
 *   мост обратно в MASTER       ← confirm становится новым CSH / CSL
 *
 * Возвращает состояние на последней свече плюс журнал событий.
 */

/* eslint no-bitwise: 0 */

const KH_NA = null;
const khIsNa = (v) => v === null || v === undefined || (typeof v === 'number' && Number.isNaN(v));

function runKhusa(c, shIdx, slIdx, opts = {}) {
  if (!Array.isArray(c) || c.length === 0) return null;
  if (shIdx == null || slIdx == null) return null;

  const fib1Pct = (opts.fib50 ?? 51) / 100;
  const fib2Pct = (opts.fib618 ?? 50) / 100;

  const s = {
    // --- 01 исходные данные -------------------------------------------------
    manualSH: KH_NA, manualSHBar: KH_NA, manualSHTime: KH_NA,
    manualSL: KH_NA, manualSLBar: KH_NA, manualSLTime: KH_NA,

    currentSH: KH_NA, currentSHBar: KH_NA, currentSHTime: KH_NA,
    currentSL: KH_NA, currentSLBar: KH_NA, currentSLTime: KH_NA,

    confirmedCSH: KH_NA, confirmedCSHBar: KH_NA, confirmedCSHTime: KH_NA,
    confirmedCSL: KH_NA, confirmedCSLBar: KH_NA, confirmedCSLTime: KH_NA,

    analysisStartBar: KH_NA,
    fib1: KH_NA, fib1Stopped: false, fib1EndBar: KH_NA,

    // --- первая структура ---------------------------------------------------
    firstState: 0,
    firstCSL: KH_NA, firstCSLBar: KH_NA, firstCSLTime: KH_NA, firstCSLRev: false,
    firstCSH: KH_NA, firstCSHBar: KH_NA, firstCSHTime: KH_NA, firstCSHRev: false,

    // --- master: bullish ----------------------------------------------------
    bullState: 0,
    bullCSHExt: KH_NA, bullCSHExtBar: KH_NA, bullCSHExtTime: KH_NA,
    bullCSHFib2: KH_NA, bullCSHRev: false, bullCSHFib2Reached: false,
    bullCSLExt: KH_NA, bullCSLExtBar: KH_NA, bullCSLExtTime: KH_NA,
    bullCSLFib2: KH_NA, bullCSLRev: false, bullCSLFib2Reached: false,

    // --- master: bearish ----------------------------------------------------
    direction: 0,                 // khusaStructureDirection: 1 = BULLISH, -1 = BEARISH
    bearState: 0,
    bearCSLExt: KH_NA, bearCSLExtBar: KH_NA, bearCSLExtTime: KH_NA,
    bearCSLFib2: KH_NA, bearCSLRev: false, bearCSLFib2Reached: false,
    bearCSHExt: KH_NA, bearCSHExtBar: KH_NA, bearCSHExtTime: KH_NA,
    bearCSHFib2: KH_NA, bearCSHRev: false, bearCSHFib2Reached: false,

    // --- автоматические свинги ---------------------------------------------
    autoState: 0, autoDir: 0,
    autoSH: KH_NA, autoSHBar: KH_NA, autoSHTime: KH_NA,
    autoSL: KH_NA, autoSLBar: KH_NA, autoSLTime: KH_NA,
    autoFib1: KH_NA, autoFib1Stopped: false,

    // --- confirm ------------------------------------------------------------
    confirmSH: KH_NA, confirmSHBar: KH_NA, confirmSHTime: KH_NA,
    confirmSL: KH_NA, confirmSLBar: KH_NA, confirmSLTime: KH_NA,
    confirmHighCand: KH_NA, confirmHighCandBar: KH_NA, confirmHighCandTime: KH_NA,
    confirmLowCand: KH_NA, confirmLowCandBar: KH_NA, confirmLowCandTime: KH_NA,
    confirmHighDone: false, confirmLowDone: false,

    // --- мост в master ------------------------------------------------------
    autoMasterStarted: false, autoMasterDir: 0,

    marketTrend: 'WAITING',
    events: [],
  };

  const log = (i, type, price, note) =>
    s.events.push({ i, t: c[i].t, type, price, note });

  const analysisStart = Math.min(shIdx, slIdx);

  for (let i = 0; i < c.length; i++) {
    const bar = c[i];
    const { o, h, l } = bar;
    const cl = bar.c;
    const prevClose = i > 0 ? c[i - 1].c : KH_NA;

    /* ============================================ 01 — ручные SH / SL ===== */

    if (i === shIdx) {
      s.manualSH = h; s.manualSHBar = i; s.manualSHTime = bar.t;
      s.currentSH = h; s.currentSHBar = i; s.currentSHTime = bar.t;
      log(i, 'SH', h, 'ручной якорь');
    }
    if (i === slIdx) {
      s.manualSL = l; s.manualSLBar = i; s.manualSLTime = bar.t;
      s.currentSL = l; s.currentSLBar = i; s.currentSLTime = bar.t;
      log(i, 'SL', l, 'ручной якорь');
    }
    if (i === analysisStart) s.analysisStartBar = i;

    const zoneActive = !khIsNa(s.analysisStartBar) && i >= s.analysisStartBar;
    const ready = !khIsNa(s.manualSH) && !khIsNa(s.manualSL) && !khIsNa(s.analysisStartBar);

    /* ========================================================= FIB 1 ===== */

    if (ready) s.fib1 = s.manualSL + (s.manualSH - s.manualSL) * fib1Pct;

    if (zoneActive && !s.fib1Stopped && !khIsNa(s.fib1) && h >= s.fib1 && l <= s.fib1) {
      s.fib1Stopped = true;
      s.fib1EndBar = i;
      log(i, 'FIB1', s.fib1, 'цена коснулась 50%');
    }

    /* ======================================= первая структура: подход ===== */

    const wasAbove = !khIsNa(s.fib1) && !khIsNa(prevClose) && prevClose > s.fib1;
    const wasBelow = !khIsNa(s.fib1) && !khIsNa(prevClose) && prevClose < s.fib1;
    const touchFromAbove = wasAbove && l <= s.fib1;
    const touchFromBelow = wasBelow && h >= s.fib1;

    // старт поиска первого CSL
    if (s.firstState === 0 && ready && zoneActive && !khIsNa(s.fib1) && touchFromAbove) {
      s.firstState = 1;
      s.firstCSL = l; s.firstCSLBar = i; s.firstCSLTime = bar.t;
      s.firstCSLRev = false;
      s.firstCSH = KH_NA; s.firstCSHBar = KH_NA; s.firstCSHTime = KH_NA;
      s.firstCSHRev = false;
    }

    // STATE 1 — поиск первого CSL
    if (s.firstState === 1) {
      if (l <= s.manualSL) {
        s.firstState = 0;
        s.firstCSL = KH_NA; s.firstCSLBar = KH_NA; s.firstCSLTime = KH_NA;
        s.firstCSLRev = false;
      } else {
        if (l < s.firstCSL) { s.firstCSL = l; s.firstCSLBar = i; s.firstCSLTime = bar.t; }
        if (cl > o && cl > s.fib1) { s.firstCSLRev = true; s.firstState = 2; }
      }
    }

    // STATE 2 — подтверждение первого CSL
    if (s.firstState === 2) {
      if (l < s.firstCSL) { s.firstCSL = l; s.firstCSLBar = i; s.firstCSLTime = bar.t; }

      if (l <= s.manualSL) {
        s.firstState = 0;
        s.firstCSL = KH_NA; s.firstCSLBar = KH_NA; s.firstCSLTime = KH_NA;
        s.firstCSLRev = false;
      } else if (h >= s.manualSH && s.firstCSLRev && !khIsNa(s.firstCSL)) {
        s.confirmedCSL = s.firstCSL;
        s.confirmedCSLBar = s.firstCSLBar;
        s.confirmedCSLTime = s.firstCSLTime;
        s.currentSL = s.confirmedCSL;
        s.currentSLBar = s.confirmedCSLBar;
        s.currentSLTime = s.confirmedCSLTime;
        log(s.confirmedCSLBar, 'CSL', s.confirmedCSL, 'первая структура');

        s.firstState = 0;
        s.firstCSL = KH_NA; s.firstCSLBar = KH_NA; s.firstCSLTime = KH_NA;
        s.firstCSLRev = false;
      }
    }

    // старт поиска первого CSH
    if (s.firstState === 0 && ready && zoneActive && !khIsNa(s.fib1) && touchFromBelow) {
      s.firstState = 3;
      s.firstCSH = h; s.firstCSHBar = i; s.firstCSHTime = bar.t;
      s.firstCSHRev = false;
      s.firstCSL = KH_NA; s.firstCSLBar = KH_NA; s.firstCSLTime = KH_NA;
      s.firstCSLRev = false;
    }

    // STATE 3 — поиск первого CSH
    if (s.firstState === 3) {
      if (h >= s.manualSH) {
        s.firstState = 0;
        s.firstCSH = KH_NA; s.firstCSHBar = KH_NA; s.firstCSHTime = KH_NA;
        s.firstCSHRev = false;
      } else {
        if (h > s.firstCSH) { s.firstCSH = h; s.firstCSHBar = i; s.firstCSHTime = bar.t; }
        if (cl < o && cl < s.fib1) { s.firstCSHRev = true; s.firstState = 4; }
      }
    }

    // STATE 4 — подтверждение первого CSH
    if (s.firstState === 4) {
      if (h > s.firstCSH) { s.firstCSH = h; s.firstCSHBar = i; s.firstCSHTime = bar.t; }

      if (h >= s.manualSH) {
        s.firstState = 0;
        s.firstCSH = KH_NA; s.firstCSHBar = KH_NA; s.firstCSHTime = KH_NA;
        s.firstCSHRev = false;
      } else if (l <= s.manualSL && s.firstCSHRev && !khIsNa(s.firstCSH)) {
        s.confirmedCSH = s.firstCSH;
        s.confirmedCSHBar = s.firstCSHBar;
        s.confirmedCSHTime = s.firstCSHTime;
        s.currentSH = s.confirmedCSH;
        s.currentSHBar = s.confirmedCSHBar;
        s.currentSHTime = s.confirmedCSHTime;
        log(s.confirmedCSHBar, 'CSH', s.confirmedCSH, 'первая структура');

        s.firstState = 0;
        s.firstCSH = KH_NA; s.firstCSHBar = KH_NA; s.firstCSHTime = KH_NA;
        s.firstCSHRev = false;
      }
    }

    /* ============================================ MASTER: BULLISH ========= */

    // пробой текущего CSH — свеча пробоя сразу становится кандидатом
    if (s.bullState === 0 && !khIsNa(s.confirmedCSL) &&
        !khIsNa(s.currentSH) && !khIsNa(s.currentSL) && h > s.currentSH) {
      s.bullState = 1;
      s.bullCSHExt = h; s.bullCSHExtBar = i; s.bullCSHExtTime = bar.t;
      s.bullCSHFib2 = KH_NA;
      s.bullCSHRev = false;
      s.bullCSHFib2Reached = false;
    }

    // STATE 1 — поиск нового CSH
    if (s.bullState === 1) {
      if (l <= s.currentSL) {
        s.bullState = 0;
        s.bullCSHExt = KH_NA; s.bullCSHExtBar = KH_NA; s.bullCSHExtTime = KH_NA;
        s.bullCSHFib2 = KH_NA; s.bullCSHRev = false; s.bullCSHFib2Reached = false;
      } else {
        // сначала максимум, только потом FIB 2 и проверка касания
        if (khIsNa(s.bullCSHExt) || h > s.bullCSHExt) {
          s.bullCSHExt = h; s.bullCSHExtBar = i; s.bullCSHExtTime = bar.t;
        }
        s.bullCSHFib2 = s.currentSL + (s.bullCSHExt - s.currentSL) * fib2Pct;

        if (cl < o && cl < s.bullCSHExt) s.bullCSHRev = true;

        if (s.bullCSHRev && l <= s.bullCSHFib2) {
          s.bullCSHFib2Reached = true;

          s.confirmedCSH = s.bullCSHExt;
          s.confirmedCSHBar = s.bullCSHExtBar;
          s.confirmedCSHTime = s.bullCSHExtTime;
          s.currentSH = s.confirmedCSH;
          s.currentSHBar = s.confirmedCSHBar;
          s.currentSHTime = s.confirmedCSHTime;
          log(s.confirmedCSHBar, 'CSH', s.confirmedCSH, 'bullish master');

          s.bullState = 2;
          s.bullCSLExt = KH_NA; s.bullCSLExtBar = KH_NA; s.bullCSLExtTime = KH_NA;
          s.bullCSLFib2 = KH_NA; s.bullCSLFib2Reached = false; s.bullCSLRev = false;

          s.bullCSHExt = KH_NA; s.bullCSHExtBar = KH_NA; s.bullCSHExtTime = KH_NA;
          s.bullCSHFib2 = KH_NA; s.bullCSHRev = false;
        }
      }
    }

    // STATE 2 — поиск нового CSL
    if (s.bullState === 2) {
      if (l <= s.currentSL) {
        s.bullState = 0;
        s.bullCSLExt = KH_NA; s.bullCSLExtBar = KH_NA; s.bullCSLExtTime = KH_NA;
        s.bullCSLFib2 = KH_NA; s.bullCSLFib2Reached = false; s.bullCSLRev = false;
      } else {
        s.bullCSLFib2 = s.currentSL + (s.confirmedCSH - s.currentSL) * fib2Pct;

        if (l <= s.bullCSLFib2) s.bullCSLFib2Reached = true;

        if (s.bullCSLFib2Reached) {
          if (khIsNa(s.bullCSLExt) || l < s.bullCSLExt) {
            s.bullCSLExt = l; s.bullCSLExtBar = i; s.bullCSLExtTime = bar.t;
          }
        }

        if (s.bullCSLFib2Reached && cl > o && cl > s.bullCSLFib2) s.bullCSLRev = true;

        if (s.bullCSLRev && h >= s.confirmedCSH && !khIsNa(s.bullCSLExt)) {
          s.confirmedCSL = s.bullCSLExt;
          s.confirmedCSLBar = s.bullCSLExtBar;
          s.confirmedCSLTime = s.bullCSLExtTime;
          s.currentSL = s.confirmedCSL;
          s.currentSLBar = s.confirmedCSLBar;
          s.currentSLTime = s.confirmedCSLTime;
          log(s.confirmedCSLBar, 'CSL', s.confirmedCSL, 'bullish master');

          s.bullState = 0;

          // краевой случай: свеча подтверждения уже пробила текущий CSH —
          // её high обязан стать первым кандидатом, иначе следующая свеча
          // с меньшим максимумом займёт его место
          if (h > s.currentSH) {
            s.bullState = 1;
            s.bullCSHExt = h; s.bullCSHExtBar = i; s.bullCSHExtTime = bar.t;
            s.bullCSHFib2 = KH_NA; s.bullCSHRev = false; s.bullCSHFib2Reached = false;
          }

          s.bullCSLExt = KH_NA; s.bullCSLExtBar = KH_NA; s.bullCSLExtTime = KH_NA;
          s.bullCSLFib2 = KH_NA; s.bullCSLFib2Reached = false; s.bullCSLRev = false;
        }
      }
    }

    /* ================================================= рыночный тренд ===== */

    if (!khIsNa(s.confirmedCSL) && !khIsNa(s.confirmedCSH)) s.marketTrend = 'BULLISH';
    else if (ready) s.marketTrend = 'READY';
    else s.marketTrend = 'WAITING';

    /* ====================================== замок направления структуры === */

    if (s.direction === 0) {
      if (!khIsNa(s.confirmedCSL)) s.direction = 1;
      else if (!khIsNa(s.confirmedCSH)) s.direction = -1;
    }

    /* ============================================ MASTER: BEARISH ========= */

    const bearActive = s.direction === -1;

    // старт поиска нового CSL
    if (bearActive && s.bearState === 0 && !khIsNa(s.confirmedCSH) &&
        !khIsNa(s.currentSL) && l < s.currentSL) {
      s.bearState = 1;
      s.bearCSLExt = l; s.bearCSLExtBar = i; s.bearCSLExtTime = bar.t;
      s.bearCSLFib2 = KH_NA; s.bearCSLRev = false; s.bearCSLFib2Reached = false;
    }

    // STATE 1 — поиск нового CSL
    if (bearActive && s.bearState === 1) {
      if (h >= s.confirmedCSH) {
        s.bearState = 0;
        s.bearCSLExt = KH_NA; s.bearCSLExtBar = KH_NA; s.bearCSLExtTime = KH_NA;
        s.bearCSLFib2 = KH_NA; s.bearCSLRev = false; s.bearCSLFib2Reached = false;
      } else {
        if (khIsNa(s.bearCSLExt) || l < s.bearCSLExt) {
          s.bearCSLExt = l; s.bearCSLExtBar = i; s.bearCSLExtTime = bar.t;
        }
        s.bearCSLFib2 = s.confirmedCSH - (s.confirmedCSH - s.bearCSLExt) * fib2Pct;

        if (cl > o && cl > s.bearCSLExt) s.bearCSLRev = true;

        if (s.bearCSLRev && h >= s.bearCSLFib2) {
          s.bearCSLFib2Reached = true;

          s.confirmedCSL = s.bearCSLExt;
          s.confirmedCSLBar = s.bearCSLExtBar;
          s.confirmedCSLTime = s.bearCSLExtTime;
          s.currentSL = s.confirmedCSL;
          s.currentSLBar = s.confirmedCSLBar;
          s.currentSLTime = s.confirmedCSLTime;
          log(s.confirmedCSLBar, 'CSL', s.confirmedCSL, 'bearish master');

          s.bearCSLExt = KH_NA; s.bearCSLExtBar = KH_NA; s.bearCSLExtTime = KH_NA;
          s.bearCSLFib2 = KH_NA; s.bearCSLFib2Reached = false; s.bearCSLRev = false;

          s.bearState = 2;
          s.bearCSHExt = KH_NA; s.bearCSHExtBar = KH_NA; s.bearCSHExtTime = KH_NA;
          s.bearCSHFib2 = KH_NA; s.bearCSHFib2Reached = false; s.bearCSHRev = false;
        }
      }
    }

    // STATE 2 — поиск нового CSH
    if (bearActive && s.bearState === 2) {
      if (l <= s.currentSL) {
        s.bearState = 0;
        s.bearCSHExt = KH_NA; s.bearCSHExtBar = KH_NA; s.bearCSHExtTime = KH_NA;
        s.bearCSHFib2 = KH_NA; s.bearCSHFib2Reached = false; s.bearCSHRev = false;
      } else {
        if (khIsNa(s.bearCSHExt) || h > s.bearCSHExt) {
          s.bearCSHExt = h; s.bearCSHExtBar = i; s.bearCSHExtTime = bar.t;
        }
        s.bearCSHFib2 = s.currentSL + (s.bearCSHExt - s.currentSL) * fib2Pct;

        if (cl < o && cl < s.bearCSHExt) s.bearCSHRev = true;

        if (s.bearCSHRev && l <= s.bearCSHFib2) {
          s.bearCSHFib2Reached = true;

          s.confirmedCSH = s.bearCSHExt;
          s.confirmedCSHBar = s.bearCSHExtBar;
          s.confirmedCSHTime = s.bearCSHExtTime;
          s.currentSH = s.confirmedCSH;
          s.currentSHBar = s.confirmedCSHBar;
          s.currentSHTime = s.confirmedCSHTime;
          log(s.confirmedCSHBar, 'CSH', s.confirmedCSH, 'bearish master');

          s.bearCSHExt = KH_NA; s.bearCSHExtBar = KH_NA; s.bearCSHExtTime = KH_NA;
          s.bearCSHFib2 = KH_NA; s.bearCSHFib2Reached = false; s.bearCSHRev = false;

          s.bearState = 0;

          // та же свеча уже пробила текущий CSL — её low открывает новый цикл
          if (l < s.currentSL) {
            s.bearState = 1;
            s.bearCSLExt = l; s.bearCSLExtBar = i; s.bearCSLExtTime = bar.t;
            s.bearCSLFib2 = KH_NA; s.bearCSLRev = false; s.bearCSLFib2Reached = false;
          }
        }
      }
    }

    /* ======================================== АВТОМАТИЧЕСКИЕ СВИНГИ ======= */

    // старт bullish-ветки
    if (s.autoState === 0 && s.direction === 1 &&
        !khIsNa(s.confirmedCSH) && !khIsNa(s.confirmedCSL) &&
        l < s.confirmedCSL && i > s.confirmedCSLBar) {
      s.autoDir = 1;
      s.autoState = 1;

      s.autoSH = s.confirmedCSH; s.autoSHBar = s.confirmedCSHBar; s.autoSHTime = s.confirmedCSHTime;
      log(s.autoSHBar, 'AUTO SH', s.autoSH, 'последний CSH');

      s.autoSL = l; s.autoSLBar = i; s.autoSLTime = bar.t;
      s.autoFib1 = KH_NA; s.autoFib1Stopped = false;
    }

    // STATE 1 — поиск авто-SL
    if (s.autoState === 1 && s.autoDir === 1) {
      if (khIsNa(s.autoSL) || l < s.autoSL) {
        s.autoSL = l; s.autoSLBar = i; s.autoSLTime = bar.t;
      }
      s.autoFib1 = s.autoSL + (s.autoSH - s.autoSL) * fib1Pct;

      if (cl > o && h >= s.autoFib1) {
        s.autoFib1Stopped = true;
        log(s.autoSLBar, 'AUTO SL', s.autoSL, 'реакция до FIB 1');
        s.autoState = 2;
        s.autoFib1 = KH_NA;
      }
    }

    // STATE 2 — ждём пробой авто-SH
    if (s.autoState === 2 && s.autoDir === 1) {
      if (!khIsNa(s.autoSH) && h > s.autoSH) {
        s.autoState = 5;
        s.autoSH = h; s.autoSHBar = i; s.autoSHTime = bar.t;
        s.autoFib1 = KH_NA; s.autoFib1Stopped = false;
      }
    }

    // STATE 5 — подтверждение авто-SH
    if (s.autoState === 5 && s.autoDir === 1) {
      if (h > s.autoSH) { s.autoSH = h; s.autoSHBar = i; s.autoSHTime = bar.t; }
      s.autoFib1 = s.autoSL + (s.autoSH - s.autoSL) * fib1Pct;

      if (cl < o && l <= s.autoFib1) {
        s.autoFib1Stopped = true;
        log(s.autoSHBar, 'AUTO SH', s.autoSH, 'реакция до FIB 1');
        s.autoState = 1;
        s.autoFib1 = KH_NA;
      }
    }

    // старт bearish-ветки
    if (s.autoState === 0 && s.direction === -1 &&
        !khIsNa(s.confirmedCSH) && !khIsNa(s.confirmedCSL) &&
        h > s.confirmedCSH && i > s.confirmedCSHBar) {
      s.autoDir = -1;
      s.autoState = 3;

      s.autoSL = s.confirmedCSL; s.autoSLBar = s.confirmedCSLBar; s.autoSLTime = s.confirmedCSLTime;
      log(s.autoSLBar, 'AUTO SL', s.autoSL, 'последний CSL');

      s.autoSH = h; s.autoSHBar = i; s.autoSHTime = bar.t;
      s.autoFib1 = KH_NA; s.autoFib1Stopped = false;
    }

    // STATE 3 — поиск авто-SH
    if (s.autoState === 3 && s.autoDir === -1) {
      if (khIsNa(s.autoSH) || h > s.autoSH) {
        s.autoSH = h; s.autoSHBar = i; s.autoSHTime = bar.t;
      }
      s.autoFib1 = s.autoSL + (s.autoSH - s.autoSL) * fib1Pct;

      if (cl < o && l <= s.autoFib1) {
        s.autoFib1Stopped = true;
        log(s.autoSHBar, 'AUTO SH', s.autoSH, 'реакция до FIB 1');
        s.autoState = 4;
        s.autoFib1 = KH_NA;
      }
    }

    // STATE 4 — ждём пробой авто-SL
    if (s.autoState === 4 && s.autoDir === -1) {
      if (!khIsNa(s.autoSL) && l < s.autoSL) {
        s.autoState = 6;
        s.autoSL = l; s.autoSLBar = i; s.autoSLTime = bar.t;
        s.autoFib1 = KH_NA; s.autoFib1Stopped = false;
      }
    }

    // STATE 6 — подтверждение авто-SL
    if (s.autoState === 6 && s.autoDir === -1) {
      if (l < s.autoSL) { s.autoSL = l; s.autoSLBar = i; s.autoSLTime = bar.t; }
      s.autoFib1 = s.autoSL + (s.autoSH - s.autoSL) * fib1Pct;

      if (cl > o && h >= s.autoFib1) {
        s.autoFib1Stopped = true;
        log(s.autoSLBar, 'AUTO SL', s.autoSL, 'реакция до FIB 1');
        // как в оригинале: медвежий цикл уходит в состояние 2
        s.autoState = 2;
        s.autoFib1 = KH_NA;
      }
    }

    /* ============================================ CONFIRM SH / SL ========= */

    if (s.autoDir === 1 && s.autoState === 1) {
      s.confirmHighDone = false;
      s.confirmHighCand = KH_NA; s.confirmHighCandBar = KH_NA; s.confirmHighCandTime = KH_NA;
    }
    if (s.autoDir === -1 && s.autoState === 3) {
      s.confirmLowDone = false;
      s.confirmLowCand = KH_NA; s.confirmLowCandBar = KH_NA; s.confirmLowCandTime = KH_NA;
    }

    // bullish — ищем один максимум разворота
    if (s.autoDir === 1 && s.autoState === 2 && !s.confirmHighDone &&
        !khIsNa(s.autoSH) && !khIsNa(s.autoSL)) {
      if (khIsNa(s.confirmHighCand) || h > s.confirmHighCand) {
        s.confirmHighCand = h; s.confirmHighCandBar = i; s.confirmHighCandTime = bar.t;
      }
    }

    // bullish — пробой авто-SL превращает максимум в CSH
    if (s.autoDir === 1 && s.autoState === 2 && !s.confirmHighDone &&
        !khIsNa(s.autoSL) && !khIsNa(s.confirmHighCand) && l < s.autoSL) {
      s.confirmSH = s.confirmHighCand;
      s.confirmSHBar = s.confirmHighCandBar;
      s.confirmSHTime = s.confirmHighCandTime;
      log(s.confirmSHBar, 'CONFIRM SH', s.confirmSH, 'пробой авто-SL');

      s.confirmHighDone = true;
      s.confirmHighCand = KH_NA; s.confirmHighCandBar = KH_NA; s.confirmHighCandTime = KH_NA;
    }

    // bearish — ищем один минимум разворота
    if (s.autoDir === -1 && s.autoState === 4 && !s.confirmLowDone &&
        !khIsNa(s.autoSH) && !khIsNa(s.autoSL)) {
      if (khIsNa(s.confirmLowCand) || l < s.confirmLowCand) {
        s.confirmLowCand = l; s.confirmLowCandBar = i; s.confirmLowCandTime = bar.t;
      }
    }

    // bearish — пробой авто-SH превращает минимум в CSL
    if (s.autoDir === -1 && s.autoState === 4 && !s.confirmLowDone &&
        !khIsNa(s.autoSH) && !khIsNa(s.confirmLowCand) && h > s.autoSH) {
      s.confirmSL = s.confirmLowCand;
      s.confirmSLBar = s.confirmLowCandBar;
      s.confirmSLTime = s.confirmLowCandTime;
      log(s.confirmSLBar, 'CONFIRM SL', s.confirmSL, 'пробой авто-SH');

      s.confirmLowDone = true;
      s.confirmLowCand = KH_NA; s.confirmLowCandBar = KH_NA; s.confirmLowCandTime = KH_NA;
    }

    /* ======================================= мост confirm → master ======== */

    const firstCSH = !s.autoMasterStarted && !khIsNa(s.confirmSH);
    const firstCSL = !s.autoMasterStarted && !khIsNa(s.confirmSL);

    if (firstCSH) {
      s.autoMasterStarted = true;
      s.autoMasterDir = -1;

      s.confirmedCSH = s.confirmSH;
      s.confirmedCSHBar = s.confirmSHBar;
      s.confirmedCSHTime = s.confirmSHTime;
      s.currentSH = s.confirmSH;
      s.currentSHBar = s.confirmSHBar;
      s.currentSHTime = s.confirmSHTime;

      if (!khIsNa(s.autoSL)) {
        s.currentSL = s.autoSL; s.currentSLBar = s.autoSLBar; s.currentSLTime = s.autoSLTime;
      }

      s.direction = -1;
      log(i, 'STRUCTURE BEARISH', s.confirmedCSH, 'мост confirm → master');

      s.bearState = 0;
      s.bearCSLExt = KH_NA; s.bearCSLExtBar = KH_NA; s.bearCSLExtTime = KH_NA;
      s.bearCSLFib2 = KH_NA; s.bearCSLRev = false; s.bearCSLFib2Reached = false;
      s.bearCSHExt = KH_NA; s.bearCSHExtBar = KH_NA; s.bearCSHExtTime = KH_NA;
      s.bearCSHFib2 = KH_NA; s.bearCSHRev = false; s.bearCSHFib2Reached = false;
    }

    if (firstCSL) {
      s.autoMasterStarted = true;
      s.autoMasterDir = 1;

      s.confirmedCSL = s.confirmSL;
      s.confirmedCSLBar = s.confirmSLBar;
      s.confirmedCSLTime = s.confirmSLTime;
      s.currentSL = s.confirmSL;
      s.currentSLBar = s.confirmSLBar;
      s.currentSLTime = s.confirmSLTime;

      if (!khIsNa(s.autoSH)) {
        s.currentSH = s.autoSH; s.currentSHBar = s.autoSHBar; s.currentSHTime = s.autoSHTime;
      }

      s.direction = 1;
      log(i, 'STRUCTURE BULLISH', s.confirmedCSL, 'мост confirm → master');

      s.bullState = 0;
      s.bullCSHExt = KH_NA; s.bullCSHExtBar = KH_NA; s.bullCSHExtTime = KH_NA;
      s.bullCSHFib2 = KH_NA; s.bullCSHRev = false; s.bullCSHFib2Reached = false;
      s.bullCSLExt = KH_NA; s.bullCSLExtBar = KH_NA; s.bullCSLExtTime = KH_NA;
      s.bullCSLFib2 = KH_NA; s.bullCSLRev = false; s.bullCSLFib2Reached = false;
    }
  }

  /* ------------------------------------------------------------- итог ---- */

  // Направление сделки берём из замка направления: marketTrend в оригинале
  // умеет только BULLISH / READY / WAITING и для bias непригоден.
  s.trend = s.direction === 1 ? 'BULLISH' : s.direction === -1 ? 'BEARISH' : s.marketTrend;

  // совместимость с остальным дашбордом
  s.shPrice = s.currentSH; s.shBar = s.currentSHBar; s.shTime = s.currentSHTime;
  s.slPrice = s.currentSL; s.slBar = s.currentSLBar; s.slTime = s.currentSLTime;

  return s;
}

if (typeof module !== 'undefined' && module.exports) module.exports = { runKhusa };
