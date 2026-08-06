"""
ИИ-агент, который принимает торговое решение по размеченной площади работы.

Модель: Claude (Anthropic). Ответ жёстко ограничен схемой AgentDecision через
structured outputs — бот никогда не парсит свободный текст.

Если ANTHROPIC_API_KEY не задан, используется детерминированный фолбэк на
правилах: сервис остаётся работоспособным без внешнего вызова.
"""

from __future__ import annotations

import json
import logging
import os
from typing import Literal

from pydantic import BaseModel, Field

log = logging.getLogger("swing-zone-bot.agent")

MODEL = os.getenv("ANTHROPIC_MODEL", "claude-opus-5")
EFFORT = os.getenv("ANTHROPIC_EFFORT", "high")
ENTRY_TOLERANCE_PCT = float(os.getenv("ENTRY_TOLERANCE_PCT", "1.5"))


class AgentDecision(BaseModel):
    """Схема ответа агента. Любое другое поле — ошибка валидации."""

    decision: Literal["enter", "wait", "skip"]
    confidence: float = Field(ge=0.0, le=1.0)
    side: Literal["buy", "sell"] | None = None
    entry: float | None = None
    stop_loss: float | None = None
    take_profit: list[float] = []
    position_size: float | None = None
    trigger: str | None = None
    reasons: list[str] = []
    risks: list[str] = []


SYSTEM = """Ты — торговый ИИ-агент, работающий по структуре рынка на таймфрейме H4.
Тебе передают размеченную «площадь работы» между свинг-хай и свинг-лоу вместе с готовым планом сделки.

Правила, которые ты не нарушаешь:
1. Направление сделки задано полем bias и не пересматривается.
2. Вход допустим только по цене trade.entry внутри зоны OTE (zone.ote).
3. Стоп trade.stop_loss не двигается. Сетап отменяется при пробое trade.invalidation.
4. decision = "skip", если R:R первой цели ниже agent.hard_limits.min_rr,
   риск выше max_risk_pct или данные старше max_data_age_hours.
5. decision = "wait", если цена ещё не дошла до зоны входа — тогда обязательно
   заполни поле trigger условием активации ордера.
6. decision = "enter" только когда цена уже в зоне входа и чек-лист выполнен.
7. Ты не предлагаешь действий вне схемы ответа: бот исполняет решение автоматически.

Аргументы в reasons — короткие, по пунктам чек-листа. В risks — что может сломать сетап."""


def _fallback(payload: dict) -> AgentDecision:
    """Детерминированное решение без обращения к модели."""
    trade = payload["trade"]
    ctx = payload["context"]
    entry, stop = trade["entry"], trade["stop_loss"]
    last = ctx["last_close"]
    lower, upper = sorted(payload["zone"]["ote"])

    risk = abs(entry - stop)
    rr = abs(trade["take_profit"][0] - entry) / risk if risk and trade.get("take_profit") else 0.0

    if rr < 2.0:
        return AgentDecision(
            decision="skip", confidence=0.9,
            reasons=[f"R:R {rr:.2f} ниже порога 2.0"],
            risks=["соотношение риск/прибыль не окупает сделку"],
        )

    in_zone = lower <= last <= upper
    if in_zone:
        return AgentDecision(
            decision="enter", confidence=0.6, side=trade["side"],
            entry=entry, stop_loss=stop, take_profit=trade["take_profit"],
            position_size=trade["position_size"],
            reasons=[f"цена {last} внутри зоны OTE {lower}–{upper}", f"R:R {rr:.2f}"],
            risks=["решение принято правилами, без ИИ-агента (нет ANTHROPIC_API_KEY)"],
        )

    return AgentDecision(
        decision="wait", confidence=0.5, side=trade["side"],
        entry=entry, stop_loss=stop, take_profit=trade["take_profit"],
        position_size=trade["position_size"],
        trigger=f"цена входит в диапазон {lower}–{upper}",
        reasons=[f"цена {last} ещё не в зоне входа"],
        risks=["откат может не состояться — сетап истечёт по времени"],
    )


def decide(payload: dict) -> AgentDecision:
    """Основная точка входа: спросить ИИ-агента, при сбое — правила."""
    if not os.getenv("ANTHROPIC_API_KEY"):
        log.info("ANTHROPIC_API_KEY не задан — используется фолбэк на правилах")
        return _fallback(payload)

    try:
        import anthropic

        client = anthropic.Anthropic()
        response = client.messages.parse(
            model=MODEL,
            max_tokens=8000,
            system=SYSTEM,
            thinking={"type": "adaptive"},
            output_config={"effort": EFFORT},
            output_format=AgentDecision,
            messages=[{
                "role": "user",
                "content": (
                    "Оцени сетап и верни решение.\n\n"
                    f"Допуск подхода цены к зоне входа: {ENTRY_TOLERANCE_PCT}%.\n\n"
                    f"{json.dumps(payload, ensure_ascii=False, indent=2)}"
                ),
            }],
        )

        if response.stop_reason == "refusal":
            log.warning("Модель отклонила запрос: %s", response.stop_details)
            return _fallback(payload)

        parsed = response.parsed_output
        if parsed is None:
            log.warning("Пустой parsed_output — фолбэк на правилах")
            return _fallback(payload)
        return parsed

    except Exception as exc:  # noqa: BLE001 — торговля не должна падать из-за агента
        log.exception("Сбой ИИ-агента (%s) — фолбэк на правилах", exc)
        return _fallback(payload)
