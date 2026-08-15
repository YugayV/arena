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

_tmp = tempfile.mkdtemp(prefix="feed-test-")
os.environ["DATABASE_URL"] = f"sqlite:///{_tmp}/test.db"
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
    globals().__setitem__("PASS", PASS + (1 if ok else 0))
    globals().__setitem__("FAIL", FAIL + (0 if ok else 1))


def raises(name, fn, fragment=""):
    global PASS, FAIL
    try:
        fn()
    except Exception as e:                                   # noqa: BLE001
        ok = fragment.lower() in str(e).lower()
        print(f"{'  ok  ' if ok else ' FAIL '} {name}: {e}")
        globals().__setitem__("PASS", PASS + (1 if ok else 0))
        globals().__setitem__("FAIL", FAIL + (0 if ok else 1))
        return
    print(f" FAIL  {name}: ошибки не было")
    globals().__setitem__("FAIL", FAIL + 1)


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

print("\n=== 6. Неизвестный провайдер ===")
saved = feed.PROVIDER
feed.PROVIDER = "нетакого"
raises("неизвестный провайдер", lambda: feed.fetch("XAUUSD"), "не поддерживается")
feed.PROVIDER = saved

srv.shutdown()
print(f"\nитого: {PASS} ok, {FAIL} fail")
sys.exit(1 if FAIL else 0)
