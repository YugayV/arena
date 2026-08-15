/**
 * График свечей турнирной площадки.
 *
 * Автор: Vitaliy Yugay · vamp.09.94@gmail.com · https://github.com/YugayV
 *
 * Рисует наш собственный ряд свечей — тот самый, по которому движок
 * исполняет ордера. Это принципиально: рядом на странице есть виджет
 * TradingView, но он показывает чужие данные. Спорные ситуации разбираются
 * по тому, что нарисовано здесь.
 *
 * Цвета берутся из CSS-переменных, поэтому график сам следует теме сайта
 * и ничего не знает о том, какая тема сейчас включена.
 */

class CandleChart {
  constructor(canvas, opts = {}) {
    this.cv = canvas;
    this.ctx = canvas.getContext('2d');
    this.candles = [];
    this.overlays = [];
    this.digits = opts.digits ?? 2;
    this.hover = -1;
    this.pad = { l: 8, r: 74, t: 10, b: 26 };

    this._onMove = (e) => this._move(e);
    this._onLeave = () => { this.hover = -1; this.draw(); this._tip(null); };
    canvas.addEventListener('mousemove', this._onMove);
    canvas.addEventListener('mouseleave', this._onLeave);

    this.tip = opts.tooltip || null;
    this._ro = new ResizeObserver(() => this.draw());
    this._ro.observe(canvas);
  }

  destroy() {
    this.cv.removeEventListener('mousemove', this._onMove);
    this.cv.removeEventListener('mouseleave', this._onLeave);
    this._ro.disconnect();
  }

  setData(candles) {
    this.candles = Array.isArray(candles) ? candles : [];
    this.draw();
  }

  /** Уровни поверх графика: вход, стоп, цель, границы площади работы. */
  setOverlays(list) {
    this.overlays = list || [];
    this.draw();
  }

  css(name, fallback) {
    const v = getComputedStyle(document.documentElement).getPropertyValue(name);
    return (v || '').trim() || fallback;
  }

  /* --------------------------------------------------------------- расчёты */

  _geom() {
    const dpr = window.devicePixelRatio || 1;
    const w = this.cv.clientWidth;
    const h = this.cv.clientHeight;
    if (this.cv.width !== Math.round(w * dpr) || this.cv.height !== Math.round(h * dpr)) {
      this.cv.width = Math.round(w * dpr);
      this.cv.height = Math.round(h * dpr);
    }
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    const p = this.pad;
    const plotW = Math.max(10, w - p.l - p.r);
    const plotH = Math.max(10, h - p.t - p.b);
    return { w, h, plotW, plotH, p };
  }

  _scale(g) {
    const c = this.candles;
    if (!c.length) return null;

    let hi = -Infinity, lo = Infinity;
    for (const k of c) { if (k.h > hi) hi = k.h; if (k.l < lo) lo = k.l; }
    for (const o of this.overlays) {
      if (!Number.isFinite(o.price)) continue;
      if (o.price > hi) hi = o.price;
      if (o.price < lo) lo = o.price;
    }
    if (!(hi > lo)) { hi = lo + 1; }

    const padPx = (hi - lo) * 0.06;
    hi += padPx; lo -= padPx;

    const step = g.plotW / c.length;
    return {
      hi, lo, step,
      y: (price) => g.p.t + (hi - price) / (hi - lo) * g.plotH,
      x: (i) => g.p.l + i * step + step / 2,
      i: (px) => Math.floor((px - g.p.l) / step),
    };
  }

  /* --------------------------------------------------------------- отрисовка */

  draw() {
    const g = this._geom();
    const ctx = this.ctx;
    ctx.clearRect(0, 0, g.w, g.h);

    const s = this._scale(g);
    if (!s) {
      ctx.fillStyle = this.css('--muted', '#888');
      ctx.font = '13px system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('Котировок пока нет', g.w / 2, g.h / 2);
      return;
    }

    this._grid(g, s);
    this._candles(g, s);
    this._levels(g, s);
    this._crosshair(g, s);
  }

  _grid(g, s) {
    const ctx = this.ctx;
    const grid = this.css('--grid', 'rgba(128,128,128,.1)');
    const muted = this.css('--muted', '#888');

    ctx.strokeStyle = grid;
    ctx.lineWidth = 1;
    ctx.fillStyle = muted;
    ctx.font = '11px ui-monospace, Menlo, monospace';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';

    const lines = 5;
    for (let i = 0; i <= lines; i++) {
      const price = s.lo + (s.hi - s.lo) * (i / lines);
      const y = Math.round(s.y(price)) + 0.5;
      ctx.beginPath();
      ctx.moveTo(g.p.l, y);
      ctx.lineTo(g.p.l + g.plotW, y);
      ctx.stroke();
      ctx.fillText(price.toFixed(this.digits), g.p.l + g.plotW + 8, y);
    }

    // подписи времени: примерно каждые 90 пикселей, по границам суток
    const c = this.candles;
    if (c.length > 1) {
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      const every = Math.max(1, Math.ceil(c.length / (g.plotW / 90)));
      for (let i = 0; i < c.length; i += every) {
        const d = new Date(c[i].ts);
        const label = d.getUTCHours() === 0
          ? `${String(d.getUTCDate()).padStart(2, '0')}.${String(d.getUTCMonth() + 1).padStart(2, '0')}`
          : `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
        ctx.fillText(label, s.x(i), g.p.t + g.plotH + 7);
      }
    }
  }

  _candles(g, s) {
    const ctx = this.ctx;
    const up = this.css('--up', '#2ebd85');
    const down = this.css('--down', '#f0616d');
    const bodyW = Math.max(1, Math.min(14, s.step * 0.68));

    for (let i = 0; i < this.candles.length; i++) {
      const k = this.candles[i];
      const rising = k.c >= k.o;
      const color = rising ? up : down;
      const x = s.x(i);

      ctx.strokeStyle = color;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(Math.round(x) + 0.5, s.y(k.h));
      ctx.lineTo(Math.round(x) + 0.5, s.y(k.l));
      ctx.stroke();

      const yo = s.y(k.o);
      const yc = s.y(k.c);
      const top = Math.min(yo, yc);
      const hgt = Math.max(1, Math.abs(yc - yo));
      ctx.fillStyle = color;
      ctx.fillRect(x - bodyW / 2, top, bodyW, hgt);
    }
  }

  _levels(g, s) {
    const ctx = this.ctx;
    ctx.font = '11px ui-monospace, Menlo, monospace';
    ctx.textBaseline = 'bottom';
    ctx.textAlign = 'left';

    for (const o of this.overlays) {
      if (!Number.isFinite(o.price)) continue;
      const y = Math.round(s.y(o.price)) + 0.5;
      ctx.strokeStyle = o.color || this.css('--accent', '#5b8def');
      ctx.lineWidth = 1;
      ctx.setLineDash(o.dash || [5, 4]);
      ctx.beginPath();
      ctx.moveTo(g.p.l, y);
      ctx.lineTo(g.p.l + g.plotW, y);
      ctx.stroke();
      ctx.setLineDash([]);

      if (o.label) {
        ctx.fillStyle = o.color || this.css('--accent', '#5b8def');
        ctx.fillText(o.label, g.p.l + 4, y - 3);
      }
    }
  }

  _crosshair(g, s) {
    if (this.hover < 0 || this.hover >= this.candles.length) return;
    const ctx = this.ctx;
    const x = Math.round(s.x(this.hover)) + 0.5;
    ctx.strokeStyle = this.css('--muted', '#888');
    ctx.lineWidth = 1;
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    ctx.moveTo(x, g.p.t);
    ctx.lineTo(x, g.p.t + g.plotH);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  /* ------------------------------------------------------------ наведение */

  _move(e) {
    const g = this._geom();
    const s = this._scale(g);
    if (!s) return;
    const rect = this.cv.getBoundingClientRect();
    const px = e.clientX - rect.left;
    const i = Math.max(0, Math.min(this.candles.length - 1, s.i(px)));
    if (i !== this.hover) {
      this.hover = i;
      this.draw();
    }
    this._tip(this.candles[i], e.clientX - rect.left, e.clientY - rect.top);
  }

  _tip(k, x, y) {
    if (!this.tip) return;
    if (!k) { this.tip.hidden = true; return; }
    const d = new Date(k.ts);
    const pad = (n) => String(n).padStart(2, '0');
    const f = (v) => Number(v).toFixed(this.digits);
    this.tip.innerHTML =
      `${pad(d.getUTCDate())}.${pad(d.getUTCMonth() + 1)} ` +
      `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())} UTC<br>` +
      `O ${f(k.o)}  H ${f(k.h)}<br>L ${f(k.l)}  C ${f(k.c)}`;
    this.tip.hidden = false;
    const w = this.cv.clientWidth;
    this.tip.style.left = (x > w - 160 ? x - 150 : x + 14) + 'px';
    this.tip.style.top = Math.max(4, y - 60) + 'px';
  }
}

window.CandleChart = CandleChart;
