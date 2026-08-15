"""
Турниры: создание, запись участников, состояние.

Автор: Vitaliy Yugay · vamp.09.94@gmail.com · https://github.com/YugayV
"""

from __future__ import annotations

import time

from . import instruments
from .db import ex, new_id, q, q1


def now_ms() -> int:
    return int(time.time() * 1000)


class TournamentError(Exception):
    """Ошибка, текст которой показывается участнику."""


def create(name: str, symbol: str, tf: str, starts_ms: int, ends_ms: int,
           start_balance: float = 10_000.0, max_risk_pct: float = 2.0,
           spread: float = 0.30, symbols: list[str] | None = None) -> dict:
    if ends_ms <= starts_ms:
        raise TournamentError("Турнир заканчивается раньше, чем начинается")

    tid = new_id()
    primary = instruments.normalize(symbol)
    ex("INSERT INTO tournaments (id, name, symbol, tf, starts_ms, ends_ms,"
       " start_balance, max_risk_pct, spread, status, cursor_ms, created_ms)"
       " VALUES (:id, :n, :s, :tf, :a, :b, :bal, :risk, :sp, 'open', 0, :now)",
       id=tid, n=name, s=primary, tf=tf.upper(), a=starts_ms, b=ends_ms,
       bal=start_balance, risk=max_risk_pct, sp=spread, now=now_ms())

    picked = [instruments.normalize(s) for s in (symbols or [primary])]
    if primary not in picked:
        picked.insert(0, primary)
    set_symbols(tid, picked)
    return get(tid)


def set_symbols(tournament_id: str, symbols: list[str]) -> list[str]:
    """Список инструментов турнира. Курсор заводится сразу на каждый."""
    clean: list[str] = []
    for s in symbols:
        n = instruments.normalize(s)
        if n and n not in clean:
            clean.append(n)
    if not clean:
        raise TournamentError("Список инструментов пуст")

    ex("DELETE FROM tournament_symbols WHERE tournament_id = :t", t=tournament_id)
    for s in clean:
        ex("INSERT INTO tournament_symbols (tournament_id, symbol)"
           " VALUES (:t, :s)", t=tournament_id, s=s)
        if not q1("SELECT symbol FROM tournament_cursors WHERE tournament_id = :t"
                  " AND symbol = :s", t=tournament_id, s=s):
            ex("INSERT INTO tournament_cursors (tournament_id, symbol, cursor_ms)"
               " VALUES (:t, :s, 0)", t=tournament_id, s=s)
    return clean


def symbols(tournament_id: str) -> list[str]:
    rows = q("SELECT symbol FROM tournament_symbols WHERE tournament_id = :t"
             " ORDER BY symbol", t=tournament_id)
    if rows:
        return [r["symbol"] for r in rows]
    # турнир, созданный до появления мультиинструмента
    t = get(tournament_id)
    return [t["symbol"]] if t else []


def has_symbol(tournament_id: str, symbol: str) -> bool:
    return instruments.normalize(symbol) in symbols(tournament_id)


def get(tournament_id: str) -> dict | None:
    return q1("SELECT * FROM tournaments WHERE id = :id", id=tournament_id)


def ensure_default() -> dict | None:
    """Турнир при первом запуске, если его задали переменными окружения.

    Свежий деплой иначе открывается пустой страницей «активного турнира
    нет», и владельцу приходится лезть в консоль Railway до того, как он
    увидел хоть что-то работающее.

    Создаётся ровно один раз: если в базе уже есть незакончившийся турнир,
    функция ничего не делает. Перезапуск сервиса не плодит турниры и не
    сбрасывает счета участников.
    """
    import os

    name = os.getenv("ARENA_DEFAULT_TOURNAMENT", "").strip()
    if not name:
        return None

    existing = upcoming_or_active()
    if existing:
        return existing

    raw = os.getenv("ARENA_DEFAULT_SYMBOLS", "").strip()
    syms = [s for s in (x.strip() for x in raw.split(",")) if s] or instruments.DEFAULT_SET
    days = int(os.getenv("ARENA_DEFAULT_DAYS", "30"))
    balance = float(os.getenv("ARENA_DEFAULT_BALANCE", "10000"))
    risk = float(os.getenv("ARENA_DEFAULT_RISK_PCT", "2"))
    tf = os.getenv("ARENA_BASE_TF", "M1")

    t = now_ms()
    tour = create(name=name, symbol=syms[0], tf=tf, starts_ms=t,
                  ends_ms=t + days * 86_400_000, start_balance=balance,
                  max_risk_pct=risk, symbols=syms)
    return tour


def active() -> dict | None:
    """Турнир, в котором сейчас идёт торговля."""
    t = now_ms()
    return q1("SELECT * FROM tournaments WHERE status = 'open' AND starts_ms <= :t"
              " AND ends_ms > :t ORDER BY starts_ms DESC LIMIT 1", t=t)


def upcoming_or_active() -> dict | None:
    """Турнир для показа на сайте: идущий, а если нет — ближайший."""
    return active() or q1(
        "SELECT * FROM tournaments WHERE status = 'open' AND ends_ms > :t"
        " ORDER BY starts_ms LIMIT 1", t=now_ms())


def listing(limit: int = 20) -> list[dict]:
    return q("SELECT * FROM tournaments ORDER BY starts_ms DESC LIMIT :n", n=limit)


def join(tournament_id: str, user_id: str) -> dict:
    tour = get(tournament_id)
    if not tour:
        raise TournamentError("Турнир не найден")
    if now_ms() >= int(tour["ends_ms"]):
        raise TournamentError("Турнир уже закончился")

    existing = q1("SELECT * FROM participants WHERE tournament_id = :t"
                  " AND user_id = :u", t=tournament_id, u=user_id)
    if existing:
        return existing

    pid = new_id()
    bal = float(tour["start_balance"])
    ex("INSERT INTO participants (id, tournament_id, user_id, balance, equity,"
       " peak_equity, max_dd, joined_ms) VALUES (:id, :t, :u, :b, :b, :b, 0, :now)",
       id=pid, t=tournament_id, u=user_id, b=bal, now=now_ms())
    return q1("SELECT * FROM participants WHERE id = :id", id=pid)


def participant(tournament_id: str, user_id: str) -> dict | None:
    return q1("SELECT * FROM participants WHERE tournament_id = :t AND user_id = :u",
              t=tournament_id, u=user_id)


def is_tradable(tour: dict) -> tuple[bool, str]:
    """Можно ли сейчас торговать в этом турнире."""
    t = now_ms()
    if tour["status"] != "open":
        return False, "Турнир закрыт"
    if t < int(tour["starts_ms"]):
        return False, "Турнир ещё не начался"
    if t >= int(tour["ends_ms"]):
        return False, "Турнир закончился"
    return True, ""
