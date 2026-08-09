"""
Swing Zone Bot — приёмник сигналов схемы `swing-zone/v1`.

Один сервис отдаёт всё сразу:
    GET  /          -> статический дашборд из web/
    POST /signal    -> приём сигнала от дашборда, TradingView или MT5
    POST /analyze   -> разбор ситуации агентом (цифры + скриншот графика)
    GET  /decision  -> последнее решение по инструменту для советника MT5

Поток данных:
    Dashboard / TradingView / MT5  --POST /signal-->  этот сервис
        -> валидация схемы и риск-лимитов (жёсткие правила, не обходятся ИИ)
        -> ИИ-агент (Claude) принимает решение enter / wait / skip
        -> исполнение (по умолчанию dry-run: только логирование)

    Dashboard  --POST /analyze-->  этот сервис
        -> агент читает разметку и картинку и возвращает разбор с рекомендациями
        -> ничего не исполняется: это аналитика для человека

Запуск из корня репозитория:
    pip install -r requirements.txt
    uvicorn bot.app:app --host 0.0.0.0 --port 8000
"""

from __future__ import annotations

import json
import logging
import os
from datetime import datetime, timezone
from pathlib import Path
from typing import Literal

from fastapi import Depends, FastAPI, Header, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, ConfigDict, Field, field_validator

from .agent import AgentAnalysis, AgentDecision, analyze, decide

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("swing-zone-bot")

# --------------------------------------------------------------------- конфиг

AUTH_TOKEN = os.getenv("BOT_AUTH_TOKEN", "")
ALLOWED_ORIGINS = [o for o in os.getenv("ALLOWED_ORIGINS", "*").split(",") if o]
DRY_RUN = os.getenv("DRY_RUN", "true").lower() != "false"

MIN_RR = float(os.getenv("MIN_RR", "2.0"))
MAX_RISK_PCT = float(os.getenv("MAX_RISK_PCT", "2.0"))
MAX_DATA_AGE_H = float(os.getenv("MAX_DATA_AGE_HOURS", "8"))
ALLOWED_SYMBOLS = {s.strip().upper() for s in os.getenv("ALLOWED_SYMBOLS", "").split(",") if s.strip()}

JOURNAL = Path(os.getenv("JOURNAL_PATH", "signals.jsonl"))
WEB_DIR = Path(__file__).resolve().parent.parent / "web"

# потолок размера скриншота, который дашборд шлёт на разбор
MAX_IMAGE_MB = float(os.getenv("MAX_IMAGE_MB", "5"))

# сколько минут решение считается актуальным для исполнителя
DECISION_TTL_MIN = float(os.getenv("DECISION_TTL_MINUTES", "240"))

# последнее решение по каждому инструменту: его забирает советник MT5
LAST_DECISION: dict[str, dict] = {}
_signal_seq = 0

# --------------------------------------------------------------------- схема


class Payload(BaseModel):
    """Базовая модель схемы.

    extra="allow": продюсеры (дашборд, Pine, MQL5) кладут в сигнал больше, чем
    требуют жёсткие правила — журнал структуры, окно анализа, брифинг агента.
    Валидируем обязательный минимум, но всё остальное доносим до агента, а не
    выбрасываем: именно эти поля дают ему контекст для разбора.
    """

    model_config = ConfigDict(extra="allow")


class SwingPoint(Payload):
    price: float
    time: str | None = None
    source: str | None = None


class Swing(Payload):
    high: SwingPoint
    low: SwingPoint
    leg_direction: Literal["up", "down"]
    strength_bars: int = 2


class Zone(Payload):
    upper: float
    lower: float
    height: float
    equilibrium: float
    ote: list[float] = Field(min_length=2, max_length=2)
    fib: dict[str, float] = {}

    @field_validator("upper")
    @classmethod
    def _upper_above_lower(cls, v, info):
        lower = info.data.get("lower")
        if lower is not None and v <= lower:
            raise ValueError("zone.upper должен быть выше zone.lower")
        return v


class Trade(Payload):
    side: Literal["buy", "sell"]
    order_type: str = "limit"
    entry: float
    stop_loss: float
    take_profit: list[float]
    rr: list[float] = []
    risk_pct: float = 1.0
    position_size: float = 0.0
    invalidation: float


class Context(Payload):
    last_close: float
    last_candle_time: str
    price_location: Literal["premium", "discount", "equilibrium"]
    atr14: float | None = None
    atr_pct_of_zone: float | None = None


class Signal(Payload):
    schema_: str = Field(alias="schema")
    symbol: str
    timeframe: str
    swing: Swing
    zone: Zone
    bias: Literal["long", "short"]
    trade: Trade
    context: Context

    @field_validator("schema_")
    @classmethod
    def _known_schema(cls, v: str) -> str:
        if v != "swing-zone/v1":
            raise ValueError(f"неизвестная схема: {v}")
        return v


class SignalResponse(BaseModel):
    accepted: bool
    decision: str
    reason: str
    guard_failures: list[str] = []
    agent: AgentDecision | None = None
    executed: bool = False


# ----------------------------------------------------------- жёсткие правила


def run_guards(sig: Signal) -> list[str]:
    """Проверки, которые ИИ-агент не может обойти. Сервер — последний рубеж."""
    fails: list[str] = []

    if ALLOWED_SYMBOLS and sig.symbol.upper() not in ALLOWED_SYMBOLS:
        fails.append(f"символ {sig.symbol} не в белом списке")

    if sig.trade.risk_pct > MAX_RISK_PCT:
        fails.append(f"риск {sig.trade.risk_pct}% выше лимита {MAX_RISK_PCT}%")

    risk_per_unit = abs(sig.trade.entry - sig.trade.stop_loss)
    if risk_per_unit <= 0:
        fails.append("стоп совпадает с ценой входа")
    elif sig.trade.take_profit:
        rr = abs(sig.trade.take_profit[0] - sig.trade.entry) / risk_per_unit
        if rr < MIN_RR:
            fails.append(f"R:R {rr:.2f} ниже минимума {MIN_RR}")

    # стоп обязан быть по «правильную» сторону от входа
    if sig.trade.side == "buy" and sig.trade.stop_loss >= sig.trade.entry:
        fails.append("для buy стоп должен быть ниже входа")
    if sig.trade.side == "sell" and sig.trade.stop_loss <= sig.trade.entry:
        fails.append("для sell стоп должен быть выше входа")

    # согласованность направления и структуры
    expected = "buy" if sig.bias == "long" else "sell"
    if sig.trade.side != expected:
        fails.append(f"side={sig.trade.side} не совпадает с bias={sig.bias}")

    # свежесть данных
    try:
        ts = datetime.fromisoformat(sig.context.last_candle_time.replace("Z", "+00:00"))
        age_h = (datetime.now(timezone.utc) - ts).total_seconds() / 3600
        if age_h > MAX_DATA_AGE_H:
            fails.append(f"данные устарели на {age_h:.1f} ч (лимит {MAX_DATA_AGE_H} ч)")
    except ValueError:
        fails.append("не удалось разобрать context.last_candle_time")

    # вход должен лежать внутри размеченной зоны
    if not (sig.zone.lower <= sig.trade.entry <= sig.zone.upper):
        fails.append("цена входа вне площади работы")

    # цена уже пробила границу зоны — последняя нога расширилась,
    # новый свинг ещё не подтверждён, разметка устарела
    if not (sig.zone.lower <= sig.context.last_close <= sig.zone.upper):
        fails.append("цена вышла за границы площади работы — структура не подтверждена")

    return fails


def execute(sig: Signal, decision: AgentDecision) -> bool:
    """Точка интеграции с биржей/брокером. По умолчанию — dry-run."""
    order = {
        "symbol": sig.symbol,
        "side": sig.trade.side,
        "type": sig.trade.order_type,
        "price": decision.entry or sig.trade.entry,
        "stop_loss": decision.stop_loss or sig.trade.stop_loss,
        "take_profit": decision.take_profit or sig.trade.take_profit,
        "quantity": decision.position_size or sig.trade.position_size,
    }
    if DRY_RUN:
        log.info("DRY-RUN ордер не отправлен: %s", order)
        return False

    # TODO: подключить SDK биржи/брокера и выставить лимитный ордер + SL/TP.
    raise NotImplementedError("Подключите исполнение ордеров перед DRY_RUN=false")


def journal(entry: dict) -> None:
    try:
        with JOURNAL.open("a", encoding="utf-8") as f:
            f.write(json.dumps(entry, ensure_ascii=False) + "\n")
    except OSError as exc:
        log.warning("Не удалось записать журнал: %s", exc)


# ------------------------------------------------------------------ приложение

app = FastAPI(title="Swing Zone Bot", version="1.0.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=ALLOWED_ORIGINS or ["*"],
    allow_methods=["POST", "GET", "OPTIONS"],
    allow_headers=["Content-Type", "X-Auth-Token"],
)


@app.get("/health")
def health() -> dict:
    return {"status": "ok", "dry_run": DRY_RUN, "min_rr": MIN_RR, "max_risk_pct": MAX_RISK_PCT}


def require_token(x_auth_token: str = Header(default=""), token: str = "") -> None:
    """Проверка секрета до разбора тела запроса.

    TradingView не умеет отправлять кастомные заголовки — для него секрет
    передаётся в query-строке: POST /signal?token=<секрет>
    """
    if AUTH_TOKEN and x_auth_token != AUTH_TOKEN and token != AUTH_TOKEN:
        raise HTTPException(status_code=401, detail="неверный токен доступа")


@app.post("/signal", response_model=SignalResponse, dependencies=[Depends(require_token)])
def signal(sig: Signal) -> SignalResponse:
    payload = sig.model_dump(by_alias=True)
    fails = run_guards(sig)

    if fails:
        log.warning("Сигнал отклонён правилами: %s", fails)
        journal({"ts": datetime.now(timezone.utc).isoformat(), "payload": payload,
                 "decision": "skip", "guard_failures": fails})
        return SignalResponse(
            accepted=False, decision="skip",
            reason="сигнал не прошёл жёсткие правила риска",
            guard_failures=fails,
        )

    decision = decide(payload)
    log.info("Решение агента: %s (%.2f) — %s", decision.decision, decision.confidence,
             "; ".join(decision.reasons))

    executed = False
    if decision.decision == "enter":
        executed = execute(sig, decision)

    journal({"ts": datetime.now(timezone.utc).isoformat(), "payload": payload,
             "decision": decision.model_dump(), "executed": executed})

    # публикуем решение для исполнителя (советника MT5)
    global _signal_seq
    _signal_seq += 1
    LAST_DECISION[sig.symbol.upper()] = {
        "signal_id": _signal_seq,
        "issued_at": datetime.now(timezone.utc).isoformat(),
        "symbol": sig.symbol.upper(),
        "decision": decision.decision,
        "side": decision.side or sig.trade.side,
        "entry": decision.entry or sig.trade.entry,
        "stop_loss": decision.stop_loss or sig.trade.stop_loss,
        "take_profit": decision.take_profit or sig.trade.take_profit,
        "position_size": decision.position_size or sig.trade.position_size,
        "risk_pct": sig.trade.risk_pct,
        "invalidation": sig.trade.invalidation,
        "bias": sig.bias,
        "source": payload.get("source"),
    }

    return SignalResponse(
        accepted=True,
        decision=decision.decision,
        reason=decision.reasons[0] if decision.reasons else "",
        agent=decision,
        executed=executed,
    )


class AnalyzeRequest(BaseModel):
    """Разбор ситуации: цифры обязательны, скриншот — по желанию."""

    signal: Signal
    image: str | None = Field(default=None, description="data:image/...;base64,...")


def parse_data_url(url: str) -> dict:
    """Разобрать data-URL картинки и проверить размер."""
    if not url.startswith("data:image/"):
        raise HTTPException(status_code=400, detail="ожидается data:image/... URL")
    try:
        header, b64 = url.split(",", 1)
    except ValueError:
        raise HTTPException(status_code=400, detail="повреждённый data-URL") from None

    media_type = header[5:].split(";")[0]
    if media_type not in {"image/png", "image/jpeg", "image/webp", "image/gif"}:
        raise HTTPException(status_code=400, detail=f"формат {media_type} не поддерживается")

    # base64 раздувает данные примерно на треть — считаем по исходному объёму
    size_mb = len(b64) * 3 / 4 / (1024 * 1024)
    if size_mb > MAX_IMAGE_MB:
        raise HTTPException(
            status_code=413,
            detail=f"скриншот {size_mb:.1f} МБ больше лимита {MAX_IMAGE_MB} МБ",
        )
    return {"media_type": media_type, "data": b64}


@app.post("/analyze", response_model=AgentAnalysis, dependencies=[Depends(require_token)])
def analyze_signal(req: AnalyzeRequest) -> AgentAnalysis:
    payload = req.signal.model_dump(by_alias=True)
    image = parse_data_url(req.image) if req.image else None

    result = analyze(payload, image)
    log.info("Разбор: %s (%.2f) — %s", result.verdict, result.confidence, result.summary[:120])

    journal({"ts": datetime.now(timezone.utc).isoformat(), "kind": "analysis",
             "payload": payload, "with_image": image is not None,
             "analysis": result.model_dump()})
    return result


@app.get("/decision", dependencies=[Depends(require_token)])
def decision(symbol: str) -> dict:
    """Последнее решение по инструменту — его забирает советник MT5.

    Возвращает decision="none", если сигнала не было, и "stale", если он
    протух: исполнять устаревший план опаснее, чем пропустить сделку.
    """
    item = LAST_DECISION.get(symbol.upper())
    if not item:
        return {"decision": "none", "symbol": symbol.upper()}

    issued = datetime.fromisoformat(item["issued_at"])
    age_min = (datetime.now(timezone.utc) - issued).total_seconds() / 60
    if age_min > DECISION_TTL_MIN:
        return {**item, "decision": "stale", "age_minutes": round(age_min, 1)}

    return {**item, "age_minutes": round(age_min, 1)}


# Статика монтируется последней: mount на "/" перехватывает всё, что не
# совпало с объявленными выше маршрутами (/health, /signal, /docs).
if WEB_DIR.is_dir():
    app.mount("/", StaticFiles(directory=WEB_DIR, html=True), name="web")
    log.info("Дашборд отдаётся из %s", WEB_DIR)
else:
    log.warning("Каталог %s не найден — дашборд не будет отдаваться", WEB_DIR)
