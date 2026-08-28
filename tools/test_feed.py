#!/usr/bin/env python3
"""
Тесты загрузчика котировок.

Запуск:  python3 tools/test_feed.py

Живой провайдер здесь недоступен, поэтому поднимается локальный двойник,
отвечающий ровно в формате Twelve Data — включая их особенность отдавать
ошибку с кодом 200 и полем status. Проверяется разбор, часовой пояс,
порядок свечей и расчёт интервала опроса под дневной бюджет.
"""

from __future__ import annotations

import json
import os
import sys
import tempfile
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

# База для тестов: по умолчанию временный SQLite, но если задан
# ARENA_TEST_DB — прогон идёт на нём. Так один и тот же набор проверок
# гоняется и на Postgres, то есть ровно на том, что стоит на Railway:
# один DDL на два диалекта надо проверять на обоих, а не верить на слово.
#   ARENA_TEST_DB=postgresql://postgres@127.0.0.1:5432/arena_test
_tmp = tempfile.mkdtemp(prefix="feed-test-")
os.environ["DATABASE_URL"] = os.getenv("ARENA_TEST_DB") or f"sqlite:///{_tmp}/test.db"
print("База проверки:", os.environ["DATABASE_URL"].split("@")[-1])
os.environ["FEED_PROVIDER"] = "twelvedata"
os.environ["FEED_API_KEY"] = "testkey"
# провайдер живёт на localhost, а прокси среды не должен его перехватывать
os.environ["NO_PROXY"] = "127.0.0.1,localhost"
os.environ["no_proxy"] = "127.0.0.1,localhost"

from arena import feed, quotes                              # noqa: E402
from arena.db import init_schema, reset_engine              # noqa: E402

reset_engine()
init_schema()

PASS = FAIL = 0
MODE = {"reply": "ok"}
SEEN = {}


def check(name, got, want):
    global PASS, FAIL
    ok = got == want
    print(f"{'  ok  ' if ok else ' FAIL '} {name}: {got}" + ("" if ok else f"  (ожидалось {want})"))
    PASS += 1 if ok else 0
    FAIL += 0 if ok else 1


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


# ------------------------------------------------------------ двойник API

OK_BODY = {
    "meta": {"symbol": "XAU/USD", "interval": "1min", "currency": "USD"},
    # провайдер отдаёт СВЕЖИЕ СВЕРХУ и строками, а не числами
    "values": [
        {"datetime": "2026-08-13 14:32:00", "open": "3401.10", "high": "3402.40",
         "low": "3400.90", "close": "3402.00", "volume": "132"},
        {"datetime": "2026-08-13 14:31:00", "open": "3400.50", "high": "3401.20",
         "low": "3400.10", "close": "3401.10", "volume": "118"},
        {"datetime": "2026-08-13 14:30:00", "open": "3399.80", "high": "3400.70",
         "low": "3399.50", "close": "3400.50", "volume": "97"},
    ],
    "status": "ok",
}

ERR_BODY = {"code": 429, "message": "You have run out of API credits",
            "status": "error"}


class Handler(BaseHTTPRequestHandler):
    def do_GET(self):                                        # noqa: N802
        from urllib.parse import parse_qs, urlparse
        qs = parse_qs(urlparse(self.path).query)
        SEEN.update({k: v[0] for k, v in qs.items()})

        body = ERR_BODY if MODE["reply"] == "error" else OK_BODY
        raw = json.dumps(body).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def log_message(self, *a):                               # тишина в выводе
        pass


srv = HTTPServer(("127.0.0.1", 0), Handler)
threading.Thread(target=srv.serve_forever, daemon=True).start()
feed.TD_URL = f"http://127.0.0.1:{srv.server_address[1]}/time_series"

# --------------------------------------------------------------------------
print("\n=== 1. Разбор ответа провайдера ===")
rows = feed.fetch("XAUUSD", "M1", 60)
check("свечей разобрано", len(rows), 3)
check("порядок хронологический", rows[0]["ts"] < rows[-1]["ts"], True)
check("строки стали числами", isinstance(rows[0]["o"], float), True)
check("close последней", rows[-1]["c"], 3402.00)

from datetime import datetime, timezone                     # noqa: E402
expect = int(datetime(2026, 8, 13, 14, 30, tzinfo=timezone.utc).timestamp() * 1000)
check("время разобрано как UTC", rows[0]["ts"], expect)

# Главное, ради чего время разбирается вручную: провайдер отдаёт строку без
# зоны, и наивный fromisoformat взял бы зону машины. На сервере в UTC это
# незаметно, а на машине в другом поясе весь ряд уехал бы на часы — и
# обнаружилось бы только по странным результатам сделок.
import time as _time                                        # noqa: E402
os.environ["TZ"] = "Asia/Tokyo"
if hasattr(_time, "tzset"):
    _time.tzset()
check("часовой пояс машины не влияет", feed._td_parse_ts("2026-08-13 14:30:00"), expect)
os.environ["TZ"] = "UTC"
if hasattr(_time, "tzset"):
    _time.tzset()

print("\n=== 2. Символ переведён в написание провайдера ===")
check("XAUUSD -> XAU/USD", SEEN.get("symbol"), "XAU/USD")
check("таймфрейм переведён", SEEN.get("interval"), "1min")
check("зона запрошена явно", SEEN.get("timezone"), "UTC")

feed.fetch("EURUSD", "M1", 60)
check("EURUSD -> EUR/USD", SEEN.get("symbol"), "EUR/USD")
feed.fetch("US500", "H1", 60)
check("US500 -> SPX", SEEN.get("symbol"), "SPX")
check("H1 -> 1h", SEEN.get("interval"), "1h")

print("\n=== 3. Ошибка провайдера приходит с кодом 200 ===")
MODE["reply"] = "error"
raises("исчерпан лимит распознан как ошибка",
       lambda: feed.fetch("XAUUSD", "M1", 60), "api credits")
MODE["reply"] = "ok"

print("\n=== 4. Загрузка в базу ===")
res = feed.pull_once(["XAUUSD", "EURUSD"], "M1", 60)
check("оба инструмента загружены", res["ok"], 2)
check("золото легло в базу", len(quotes.series("XAUUSD", "M1", 100)), 3)
check("евро легло в базу", len(quotes.series("EURUSD", "M1", 100)), 3)

MODE["reply"] = "error"
res = feed.pull_once(["XAUUSD"], "M1", 60)
check("сбой провайдера не роняет проход", res["ok"], 0)
check("сбой записан", "XAUUSD" in res["failed"], True)
MODE["reply"] = "ok"

print("\n=== 5. Интервал опроса влезает в дневной бюджет ===")
# 800 запросов в сутки, 6 инструментов -> не чаще чем раз в 648 с
feed.DAILY_BUDGET = 800
check("6 инструментов", round(feed.poll_interval(6)), 648)
# 800 запросов в сутки не хватает даже на одну минутку в минуту:
# 86400 / 800 = 108 секунд. Это и есть цена бесплатного тарифа.
check("1 инструмент при бюджете 800", round(feed.poll_interval(1)), 108)
check("больше инструментов — реже опрос",
      feed.poll_interval(12) > feed.poll_interval(6), True)

feed.DAILY_BUDGET = 100_000
check("щедрый бюджет даёт минимальный интервал",
      feed.poll_interval(6), feed.MIN_INTERVAL_S)

print("\n=== 6. Фоновый цикл ===")
# До сих пор проверялась только разовая загрузка. Здесь запускается тот же
# цикл, что работает на сервере: поток должен сам опрашивать провайдера,
# складывать свечи в базу, прокручивать турнир и останавливаться по команде.
from arena import tournament                                # noqa: E402

_now = int(_time.time() * 1000)
tour = tournament.create("Поток", "XAUUSD", "M1", _now - 3_600_000,
                         _now + 30 * 86_400_000, symbols=["XAUUSD", "EURUSD"])

feed.DAILY_BUDGET = 10_000_000       # чтобы интервал упёрся в минимум
feed.MIN_INTERVAL_S = 1
feed.BARS_PER_CALL = 60

before = len(quotes.series("XAUUSD", "M1", 100))
started = feed.start()
check("цикл запустился", started, True)
check("статус говорит, что работает", feed.status(2)["running"], True)

# ждём, пока цикл сделает хотя бы один проход
deadline = _time.time() + 15
polls = 0
while _time.time() < deadline:
    _time.sleep(0.5)
    if len(quotes.series("XAUUSD", "M1", 100)) >= before:
        polls += 1
        if polls >= 2:
            break

check("свечи легли в базу", len(quotes.series("XAUUSD", "M1", 100)) > 0, True)
check("евро тоже опрошено", len(quotes.series("EURUSD", "M1", 100)) > 0, True)
check("курсор турнира поехал",
      __import__("arena.engine", fromlist=["engine"]).cursor_of(tour["id"], "XAUUSD") > 0,
      True)

feed.stop()
_time.sleep(1.5)
check("цикл остановился по команде", feed.status(2)["running"], False)

print("\n=== 7. Сбой провайдера не убивает цикл ===")
MODE["reply"] = "error"
feed._stop.clear()
feed._thread = None
check("цикл поднялся снова", feed.start(), True)
_time.sleep(3)
check("поток жив при ошибках провайдера", feed.status(2)["running"], True)
feed.stop()
_time.sleep(1.5)
MODE["reply"] = "ok"

print("\n=== 8. Неизвестный провайдер ===")
saved = feed.PROVIDER
feed.PROVIDER = "нетакого"
raises("неизвестный провайдер", lambda: feed.fetch("XAUUSD"), "не поддерживается")
feed.PROVIDER = saved

srv.shutdown()
print(f"\nитого: {PASS} ok, {FAIL} fail")
sys.exit(1 if FAIL else 0)
