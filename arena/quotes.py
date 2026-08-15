"""
Хранилище котировок площадки.

Автор: Vitaliy Yugay · vamp.09.94@gmail.com · https://github.com/YugayV

Виджет TradingView на сайте — это только картинка: данных из него на сервере
нет. Зачёт турнира считается по СВОЕМУ ряду свечей, который лежит здесь. Это
и есть смысл разделения: спор «у меня стоп не задело» решается запросом к
этой таблице, а не скриншотом.

Хранится один базовый таймфрейм (по умолчанию M1). Старшие строятся
агрегацией на лету — так исключено расхождение между тем, что видит
участник, и тем, по чему исполняются его ордера.
"""

from __future__ import annotations

import logging

from .db import ex_many, q, q1

log = logging.getLogger("arena.quotes")

TF_MS = {
    "M1": 60_000, "M5": 300_000, "M15": 900_000, "M30": 1_800_000,
    "H1": 3_600_000, "H4": 14_400_000, "D1": 86_400_000,
}


def tf_ms(tf: str) -> int:
    v = TF_MS.get((tf or "").upper())
    if not v:
        raise ValueError(f"неизвестный таймфрейм: {tf}")
    return v


# Upsert одинаково понимают и SQLite (>=3.24), и Postgres.
_UPSERT = """
INSERT INTO candles (symbol, tf, ts, o, h, l, c, v)
VALUES (:symbol, :tf, :ts, :o, :h, :l, :c, :v)
ON CONFLICT (symbol, tf, ts) DO UPDATE SET
    o = excluded.o, h = excluded.h, l = excluded.l,
    c = excluded.c, v = excluded.v
"""


# Старшие таймфреймы, которые пересобираются при каждом приёме котировок.
#
# Собирать их на лету из минуток нельзя: 300 дневных свечей — это 432 000
# минутных строк на один запрос графика. Поэтому свёртки материализуются,
# и только те корзины, которых коснулись новые данные.
ROLLUPS = ["M15", "H1", "H4", "D1"]


def rollup(symbol: str, base_tf: str, touched: set[int]) -> int:
    """Пересборка старших свечей для корзин, задетых новыми данными."""
    symbol = symbol.upper()
    base = tf_ms(base_tf)
    written = 0

    for target in ROLLUPS:
        step = tf_ms(target)
        if step <= base:
            continue

        buckets = sorted({ts - ts % step for ts in touched})
        rows = []
        for b in buckets:
            src = q("SELECT ts, o, h, l, c, v FROM candles WHERE symbol = :s"
                    " AND tf = :tf AND ts >= :a AND ts < :b ORDER BY ts",
                    s=symbol, tf=base_tf.upper(), a=b, b=b + step)
            if not src:
                continue
            rows.append({
                "symbol": symbol, "tf": target, "ts": b,
                "o": src[0]["o"],
                "h": max(r["h"] for r in src),
                "l": min(r["l"] for r in src),
                "c": src[-1]["c"],
                "v": sum((r["v"] or 0) for r in src) or None,
            })
        if rows:
            ex_many(_UPSERT, rows)
            written += len(rows)

    return written


def ingest(symbol: str, tf: str, candles: list[dict]) -> dict:
    """Приём свечей от источника. Возвращает сводку по записанному."""
    symbol = symbol.upper()
    tf = tf.upper()
    step = tf_ms(tf)

    rows = []
    bad = 0
    for k in candles:
        try:
            ts = int(k["ts"])
            o, h, l, c = float(k["o"]), float(k["h"]), float(k["l"]), float(k["c"])
        except (KeyError, TypeError, ValueError):
            bad += 1
            continue
        if h < l or h < max(o, c) - 1e-9 or l > min(o, c) + 1e-9:
            bad += 1                      # свеча, которой не может существовать
            continue
        # выравнивание по сетке таймфрейма: иначе агрегация поедет
        ts -= ts % step
        v = k.get("v")
        rows.append({"symbol": symbol, "tf": tf, "ts": ts, "o": o, "h": h,
                     "l": l, "c": c, "v": float(v) if v is not None else None})

    rolled = 0
    if rows:
        ex_many(_UPSERT, rows)
        rolled = rollup(symbol, tf, {r["ts"] for r in rows})

    return {"accepted": len(rows), "rejected": bad, "rolled_up": rolled,
            "last_ts": max((r["ts"] for r in rows), default=None)}


def latest_ts(symbol: str, tf: str) -> int | None:
    row = q1("SELECT max(ts) AS m FROM candles WHERE symbol = :s AND tf = :tf",
             s=symbol.upper(), tf=tf.upper())
    return int(row["m"]) if row and row["m"] is not None else None


def latest_price(symbol: str, tf: str) -> float | None:
    row = q1("SELECT c FROM candles WHERE symbol = :s AND tf = :tf"
             " ORDER BY ts DESC LIMIT 1", s=symbol.upper(), tf=tf.upper())
    return float(row["c"]) if row else None


def series(symbol: str, tf: str, limit: int = 500,
           since: int | None = None, until: int | None = None) -> list[dict]:
    """Свечи по возрастанию времени. limit отсчитывается от свежего конца."""
    sql = ["SELECT ts, o, h, l, c, v FROM candles WHERE symbol = :s AND tf = :tf"]
    p: dict = {"s": symbol.upper(), "tf": tf.upper(), "n": max(1, min(limit, 5000))}
    if since is not None:
        sql.append("AND ts >= :since")
        p["since"] = int(since)
    if until is not None:
        sql.append("AND ts <= :until")
        p["until"] = int(until)
    sql.append("ORDER BY ts DESC LIMIT :n")

    rows = q(" ".join(sql), **p)
    rows.reverse()
    return rows


def series_from(symbol: str, tf: str, since: int, limit: int) -> list[dict]:
    """Первые N свечей ПОСЛЕ указанного времени.

    Отдельная функция, а не флаг у series(): series отдаёт свежий конец ряда
    (ORDER BY ts DESC LIMIT n), и для прокрутки турнира это ловушка — пачка
    из 5000 свечей взяла бы последние 5000, молча перепрыгнув середину
    истории. Здесь порядок возрастающий с самого начала.
    """
    return q("SELECT ts, o, h, l, c, v FROM candles WHERE symbol = :s"
             " AND tf = :tf AND ts >= :since ORDER BY ts ASC LIMIT :n",
             s=symbol.upper(), tf=tf.upper(), since=int(since),
             n=max(1, int(limit)))


def aggregate(candles: list[dict], target_tf: str, base_tf: str) -> list[dict]:
    """Склейка базовых свечей в старший таймфрейм по сетке UTC."""
    step = tf_ms(target_tf)
    base = tf_ms(base_tf)
    if step <= base:
        return candles

    out: list[dict] = []
    cur: dict | None = None
    for k in candles:
        bucket = int(k["ts"]) - int(k["ts"]) % step
        if cur is None or cur["ts"] != bucket:
            if cur is not None:
                out.append(cur)
            cur = {"ts": bucket, "o": k["o"], "h": k["h"], "l": k["l"], "c": k["c"],
                   "v": k.get("v") or 0}
        else:
            cur["h"] = max(cur["h"], k["h"])
            cur["l"] = min(cur["l"], k["l"])
            cur["c"] = k["c"]
            cur["v"] = (cur["v"] or 0) + (k.get("v") or 0)
    if cur is not None:
        out.append(cur)
    return out


def window(symbol: str, base_tf: str, view_tf: str, bars: int) -> list[dict]:
    """Готовый ряд для графика.

    Если нужный таймфрейм уже материализован свёрткой — читаем его напрямую
    одним запросом. Склейка на лету остаётся запасным путём для баз, которые
    наполнялись до появления свёрток.
    """
    view_tf = view_tf.upper()
    base_tf = base_tf.upper()

    if view_tf == base_tf:
        return series(symbol, base_tf, limit=bars)

    ready = series(symbol, view_tf, limit=bars)
    if ready:
        return ready

    need = tf_ms(view_tf) // tf_ms(base_tf) * bars
    raw = series(symbol, base_tf, limit=min(max(need, bars), 5000))
    return aggregate(raw, view_tf, base_tf)
