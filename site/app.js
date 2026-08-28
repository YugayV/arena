/**
 * KHUSA Arena — логика сайта.
 *
 * Автор: Vitaliy Yugay · vamp.09.94@gmail.com · https://github.com/YugayV
 *
 * Никаких сборщиков и фреймворков: один файл, обычные запросы к /api.
 * Сессия живёт в HttpOnly-куке, поэтому JS её не видит и не может утечь
 * вместе с чужим скриптом — состояние входа узнаём через GET /api/me.
 */

const $ = (id) => document.getElementById(id);

const state = {
  user: null,
  tour: null,
  joined: false,
  part: null,
  tf: 'H1',
  symbol: null,        // выбранный инструмент
  symbols: [],         // инструменты турнира с их характеристиками
  lags: {},            // отставание потока по каждому инструменту
  prices: {},          // последняя цена по каждому инструменту
  specs: {},           // характеристики инструментов по символу
  candles: [],
  digits: 2,
  authMode: 'login',
  lang: 'ru',
  feed: null,          // диагностика потока: почему пусто
  timer: null,
};

/* ------------------------------------------------------------------ запросы */

async function api(path, opts = {}) {
  const res = await fetch('/api' + path, {
    method: opts.body ? 'POST' : 'GET',
    headers: opts.body ? { 'Content-Type': 'application/json' } : {},
    body: opts.body ? JSON.stringify(opts.body) : undefined,
    credentials: 'same-origin',
    ...opts.raw,
  });
  let data = null;
  try { data = await res.json(); } catch { /* тело может быть пустым */ }
  if (!res.ok) {
    const msg = (data && (data.detail || data.message)) || `Ошибка ${res.status}`;
    throw new Error(typeof msg === 'string' ? msg : JSON.stringify(msg));
  }
  return data;
}

/* -------------------------------------------------------------------- вид */

const fmt = (v, d = state.digits) =>
  Number.isFinite(Number(v))
    ? Number(v).toLocaleString('ru-RU', { minimumFractionDigits: d, maximumFractionDigits: d })
    : '—';

/** Число по правилам конкретного инструмента.
 *  Без этого цена EUR/USD в таблице сделок показывалась бы как 1,077 —
 *  с точностью выбранного сейчас золота, то есть бессмысленно. */
function fmtSym(v, symbol) {
  const spec = state.specs[symbol];
  return fmt(v, spec ? spec.digits : state.digits);
}

const money = (v) => (Number.isFinite(Number(v))
  ? Number(v).toLocaleString('ru-RU', { maximumFractionDigits: 2 }) : '—');

function when(ms) {
  if (!ms) return '—';
  const d = new Date(Number(ms));
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getUTCDate())}.${p(d.getUTCMonth() + 1)} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
}

function note(el, text, kind = '') {
  if (!text) { el.hidden = true; return; }
  el.textContent = text;
  el.className = 'note small' + (kind ? ' ' + kind : '');
  el.hidden = false;
}

/* ------------------------------------------------------------------- темы */

function setTheme(name) {
  document.documentElement.setAttribute('data-theme', name);
  localStorage.setItem('arena-theme', name);
  document.querySelectorAll('[data-theme-set]').forEach((b) => {
    b.setAttribute('aria-pressed', String(b.dataset.themeSet === name));
  });
  if (chart) chart.draw();
}

/* ------------------------------------------------------------------- язык */

function setLang(lang) {
  state.lang = lang;
  localStorage.setItem('arena-lang', lang);
  applyI18n(lang);
  document.querySelectorAll('[data-lang]').forEach((b) => {
    b.setAttribute('aria-pressed', String(b.dataset.lang === lang));
  });

  // Перерисовываем всё, что собрано скриптом: словарь трогает только
  // размеченную статику, а таблицы и карточки строятся в JS.
  setAuthMode(state.authMode);
  renderTicker();
  renderAccount();
  renderTrades();
  renderProfile();
  previewTrade();
  if (!$('page-board').hidden) loadBoard();
  if (state.tour) loadTournament();
}

/* ---------------------------------------------------------------- вкладки */

const PAGES = ['home', 'about', 'products', 'academy', 'rules', 'arena', 'board', 'profile'];

function show(tab) {
  PAGES.forEach((t) => {
    const el = $('page-' + t);
    if (el) el.hidden = t !== tab;
  });
  document.querySelectorAll('#tabs button').forEach((b) => {
    b.setAttribute('aria-selected', String(b.dataset.tab === tab));
  });
  location.hash = tab;

  if (tab === 'board') loadBoard();
  if (tab === 'arena') refreshArena();
  if (tab === 'profile') renderProfile();
  window.scrollTo({ top: 0, behavior: 'instant' });
}

/* ------------------------------------------------------------------ график */

let chart = null;

function initChart() {
  if (chart) return;
  chart = new CandleChart($('chart'), { tooltip: $('tip'), digits: state.digits });
}

async function loadCandles() {
  try {
    const sym = state.symbol ? `&symbol=${encodeURIComponent(state.symbol)}` : '';
    const r = await api(`/candles?tf=${state.tf}&bars=260${sym}`);
    state.candles = r.candles || [];
    state.symbol = r.symbol;
    // знаков после запятой у каждого инструмента своё: 5 у EUR/USD, 2 у золота
    state.digits = r.spec ? r.spec.digits : 2;

    initChart();
    chart.digits = state.digits;
    chart.setData(state.candles);
    drawOverlays();

    const name = r.spec && r.spec.name !== r.symbol ? ` · ${r.spec.name}` : '';
    $('chartTitle').textContent = `${r.symbol}${name} · ${r.tf}`;
    const last = state.candles[state.candles.length - 1];
    $('pricePill').textContent = last ? fmt(last.c) : '—';
    updateFeedPill(r.lag_ms);
    renderInstruments();

    // Пустой график без объяснения — худшее, что можно показать человеку,
    // который только что настроил мост. Спрашиваем сервер, что не так.
    if (!state.candles.length) loadFeedDiag();
    else note($('chartHint'), '');
  } catch (e) {
    console.warn('Свечи не загрузились:', e.message);
  }
}

/** Почему котировок нет — ответ берём у сервера, а не гадаем в браузере. */
async function loadFeedDiag() {
  try {
    const f = await api('/feed');
    state.feed = f;
    if (f.hint) {
      note($('chartHint'), f.hint, 'warn');
    } else {
      note($('chartHint'), '');
    }
  } catch {
    note($('chartHint'), '');
  }
}

/** Лента инструментов турнира с текущей ценой и признаком отставания. */
function renderInstruments() {
  const bar = $('instrumentBar');
  if (!state.symbols.length) { bar.innerHTML = ''; return; }

  bar.innerHTML = state.symbols.map((s) => {
    const lag = state.lags[s.symbol];
    const stale = lag === null || lag === undefined || lag > 180000;
    const raw = s.symbol === state.symbol && state.candles.length
      ? state.candles[state.candles.length - 1].c
      : state.prices[s.symbol];
    // Number(null) === 0, поэтому проверки на конечность мало: инструмент
    // без котировок показывал цену 0.00000, и это читалось как настоящий
    // ноль, а не как отсутствие данных.
    const px = (raw === null || raw === undefined || raw === '' || !Number.isFinite(Number(raw)))
      ? '' : Number(raw).toFixed(s.digits);
    return `<button data-sym="${s.symbol}" class="${stale ? 'stale' : ''}"
      aria-pressed="${s.symbol === state.symbol}"
      title="${esc(s.name)}${stale ? ' — поток отстал' : ''}">
      <span class="sym">${s.symbol}</span>
      <span class="px">${px || esc(s.group)}</span>
    </button>`;
  }).join('');

  bar.querySelectorAll('[data-sym]').forEach((b) => {
    b.onclick = () => {
      if (b.dataset.sym === state.symbol) return;
      state.symbol = b.dataset.sym;
      // Стоп и цель от прошлого инструмента здесь бессмысленны: уровень 150
      // от USD/JPY на графике EUR/USD — это не план, а мусор.
      ['sl', 'tp', 'limitPrice'].forEach((id) => { $(id).value = ''; });
      note($('tradeMsg'), '');
      loadCandles();
      previewTrade();
    };
  });

  const lag = state.lags[state.symbol];
  const pill = $('symLag');
  pill.hidden = false;
  if (lag === null || lag === undefined) {
    pill.textContent = 'нет котировок';
    pill.className = 'pill bad';
  } else {
    const sec = Math.round(lag / 1000);
    pill.textContent = sec < 90 ? `${sec} с назад` : `${Math.round(sec / 60)} мин назад`;
    pill.className = 'pill ' + (sec < 180 ? 'ok' : 'warn');
  }
}

/** Бегущая строка из макета: живые цены инструментов турнира. */
function renderTicker() {
  const host = $('ticker');
  if (!host) return;

  const items = state.symbols.length
    ? state.symbols.map((s) => {
        const px = state.prices[s.symbol];
        const val = (px === null || px === undefined || !Number.isFinite(Number(px)))
          ? '—' : Number(px).toFixed(s.digits);
        return `<span>${esc(s.symbol)} <b>${val}</b></span>`;
      })
    : [
        '<span>Турнир по торговле от структуры</span>',
        '<span>Бумажный счёт · <b>общие котировки</b></span>',
        '<span>Стоп обязателен</span>',
      ];

  // Лента повторяется дважды: анимация сдвигает её ровно на половину,
  // и склейка получается бесшовной при любом числе инструментов.
  host.innerHTML = items.join('') + items.join('');
}

function updateFeedPill(lagMs) {
  const pill = $('feedPill');
  pill.hidden = false;
  if (lagMs === null || lagMs === undefined) {
    pill.textContent = 'поток: нет данных';
    pill.className = 'pill bad';
    return;
  }
  const s = Math.round(lagMs / 1000);
  pill.textContent = `поток: ${s < 90 ? s + ' с' : Math.round(s / 60) + ' мин'}`;
  pill.className = 'pill ' + (s < 180 ? 'ok' : 'bad');
}

/** Уровни задуманной сделки и открытых позиций поверх свечей. */
function drawOverlays() {
  if (!chart) return;
  const css = (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
  const out = [];

  const sl = parseFloat($('sl').value);
  const tp = parseFloat($('tp').value);
  const lim = parseFloat($('limitPrice').value);
  if (Number.isFinite(lim) && $('kind').value === 'limit') {
    out.push({ price: lim, color: css('--accent'), label: 'вход' });
  }
  if (Number.isFinite(sl)) out.push({ price: sl, color: css('--down'), label: 'стоп' });
  if (Number.isFinite(tp)) out.push({ price: tp, color: css('--up'), label: 'цель' });

  // Только позиции ПО ЭТОМУ инструменту: уровень золота 3400 на графике
  // EUR/USD растянул бы шкалу так, что свечей стало бы не видно.
  const st = state.part;
  if (st) {
    const mine = (row) => !row.symbol || row.symbol === state.symbol;
    for (const t of (st.open_trades || []).filter(mine)) {
      out.push({ price: t.entry, color: css('--accent-2'), dash: [2, 3],
        label: `${t.side === 'buy' ? 'лонг' : 'шорт'} ${fmtSym(t.entry, t.symbol)}` });
    }
    for (const o of (st.pending_orders || []).filter(mine)) {
      if (o.limit_price) {
        out.push({ price: o.limit_price, color: css('--muted'), dash: [2, 4],
          label: 'ордер' });
      }
    }
  }
  chart.setOverlays(out);
}

/* ------------------------------------------------------------------ турнир */

async function loadTournament() {
  const r = await api('/tournament');
  state.tour = r.tournament;
  state.joined = !!r.joined;
  state.part = r.state || null;
  state.tradable = r.tradable;
  state.reason = r.reason;
  state.symbols = r.symbols || [];
  state.lags = r.lags || {};
  state.prices = r.prices || {};
  state.specs = Object.fromEntries((r.symbols || []).map((s) => [s.symbol, s]));
  if (!state.symbol && state.symbols.length) {
    state.symbol = state.symbols[0].symbol;
  }

  renderHero(r);
  renderTicker();
  renderHeroResults();

  const box = $('tourInfo');
  if (!r.tournament) {
    box.textContent = 'Активного турнира сейчас нет.';
    return r;
  }
  const t = r.tournament;
  box.innerHTML = `
    <div class="stats">
      <div class="stat"><div class="k">Название</div><div class="v" style="font-size:14px">${esc(t.name)}</div></div>
      <div class="stat"><div class="k">Инструменты</div><div class="v" style="font-size:15px">${
        (r.symbols || []).map((s) => s.symbol).join(', ') || t.symbol}</div></div>
      <div class="stat"><div class="k">Старт депозита</div><div class="v">${money(t.start_balance)}</div></div>
      <div class="stat"><div class="k">Риск на сделку</div><div class="v">${t.max_risk_pct}%</div></div>
      <div class="stat"><div class="k">Участников</div><div class="v">${r.participants}</div></div>
      <div class="stat"><div class="k">До конца</div><div class="v" style="font-size:15px">${untilEnd(t.ends_ms)}</div></div>
    </div>
    <p class="small ${r.tradable ? 'muted' : 'warn'}" style="margin-top:12px">
      ${r.tradable ? 'Торговля открыта.' : 'Торговля закрыта: ' + (r.reason || '—')}
    </p>`;
  return r;
}

/** «Последние результаты» из макета — живая тройка лидеров. */
async function renderHeroResults() {
  const host = $('heroResults');
  if (!host) return;
  try {
    const r = await api('/leaderboard');
    const rows = (r.rows || []).slice(0, 3);
    if (!rows.length) {
      host.innerHTML = `<li class="muted small">${esc(t('hero.empty', state.lang))}</li>`;
      return;
    }
    host.innerHTML = rows.map((row) => `
      <li>
        <span class="place">${row.place}</span>
        <span class="who">${esc(row.nickname)}</span>
        <span class="val ${row.return_pct >= 0 ? 'up' : 'down'}">${row.return_pct.toFixed(2)}%</span>
      </li>`).join('');
  } catch {
    host.innerHTML = `<li class="muted small">${esc(t('hero.empty', state.lang))}</li>`;
  }
}

/** Цифры под заголовком главной. */
function renderHero(r) {
  const t = r.tournament;
  const set = (id, v) => { const el = $(id); if (el) el.textContent = v; };
  if (!t) {
    ['hsSymbols', 'hsPlayers', 'hsBalance', 'hsLeft'].forEach((id) => set(id, '—'));
    return;
  }
  set('hsSymbols', (r.symbols || []).length || 1);
  set('hsPlayers', r.participants ?? 0);
  set('hsBalance', money(t.start_balance));
  set('hsLeft', untilEnd(t.ends_ms));
}

function untilEnd(ms) {
  const left = Number(ms) - Date.now();
  if (left <= 0) return 'завершён';
  const d = Math.floor(left / 86400000);
  const h = Math.floor((left % 86400000) / 3600000);
  return d > 0 ? `${d} д ${h} ч` : `${h} ч`;
}

async function joinTournament() {
  if (!state.user) { show('profile'); return; }
  try {
    await api('/tournament/join', { body: {} });
    await refreshArena();
    show('arena');
  } catch (e) {
    alert(e.message);
  }
}

/* ------------------------------------------------------------------ счёт */

function renderAccount() {
  const st = state.part;
  if (!st || !st.participant) {
    ['stBalance', 'stEquity', 'stTrades', 'stDd'].forEach((k) => { $(k).textContent = '—'; });
    return;
  }
  const p = st.participant;
  const s = st.stats || {};
  $('stBalance').textContent = money(p.balance);
  $('stEquity').textContent = money(p.equity);
  $('stTrades').textContent = s.trades ?? 0;
  $('stDd').textContent = (s.max_dd ?? 0).toFixed(1) + '%';
}

function renderTrades() {
  const st = state.part;
  const box = $('tradesBox');
  if (!st) { box.textContent = 'Вы ещё не участвуете в турнире.'; return; }

  const open = st.open_trades || [];
  const pend = st.pending_orders || [];
  if (!open.length && !pend.length) {
    box.innerHTML = '<span class="muted">Открытых сделок и ордеров нет.</span>';
    return;
  }

  let html = '';
  if (open.length) {
    html += '<h3>Открытые</h3><div class="table-wrap"><table><thead><tr>' +
      '<th>Инструмент</th><th>Сторона</th><th class="num">Вход</th><th class="num">Стоп</th>' +
      '<th class="num">Цель</th><th class="num">Объём</th><th></th></tr></thead><tbody>';
    for (const t of open) {
      html += `<tr>
        <td>${esc(t.symbol || '—')}</td>
        <td class="${t.side === 'buy' ? 'up' : 'down'}">${t.side === 'buy' ? 'лонг' : 'шорт'}</td>
        <td class="num">${fmtSym(t.entry, t.symbol)}</td>
        <td class="num">${fmtSym(t.sl, t.symbol)}</td>
        <td class="num">${fmtSym(t.tp, t.symbol)}</td>
        <td class="num">${Number(t.volume).toFixed(3)}</td>
        <td class="right"><button class="btn sm" data-close="${t.id}">Закрыть</button></td>
      </tr>`;
    }
    html += '</tbody></table></div>';
  }
  if (pend.length) {
    html += '<h3 style="margin-top:14px">Отложенные</h3><div class="table-wrap"><table><thead><tr>' +
      '<th>Инструмент</th><th>Сторона</th><th class="num">Цена</th><th class="num">Стоп</th>' +
      '<th class="num">Цель</th><th></th></tr></thead><tbody>';
    for (const o of pend) {
      html += `<tr>
        <td>${esc(o.symbol || '—')}</td>
        <td class="${o.side === 'buy' ? 'up' : 'down'}">${o.side === 'buy' ? 'лонг' : 'шорт'}</td>
        <td class="num">${fmtSym(o.limit_price, o.symbol)}</td>
        <td class="num">${fmtSym(o.sl, o.symbol)}</td>
        <td class="num">${fmtSym(o.tp, o.symbol)}</td>
        <td class="right"><button class="btn sm" data-cancel="${o.id}">Снять</button></td>
      </tr>`;
    }
    html += '</tbody></table></div>';
  }
  box.innerHTML = html;

  box.querySelectorAll('[data-close]').forEach((b) => {
    b.onclick = async () => {
      b.disabled = true;
      try { await api(`/trades/${b.dataset.close}/close`, { body: {} }); await refreshArena(); }
      catch (e) { alert(e.message); b.disabled = false; }
    };
  });
  box.querySelectorAll('[data-cancel]').forEach((b) => {
    b.onclick = async () => {
      b.disabled = true;
      try { await api(`/orders/${b.dataset.cancel}/cancel`, { body: {} }); await refreshArena(); }
      catch (e) { alert(e.message); b.disabled = false; }
    };
  });
}

/* ------------------------------------------------------------ форма сделки */

function previewTrade() {
  const box = $('tradePreview');
  const st = state.part;
  const last = state.candles[state.candles.length - 1];
  if (!st || !last) { box.textContent = 'Нужно войти в турнир.'; return; }

  const kind = $('kind').value;
  const side = $('side').value;
  const entry = kind === 'limit' ? parseFloat($('limitPrice').value) : Number(last.c);
  const sl = parseFloat($('sl').value);
  const tp = parseFloat($('tp').value);
  const risk = parseFloat($('riskPct').value);

  if (!Number.isFinite(entry) || !Number.isFinite(sl) || !Number.isFinite(risk)) {
    box.textContent = 'Заполните стоп, чтобы увидеть объём и R:R.';
    box.className = 'note small';
    return;
  }
  const dist = Math.abs(entry - sl);
  if (dist <= 0) {
    box.textContent = 'Стоп совпадает с ценой входа.';
    box.className = 'note small err';
    return;
  }
  const bal = Number(st.participant.balance);
  const vol = (bal * risk / 100) / dist;
  const rr = Number.isFinite(tp) ? Math.abs(tp - entry) / dist : null;

  const wrongSide = (side === 'buy' && sl >= entry) || (side === 'sell' && sl <= entry);
  box.className = 'note small' + (wrongSide ? ' err' : '');
  box.innerHTML = wrongSide
    ? `Стоп стоит не с той стороны: для ${side === 'buy' ? 'покупки он должен быть ниже' : 'продажи он должен быть выше'} входа.`
    : `Вход ${fmt(entry)} · объём <b>${vol.toFixed(3)}</b> · риск ${money(bal * risk / 100)}` +
      (rr ? ` · R:R <b>${rr.toFixed(2)}</b>` : ' · цель не задана');

  drawOverlays();
}

async function sendTrade() {
  const btn = $('btnSend');
  btn.disabled = true;
  note($('tradeMsg'), '');
  try {
    const body = {
      symbol: state.symbol,
      side: $('side').value,
      kind: $('kind').value,
      limit_price: $('kind').value === 'limit' ? parseFloat($('limitPrice').value) : null,
      sl: parseFloat($('sl').value),
      tp: $('tp').value ? parseFloat($('tp').value) : null,
      risk_pct: parseFloat($('riskPct').value),
    };
    const r = await api('/orders', { body });
    note($('tradeMsg'),
      `Принято. Объём ${Number(r.volume).toFixed(3)}, цена ${fmt(r.reference_price)}.`, 'ok');
    await refreshArena();
  } catch (e) {
    note($('tradeMsg'), e.message, 'err');
  } finally {
    btn.disabled = false;
  }
}

/* --------------------------------------------------------------- подсказки */

function hintBody() {
  const last = state.candles[state.candles.length - 1];
  const kind = $('kind').value;
  return {
    symbol: state.symbol,
    side: $('side').value,
    entry: kind === 'limit' ? parseFloat($('limitPrice').value) || null : (last ? last.c : null),
    sl: parseFloat($('sl').value) || null,
    tp: parseFloat($('tp').value) || null,
    tf: state.tf,
    bars: 200,
  };
}

function renderHint(h) {
  const box = $('hintBox');
  const rules = h.rules || (h.source === 'rules' ? h : null);
  let html = '';

  if (h.summary && h.source && h.source.startsWith('model')) {
    const cls = h.verdict === 'enter' ? 'ok' : h.verdict === 'skip' ? 'bad' : 'warn';
    html += `<div class="hint-block"><span class="pill ${cls}">${h.verdict}</span>
      <span class="pill">уверенность ${Math.round((h.confidence || 0) * 100)}%</span>
      <p class="small" style="margin-top:8px">${esc(h.summary)}</p>`;
    if (h.reasons?.length) html += list('Почему', h.reasons);
    if (h.risks?.length) html += list('Риски', h.risks);
    html += `<p class="small muted">${esc(h.source)}</p></div>`;
  }

  if (rules) {
    html += '<div class="hint-block">';
    if (rules.notes?.length) html += list('Разбор по правилам', rules.notes);
    if (rules.warnings?.length) html += list('Предупреждения', rules.warnings, 'warn');
    if (rules.levels?.length) {
      html += '<h3 style="margin-top:10px">Уровни</h3><div class="table-wrap"><table><tbody>';
      for (const l of rules.levels) {
        html += `<tr><td>${esc(l.name)}</td><td class="num">${fmt(l.price)}</td></tr>`;
      }
      html += '</tbody></table></div>';
    }
    html += '</div>';

    if (chart) {
      const css = (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
      const extra = (rules.levels || []).map((l) => ({
        price: l.price, color: css('--muted'), dash: [1, 5], label: l.name,
      }));
      chart.setOverlays([...(chart.overlays || []), ...extra]);
    }
  }

  box.innerHTML = html || '<span class="muted small">Подсказки нет.</span>';
}

const esc = (s) => String(s).replace(/[&<>"]/g,
  (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));

function list(title, items, cls = '') {
  return `<h3 style="margin-top:10px">${esc(title)}</h3><ul class="hint-list small ${cls}">` +
    items.map((x) => `<li>${esc(x)}</li>`).join('') + '</ul>';
}

async function askHint(kind) {
  const btn = kind === 'model' ? $('btnModel') : $('btnRules');
  btn.disabled = true;
  try {
    const h = await api(`/hint/${kind}`, { body: hintBody() });
    renderHint(h);
    if (h.quota) showQuota(h.quota);
  } catch (e) {
    $('hintBox').innerHTML = `<div class="note small err">${esc(e.message)}</div>`;
  } finally {
    btn.disabled = false;
  }
}

function showQuota(q) {
  $('quotaLine').textContent = q
    ? `Подсказок модели осталось: ${q.left} из ${q.limit} за сутки.`
    : 'Разбор по правилам бесплатен и без ограничений.';
}

/* ------------------------------------------------------------------ вход */

function setAuthMode(mode) {
  state.authMode = mode;
  const reg = mode === 'register';
  const L = (k) => t(k, state.lang);
  $('authTitle').textContent = L(reg ? 'auth.register' : 'auth.login');
  $('emailField').hidden = !reg;
  $('loginLabel').textContent = L(reg ? 'auth.nickField' : 'auth.loginField');
  $('btnSubmitAuth').textContent = L(reg ? 'auth.submitReg' : 'auth.submitLogin');
  $('btnToggleAuth').textContent = L(reg ? 'auth.toLogin' : 'auth.toReg');
  note($('authMsg'), '');
}

async function submitAuth() {
  const btn = $('btnSubmitAuth');
  btn.disabled = true;
  try {
    if (state.authMode === 'register') {
      await api('/register', {
        body: {
          email: $('regEmail').value.trim(),
          nickname: $('loginField').value.trim(),
          password: $('passField').value,
        },
      });
    } else {
      await api('/login', {
        body: { login: $('loginField').value.trim(), password: $('passField').value },
      });
    }
    $('passField').value = '';
    await boot();
    show('arena');
  } catch (e) {
    note($('authMsg'), e.message, 'err');
  } finally {
    btn.disabled = false;
  }
}

async function logout() {
  await api('/logout', { body: {} });
  state.user = null;
  await boot();
  show('home');
}

function renderProfile() {
  const box = $('profileBox');
  if (!state.user) {
    box.innerHTML = '<span class="muted">Вы не вошли. Форма справа — вход и регистрация.</span>';
    $('authCard').hidden = false;
    renderHistory([]);
    return;
  }
  $('authCard').hidden = true;
  const u = state.user;
  box.innerHTML = `
    <div class="stats">
      <div class="stat"><div class="k">Имя</div><div class="v" style="font-size:15px">${esc(u.nickname)}</div></div>
      <div class="stat"><div class="k">Почта</div><div class="v" style="font-size:13px">${esc(u.email)}</div></div>
      <div class="stat"><div class="k">С нами с</div><div class="v" style="font-size:15px">${when(u.created_ms)}</div></div>
    </div>
    <div class="btn-row" style="margin-top:14px">
      <button class="btn" id="btnLogout">Выйти</button>
    </div>`;
  $('btnLogout').onclick = logout;
  renderHistory(state.part?.closed_trades || []);
}

function renderHistory(rows) {
  const tb = $('historyTable').querySelector('tbody');
  if (!rows.length) {
    tb.innerHTML = '<tr><td colspan="7" class="muted">Закрытых сделок пока нет.</td></tr>';
    return;
  }
  tb.innerHTML = rows.map((t) => `
    <tr>
      <td>${when(t.entry_ms)}</td>
      <td>${esc(t.symbol || '—')}</td>
      <td class="${t.side === 'buy' ? 'up' : 'down'}">${t.side === 'buy' ? 'лонг' : 'шорт'}</td>
      <td class="num">${fmtSym(t.entry, t.symbol)}</td>
      <td class="num">${fmtSym(t.exit_price, t.symbol)}</td>
      <td>${esc(t.exit_reason || '—')}</td>
      <td class="num ${Number(t.pnl) >= 0 ? 'up' : 'down'}">${money(t.pnl)}</td>
      <td class="num">${t.r_multiple === null ? '—' : Number(t.r_multiple).toFixed(2)}</td>
    </tr>`).join('');
}

/* --------------------------------------------------------------- таблица */

async function loadBoard() {
  const tb = $('boardTable').querySelector('tbody');
  try {
    const r = await api('/leaderboard');
    if (!r.rows?.length) {
      tb.innerHTML = '<tr><td colspan="6" class="muted">Пока никто не участвует.</td></tr>';
      return;
    }
    tb.innerHTML = r.rows.map((row) => `
      <tr>
        <td><span class="rank ${row.place <= 3 ? 'top' : ''}">${row.place}</span></td>
        <td>${esc(row.nickname)}</td>
        <td class="num">${money(row.equity)}</td>
        <td class="num ${row.return_pct >= 0 ? 'up' : 'down'}">${row.return_pct.toFixed(2)}%</td>
        <td class="num">${Number(row.max_dd).toFixed(1)}%</td>
        <td class="num">${row.closed_n}</td>
      </tr>`).join('');
  } catch (e) {
    tb.innerHTML = `<tr><td colspan="6" class="muted">${esc(e.message)}</td></tr>`;
  }
}

/* ------------------------------------------------------------------ циклы */

async function refreshArena() {
  await loadTournament();
  await loadCandles();
  renderAccount();
  renderTrades();
  previewTrade();

  const gate = $('tradeGate');
  if (!state.user) {
    gate.hidden = false;
    gate.textContent = 'Войдите, чтобы торговать.';
    $('tradeForm').style.opacity = .45;
  } else if (!state.joined) {
    gate.hidden = false;
    gate.innerHTML = 'Вы ещё не в турнире. <button class="btn sm" id="btnJoinInline">Участвовать</button>';
    $('btnJoinInline').onclick = joinTournament;
    $('tradeForm').style.opacity = .45;
  } else if (!state.tradable) {
    gate.hidden = false;
    gate.textContent = state.reason || 'Торговля закрыта.';
    $('tradeForm').style.opacity = .45;
  } else {
    gate.hidden = true;
    $('tradeForm').style.opacity = 1;
  }
}

async function boot() {
  try {
    const me = await api('/me');
    state.user = me.user;
    showQuota(me.quota);
  } catch { state.user = null; }

  $('btnAuth').textContent = state.user ? state.user.nickname : t('nav.login', state.lang);
  await refreshArena();
  renderProfile();
}

/* ------------------------------------------------------------------ старт */

function wire() {
  document.querySelectorAll('[data-theme-set]').forEach((b) => {
    b.onclick = () => setTheme(b.dataset.themeSet);
  });
  document.querySelectorAll('[data-lang]').forEach((b) => {
    b.onclick = () => setLang(b.dataset.lang);
  });
  document.querySelectorAll('#tabs button').forEach((b) => {
    b.onclick = () => show(b.dataset.tab);
  });
  document.querySelectorAll('[data-go]').forEach((b) => {
    b.onclick = (e) => { e.preventDefault(); show(b.dataset.go); };
  });

  $('btnAuth').onclick = () => show('profile');
  $('btnJoinHero').onclick = joinTournament;
  const joinBand = $('btnJoinBand');
  if (joinBand) joinBand.onclick = joinTournament;
  $('btnSubmitAuth').onclick = submitAuth;
  $('btnToggleAuth').onclick = () => setAuthMode(state.authMode === 'login' ? 'register' : 'login');
  $('passField').addEventListener('keydown', (e) => { if (e.key === 'Enter') submitAuth(); });

  $('kind').onchange = () => {
    $('limitField').hidden = $('kind').value !== 'limit';
    previewTrade();
  };
  $('side').onchange = () => {
    const buy = $('side').value === 'buy';
    $('btnSend').className = 'btn wide ' + (buy ? 'buy' : 'sell');
    previewTrade();
  };
  ['sl', 'tp', 'riskPct', 'limitPrice'].forEach((id) => {
    $(id).addEventListener('input', previewTrade);
  });
  $('btnSend').onclick = sendTrade;
  $('btnRules').onclick = () => askHint('rules');
  $('btnModel').onclick = () => askHint('model');

  document.querySelectorAll('#tfSwitch button').forEach((b) => {
    b.onclick = () => {
      state.tf = b.dataset.tf;
      document.querySelectorAll('#tfSwitch button').forEach((x) => {
        x.setAttribute('aria-pressed', String(x === b));
      });
      loadCandles();
    };
  });
}

// Тема по умолчанию — «ночь»: именно она соответствует макету.
// Старое значение из localStorage может ссылаться на удалённую тему,
// поэтому неизвестное имя откатывается к ночной, а не оставляет сайт
// без единой переменной цвета.
const savedTheme = localStorage.getItem('arena-theme');
setTheme(['night', 'day'].includes(savedTheme) ? savedTheme : 'night');

const savedLang = localStorage.getItem('arena-lang');
state.lang = ['ru', 'en'].includes(savedLang) ? savedLang : 'ru';
applyI18n(state.lang);
document.querySelectorAll('[data-lang]').forEach((b) => {
  b.setAttribute('aria-pressed', String(b.dataset.lang === state.lang));
});
wire();
setAuthMode('login');
show(PAGES.includes(location.hash.slice(1)) ? location.hash.slice(1) : 'home');
boot();

// свечи и состояние счёта подтягиваются сами: турнир идёт в реальном времени
state.timer = setInterval(() => {
  if (!document.hidden) refreshArena();
}, 30000);

// Состояние наружу — для отладки и автотестов. Только чтение: сессия живёт
// в HttpOnly-куке, и подменой полей здесь ничего не выторгуешь — все проверки
// делает сервер.
window.arena = state;
