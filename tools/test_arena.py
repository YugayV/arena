#!/usr/bin/env python3
"""
Тесты турнирного движка.

Запуск:  python3 tools/test_arena.py

Проверяется в первую очередь не «считает ли прибыль», а невозможность
выиграть за счёт информации, которой нет у остальных участников.
"""

from __future__ import annotations

import os
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

_tmp = tempfile.mkdtemp(prefix="arena-test-")
os.environ["DATABASE_URL"] = f"sqlite:///{_tmp}/test.db"

from arena import auth, engine, quotes, tournament          # noqa: E402
from arena.db import init_schema, q1, reset_engine          # noqa: E402

reset_engine()
init_schema()

H1 = 3_600_000
# Свечи кладём в недавнее прошлое: проверка свежести потока и окно турнира
# считаются от настоящего времени, а не от выдуманной точки.
_NOW = int(__import__("time").time() * 1000)
T0 = (_NOW - 30 * H1) // H1 * H1

PASS = FAIL = 0


def check(name, got, want):
    global PASS, FAIL
    ok = got == want
    print(f"{'  ok  ' if ok else ' FAIL '} {name}: {got}" + ("" if ok else f"  (ожидалось {want})"))
    if ok:
        PASS += 1
    else:
        FAIL += 1


def near(name, got, want, tol=1e-6):
    check(name, abs(float(got) - float(want)) < tol, True)


def raises(name, fn, fragment=""):
    global PASS, FAIL
    try:
        fn()
    except Exception as e:                                   # noqa: BLE001
        ok = fragment.lower() in str(e).lower()
        print(f"{'  ok  ' if ok else ' FAIL '} {name}: {e}")
        PASS += 1 if ok else 0
        FAIL += 0 if ok else 1
        return
    print(f" FAIL  {name}: ошибки не было")
    FAIL += 1


def candle(i, o, h, l, c):
    return {"ts": T0 + i * H1, "o": o, "h": h, "l": l, "c": c}


def fresh_now(idx):
    """Момент времени сразу после закрытия свечи idx — поток считается свежим."""
    return T0 + (idx + 1) * H1 + 1000


# --------------------------------------------------------------------------
print("\n=== 1. Регистрация ===")
u = auth.register("trader@example.com", "Трейдер", "verygoodpass")
check("пользователь создан", bool(u["id"]), True)
raises("повтор почты", lambda: auth.register("trader@example.com", "Другой", "verygoodpass"),
       "почта уже")
raises("повтор имени", lambda: auth.register("other@example.com", "трейдер", "verygoodpass"),
       "имя уже занято")
raises("короткий пароль", lambda: auth.register("a@b.cc", "Кто-то", "1234"), "короче 8")
raises("мусорная почта", lambda: auth.register("не-почта", "Кто-то", "verygoodpass"),
       "почта выглядит")

user2, token2 = auth.login("trader@example.com", "verygoodpass")
check("вход по почте", user2["nickname"], "Трейдер")
check("сессия жива", auth.user_by_token(token2)["id"], u["id"])
raises("неверный пароль", lambda: auth.login("trader@example.com", "wrongpass"),
       "неверный логин")
auth.close_session(token2)
check("выход убил сессию", auth.user_by_token(token2), None)

# --------------------------------------------------------------------------
print("\n=== 2. Котировки ===")
quotes.ingest("XAUUSD", "H1", [candle(i, 3400, 3405, 3395, 3400) for i in range(5)])
check("свечей записано", len(quotes.series("XAUUSD", "H1", 100)), 5)
r = quotes.ingest("XAUUSD", "H1", [{"ts": T0, "o": 3400, "h": 3405, "l": 3395, "c": 3402}])
check("повтор перезаписал, а не задвоил", len(quotes.series("XAUUSD", "H1", 100)), 5)
check("close обновился", quotes.series("XAUUSD", "H1", 100)[0]["c"], 3402)
bad = quotes.ingest("XAUUSD", "H1", [{"ts": T0, "o": 10, "h": 1, "l": 100, "c": 5}])
check("невозможная свеча отброшена", bad["rejected"], 1)

# --------------------------------------------------------------------------
print("\n=== 3. Турнир и участник ===")
tour = tournament.create("Тест", "XAUUSD", "H1", T0, _NOW + 30 * 86_400_000,
                         start_balance=10_000, max_risk_pct=2.0, spread=0.30,
                         symbols=["XAUUSD", "EURUSD"])
check("инструментов в турнире", len(tournament.symbols(tour["id"])), 2)
part = tournament.join(tour["id"], u["id"])
check("баланс на старте", part["balance"], 10_000)
check("повторный вход не дублирует", tournament.join(tour["id"], u["id"])["id"], part["id"])

# --------------------------------------------------------------------------
print("\n=== 4. Проверки при выставлении ордера ===")
now = fresh_now(4)
raises("без стопа", lambda: engine.place_order(
    part, tour, side="buy", kind="market", limit_price=None, sl=None, tp=None,
    risk_pct=1.0, now_ms=now), "без стопа")
raises("стоп не с той стороны", lambda: engine.place_order(
    part, tour, side="buy", kind="market", limit_price=None, sl=3500, tp=None,
    risk_pct=1.0, now_ms=now), "стоп ставится ниже")
raises("риск выше предела", lambda: engine.place_order(
    part, tour, side="buy", kind="market", limit_price=None, sl=3390, tp=None,
    risk_pct=5.0, now_ms=now), "риск выше предела")
raises("лимитка не по ту сторону рынка", lambda: engine.place_order(
    part, tour, side="buy", kind="limit", limit_price=3500, sl=3400, tp=None,
    risk_pct=1.0, now_ms=now), "ниже рынка")

# --------------------------------------------------------------------------
print("\n=== 5. Отставший поток закрывает торговлю ===")
stale = T0 + 5 * H1 + int(engine.MAX_FEED_LAG_S * 1000) + 60_000
raises("торговля при отставании потока", lambda: engine.place_order(
    part, tour, side="buy", kind="market", limit_price=None, sl=3390, tp=None,
    risk_pct=1.0, now_ms=stale), "отстал")

# --------------------------------------------------------------------------
print("\n=== 6. Рыночный ордер и объём по риску ===")
res = engine.place_order(part, tour, side="buy", kind="market", limit_price=None,
                         sl=3392.0, tp=3420.0, risk_pct=1.0, now_ms=now)
# Последняя свеча — индекс 4 с close 3400 (перезаписывали мы нулевую).
# Риск 1% = 100$, расстояние до стопа 8 -> объём 12.5; вход = 3400 + половина спреда.
near("объём по риску 1% от 10000", res["volume"], 10_000 * 0.01 / (3400 - 3392))
tr = q1("SELECT * FROM trades WHERE participant_id = :p AND status='open'", p=part["id"])
near("вход по ask (со спредом)", tr["entry"], 3400 + 0.15)
check("сделка открыта сразу", tr["status"], "open")

# --------------------------------------------------------------------------
print("\n=== 7. Стоп важнее цели в одной свече ===")
# свеча задевает и 3420 (цель), и 3392 (стоп) — обязан сработать стоп
quotes.ingest("XAUUSD", "H1", [candle(5, 3402, 3425, 3390, 3410)])
tour = tournament.get(tour["id"])
engine.process(tour)
done = q1("SELECT * FROM trades WHERE id = :id", id=tr["id"])
check("сделка закрыта", done["status"], "closed")
check("причина выхода", done["exit_reason"], "stop")
check("убыток", done["pnl"] < 0, True)
near("R примерно -1", done["r_multiple"], -1.0, tol=0.05)

part = q1("SELECT * FROM participants WHERE id = :id", id=part["id"])
check("баланс уменьшился", part["balance"] < 10_000, True)

# --------------------------------------------------------------------------
print("\n=== 8. Лимитка не исполняется своей же свечой (защита от игры в прошлое) ===")
# Ставим лимитку на покупку по 3395. Последняя свеча (индекс 5) уже имеет
# low 3390 — то есть «в прошлом» цена там была. Исполниться не должна.
now = fresh_now(5)
res = engine.place_order(part, tour, side="buy", kind="limit", limit_price=3395.0,
                         sl=3385.0, tp=3415.0, risk_pct=1.0, now_ms=now)
tour = tournament.get(tour["id"])
engine.process(tour)
od = q1("SELECT * FROM orders WHERE id = :id", id=res["order_id"])
check("ордер всё ещё ждёт", od["status"], "pending")
check("сделок не открылось", q1(
    "SELECT count(*) AS n FROM trades WHERE participant_id=:p AND status='open'",
    p=part["id"])["n"], 0)

print("     ... и исполняется следующей свечой")
quotes.ingest("XAUUSD", "H1", [candle(6, 3400, 3402, 3393, 3398)])
tour = tournament.get(tour["id"])
engine.process(tour)
od = q1("SELECT * FROM orders WHERE id = :id", id=res["order_id"])
check("ордер исполнен", od["status"], "filled")
tr2 = q1("SELECT * FROM trades WHERE order_id = :o", o=res["order_id"])
near("вход по лимиту + половина спреда", tr2["entry"], 3395 + 0.15)

# --------------------------------------------------------------------------
print("\n=== 9. Цель отрабатывает ===")
quotes.ingest("XAUUSD", "H1", [candle(7, 3398, 3418, 3396, 3416)])
tour = tournament.get(tour["id"])
engine.process(tour)
tr2 = q1("SELECT * FROM trades WHERE id = :id", id=tr2["id"])
check("закрыта по цели", tr2["exit_reason"], "target")
check("прибыль", tr2["pnl"] > 0, True)
near("R около +2", tr2["r_multiple"], 2.0, tol=0.1)

# --------------------------------------------------------------------------
print("\n=== 10. Повторный прогон ничего не меняет ===")
before = q1("SELECT balance FROM participants WHERE id=:id", id=part["id"])["balance"]
tour = tournament.get(tour["id"])
engine.process(tour)
engine.process(tournament.get(tour["id"]))
after = q1("SELECT balance FROM participants WHERE id=:id", id=part["id"])["balance"]
near("баланс не изменился", after, before)

# --------------------------------------------------------------------------
print("\n=== 11. Срок жизни лимитки ===")
now = fresh_now(7)
res = engine.place_order(part, tour, side="buy", kind="limit", limit_price=3300.0,
                         sl=3290.0, tp=3330.0, risk_pct=1.0, now_ms=now,
                         expiry_bars=2)
quotes.ingest("XAUUSD", "H1", [candle(8, 3416, 3420, 3410, 3418),
                               candle(9, 3418, 3422, 3412, 3420),
                               candle(10, 3420, 3424, 3414, 3422)])
tour = tournament.get(tour["id"])
engine.process(tour)
od = q1("SELECT * FROM orders WHERE id = :id", id=res["order_id"])
check("лимитка снята по сроку", od["status"], "expired")

# --------------------------------------------------------------------------
print("\n=== 12. Пределы по количеству ===")
now = fresh_now(10)
for i in range(engine.MAX_OPEN_TRADES):
    engine.place_order(part, tour, side="buy", kind="market", limit_price=None,
                       sl=3400.0, tp=3450.0, risk_pct=0.5, now_ms=now)
raises("больше предела открытых сделок", lambda: engine.place_order(
    part, tour, side="buy", kind="market", limit_price=None, sl=3400.0, tp=None,
    risk_pct=0.5, now_ms=now), "это предел")

# --------------------------------------------------------------------------
print("\n=== 13. Таблица результатов ===")
board = engine.leaderboard(tour["id"])
check("участник в таблице", board[0]["nickname"], "Трейдер")
check("место проставлено", board[0]["place"], 1)

# --------------------------------------------------------------------------
print("\n=== 14. Агрегация таймфреймов ===")
# Склейка идёт по абсолютной сетке UTC, а не от первой свечи набора: иначе
# один и тот же час попадал бы в разные H4-свечи у разных участников.
H4 = 4 * H1
aligned = (T0 // H4) * H4
base = [{"ts": aligned + i * H1, "o": 3400 + i, "h": 3410 + i,
         "l": 3390 + i, "c": 3405 + i} for i in range(8)]
agg = quotes.aggregate(base, "H4", "H1")
check("8 часовых -> 2 четырёхчасовых", len(agg), 2)
check("open первой равен open первой часовой", agg[0]["o"], base[0]["o"])
check("close первой равен close четвёртой", agg[0]["c"], base[3]["c"])
check("high — максимум из четырёх", agg[0]["h"], max(k["h"] for k in base[:4]))
check("вторая свеча начинается ровно по сетке", agg[1]["ts"] - agg[0]["ts"], H4)

# Набор, начинающийся не по сетке, обязан дать неполную первую свечу
off = [{"ts": aligned + (i + 2) * H1, "o": 1, "h": 2, "l": 0.5, "c": 1.5}
       for i in range(4)]
agg2 = quotes.aggregate(off, "H4", "H1")
check("смещённый набор даёт неполную первую свечу", len(agg2), 2)

# --------------------------------------------------------------------------
print("\n=== 15. Заливка истории обрабатывается целиком ===")
# Пачка прокрутки — 5000 свечей. Заливаем заведомо больше и проверяем, что
# курсор доехал до конца, а не остановился на краю первой пачки.
big_t0 = T0 + 200 * H1
many = [{"ts": big_t0 + i * H1, "o": 3400, "h": 3402, "l": 3398, "c": 3400}
        for i in range(6000)]
quotes.ingest("XAUUSD", "H1", many)
tour = tournament.get(tour["id"])
res = engine.process(tour)
tour = tournament.get(tour["id"])
check("обработано больше одной пачки", res["candles"] > engine.BATCH, True)
check("курсор доехал до последней свечи",
      engine.cursor_of(tour["id"], "XAUUSD"), big_t0 + 5999 * H1)

print("\n=== 17. Инструменты считаются раздельно ===")
# Спред берётся из справочника, а не общий на турнир: у EUR/USD он в тысячи
# раз меньше золотого, и общее число исказило бы зачёт.
check("спред золота", engine.spread_for(tour, "XAUUSD"), 0.30)
check("спред EUR/USD", engine.spread_for(tour, "EURUSD"), 0.00008)
check("незнакомый символ берёт спред турнира",
      engine.spread_for(tour, "BROKERX"), 0.30)

# Курсоры независимы: у EUR/USD котировок ещё не было
check("курсор EUR/USD не двигался", engine.cursor_of(tour["id"], "EURUSD"), 0)

eur_t0 = (_NOW - 5 * H1) // H1 * H1
quotes.ingest("EURUSD", "H1", [
    {"ts": eur_t0 + i * H1, "o": 1.0850, "h": 1.0865, "l": 1.0840, "c": 1.0855}
    for i in range(4)])
tour = tournament.get(tour["id"])
engine.process(tour)
check("курсор EUR/USD поехал",
      engine.cursor_of(tour["id"], "EURUSD"), eur_t0 + 3 * H1)
check("курсор золота не сбился",
      engine.cursor_of(tour["id"], "XAUUSD"), big_t0 + 5999 * H1)

raises("инструмент вне турнира", lambda: engine.place_order(
    part, tour, symbol="BTCUSD", side="buy", kind="market", limit_price=None,
    sl=1.0, tp=None, risk_pct=1.0, now_ms=_NOW), "не участвует")

print("\n=== 18. Справочник инструментов ===")
from arena import instruments as inst                       # noqa: E402
check("EUR/USD нормализуется", inst.normalize("eur/usd"), "EURUSD")
check("XAU-USD нормализуется", inst.normalize("XAU-USD"), "XAUUSD")
check("у золота 2 знака", inst.spec("XAUUSD")["digits"], 2)
check("у EUR/USD 5 знаков", inst.spec("EURUSD")["digits"], 5)
check("у иены 3 знака", inst.spec("USDJPY")["digits"], 3)
check("групп больше одной", len(inst.groups()) > 1, True)

print("\n=== 16. Свёртки старших таймфреймов ===")
h4 = quotes.series("XAUUSD", "H4", 10000)
check("H4 материализован", len(h4) > 0, True)
check("H4 не длиннее часового ряда",
      len(h4) < len(quotes.series("XAUUSD", "H1", 10000)), True)
row = quotes.series_from("XAUUSD", "H1", big_t0, 3)
check("series_from отдаёт НАЧАЛО, а не хвост", row[0]["ts"], big_t0)

print(f"\nитого: {PASS} ok, {FAIL} fail")
sys.exit(1 if FAIL else 0)
