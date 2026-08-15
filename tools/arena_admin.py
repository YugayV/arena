#!/usr/bin/env python3
"""
Управление турнирной площадкой из командной строки.

Автор: Vitaliy Yugay · vamp.09.94@gmail.com · https://github.com/YugayV

    python3 tools/arena_admin.py init
    python3 tools/arena_admin.py tournament "Август" XAUUSD --days 30
    python3 tools/arena_admin.py list
    python3 tools/arena_admin.py load candles.json --symbol XAUUSD --tf M1
    python3 tools/arena_admin.py demo --bars 3000

Работает с той же базой, что и сайт: адрес берётся из DATABASE_URL.
На Railway запускается через `railway run python3 tools/arena_admin.py ...`
"""

from __future__ import annotations

import argparse
import json
import os
import random
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from arena import engine, quotes, tournament            # noqa: E402
from arena.db import init_schema, q                     # noqa: E402

MS_DAY = 86_400_000


def cmd_init(_args) -> None:
    init_schema()
    print("Схема создана или уже была на месте.")


def cmd_tournament(args) -> None:
    init_schema()
    now = int(time.time() * 1000)
    t = tournament.create(
        name=args.name, symbol=args.symbol.upper(), tf=args.tf.upper(),
        starts_ms=now, ends_ms=now + args.days * MS_DAY,
        start_balance=args.balance, max_risk_pct=args.risk, spread=args.spread)
    print(f"Турнир создан: {t['name']} ({t['id']})")
    print(f"  инструмент  {t['symbol']} {t['tf']}")
    print(f"  депозит     {t['start_balance']:.2f}")
    print(f"  риск        до {t['max_risk_pct']}% на сделку")
    print(f"  спред       {t['spread']}")
    print(f"  до          {time.strftime('%Y-%m-%d %H:%M', time.gmtime(t['ends_ms'] / 1000))} UTC")


def cmd_list(_args) -> None:
    rows = tournament.listing()
    if not rows:
        print("Турниров нет.")
        return
    for t in rows:
        live = "идёт" if tournament.is_tradable(t)[0] else "закрыт"
        n = q("SELECT count(*) AS n FROM participants WHERE tournament_id = :t",
              t=t["id"])[0]["n"]
        print(f"{t['id'][:8]}  {t['name'][:24]:24}  {t['symbol']:8} {t['tf']:3} "
              f"{live:7} участников: {n}")


def cmd_load(args) -> None:
    """Загрузка истории из JSON, полученного через tools/csv2json.mjs."""
    init_schema()
    with open(args.file, encoding="utf-8") as f:
        candles = json.load(f)
    res = quotes.ingest(args.symbol, args.tf, candles)
    print(f"Принято: {res['accepted']}, отброшено: {res['rejected']}")
    if res["last_ts"]:
        print("Последняя свеча:",
              time.strftime("%Y-%m-%d %H:%M", time.gmtime(res["last_ts"] / 1000)), "UTC")
    _process()


def cmd_demo(args) -> None:
    """Синтетические свечи для проверки площадки без внешнего источника.

    Это НЕ рыночные данные. Нужны только чтобы увидеть работающий сайт до
    подключения настоящего потока.
    """
    init_schema()
    step = quotes.tf_ms(args.tf)
    now = int(time.time() * 1000)
    start = (now - args.bars * step) // step * step

    rnd = random.Random(args.seed)
    price = args.price
    rows = []
    for i in range(args.bars):
        o = price
        c = o + (rnd.random() - 0.5) * args.vol * 2
        h = max(o, c) + rnd.random() * args.vol
        l = min(o, c) - rnd.random() * args.vol
        rows.append({"ts": start + i * step, "o": round(o, 2), "h": round(h, 2),
                     "l": round(l, 2), "c": round(c, 2), "v": 0})
        price = c

    res = quotes.ingest(args.symbol, args.tf, rows)
    print(f"Записано демо-свечей: {res['accepted']} ({args.symbol} {args.tf})")
    print("ВНИМАНИЕ: это случайные данные, а не рынок.")
    _process()


def _process() -> None:
    t = tournament.active()
    if t:
        res = engine.process(t)
        print(f"Турнир прокручен: свечей {res['candles']}, "
              f"исполнено {res['fills']}, закрыто {res['closes']}")


def main() -> None:
    p = argparse.ArgumentParser(description="Управление Swing Zone Arena")
    sub = p.add_subparsers(dest="cmd", required=True)

    sub.add_parser("init", help="создать схему базы").set_defaults(fn=cmd_init)

    t = sub.add_parser("tournament", help="создать турнир")
    t.add_argument("name")
    t.add_argument("symbol")
    t.add_argument("--tf", default="M1", help="базовый таймфрейм котировок")
    t.add_argument("--days", type=int, default=30)
    t.add_argument("--balance", type=float, default=10_000.0)
    t.add_argument("--risk", type=float, default=2.0)
    t.add_argument("--spread", type=float, default=0.30)
    t.set_defaults(fn=cmd_tournament)

    sub.add_parser("list", help="показать турниры").set_defaults(fn=cmd_list)

    ld = sub.add_parser("load", help="залить историю из JSON")
    ld.add_argument("file")
    ld.add_argument("--symbol", required=True)
    ld.add_argument("--tf", default="M1")
    ld.set_defaults(fn=cmd_load)

    d = sub.add_parser("demo", help="сгенерировать демо-котировки")
    d.add_argument("--symbol", default="XAUUSD")
    d.add_argument("--tf", default="M1")
    d.add_argument("--bars", type=int, default=3000)
    d.add_argument("--price", type=float, default=3400.0)
    d.add_argument("--vol", type=float, default=1.2)
    d.add_argument("--seed", type=int, default=7)
    d.set_defaults(fn=cmd_demo)

    args = p.parse_args()
    args.fn(args)


if __name__ == "__main__":
    main()
