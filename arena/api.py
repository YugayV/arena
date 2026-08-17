"""
HTTP-интерфейс турнирной площадки.

Автор: Vitaliy Yugay · vamp.09.94@gmail.com · https://github.com/YugayV

Сессия хранится в куке SameSite=Lax + HttpOnly: чужой сайт не сможет ни
прочитать её из JavaScript, ни отправить POST от имени участника.
"""

from __future__ import annotations

import logging
import os
import time

from fastapi import APIRouter, Cookie, Depends, Header, HTTPException, Response
from pydantic import BaseModel, Field

from . import auth, engine, feed, hints, instruments, quotes, tournament
from .db import q1

log = logging.getLogger("arena.api")

router = APIRouter(prefix="/api", tags=["arena"])

INGEST_TOKEN = os.getenv("QUOTES_INGEST_TOKEN", "")
SECURE_COOKIES = os.getenv("SECURE_COOKIES", "auto").lower()
BASE_TF = os.getenv("ARENA_BASE_TF", "M1")


def now_ms() -> int:
    return int(time.time() * 1000)


def _set_cookie(resp: Response, token: str) -> None:
    secure = SECURE_COOKIES == "true" or (
        SECURE_COOKIES == "auto" and bool(os.getenv("RAILWAY_ENVIRONMENT")))
    resp.set_cookie(
        auth.COOKIE, token,
        max_age=auth.SESSION_DAYS * 86400,
        httponly=True, samesite="lax", secure=secure, path="/",
    )


# ------------------------------------------------------------------- доступ

def current_user(arena_session: str | None = Cookie(default=None)) -> dict:
    user = auth.user_by_token(arena_session)
    if not user:
        raise HTTPException(status_code=401, detail="Нужно войти")
    return user


def optional_user(arena_session: str | None = Cookie(default=None)) -> dict | None:
    return auth.user_by_token(arena_session)


def require_ingest_token(x_ingest_token: str = Header(default=""),
                         token: str = "") -> None:
    if not INGEST_TOKEN:
        raise HTTPException(status_code=503,
                            detail="Приём котировок не настроен: нет QUOTES_INGEST_TOKEN")
    if x_ingest_token != INGEST_TOKEN and token != INGEST_TOKEN:
        raise HTTPException(status_code=401, detail="Неверный токен источника")


# -------------------------------------------------------------------- схемы

class RegisterIn(BaseModel):
    email: str
    nickname: str
    password: str


class LoginIn(BaseModel):
    login: str
    password: str


class CandleIn(BaseModel):
    ts: int
    o: float
    h: float
    l: float
    c: float
    v: float | None = None


class IngestIn(BaseModel):
    symbol: str
    tf: str = BASE_TF
    candles: list[CandleIn]


class OrderIn(BaseModel):
    symbol: str | None = None
    side: str
    kind: str = "market"
    limit_price: float | None = None
    sl: float | None = None
    tp: float | None = None
    risk_pct: float = Field(default=1.0, gt=0)
    expiry_bars: int = Field(default=24, ge=1, le=500)


class HintIn(BaseModel):
    symbol: str | None = None
    side: str | None = None
    entry: float | None = None
    sl: float | None = None
    tp: float | None = None
    tf: str = "H1"
    bars: int = Field(default=200, ge=20, le=1000)


# --------------------------------------------------------------------- вход

@router.post("/register")
def api_register(body: RegisterIn, resp: Response) -> dict:
    try:
        user = auth.register(body.email, body.nickname, body.password)
    except auth.AuthError as e:
        raise HTTPException(status_code=400, detail=str(e))
    _set_cookie(resp, auth.open_session(user["id"]))
    return {"user": user}


@router.post("/login")
def api_login(body: LoginIn, resp: Response) -> dict:
    try:
        user, token = auth.login(body.login, body.password)
    except auth.AuthError as e:
        raise HTTPException(status_code=401, detail=str(e))
    _set_cookie(resp, token)
    return {"user": user}


@router.post("/logout")
def api_logout(resp: Response, arena_session: str | None = Cookie(default=None)) -> dict:
    auth.close_session(arena_session or "")
    resp.delete_cookie(auth.COOKIE, path="/")
    return {"ok": True}


@router.get("/me")
def api_me(user: dict | None = Depends(optional_user)) -> dict:
    if not user:
        return {"user": None}
    return {"user": user, "quota": hints.quota_state(user["id"])}


# ---------------------------------------------------------------- котировки

@router.post("/quotes/ingest", dependencies=[Depends(require_ingest_token)])
def api_ingest(body: IngestIn) -> dict:
    res = quotes.ingest(body.symbol, body.tf,
                        [c.model_dump() for c in body.candles])
    # новые свечи сразу прокручивают турнир: исполняются лимитки, стопы, цели
    tour = tournament.active()
    if tour:
        res["processed"] = engine.process(tour)
    return res


@router.get("/feed")
def api_feed() -> dict:
    """Состояние потока котировок.

    Отвечает на вопрос «почему торговля закрыта»: провайдер выключен,
    ключа нет, цикл не поднялся — или всё в порядке, а данные просто ещё
    не дошли.
    """
    tour = tournament.upcoming_or_active()
    syms = tournament.symbols(tour["id"]) if tour else []
    now = now_ms()
    return {
        **feed.status(len(syms)),
        "symbols": syms,
        "lags_ms": {s: engine.feed_lag_ms(s, tour["tf"], now) for s in syms} if tour else {},
        "max_lag_s": engine.MAX_FEED_LAG_S,
    }


@router.get("/instruments")
def api_instruments() -> dict:
    """Справочник инструментов и то, какие из них в текущем турнире."""
    tour = tournament.upcoming_or_active()
    active_syms = tournament.symbols(tour["id"]) if tour else []
    return {"groups": instruments.groups(), "active": active_syms}


@router.get("/candles")
def api_candles(tf: str = "H1", bars: int = 300, symbol: str | None = None) -> dict:
    tour = tournament.upcoming_or_active()
    sym = instruments.normalize(symbol or (tour["symbol"] if tour else "XAUUSD"))
    bars = max(20, min(bars, 2000))
    rows = quotes.window(sym, BASE_TF, tf, bars)
    return {"symbol": sym, "tf": tf.upper(), "base_tf": BASE_TF,
            "spec": instruments.spec(sym),
            "candles": rows[-bars:],
            "lag_ms": engine.feed_lag_ms(sym, BASE_TF, now_ms())}


# ------------------------------------------------------------------- турнир

def _tour_or_404() -> dict:
    tour = tournament.upcoming_or_active()
    if not tour:
        raise HTTPException(status_code=404, detail="Активного турнира нет")
    return tour


@router.get("/tournament")
def api_tournament(user: dict | None = Depends(optional_user)) -> dict:
    tour = tournament.upcoming_or_active()
    if not tour:
        return {"tournament": None}

    tradable, why = tournament.is_tradable(tour)

    syms = tournament.symbols(tour["id"])
    now = now_ms()
    # Отставание своё у каждого инструмента: биржевые закрываются на ночь,
    # и общий вывод «поток отстал» запретил бы торговать круглосуточной
    # криптой из-за выходного на индексах.
    lags = {s: engine.feed_lag_ms(s, tour["tf"], now) for s in syms}
    prices = {s: quotes.latest_price(s, tour["tf"]) for s in syms}
    fresh = [s for s, v in lags.items() if v is not None
             and v <= engine.MAX_FEED_LAG_S * 1000]
    if tradable and not fresh:
        tradable, why = False, "Поток котировок отстал по всем инструментам"

    out: dict = {
        "tournament": tour,
        "symbols": [instruments.spec(s) for s in syms],
        "tradable": tradable,
        "reason": why,
        "feed_lag_ms": lags.get(tour["symbol"]),
        "lags": lags,
        "prices": prices,
        "fresh": fresh,
        "participants": q1("SELECT count(*) AS n FROM participants"
                           " WHERE tournament_id = :t", t=tour["id"])["n"],
    }
    if user:
        part = tournament.participant(tour["id"], user["id"])
        out["joined"] = bool(part)
        if part:
            engine.process(tournament.get(tour["id"]))
            out["state"] = engine.participant_state(part["id"])
    return out


@router.post("/tournament/join")
def api_join(user: dict = Depends(current_user)) -> dict:
    tour = _tour_or_404()
    try:
        part = tournament.join(tour["id"], user["id"])
    except tournament.TournamentError as e:
        raise HTTPException(status_code=400, detail=str(e))
    return {"participant": part}


@router.get("/leaderboard")
def api_leaderboard() -> dict:
    tour = tournament.upcoming_or_active()
    if not tour:
        return {"rows": []}
    engine.process(tournament.get(tour["id"]))
    return {"tournament": tour["name"], "rows": engine.leaderboard(tour["id"])}


# ------------------------------------------------------------------ торговля

def _participant(user: dict, tour: dict) -> dict:
    part = tournament.participant(tour["id"], user["id"])
    if not part:
        raise HTTPException(status_code=400, detail="Вы не участвуете в турнире")
    return part


@router.post("/orders")
def api_place(body: OrderIn, user: dict = Depends(current_user)) -> dict:
    tour = _tour_or_404()
    ok, why = tournament.is_tradable(tour)
    if not ok:
        raise HTTPException(status_code=400, detail=why)

    part = _participant(user, tour)
    engine.process(tournament.get(tour["id"]))
    part = q1("SELECT * FROM participants WHERE id = :id", id=part["id"])

    try:
        res = engine.place_order(
            part, tour, symbol=body.symbol, side=body.side, kind=body.kind,
            limit_price=body.limit_price, sl=body.sl, tp=body.tp,
            risk_pct=body.risk_pct, now_ms=now_ms(), expiry_bars=body.expiry_bars)
    except engine.TradeError as e:
        raise HTTPException(status_code=400, detail=str(e))
    return res


@router.post("/orders/{order_id}/cancel")
def api_cancel(order_id: str, user: dict = Depends(current_user)) -> dict:
    tour = _tour_or_404()
    part = _participant(user, tour)
    try:
        engine.cancel_order(part, order_id)
    except engine.TradeError as e:
        raise HTTPException(status_code=400, detail=str(e))
    return {"ok": True}


@router.post("/trades/{trade_id}/close")
def api_close(trade_id: str, user: dict = Depends(current_user)) -> dict:
    tour = _tour_or_404()
    part = _participant(user, tour)
    engine.process(tournament.get(tour["id"]))
    try:
        res = engine.close_trade(part, tour, trade_id, now_ms())
    except engine.TradeError as e:
        raise HTTPException(status_code=400, detail=str(e))
    return res


# ----------------------------------------------------------------- подсказки

# Сколько свечей нужно, чтобы разбор был осмысленным. Столько же требует
# rules_hint: на меньшем окне «площадь работы» — это шум.
HINT_MIN_BARS = 20

# Порядок понижения таймфрейма при нехватке истории.
HINT_FALLBACK = ["D1", "H4", "H1", "M15", "M5", "M1"]


def _hint_context(tour: dict, body: HintIn) -> tuple[dict, dict]:
    sym = instruments.normalize(body.symbol or tour["symbol"])
    rows = quotes.window(sym, BASE_TF, body.tf, body.bars)
    used_tf = body.tf.upper()

    # Свежий турнир: поток идёт час, на H1 всего пять свечей, и разбор
    # возвращал бы пустоту. Спускаемся на младший таймфрейм, где истории
    # уже хватает, и честно говорим, на каком считали.
    if len(rows) < HINT_MIN_BARS:
        start = HINT_FALLBACK.index(used_tf) if used_tf in HINT_FALLBACK else 0
        for tf in HINT_FALLBACK[start + 1:]:
            alt = quotes.window(sym, BASE_TF, tf, body.bars)
            if len(alt) >= HINT_MIN_BARS:
                rows, used_tf = alt, tf
                break
    rules = hints.rules_hint(
        rows, side=body.side, entry=body.entry, sl=body.sl, tp=body.tp,
        max_risk_pct=float(tour["max_risk_pct"]))
    rules["timeframe"] = used_tf
    if used_tf != body.tf.upper():
        rules.setdefault("notes", []).insert(
            0, f"Истории на {body.tf.upper()} пока мало — разбор посчитан на {used_tf}")
    ctx = {
        "символ": sym, "инструмент": instruments.spec(sym)["name"],
        "таймфрейм": used_tf,
        "последняя_цена": rows[-1]["c"] if rows else None,
        "задумана_сделка": {"сторона": body.side, "вход": body.entry,
                            "стоп": body.sl, "цель": body.tp},
    }
    return rules, ctx


@router.post("/hint/rules")
def api_hint_rules(body: HintIn, user: dict = Depends(current_user)) -> dict:
    tour = _tour_or_404()
    rules, _ = _hint_context(tour, body)
    return rules


@router.post("/hint/model")
def api_hint_model(body: HintIn, user: dict = Depends(current_user)) -> dict:
    tour = _tour_or_404()
    rules, ctx = _hint_context(tour, body)
    try:
        out = hints.model_hint(user["id"], rules, ctx)
    except hints.HintError as e:
        # квота или недоступность модели — не повод оставлять участника ни с чем
        raise HTTPException(status_code=429 if "Лимит" in str(e) else 503,
                            detail=str(e))
    out["rules"] = rules
    out["quota"] = hints.quota_state(user["id"])
    return out
