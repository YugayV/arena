"""
База турнирной площадки.

Автор: Vitaliy Yugay · vamp.09.94@gmail.com · https://github.com/YugayV

Один и тот же DDL работает и на SQLite (разработка, тесты), и на Postgres
(Railway). Чтобы это было правдой без ветвления по диалектам:

  * идентификаторы генерируются в Python (uuid4.hex), а не SERIAL/AUTOINCREMENT;
  * время везде — целое число миллисекунд UTC, а не TIMESTAMP;
  * логические поля — INTEGER 0/1;
  * цены — DOUBLE PRECISION: в Postgres это float8, в SQLite тип с плавающей
    точкой. REAL брать нельзя: в Postgres это float4, и цена золота потеряет
    копейки уже на четвёртой значащей цифре.
"""

from __future__ import annotations

import logging
import os
import uuid
from typing import Any, Iterable

from sqlalchemy import create_engine, text
from sqlalchemy.engine import Engine

log = logging.getLogger("arena.db")

DEFAULT_URL = "sqlite:///arena.db"


def normalize_url(raw: str) -> str:
    """Приведение DATABASE_URL к драйверу, который у нас в зависимостях.

    Railway отдаёт строку вида postgresql://... — SQLAlchemy по умолчанию
    попытается взять psycopg2, которого у нас нет. Явно указываем psycopg 3.
    """
    url = (raw or DEFAULT_URL).strip()
    if url.startswith("postgres://"):
        url = "postgresql+psycopg://" + url[len("postgres://"):]
    elif url.startswith("postgresql://"):
        url = "postgresql+psycopg://" + url[len("postgresql://"):]
    return url


_engine: Engine | None = None


def engine() -> Engine:
    global _engine
    if _engine is None:
        url = normalize_url(os.getenv("DATABASE_URL", DEFAULT_URL))
        kwargs: dict[str, Any] = {"pool_pre_ping": True, "future": True}
        if url.startswith("sqlite"):
            # одна и та же база из нескольких потоков uvicorn
            kwargs["connect_args"] = {"check_same_thread": False}
        else:
            kwargs["pool_size"] = 5
            kwargs["max_overflow"] = 5
        _engine = create_engine(url, **kwargs)
        log.info("База: %s", url.split("@")[-1] if "@" in url else url)
    return _engine


def reset_engine() -> None:
    """Сброс пула — нужен тестам, которые подменяют DATABASE_URL."""
    global _engine
    if _engine is not None:
        _engine.dispose()
    _engine = None


def new_id() -> str:
    return uuid.uuid4().hex


# --------------------------------------------------------------------- схема

SCHEMA: list[str] = [
    """
    CREATE TABLE IF NOT EXISTS users (
        id           TEXT PRIMARY KEY,
        email        TEXT NOT NULL UNIQUE,
        nickname     TEXT NOT NULL UNIQUE,
        -- Регистронезависимое имя считается в Python через casefold и
        -- хранится отдельной колонкой. Полагаться на lower() в SQL нельзя:
        -- в SQLite он работает только с латиницей, и «Трейдер» с «трейдер»
        -- прошли бы как два разных участника.
        nickname_lc  TEXT NOT NULL UNIQUE,
        pw_hash      TEXT NOT NULL,
        created_ms   BIGINT NOT NULL,
        is_admin     INTEGER NOT NULL DEFAULT 0,
        ai_used      INTEGER NOT NULL DEFAULT 0,
        ai_window_ms BIGINT NOT NULL DEFAULT 0
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS sessions (
        token      TEXT PRIMARY KEY,
        user_id    TEXT NOT NULL,
        created_ms BIGINT NOT NULL,
        expires_ms BIGINT NOT NULL
    )
    """,
    "CREATE INDEX IF NOT EXISTS ix_sessions_user ON sessions (user_id)",
    """
    CREATE TABLE IF NOT EXISTS candles (
        symbol TEXT NOT NULL,
        tf     TEXT NOT NULL,
        ts     BIGINT NOT NULL,
        o DOUBLE PRECISION NOT NULL,
        h DOUBLE PRECISION NOT NULL,
        l DOUBLE PRECISION NOT NULL,
        c DOUBLE PRECISION NOT NULL,
        v DOUBLE PRECISION,
        PRIMARY KEY (symbol, tf, ts)
    )
    """,
    "CREATE INDEX IF NOT EXISTS ix_candles_lookup ON candles (symbol, tf, ts)",
    """
    CREATE TABLE IF NOT EXISTS tournaments (
        id            TEXT PRIMARY KEY,
        name          TEXT NOT NULL,
        symbol        TEXT NOT NULL,
        tf            TEXT NOT NULL,
        starts_ms     BIGINT NOT NULL,
        ends_ms       BIGINT NOT NULL,
        start_balance DOUBLE PRECISION NOT NULL,
        max_risk_pct  DOUBLE PRECISION NOT NULL DEFAULT 2.0,
        spread        DOUBLE PRECISION NOT NULL DEFAULT 0.30,
        status        TEXT NOT NULL DEFAULT 'open',
        cursor_ms     BIGINT NOT NULL DEFAULT 0,
        created_ms    BIGINT NOT NULL
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS participants (
        id            TEXT PRIMARY KEY,
        tournament_id TEXT NOT NULL,
        user_id       TEXT NOT NULL,
        balance       DOUBLE PRECISION NOT NULL,
        equity        DOUBLE PRECISION NOT NULL,
        peak_equity   DOUBLE PRECISION NOT NULL,
        max_dd        DOUBLE PRECISION NOT NULL DEFAULT 0,
        joined_ms     BIGINT NOT NULL,
        UNIQUE (tournament_id, user_id)
    )
    """,
    "CREATE INDEX IF NOT EXISTS ix_part_tour ON participants (tournament_id)",
    """
    CREATE TABLE IF NOT EXISTS orders (
        id             TEXT PRIMARY KEY,
        participant_id TEXT NOT NULL,
        side           TEXT NOT NULL,
        kind           TEXT NOT NULL,
        volume         DOUBLE PRECISION NOT NULL,
        limit_price    DOUBLE PRECISION,
        sl             DOUBLE PRECISION,
        tp             DOUBLE PRECISION,
        status         TEXT NOT NULL DEFAULT 'pending',
        placed_ms      BIGINT NOT NULL,
        expires_ms     BIGINT,
        resolved_ms    BIGINT,
        note           TEXT
    )
    """,
    "CREATE INDEX IF NOT EXISTS ix_orders_part ON orders (participant_id, status)",
    """
    CREATE TABLE IF NOT EXISTS trades (
        id             TEXT PRIMARY KEY,
        participant_id TEXT NOT NULL,
        order_id       TEXT,
        side           TEXT NOT NULL,
        volume         DOUBLE PRECISION NOT NULL,
        entry          DOUBLE PRECISION NOT NULL,
        entry_ms       BIGINT NOT NULL,
        sl             DOUBLE PRECISION,
        tp             DOUBLE PRECISION,
        exit_price     DOUBLE PRECISION,
        exit_ms        BIGINT,
        exit_reason    TEXT,
        pnl            DOUBLE PRECISION,
        r_multiple     DOUBLE PRECISION,
        status         TEXT NOT NULL DEFAULT 'open'
    )
    """,
    "CREATE INDEX IF NOT EXISTS ix_trades_part ON trades (participant_id, status)",
    """
    CREATE TABLE IF NOT EXISTS ai_usage (
        id      TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        ts_ms   BIGINT NOT NULL,
        kind    TEXT NOT NULL,
        model   TEXT,
        ok      INTEGER NOT NULL DEFAULT 1
    )
    """,
    "CREATE INDEX IF NOT EXISTS ix_ai_user ON ai_usage (user_id, ts_ms)",
]


def init_schema() -> None:
    with engine().begin() as cx:
        for ddl in SCHEMA:
            cx.execute(text(ddl))
    log.info("Схема готова")


# ------------------------------------------------------------------ хелперы

def q(sql: str, **params: Any) -> list[dict]:
    """SELECT -> список словарей."""
    with engine().connect() as cx:
        rows = cx.execute(text(sql), params).mappings().all()
    return [dict(r) for r in rows]


def q1(sql: str, **params: Any) -> dict | None:
    rows = q(sql, **params)
    return rows[0] if rows else None


def ex(sql: str, **params: Any) -> None:
    with engine().begin() as cx:
        cx.execute(text(sql), params)


def ex_many(sql: str, rows: Iterable[dict]) -> None:
    rows = list(rows)
    if not rows:
        return
    with engine().begin() as cx:
        cx.execute(text(sql), rows)
