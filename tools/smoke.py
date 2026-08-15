#!/usr/bin/env python3
"""
Проверка живого развёрнутого сайта.

Автор: Vitaliy Yugay · vamp.09.94@gmail.com · https://github.com/YugayV

    python3 tools/smoke.py https://arena.up.railway.app
    python3 tools/smoke.py http://127.0.0.1:8000 --ingest-token devtoken

Скрипт делает то же, что сделал бы первый участник: регистрируется,
входит в турнир, ставит сделку, просит разбор, смотрит таблицу. Ответ
«сервис отвечает 200» ничего не значит, если при этом нельзя торговать.

Заводится настоящий тестовый аккаунт со случайной почтой — на боевой
площадке он останется в базе и в таблице результатов. Для боевого стенда
это разовая проверка после деплоя, а не то, что гоняют по расписанию.
Флаг --read-only проверяет только то, что не меняет данные.

Код возврата 0 — всё хорошо, 1 — есть провалы.
"""

from __future__ import annotations

import argparse
import json
import secrets
import sys
import time

import httpx

OK = "  ok  "
BAD = " ПРОВАЛ "
SKIP = " пропуск "

PASS = FAIL = 0


def check(name: str, ok: bool, detail: str = "") -> bool:
    global PASS, FAIL
    print(f"{OK if ok else BAD} {name}" + (f": {detail}" if detail else ""))
    if ok:
        PASS += 1
    else:
        FAIL += 1
    return ok


def skip(name: str, why: str) -> None:
    print(f"{SKIP} {name}: {why}")


def main() -> int:
    p = argparse.ArgumentParser(description="Проверка развёрнутой площадки")
    p.add_argument("url", help="адрес сайта, например https://arena.up.railway.app")
    p.add_argument("--ingest-token", default="", help="QUOTES_INGEST_TOKEN — проверить приём котировок")
    p.add_argument("--read-only", action="store_true", help="не создавать аккаунт и сделки")
    p.add_argument("--timeout", type=float, default=30.0)
    args = p.parse_args()

    base = args.url.rstrip("/")
    print(f"Проверяю {base}\n")

    # Куки нужны: сессия участника живёт в HttpOnly-куке
    cx = httpx.Client(base_url=base, timeout=args.timeout, follow_redirects=True)

    # ------------------------------------------------------------- сервис
    print("--- сервис ---")
    try:
        r = cx.get("/health")
        health = r.json()
    except Exception as e:                                   # noqa: BLE001
        check("сервис отвечает", False, str(e))
        print("\nДальше идти некуда: сервис недоступен.")
        return 1

    check("сервис отвечает", r.status_code == 200, f"HTTP {r.status_code}")
    check("агент разбора", health.get("agent") in ("claude", "rules"),
          f"{health.get('agent')} ({health.get('model') or 'без модели'})")
    if health.get("agent") == "rules":
        print("       примечание: ANTHROPIC_API_KEY не задан — разбор идёт по правилам")
    check("режим dry_run", health.get("dry_run") is not None, str(health.get("dry_run")))

    r = cx.get("/api/health")
    arena = r.json() if r.status_code == 200 else {}
    if not check("площадка подключена", bool(arena.get("arena")), json.dumps(arena, ensure_ascii=False)):
        print("\nПлощадка не поднялась — проверьте DATABASE_URL и логи деплоя.")
        return 1
    check("сайт отдаётся", bool(arena.get("site")))

    r = cx.get("/")
    check("главная страница открывается",
          r.status_code == 200 and "Swing Zone Arena" in r.text,
          f"HTTP {r.status_code}, {len(r.text)} байт")

    r = cx.get("/dashboard/")
    check("дашборд разметки открывается", r.status_code == 200, f"HTTP {r.status_code}")

    # ------------------------------------------------------------ турнир
    print("\n--- турнир ---")
    r = cx.get("/api/tournament")
    tour = r.json()
    if not check("турнир существует", bool(tour.get("tournament")),
                 (tour.get("tournament") or {}).get("name", "нет активного турнира")):
        print("\nСоздайте турнир: railway run python3 tools/arena_admin.py tournament ...")
        print("или задайте ARENA_DEFAULT_TOURNAMENT и перезапустите сервис.")
        return 1

    syms = [s["symbol"] for s in tour.get("symbols", [])]
    check("инструменты назначены", bool(syms), ", ".join(syms))

    lags = tour.get("lags") or {}
    fresh = tour.get("fresh") or []
    for s in syms:
        lag = lags.get(s)
        human = "нет котировок" if lag is None else f"{int(lag / 1000)} с назад"
        print(f"       {s:8} {human}")
    check("есть хотя бы один свежий инструмент", bool(fresh), ", ".join(fresh) or "ни одного")

    if not fresh:
        print("       поток не наполняется: запустите ArenaFeed.mq5 либо FEED_PROVIDER")

    # ------------------------------------------------------------- свечи
    print("\n--- котировки ---")
    target = fresh[0] if fresh else (syms[0] if syms else "XAUUSD")
    r = cx.get("/api/candles", params={"symbol": target, "tf": "H1", "bars": 120})
    body = r.json()
    candles = body.get("candles") or []
    check(f"свечи по {target}", len(candles) > 0, f"{len(candles)} шт., H1")
    if candles:
        spec = body.get("spec") or {}
        last = candles[-1]
        check("цена похожа на настоящую", float(last["c"]) > 0,
              f"{last['c']} ({spec.get('name', target)}, знаков {spec.get('digits')})")
        check("свеча непротиворечива",
              float(last["h"]) >= float(last["l"])
              and float(last["h"]) >= max(float(last["o"]), float(last["c"]))
              and float(last["l"]) <= min(float(last["o"]), float(last["c"])))

    r = cx.get("/api/instruments")
    check("справочник инструментов", r.status_code == 200,
          f"{sum(len(v) for v in (r.json().get('groups') or {}).values())} инструментов")

    # --------------------------------------------------------- приём котировок
    print("\n--- приём котировок ---")
    r = cx.post("/api/quotes/ingest", json={"symbol": "XAUUSD", "tf": "M1", "candles": []})
    check("без токена приём закрыт", r.status_code in (401, 503), f"HTTP {r.status_code}")

    if args.ingest_token:
        # Пачка НАМЕРЕННО пустая. Проверить надо, что токен принят и ручка
        # жива, а вписывать выдуманную цену в боевой ряд нельзя: по этому
        # ряду считается зачёт, и одна фальшивая свеча может сорвать чужой
        # стоп. Пустой список проходит те же проверки доступа.
        r = cx.post("/api/quotes/ingest",
                    headers={"X-Ingest-Token": args.ingest_token},
                    json={"symbol": target, "tf": "M1", "candles": []})
        body = r.json() if r.status_code == 200 else {}
        check("приём с токеном работает",
              r.status_code == 200 and body.get("accepted") == 0,
              f"HTTP {r.status_code} {r.text[:120]}")
    else:
        skip("приём с токеном", "не передан --ingest-token")

    # ------------------------------------------------------------ участник
    print("\n--- участник ---")
    if args.read_only:
        skip("регистрация и сделка", "включён --read-only")
    else:
        nick = "Проверка" + secrets.token_hex(3)
        email = f"smoke-{secrets.token_hex(6)}@example.com"
        pw = secrets.token_urlsafe(16)

        r = cx.post("/api/register", json={"email": email, "nickname": nick, "password": pw})
        if not check("регистрация", r.status_code == 200, f"HTTP {r.status_code} {r.text[:120]}"):
            return 1
        check("сессия установлена", bool(cx.cookies.get("arena_session")))

        r = cx.get("/api/me")
        me = r.json()
        check("вход опознан", (me.get("user") or {}).get("nickname") == nick)
        quota = me.get("quota") or {}
        check("квота подсказок", "left" in quota,
              f"{quota.get('left')} из {quota.get('limit')} в сутки")

        r = cx.post("/api/tournament/join", json={})
        check("вступление в турнир", r.status_code == 200, f"HTTP {r.status_code} {r.text[:120]}")

        # разбор по правилам работает всегда и ничего не стоит
        r = cx.post("/api/hint/rules", json={"symbol": target, "tf": "H1", "bars": 120})
        hint = r.json() if r.status_code == 200 else {}
        check("разбор по правилам", r.status_code == 200 and bool(hint.get("levels")),
              f"уровней {len(hint.get('levels') or [])}")

        # сделка: только если поток свежий, иначе движок обязан отказать
        if candles and fresh:
            last_c = float(candles[-1]["c"])
            r = cx.post("/api/orders", json={
                "symbol": target, "side": "buy", "kind": "market",
                "sl": round(last_c * 0.99, 6), "tp": round(last_c * 1.02, 6),
                "risk_pct": 0.5})
            ok = r.status_code == 200
            check("сделка принята", ok, r.text[:160])

            if ok:
                trade_id = None
                st = cx.get("/api/tournament").json().get("state") or {}
                opened = st.get("open_trades") or []
                check("сделка видна в счёте", len(opened) == 1,
                      f"объём {opened[0]['volume']:.3f}" if opened else "не найдена")
                if opened:
                    trade_id = opened[0]["id"]
                    check("инструмент записан", opened[0].get("symbol") == target,
                          str(opened[0].get("symbol")))

                if trade_id:
                    r = cx.post(f"/api/trades/{trade_id}/close", json={})
                    check("закрытие сделки", r.status_code == 200, r.text[:120])

            # сделка без стопа приниматься не должна
            r = cx.post("/api/orders", json={
                "symbol": target, "side": "buy", "kind": "market", "risk_pct": 0.5})
            check("сделка без стопа отклонена", r.status_code == 400,
                  f"HTTP {r.status_code}")

            # риск выше предела турнира тоже
            limit = float(tour["tournament"]["max_risk_pct"])
            r = cx.post("/api/orders", json={
                "symbol": target, "side": "buy", "kind": "market",
                "sl": round(last_c * 0.99, 6), "risk_pct": limit + 5})
            check("превышение риска отклонено", r.status_code == 400,
                  f"HTTP {r.status_code}")
        else:
            skip("сделка", "нет свежих котировок — движок обязан отказать")

        r = cx.get("/api/leaderboard")
        rows = (r.json() or {}).get("rows") or []
        check("таблица результатов", r.status_code == 200 and len(rows) > 0,
              f"участников {len(rows)}")

        r = cx.post("/api/logout", json={})
        check("выход", r.status_code == 200)
        r = cx.get("/api/me")
        check("сессия закрыта", (r.json() or {}).get("user") is None)
        print(f"       остался тестовый аккаунт: {nick}")

    # -------------------------------------------------------------- защита
    print("\n--- защита ---")
    anon = httpx.Client(base_url=base, timeout=args.timeout)
    r = anon.post("/api/orders", json={"side": "buy", "kind": "market", "sl": 1})
    check("торговля без входа закрыта", r.status_code == 401, f"HTTP {r.status_code}")
    r = anon.post("/api/hint/model", json={})
    check("подсказка модели без входа закрыта", r.status_code == 401, f"HTTP {r.status_code}")
    anon.close()

    cx.close()

    print(f"\nитого: {PASS} успешно, {FAIL} провалов")
    return 1 if FAIL else 0


if __name__ == "__main__":
    sys.exit(main())
