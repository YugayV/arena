"""
Справочник инструментов площадки.

Автор: Vitaliy Yugay · vamp.09.94@gmail.com · https://github.com/YugayV

Один спред на все инструменты — это ошибка, которая тихо портит зачёт.
У EUR/USD типичный спред 0.00008, у золота 0.30, у биткоина 20. Если
взять общее число, то на одних инструментах издержки исчезнут, а на других
съедят всю сделку, и таблица результатов будет отражать выбор инструмента,
а не качество торговли.

Поэтому характеристики живут здесь, рядом с символом:

  digits  — знаков после запятой при показе и округлении
  spread  — типичный спред в цене инструмента
  step    — минимальное осмысленное движение (для подсказок по стопу)

Значения — средние по рынку для розничного счёта. Точные цифры зависят от
брокера; если площадка кормится мостом из MT5, спред стоит взять из
терминала и переопределить здесь.
"""

from __future__ import annotations

FOREX = "Валюты"
METALS = "Металлы"
CRYPTO = "Криптовалюты"
INDICES = "Индексы"
ENERGY = "Энергоносители"


INSTRUMENTS: dict[str, dict] = {
    # ---------------------------------------------------------------- валюты
    "EURUSD": {"name": "Евро / Доллар", "group": FOREX, "digits": 5,
               "spread": 0.00008, "step": 0.00001, "provider": "EUR/USD"},
    "GBPUSD": {"name": "Фунт / Доллар", "group": FOREX, "digits": 5,
               "spread": 0.00012, "step": 0.00001, "provider": "GBP/USD"},
    "USDJPY": {"name": "Доллар / Иена", "group": FOREX, "digits": 3,
               "spread": 0.010, "step": 0.001, "provider": "USD/JPY"},
    "AUDUSD": {"name": "Австралиец / Доллар", "group": FOREX, "digits": 5,
               "spread": 0.00012, "step": 0.00001, "provider": "AUD/USD"},
    "USDCHF": {"name": "Доллар / Франк", "group": FOREX, "digits": 5,
               "spread": 0.00013, "step": 0.00001, "provider": "USD/CHF"},
    "USDCAD": {"name": "Доллар / Канадец", "group": FOREX, "digits": 5,
               "spread": 0.00014, "step": 0.00001, "provider": "USD/CAD"},

    # --------------------------------------------------------------- металлы
    "XAUUSD": {"name": "Золото", "group": METALS, "digits": 2,
               "spread": 0.30, "step": 0.01, "provider": "XAU/USD"},
    "XAGUSD": {"name": "Серебро", "group": METALS, "digits": 3,
               "spread": 0.025, "step": 0.001, "provider": "XAG/USD"},

    # ----------------------------------------------------------- криптовалюты
    "BTCUSD": {"name": "Биткоин", "group": CRYPTO, "digits": 1,
               "spread": 20.0, "step": 0.1, "provider": "BTC/USD"},
    "ETHUSD": {"name": "Эфир", "group": CRYPTO, "digits": 2,
               "spread": 1.5, "step": 0.01, "provider": "ETH/USD"},

    # --------------------------------------------------------------- индексы
    "US500": {"name": "S&P 500", "group": INDICES, "digits": 2,
              "spread": 0.50, "step": 0.01, "provider": "SPX"},
    "NAS100": {"name": "Nasdaq 100", "group": INDICES, "digits": 2,
               "spread": 1.50, "step": 0.01, "provider": "NDX"},

    # -------------------------------------------------------------- сырьевые
    "USOIL": {"name": "Нефть WTI", "group": ENERGY, "digits": 2,
              "spread": 0.03, "step": 0.01, "provider": "WTI/USD"},
}

DEFAULT_SET = ["XAUUSD", "EURUSD", "GBPUSD", "USDJPY", "BTCUSD", "US500"]


def normalize(symbol: str) -> str:
    """Приведение написания к нашему ключу: eur/usd, EUR-USD, EURUSD -> EURUSD."""
    s = (symbol or "").upper().strip()
    for ch in ("/", "-", "_", " ", "."):
        s = s.replace(ch, "")
    return s


def get(symbol: str) -> dict | None:
    return INSTRUMENTS.get(normalize(symbol))


def known(symbol: str) -> bool:
    return normalize(symbol) in INSTRUMENTS


def spec(symbol: str, fallback_spread: float = 0.30) -> dict:
    """Характеристики инструмента.

    Неизвестный символ не считается ошибкой: площадка может кормиться мостом
    из MT5, где у брокера свои имена. Тогда берутся безопасные значения по
    умолчанию, а спред — заданный в турнире.
    """
    info = get(symbol)
    if info:
        return {"symbol": normalize(symbol), **info}
    return {"symbol": normalize(symbol), "name": normalize(symbol),
            "group": "Прочее", "digits": 2, "spread": fallback_spread,
            "step": 0.01, "provider": symbol}


def listing() -> list[dict]:
    """Все инструменты, сгруппированные для показа на сайте."""
    return [{"symbol": s, **info} for s, info in INSTRUMENTS.items()]


def groups() -> dict[str, list[dict]]:
    out: dict[str, list[dict]] = {}
    for s, info in INSTRUMENTS.items():
        out.setdefault(info["group"], []).append({"symbol": s, **info})
    return out
