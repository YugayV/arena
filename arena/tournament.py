"""
Турниры: создание, запись участников, состояние.

Автор: Vitaliy Yugay · vamp.09.94@gmail.com · https://github.com/YugayV
"""

from __future__ import annotations

import time

from .db import ex, new_id, q, q1


def now_ms() -> int:
    return int(time.time() * 1000)


class TournamentError(Exception):
    """Ошибка, текст которой показывается участнику."""


def create(name: str, symbol: str, tf: str, starts_ms: int, ends_ms: int,
           start_balance: float = 10_000.0, max_risk_pct: float = 2.0,
           spread: float = 0.30) -> dict:
    if ends_ms <= starts_ms:
        raise TournamentError("Турнир заканчивается раньше, чем начинается")
    tid = new_id()
    ex("INSERT INTO tournaments (id, name, symbol, tf, starts_ms, ends_ms,"
       " start_balance, max_risk_pct, spread, status, cursor_ms, created_ms)"
       " VALUES (:id, :n, :s, :tf, :a, :b, :bal, :risk, :sp, 'open', 0, :now)",
       id=tid, n=name, s=symbol.upper(), tf=tf.upper(), a=starts_ms, b=ends_ms,
       bal=start_balance, risk=max_risk_pct, sp=spread, now=now_ms())
    return get(tid)


def get(tournament_id: str) -> dict | None:
    return q1("SELECT * FROM tournaments WHERE id = :id", id=tournament_id)


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
