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

from arena import engine, instruments, quotes, tournament  # noqa: E402
from arena.db import init_schema, q                     # noqa: E402

MS_DAY = 86_400_000


def cmd_init(_args) -> None:
    init_schema()
    print("Схема создана или уже была на месте.")


def cmd_tournament(args) -> None:
    init_schema()
    now = int(time.time() * 1000)
    syms = [s.strip() for s in (args.symbols or args.symbol).split(",") if s.strip()]
    t = tournament.create(
        name=args.name, symbol=syms[0], tf=args.tf.upper(),
        starts_ms=now, ends_ms=now + args.days * MS_DAY,
        start_balance=args.balance, max_risk_pct=args.risk, spread=args.spread,
        symbols=syms)
    picked = tournament.symbols(t["id"])
    print(f"Турнир создан: {t['name']} ({t['id']})")
    print(f"  таймфрейм   {t['tf']}")
    print("  инструменты:")
    for sym in picked:
        spec = instruments.spec(sym)
        mark = "" if instruments.known(sym) else "  (нет в справочнике)"
        print(f"    {sym:8} {spec['name']:22} спред {spec['spread']:<10g}"
              f" знаков {spec['digits']}{mark}")
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
        syms = ",".join(tournament.symbols(t["id"]))
        print(f"{t['id'][:8]}  {t['name'][:20]:20}  {syms[:34]:34} {t['tf']:3} "
              f"{live:7} участников: {n}")


def cmd_instruments(_args) -> None:
    """Справочник: что можно поставить в турнир."""
    for group, items in instruments.groups().items():
        print(f"\n{group}")
        for i in items:
            print(f"  {i['symbol']:8} {i['name']:22} спред {i['spread']:<10g}"
                  f" знаков {i['digits']}  провайдер: {i['provider']}")
    print(f"\nНабор по умолчанию: {','.join(instruments.DEFAULT_SET)}")


def cmd_pull(args) -> None:
    """Разовая загрузка котировок с провайдера."""
    from arena import feed

    init_schema()
    syms = [s.strip() for s in args.symbols.split(",") if s.strip()]
    if not syms:
        t = tournament.upcoming_or_active()
        syms = tournament.symbols(t["id"]) if t else []
    if not syms:
        print("Нечего загружать: не заданы инструменты и нет активного турнира.")
        return

    print(f"Провайдер: {feed.PROVIDER}, инструментов: {len(syms)}, "
          f"интервал под бюджет: {feed.poll_interval(len(syms)):.0f} с")
    res = feed.pull_once(syms, args.tf, args.bars)
    print(f"Загружено инструментов: {res['ok']} из {len(syms)}")
    for sym, err in res["failed"].items():
        print(f"  {sym}: {err}")
    _process()


def cmd_feed(args) -> None:
    """Поток котировок в переднем плане.

    Нужен, когда загрузчик хочется держать ОТДЕЛЬНЫМ процессом, а не
    внутри веб-сервиса. На Railway это второй сервис из того же репозитория
    со стартовой командой `python3 tools/arena_admin.py feed`.

    Зачем так. Веб-сервис можно масштабировать в несколько реплик, и тогда
    внутри каждой заработает свой загрузчик: запросы к провайдеру
    умножатся на число реплик, а дневной бюджет кончится во столько же раз
    быстрее. Отдельный воркер в одном экземпляре от этого избавлен —
    только не забудьте выключить встроенный, оставив FEED_PROVIDER=off у
    веб-сервиса.
    """
    from arena import feed

    init_schema()
    if feed.PROVIDER == "off":
        print("FEED_PROVIDER=off — загрузчик выключен. Задайте провайдера.")
        return
    if not feed.API_KEY:
        print("FEED_API_KEY не задан — провайдер не ответит.")
        return

    t = tournament.upcoming_or_active()
    syms = [s.strip() for s in args.symbols.split(",") if s.strip()]
    if not syms:
        syms = tournament.symbols(t["id"]) if t else []
    if not syms:
        print("Нет инструментов: создайте турнир или задайте --symbols.")
        return

    interval = feed.poll_interval(len(syms))
    print(f"Провайдер: {feed.PROVIDER}")
    print(f"Инструменты: {', '.join(syms)}")
    print(f"Бюджет: {feed.DAILY_BUDGET} запросов в сутки")
    print(f"Интервал опроса: {interval:.0f} с "
          f"({len(syms)} инструментов x 86400 / {feed.DAILY_BUDGET})")
    if interval > engine.MAX_FEED_LAG_S:
        print(f"ВНИМАНИЕ: интервал {interval:.0f} с больше порога свежести "
              f"MAX_FEED_LAG_S ({engine.MAX_FEED_LAG_S:.0f} с) — площадка будет "
              f"закрывать торговлю между опросами. Уменьшите число инструментов, "
              f"поднимите MAX_FEED_LAG_S или возьмите платный тариф.")
    print("Остановка — Ctrl+C\n")

    try:
        while True:
            res = feed.pull_once(syms, args.tf, args.bars)
            stamp = time.strftime("%H:%M:%S", time.gmtime())
            print(f"[{stamp}] обновлено {res['ok']} из {len(syms)}"
                  + (f", сбои: {list(res['failed'])}" if res["failed"] else ""))
            _process()
            time.sleep(interval)
    except KeyboardInterrupt:
        print("\nОстановлено.")


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

    # Округление берём из справочника: у EUR/USD пять знаков, и round(.., 2)
    # превратил бы 1.08503 в 1.09, уничтожив весь ход цены.
    spec = instruments.spec(args.symbol)
    dg = spec["digits"]
    vol = args.vol if args.vol is not None else spec["step"] * 40

    rnd = random.Random(args.seed)
    price = args.price
    rows = []
    for i in range(args.bars):
        o = price
        c = o + (rnd.random() - 0.5) * vol * 2
        h = max(o, c) + rnd.random() * vol
        l = min(o, c) - rnd.random() * vol
        rows.append({"ts": start + i * step, "o": round(o, dg), "h": round(h, dg),
                     "l": round(l, dg), "c": round(c, dg), "v": 0})
        price = c

    res = quotes.ingest(args.symbol, args.tf, rows)
    print(f"Записано демо-свечей: {res['accepted']} ({args.symbol} {args.tf}, "
          f"{dg} знаков, размах {vol:g})")
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
    t.add_argument("symbol", nargs="?", default="XAUUSD")
    t.add_argument("--symbols", default="",
                   help="список через запятую, например XAUUSD,EURUSD,BTCUSD")
    t.add_argument("--tf", default="M1", help="базовый таймфрейм котировок")
    t.add_argument("--days", type=int, default=30)
    t.add_argument("--balance", type=float, default=10_000.0)
    t.add_argument("--risk", type=float, default=2.0)
    t.add_argument("--spread", type=float, default=0.30)
    t.set_defaults(fn=cmd_tournament)

    sub.add_parser("list", help="показать турниры").set_defaults(fn=cmd_list)
    sub.add_parser("instruments", help="справочник инструментов").set_defaults(
        fn=cmd_instruments)

    pl = sub.add_parser("pull", help="разово загрузить котировки с провайдера")
    pl.add_argument("--symbols", default="", help="через запятую; пусто — все из турнира")
    pl.add_argument("--tf", default="M1")
    pl.add_argument("--bars", type=int, default=200)
    pl.set_defaults(fn=cmd_pull)

    fd = sub.add_parser("feed", help="поток котировок в переднем плане")
    fd.add_argument("--symbols", default="", help="через запятую; пусто — все из турнира")
    fd.add_argument("--tf", default="M1")
    fd.add_argument("--bars", type=int, default=60)
    fd.set_defaults(fn=cmd_feed)

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
    d.add_argument("--vol", type=float, default=None,
                   help="размах свечи; по умолчанию из шага инструмента")
    d.add_argument("--seed", type=int, default=7)
    d.set_defaults(fn=cmd_demo)

    args = p.parse_args()
    args.fn(args)


if __name__ == "__main__":
    main()
