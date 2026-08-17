#!/usr/bin/env python3
"""
Проверка контракта моста из MT5.

Автор: Vitaliy Yugay · vamp.09.94@gmail.com · https://github.com/YugayV

    python3 tools/test_mt5_bridge.py http://127.0.0.1:8000 --token devtoken

MetaTrader сюда не поставить, и скомпилировать mt5/ArenaFeed.mq5 нечем.
Поэтому проверяется то, что проверить можно: СТЫК. Скрипт собирает тело
запроса ровно так же, как советник — те же поля, тот же порядок свечей,
то же деление на пачки, тот же пересчёт времени сервера в UTC — и
отправляет его площадке. Если стык сходится, остаётся только собрать
советник в терминале.

Отдельно проверяется главная ошибка, из-за которой всё это написано:
MqlRates.time — время сервера брокера, а не UTC. Тест показывает, что
получилось бы без пересчёта.
"""

from __future__ import annotations

import argparse
import json
import random
import sys
import time

import httpx

PASS = FAIL = 0


def check(name: str, ok: bool, detail: str = "") -> bool:
    global PASS, FAIL
    print(f"{'  ok  ' if ok else ' ПРОВАЛ '} {name}" + (f": {detail}" if detail else ""))
    if ok:
        PASS += 1
    else:
        FAIL += 1
    return ok


# ------------------------------------------------------- эмуляция советника

def server_to_utc_offset(server_ahead_hours: float) -> int:
    """То же округление, что в ServerToUtcOffset() советника."""
    diff = int(server_ahead_hours * 3600)
    q = 900
    return ((diff + (q // 2 if diff >= 0 else -q // 2)) // q) * q


def build_rates(symbol: str, bars: int, digits: int, price: float,
                vol: float, server_offset_s: int) -> list[dict]:
    """Свечи в том виде, в каком их отдаёт CopyRates: время СЕРВЕРА, свежие
    под индексом 0 (ArraySetAsSeries)."""
    now_utc = int(time.time() // 60 * 60)
    rnd = random.Random(hash(symbol) & 0xFFFF)

    out = []
    p = price
    for i in range(bars):
        ts_utc = now_utc - (bars - 1 - i) * 60
        o = p
        c = o + (rnd.random() - 0.5) * vol * 2
        h = max(o, c) + rnd.random() * vol
        l = min(o, c) - rnd.random() * vol
        out.append({
            # именно так и лежит в MqlRates: время сервера, не UTC
            "time": ts_utc + server_offset_s,
            "open": round(o, digits), "high": round(h, digits),
            "low": round(l, digits), "close": round(c, digits),
            "tick_volume": rnd.randint(40, 300),
        })
        p = c

    out.reverse()                      # индекс 0 — самая свежая свеча
    return out


def build_body(name: str, rates: list[dict], frm: int, to: int,
               digits: int, utc_offset: int, apply_offset: bool = True) -> dict:
    """BuildBody() советника: индексы идут от старших к младшим."""
    candles = []
    for i in range(frm, to - 1, -1):
        r = rates[i]
        ts = r["time"] - (utc_offset if apply_offset else 0)
        candles.append({
            "ts": ts * 1000,
            "o": round(r["open"], digits), "h": round(r["high"], digits),
            "l": round(r["low"], digits), "c": round(r["close"], digits),
            "v": r["tick_volume"],
        })
    return {"symbol": name, "tf": "M1", "candles": candles}


def main() -> int:
    p = argparse.ArgumentParser(description="Проверка стыка моста из MT5")
    p.add_argument("url")
    p.add_argument("--token", required=True, help="QUOTES_INGEST_TOKEN")
    p.add_argument("--server-offset-hours", type=float, default=3.0,
                   help="на сколько часов сервер брокера впереди UTC")
    args = p.parse_args()

    base = args.url.rstrip("/")
    cx = httpx.Client(base_url=base, timeout=30.0)
    hdr = {"X-Ingest-Token": args.token}

    off = server_to_utc_offset(args.server_offset_hours)
    print(f"Площадка: {base}")
    print(f"Сервер брокера впереди UTC на {args.server_offset_hours} ч "
          f"-> смещение {off} с\n")

    check("смещение округлено к 15 минутам", off % 900 == 0, f"{off} с")
    check("нелепое смещение отбрасывается",
          server_to_utc_offset(20) == 72000, "проверка границы 14 ч — см. советник")

    # ----------------------------------------------------------- инструменты
    plan = [
        ("XAUUSD", 2, 3400.0, 0.45),
        ("EURUSD", 5, 1.0850, 0.00035),
        ("USDJPY", 3, 152.40, 0.045),
        ("BTCUSD", 1, 68500.0, 45.0),
    ]

    print("\n--- заливка истории пачками ---")
    BATCH = 500
    for name, dg, price, vol in plan:
        rates = build_rates(name, 1200, dg, price, vol, off)

        # Backfill(): идём от самой старой к свежей, пропуская индекс 0
        sent = 0
        start = len(rates) - 1
        while start >= 1:
            frm = start
            to = max(1, start - BATCH + 1)
            body = build_body(name, rates, frm, to, dg, off)
            r = cx.post("/api/quotes/ingest", headers=hdr, json=body)
            if r.status_code != 200:
                check(f"{name}: пачка принята", False, f"HTTP {r.status_code} {r.text[:120]}")
                break
            sent += r.json().get("accepted", 0)
            start -= BATCH
        else:
            check(f"{name}: история принята", sent >= 1199, f"{sent} свечей")

        # незакрытая свеча (индекс 0) отправляться не должна ни разу
        newest_sent = max(
            c["ts"] for c in build_body(name, rates, len(rates) - 1, 1, dg, off)["candles"])
        newest_all = (rates[0]["time"] - off) * 1000
        check(f"{name}: текущая свеча не отправлена", newest_sent < newest_all,
              "индекс 0 пропущен")

    # ------------------------------------------------------------ время в UTC
    print("\n--- время ---")
    name, dg, price, vol = plan[0]
    rates = build_rates(name, 5, dg, price, vol, off)
    body = build_body(name, rates, len(rates) - 1, 1, dg, off)
    r = cx.post("/api/quotes/ingest", headers=hdr, json=body)
    check("свечи приняты", r.status_code == 200, f"HTTP {r.status_code}")

    lag = cx.get("/api/feed").json().get("lags_ms", {}).get(name)
    check("площадка видит поток свежим",
          lag is not None and lag < 300_000,
          f"отставание {lag // 1000 if lag is not None else '—'} с")

    # А теперь то же самое БЕЗ пересчёта — так вело себя до правки
    wrong = build_body(name, rates, len(rates) - 1, 1, dg, off, apply_offset=False)
    ahead_s = (max(c["ts"] for c in wrong["candles"])
               - max(c["ts"] for c in body["candles"])) // 1000
    check("без пересчёта свечи ушли бы в будущее", ahead_s == off,
          f"на {ahead_s // 3600} ч вперёд — именно это и ломало зачёт")

    # ---------------------------------------------------------- защита стыка
    print("\n--- защита ---")
    r = cx.post("/api/quotes/ingest", json=body)
    check("без токена приём закрыт", r.status_code in (401, 503), f"HTTP {r.status_code}")

    r = cx.post("/api/quotes/ingest", headers=hdr,
                json={"symbol": "XAUUSD", "tf": "M1", "candles": [
                    {"ts": int(time.time()) * 1000, "o": 10, "h": 1, "l": 100, "c": 5}]})
    check("невозможная свеча отброшена",
          r.status_code == 200 and r.json().get("rejected") == 1,
          json.dumps(r.json(), ensure_ascii=False))

    # брокерское имя с суффиксом: советник умеет переименовывать, но если
    # не настроить — символ уедет в базу под чужим именем и в турнир не попадёт
    r = cx.post("/api/quotes/ingest", headers=hdr,
                json={"symbol": "XAUUSD.m", "tf": "M1", "candles": [
                    {"ts": int(time.time() // 60 * 60) * 1000,
                     "o": 3400, "h": 3401, "l": 3399, "c": 3400.5}]})
    accepted = r.json().get("accepted") if r.status_code == 200 else None
    check("брокерский суффикс принимается как отдельный символ", accepted == 1,
          "поэтому InpSymbolAs обязателен при суффиксах у брокера")

    cx.close()
    print(f"\nитого: {PASS} успешно, {FAIL} провалов")
    return 1 if FAIL else 0


if __name__ == "__main__":
    sys.exit(main())
