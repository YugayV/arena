"""
Загрузчик реальных котировок.

Автор: Vitaliy Yugay · vamp.09.94@gmail.com · https://github.com/YugayV

Два способа наполнять базу площадки настоящими данными:

  МОСТ ИЗ MT5 (mt5/ArenaFeed.mq5) — толкает свечи сам, в реальном времени,
  бесплатно и ровно с того фида, на котором вы торгуете. Ограничение одно:
  терминал должен быть включён.

  ЭТОТ МОДУЛЬ — тянет свечи с внешнего провайдера по расписанию. Нужен,
  когда терминала нет. Провайдер выбирается FEED_PROVIDER.

Про бесплатные тарифы честно. У Twelve Data бесплатно 800 запросов в сутки
и 8 в минуту. Один запрос возвращает свечи по ОДНОМУ инструменту, поэтому
шесть инструментов при опросе раз в минуту — это 8640 запросов в сутки,
то есть в десять раз больше лимита. Поэтому интервал опроса считается из
бюджета и числа инструментов, а не берётся с потолка, и результат честно
печатается в лог при старте.

Следствие, о котором надо знать: на бесплатном тарифе поток отстаёт на
несколько минут, и правило свежести (MAX_FEED_LAG_S) закроет торговлю.
Либо поднимайте MAX_FEED_LAG_S, соглашаясь на задержку, либо берите
меньше инструментов, либо платный тариф, либо мост из MT5.
"""

from __future__ import annotations

import logging
import os
import threading
import time
from datetime import datetime, timezone

import httpx

from . import instruments, quotes

log = logging.getLogger("arena.feed")

PROVIDER = os.getenv("FEED_PROVIDER", "off").lower()
API_KEY = os.getenv("FEED_API_KEY", "")
BASE_TF = os.getenv("ARENA_BASE_TF", "M1")

# бюджет запросов в сутки у провайдера (800 — бесплатный тариф Twelve Data)
DAILY_BUDGET = int(os.getenv("FEED_DAILY_BUDGET", "800"))
MIN_INTERVAL_S = float(os.getenv("FEED_MIN_INTERVAL_S", "60"))
BARS_PER_CALL = int(os.getenv("FEED_BARS_PER_CALL", "60"))

# Адрес провайдера можно переопределить: у части пользователей запросы
# ходят через свой прокси или зеркало, а на закрытом контуре прямой доступ
# к api.twelvedata.com может быть попросту запрещён.
TD_URL = os.getenv("FEED_URL", "https://api.twelvedata.com/time_series")

TD_INTERVAL = {
    "M1": "1min", "M5": "5min", "M15": "15min", "M30": "30min",
    "H1": "1h", "H4": "4h", "D1": "1day",
}


class FeedError(Exception):
    """Провайдер не отдал данные."""


def poll_interval(symbol_count: int) -> float:
    """Пауза между опросами одного инструмента, влезающая в дневной бюджет.

    Считаем честно: каждый инструмент опрашивается отдельным запросом,
    значит за сутки уйдёт symbol_count * (86400 / interval) запросов.
    Отсюда interval >= symbol_count * 86400 / бюджет.
    """
    if symbol_count <= 0 or DAILY_BUDGET <= 0:
        return MIN_INTERVAL_S
    need = symbol_count * 86400.0 / DAILY_BUDGET
    return max(MIN_INTERVAL_S, need)


# ------------------------------------------------------------- Twelve Data

def _td_parse_ts(raw: str) -> int:
    """Время свечи провайдера в миллисекунды UTC.

    Провайдер отдаёт «2026-08-13 14:31:00» без зоны — для валют и металлов
    это UTC. Разбираем явно, а не через fromisoformat с локальной зоной:
    иначе на машине с не-UTC временем весь ряд уедет на несколько часов,
    и это заметят только по странным результатам сделок.
    """
    raw = (raw or "").strip()
    fmt = "%Y-%m-%d %H:%M:%S" if len(raw) > 10 else "%Y-%m-%d"
    dt = datetime.strptime(raw, fmt).replace(tzinfo=timezone.utc)
    return int(dt.timestamp() * 1000)


def fetch_twelvedata(symbol: str, tf: str, bars: int) -> list[dict]:
    if not API_KEY:
        raise FeedError("FEED_API_KEY не задан")

    spec = instruments.spec(symbol)
    interval = TD_INTERVAL.get(tf.upper())
    if not interval:
        raise FeedError(f"провайдер не знает таймфрейм {tf}")

    r = httpx.get(TD_URL, params={
        "symbol": spec["provider"],
        "interval": interval,
        "outputsize": max(1, min(bars, 5000)),
        "format": "JSON",
        "timezone": "UTC",
        "apikey": API_KEY,
    }, timeout=30.0)

    if r.status_code != 200:
        raise FeedError(f"HTTP {r.status_code}")

    data = r.json()
    # у провайдера ошибка приезжает с кодом 200 и полем status
    if isinstance(data, dict) and data.get("status") == "error":
        raise FeedError(str(data.get("message", "ошибка провайдера"))[:200])

    values = (data or {}).get("values") or []
    out = []
    for v in values:
        try:
            out.append({
                "ts": _td_parse_ts(v["datetime"]),
                "o": float(v["open"]), "h": float(v["high"]),
                "l": float(v["low"]), "c": float(v["close"]),
                "v": float(v["volume"]) if v.get("volume") else None,
            })
        except (KeyError, TypeError, ValueError):
            continue

    # провайдер отдаёт свежие сверху — на приёме порядок неважен, но пусть
    # наружу уходит привычный хронологический
    out.sort(key=lambda k: k["ts"])
    return out


FETCHERS = {"twelvedata": fetch_twelvedata}


def fetch(symbol: str, tf: str = BASE_TF, bars: int = BARS_PER_CALL) -> list[dict]:
    fn = FETCHERS.get(PROVIDER)
    if not fn:
        raise FeedError(f"провайдер {PROVIDER} не поддерживается")
    return fn(symbol, tf, bars)


def pull_once(symbols: list[str], tf: str = BASE_TF,
              bars: int = BARS_PER_CALL) -> dict:
    """Один проход по инструментам. Возвращает сводку для лога."""
    done, failed = 0, {}
    for sym in symbols:
        try:
            candles = fetch(sym, tf, bars)
            if candles:
                quotes.ingest(sym, tf, candles)
                done += 1
        except (FeedError, httpx.HTTPError) as e:
            failed[sym] = str(e)
            log.warning("Котировки %s не получены: %s", sym, e)
    return {"ok": done, "failed": failed}


# ------------------------------------------------------------- фоновый цикл

_stop = threading.Event()
_thread: threading.Thread | None = None


def _loop() -> None:
    from . import tournament
    from .db import init_schema

    init_schema()

    while not _stop.is_set():
        try:
            tour = tournament.upcoming_or_active()
            syms = tournament.symbols(tour["id"]) if tour else []
            if not syms:
                _stop.wait(60)
                continue

            interval = poll_interval(len(syms))
            res = pull_once(syms, BASE_TF, BARS_PER_CALL)

            if tour and res["ok"]:
                from . import engine
                engine.process(tournament.get(tour["id"]))

            log.info("Поток: обновлено %d из %d, следующий проход через %.0f с",
                     res["ok"], len(syms), interval)
            _stop.wait(interval)
        except Exception as e:                               # noqa: BLE001
            # фоновый поток не имеет права уронить сервис
            log.exception("Сбой в цикле котировок: %s", e)
            _stop.wait(60)


def start() -> bool:
    """Запуск фонового загрузчика. Возвращает False, если он не нужен."""
    global _thread
    if PROVIDER == "off" or PROVIDER not in FETCHERS:
        return False
    if not API_KEY:
        log.warning("FEED_PROVIDER=%s, но FEED_API_KEY не задан — поток не запущен",
                    PROVIDER)
        return False
    if _thread and _thread.is_alive():
        return True

    _stop.clear()
    _thread = threading.Thread(target=_loop, name="arena-feed", daemon=True)
    _thread.start()
    log.info("Загрузчик котировок запущен: провайдер %s, бюджет %d запросов в сутки",
             PROVIDER, DAILY_BUDGET)
    return True


def stop() -> None:
    _stop.set()


def status(symbol_count: int = 0) -> dict:
    return {
        "provider": PROVIDER,
        "running": bool(_thread and _thread.is_alive()),
        "has_key": bool(API_KEY),
        "daily_budget": DAILY_BUDGET,
        "interval_s": poll_interval(symbol_count) if symbol_count else None,
    }
