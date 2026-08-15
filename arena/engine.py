"""
Движок бумажной торговли турнира.

Автор: Vitaliy Yugay · vamp.09.94@gmail.com · https://github.com/YugayV

Главное требование к бумажной торговле — не реализм, а невозможность
выиграть за счёт информации, которой нет у остальных. Отсюда три правила,
которые важнее всего остального кода:

1. ОТЛОЖЕННЫЙ ОРДЕР ИСПОЛНЯЕТСЯ ТОЛЬКО СВЕЧАМИ СТРОГО ПОЗЖЕ РАЗМЕЩЕНИЯ.
   Иначе участник видит хай уже сформированной свечи и ставит лимитку,
   которая «сработала» в прошлом.

2. РЫНОЧНЫЙ ОРДЕР ОТКЛОНЯЕТСЯ, ЕСЛИ ПОТОК ОТСТАЛ.
   Рядом на странице живёт виджет TradingView с настоящей ценой. Если наш
   ряд свечей отстал на несколько минут, участник видит будущее относительно
   нашей базы и может входить по устаревшей цене без риска. Поэтому при
   отставании потока больше MAX_FEED_LAG_S торговля закрывается для всех.

3. ЕСЛИ ВНУТРИ СВЕЧИ ДОСТИЖИМЫ И СТОП, И ЦЕЛЬ — СЧИТАЕТСЯ СТОП.
   Порядок тиков внутри свечи нам неизвестен, и трактовать неизвестность
   в пользу участника значит завышать результаты у всех.
"""

from __future__ import annotations

import logging
import os
from typing import Any

from .db import ex, new_id, q, q1
from .quotes import latest_ts, series, series_from, tf_ms

log = logging.getLogger("arena.engine")

MAX_OPEN_TRADES = int(os.getenv("MAX_OPEN_TRADES", "5"))
MAX_PENDING_ORDERS = int(os.getenv("MAX_PENDING_ORDERS", "10"))
MAX_FEED_LAG_S = float(os.getenv("MAX_FEED_LAG_S", "180"))


class TradeError(Exception):
    """Ошибка, текст которой показывается участнику."""


# --------------------------------------------------------------- вспомогательное

def _half(spread: float) -> float:
    return max(0.0, float(spread)) / 2.0


def ask(price: float, spread: float) -> float:
    return price + _half(spread)


def bid(price: float, spread: float) -> float:
    return price - _half(spread)


def feed_lag_ms(symbol: str, tf: str, now_ms: int) -> int | None:
    """Насколько наш ряд отстал от текущего момента."""
    last = latest_ts(symbol, tf)
    if last is None:
        return None
    # свеча помечена временем открытия — к отставанию добавляем её длину
    return max(0, now_ms - (last + tf_ms(tf)))


def require_fresh_feed(tour: dict, now_ms: int) -> None:
    lag = feed_lag_ms(tour["symbol"], tour["tf"], now_ms)
    if lag is None:
        raise TradeError("Котировок ещё нет — торговля закрыта")
    if lag > MAX_FEED_LAG_S * 1000:
        raise TradeError(
            f"Поток котировок отстал на {int(lag / 1000)} с — торговля временно "
            f"закрыта для всех участников")


# ------------------------------------------------------------------- размер

def size_for_risk(balance: float, risk_pct: float, entry: float, sl: float) -> float:
    """Объём из риска в процентах депозита и расстояния до стопа."""
    dist = abs(float(entry) - float(sl))
    if dist <= 0:
        raise TradeError("Стоп совпадает с ценой входа")
    risk_money = float(balance) * float(risk_pct) / 100.0
    return risk_money / dist


# ---------------------------------------------------------------- размещение

def place_order(part: dict, tour: dict, *, side: str, kind: str,
                limit_price: float | None, sl: float | None, tp: float | None,
                risk_pct: float, now_ms: int, expiry_bars: int = 24) -> dict:
    side = (side or "").lower()
    kind = (kind or "").lower()
    if side not in {"buy", "sell"}:
        raise TradeError("Направление должно быть buy или sell")
    if kind not in {"market", "limit"}:
        raise TradeError("Тип ордера должен быть market или limit")

    require_fresh_feed(tour, now_ms)

    if float(risk_pct) <= 0:
        raise TradeError("Риск должен быть больше нуля")
    if float(risk_pct) > float(tour["max_risk_pct"]):
        raise TradeError(f"Риск выше предела турнира ({tour['max_risk_pct']}%)")

    open_n = q1("SELECT count(*) AS n FROM trades WHERE participant_id = :p"
                " AND status = 'open'", p=part["id"])["n"]
    if open_n >= MAX_OPEN_TRADES:
        raise TradeError(f"Уже открыто {open_n} сделок — это предел")

    pend_n = q1("SELECT count(*) AS n FROM orders WHERE participant_id = :p"
                " AND status = 'pending'", p=part["id"])["n"]
    if pend_n >= MAX_PENDING_ORDERS:
        raise TradeError(f"Уже висит {pend_n} отложенных ордеров — это предел")

    last = series(tour["symbol"], tour["tf"], limit=1)
    if not last:
        raise TradeError("Котировок ещё нет")
    last_c = float(last[-1]["c"])
    last_ts = int(last[-1]["ts"])

    ref = last_c if kind == "market" else float(limit_price or 0)
    if kind == "limit":
        if ref <= 0:
            raise TradeError("Не задана цена лимитного ордера")
        # лимитка по определению стоит по ту сторону рынка
        if side == "buy" and ref >= last_c:
            raise TradeError("Лимитка на покупку ставится ниже рынка")
        if side == "sell" and ref <= last_c:
            raise TradeError("Лимитка на продажу ставится выше рынка")

    if sl is None:
        raise TradeError("Без стопа сделки не принимаются")
    sl = float(sl)
    if side == "buy" and sl >= ref:
        raise TradeError("Для покупки стоп ставится ниже цены входа")
    if side == "sell" and sl <= ref:
        raise TradeError("Для продажи стоп ставится выше цены входа")
    if tp is not None:
        tp = float(tp)
        if side == "buy" and tp <= ref:
            raise TradeError("Для покупки цель ставится выше цены входа")
        if side == "sell" and tp >= ref:
            raise TradeError("Для продажи цель ставится ниже цены входа")

    volume = size_for_risk(part["balance"], risk_pct, ref, sl)
    if volume <= 0:
        raise TradeError("Расчётный объём получился нулевым")

    oid = new_id()
    step = tf_ms(tour["tf"])
    expires = last_ts + expiry_bars * step if kind == "limit" else None

    ex("INSERT INTO orders (id, participant_id, side, kind, volume, limit_price,"
       " sl, tp, status, placed_ms, expires_ms) VALUES (:id, :p, :side, :kind,"
       " :vol, :lim, :sl, :tp, 'pending', :ts, :exp)",
       id=oid, p=part["id"], side=side, kind=kind, vol=volume,
       lim=(ref if kind == "limit" else None), sl=sl, tp=tp,
       ts=last_ts, exp=expires)

    # Рыночный ордер исполняем сразу по последней известной цене: это и есть
    # текущий рынок, будущего в нём нет. Свежесть потока уже проверена выше.
    if kind == "market":
        fill = ask(last_c, tour["spread"]) if side == "buy" else bid(last_c, tour["spread"])
        _open_trade(part, oid, side, volume, fill, last_ts, sl, tp)
        ex("UPDATE orders SET status = 'filled', resolved_ms = :ts WHERE id = :id",
           ts=last_ts, id=oid)

    return {"order_id": oid, "volume": volume, "reference_price": ref}


def cancel_order(part: dict, order_id: str) -> None:
    row = q1("SELECT * FROM orders WHERE id = :id AND participant_id = :p",
             id=order_id, p=part["id"])
    if not row:
        raise TradeError("Ордер не найден")
    if row["status"] != "pending":
        raise TradeError("Ордер уже не в ожидании")
    ex("UPDATE orders SET status = 'cancelled' WHERE id = :id", id=order_id)


def _open_trade(part: dict, order_id: str | None, side: str, volume: float,
                entry: float, ts: int, sl: float | None, tp: float | None) -> str:
    tid = new_id()
    ex("INSERT INTO trades (id, participant_id, order_id, side, volume, entry,"
       " entry_ms, sl, tp, status) VALUES (:id, :p, :o, :side, :vol, :entry,"
       " :ts, :sl, :tp, 'open')",
       id=tid, p=part["id"], o=order_id, side=side, vol=volume, entry=entry,
       ts=ts, sl=sl, tp=tp)
    return tid


def close_trade(part: dict, tour: dict, trade_id: str, now_ms: int) -> dict:
    """Закрытие руками по текущей цене."""
    require_fresh_feed(tour, now_ms)
    tr = q1("SELECT * FROM trades WHERE id = :id AND participant_id = :p",
            id=trade_id, p=part["id"])
    if not tr:
        raise TradeError("Сделка не найдена")
    if tr["status"] != "open":
        raise TradeError("Сделка уже закрыта")

    last = series(tour["symbol"], tour["tf"], limit=1)[-1]
    mid = float(last["c"])
    px = bid(mid, tour["spread"]) if tr["side"] == "buy" else ask(mid, tour["spread"])
    _settle(part, tr, px, int(last["ts"]), "manual")
    return {"exit": px}


# ------------------------------------------------------------------ расчёты

def _pnl(side: str, entry: float, exit_price: float, volume: float) -> float:
    d = exit_price - entry if side == "buy" else entry - exit_price
    return d * volume


def _settle(part: dict, tr: dict, exit_price: float, ts: int, reason: str) -> float:
    pnl = _pnl(tr["side"], float(tr["entry"]), float(exit_price), float(tr["volume"]))

    r = None
    if tr["sl"] is not None:
        risk = abs(float(tr["entry"]) - float(tr["sl"])) * float(tr["volume"])
        if risk > 0:
            r = pnl / risk

    ex("UPDATE trades SET status='closed', exit_price=:px, exit_ms=:ts,"
       " exit_reason=:why, pnl=:pnl, r_multiple=:r WHERE id = :id",
       px=exit_price, ts=ts, why=reason, pnl=pnl, r=r, id=tr["id"])
    ex("UPDATE participants SET balance = balance + :pnl WHERE id = :p",
       pnl=pnl, p=tr["participant_id"])
    return pnl


def unrealized(participant_id: str, price: float) -> float:
    rows = q("SELECT side, entry, volume FROM trades WHERE participant_id = :p"
             " AND status = 'open'", p=participant_id)
    return sum(_pnl(r["side"], float(r["entry"]), price, float(r["volume"]))
               for r in rows)


def refresh_equity(participant_id: str, price: float) -> dict:
    part = q1("SELECT * FROM participants WHERE id = :id", id=participant_id)
    if not part:
        return {}
    eq = float(part["balance"]) + unrealized(participant_id, price)
    peak = max(float(part["peak_equity"]), eq)
    dd = max(float(part["max_dd"]), (peak - eq) / peak * 100.0 if peak > 0 else 0.0)
    ex("UPDATE participants SET equity=:e, peak_equity=:pk, max_dd=:dd WHERE id=:id",
       e=eq, pk=peak, dd=dd, id=participant_id)
    return {"equity": eq, "peak": peak, "max_dd": dd}


# ------------------------------------------------------- прогон новых свечей

BATCH = 5000
MAX_BATCHES = 200


def process(tour: dict) -> dict:
    """Прокрутка турнира до конца имеющихся котировок.

    Идемпотентна: курсор двигается только вперёд, повторный вызов на тех же
    данных ничего не изменит.

    Свечи берутся пачками, но цикл идёт до полного догона. Без цикла заливка
    истории обрабатывалась бы частично и молча: курсор доехал бы до края
    первой пачки, а остальное осталось бы неучтённым до следующего вызова.
    """
    total = {"candles": 0, "fills": 0, "closes": 0}
    for _ in range(MAX_BATCHES):
        step = _process_batch(tour)
        for k in total:
            total[k] += step[k]
        if step["candles"] < BATCH:
            break
        tour = q1("SELECT * FROM tournaments WHERE id = :id", id=tour["id"])
    return total


def _process_batch(tour: dict) -> dict:
    cursor = int(tour["cursor_ms"] or 0)
    candles = series_from(tour["symbol"], tour["tf"], cursor + 1, BATCH)
    if not candles:
        return {"candles": 0, "fills": 0, "closes": 0}

    parts = q("SELECT * FROM participants WHERE tournament_id = :t", t=tour["id"])
    if not parts:
        last_ts = int(candles[-1]["ts"])
        ex("UPDATE tournaments SET cursor_ms = :ts WHERE id = :id",
           ts=last_ts, id=tour["id"])
        return {"candles": len(candles), "fills": 0, "closes": 0}

    spread = float(tour["spread"])
    fills = closes = 0

    for k in candles:
        ts, o, h, l, c = (int(k["ts"]), float(k["o"]), float(k["h"]),
                          float(k["l"]), float(k["c"]))

        for part in parts:
            fills += _fill_pending(part, ts, o, h, l, spread)
            closes += _resolve_open(part, ts, o, h, l, spread)

    for part in parts:
        refresh_equity(part["id"], float(candles[-1]["c"]))

    ex("UPDATE tournaments SET cursor_ms = :ts WHERE id = :id",
       ts=int(candles[-1]["ts"]), id=tour["id"])

    return {"candles": len(candles), "fills": fills, "closes": closes}


def _fill_pending(part: dict, ts: int, o: float, h: float, l: float,
                  spread: float) -> int:
    # placed_ms < ts — то самое правило «только будущими свечами»
    pend = q("SELECT * FROM orders WHERE participant_id = :p AND status='pending'"
             " AND placed_ms < :ts ORDER BY placed_ms", p=part["id"], ts=ts)
    n = 0
    for od in pend:
        if od["expires_ms"] is not None and ts > int(od["expires_ms"]):
            ex("UPDATE orders SET status='expired', resolved_ms=:ts WHERE id=:id",
               ts=ts, id=od["id"])
            continue

        lim = float(od["limit_price"]) if od["limit_price"] is not None else None
        if lim is None:
            continue                      # рыночные исполняются при размещении

        if od["side"] == "buy":
            if l > lim:
                continue
            # разрыв в нашу пользу исполняется по цене открытия, а не по лимиту
            fill = ask(min(lim, o), spread)
        else:
            if h < lim:
                continue
            fill = bid(max(lim, o), spread)

        _open_trade(part, od["id"], od["side"], float(od["volume"]), fill, ts,
                    od["sl"], od["tp"])
        ex("UPDATE orders SET status='filled', resolved_ms=:ts WHERE id=:id",
           ts=ts, id=od["id"])
        n += 1
    return n


def _resolve_open(part: dict, ts: int, o: float, h: float, l: float,
                  spread: float) -> int:
    rows = q("SELECT * FROM trades WHERE participant_id = :p AND status='open'"
             " AND entry_ms <= :ts", p=part["id"], ts=ts)
    n = 0
    for tr in rows:
        sl = float(tr["sl"]) if tr["sl"] is not None else None
        tp = float(tr["tp"]) if tr["tp"] is not None else None

        if tr["side"] == "buy":
            hit_sl = sl is not None and l <= sl
            hit_tp = tp is not None and h >= tp
            # стоп раньше цели: порядок тиков внутри свечи неизвестен
            if hit_sl:
                _settle(part, tr, bid(min(sl, o), spread), ts, "stop")
            elif hit_tp:
                _settle(part, tr, bid(max(tp, o), spread), ts, "target")
            else:
                continue
        else:
            hit_sl = sl is not None and h >= sl
            hit_tp = tp is not None and l <= tp
            if hit_sl:
                _settle(part, tr, ask(max(sl, o), spread), ts, "stop")
            elif hit_tp:
                _settle(part, tr, ask(min(tp, o), spread), ts, "target")
            else:
                continue
        n += 1
    return n


# ----------------------------------------------------------------- сводки

def participant_state(part_id: str) -> dict[str, Any]:
    part = q1("SELECT * FROM participants WHERE id = :id", id=part_id)
    if not part:
        return {}
    open_trades = q("SELECT * FROM trades WHERE participant_id=:p AND status='open'"
                    " ORDER BY entry_ms DESC", p=part_id)
    closed = q("SELECT * FROM trades WHERE participant_id=:p AND status='closed'"
               " ORDER BY exit_ms DESC LIMIT 100", p=part_id)
    orders = q("SELECT * FROM orders WHERE participant_id=:p AND status='pending'"
               " ORDER BY placed_ms DESC", p=part_id)

    wins = [t for t in closed if (t["pnl"] or 0) > 0]
    return {
        "participant": part,
        "open_trades": open_trades,
        "closed_trades": closed,
        "pending_orders": orders,
        "stats": {
            "trades": len(closed),
            "winrate": (len(wins) / len(closed) * 100.0) if closed else 0.0,
            "net_pnl": sum(float(t["pnl"] or 0) for t in closed),
            "net_r": sum(float(t["r_multiple"] or 0) for t in closed),
            "max_dd": float(part["max_dd"]),
        },
    }


def leaderboard(tournament_id: str, limit: int = 100) -> list[dict]:
    rows = q(
        "SELECT p.id, p.equity, p.balance, p.max_dd, u.nickname,"
        " (SELECT count(*) FROM trades t WHERE t.participant_id = p.id"
        "  AND t.status='closed') AS closed_n"
        " FROM participants p JOIN users u ON u.id = p.user_id"
        " WHERE p.tournament_id = :t ORDER BY p.equity DESC LIMIT :n",
        t=tournament_id, n=limit)
    tour = q1("SELECT start_balance FROM tournaments WHERE id = :id", id=tournament_id)
    base = float(tour["start_balance"]) if tour else 0.0
    for i, r in enumerate(rows, 1):
        r["place"] = i
        r["return_pct"] = ((float(r["equity"]) - base) / base * 100.0) if base else 0.0
    return rows
