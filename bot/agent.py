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


class AgentAnalysis(BaseModel):
    """Разбор ситуации: что агент увидел и что советует."""

    verdict: Literal["enter", "wait", "skip"]
    confidence: float = Field(ge=0.0, le=1.0)
    summary: str = Field(description="Один абзац: что происходит и что делать")
    structure_read: str = Field(description="Как агент читает структуру рынка")
    key_levels: list[str] = Field(default=[], description="Уровни, за которыми следить")
    recommendations: list[str] = Field(default=[], description="Конкретные действия")
    risks: list[str] = Field(default=[], description="Что может сломать сетап")
    invalidation: str = Field(default="", description="При каком условии отменять сетап")
    chart_notes: list[str] = Field(
        default=[], description="Что видно на графике, но нет в цифрах")


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


ANALYSIS_SYSTEM = """Ты — торговый аналитик, работающий по структуре рынка на H4.

Тебе передают размеченную площадь работы между свинг-хай и свинг-лоу: цифры плана,
журнал того, что делала структура, и — когда он есть — скриншот графика.

Как отвечать:
1. Опирайся на переданные цифры. Если картинка противоречит цифрам, скажи об этом
   прямо в chart_notes, а не подгоняй одно под другое.
2. structure_read — как ты читаешь структуру: где рынок в диапазоне, куда идёт
   последняя нога, подтверждена ли она.
3. key_levels — конкретные цены, а не «зона сопротивления».
4. recommendations — действия, которые можно выполнить: где ставить ордер, что
   считать подтверждением, когда не входить вовсе.
5. verdict = skip, если R:R первой цели ниже 2, риск выше лимита или данные старые.
   verdict = wait, если цена ещё не в зоне входа. verdict = enter — только когда
   цена уже в зоне и план цел.
6. chart_notes заполняй только если реально видишь скриншот: свечные формации,
   гэпы, объёмы, уровни, которых нет в цифрах. Без картинки оставь список пустым.

Пиши по-русски, коротко и по делу. Не выдумывай данных, которых тебе не дали."""


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


def _fallback_analysis(payload: dict, note: str) -> AgentAnalysis:
    """Разбор без модели: пересказ цифр, которые и так есть в payload.

    chart_notes остаётся пустым: писать туда служебные сообщения нельзя —
    это раздел про то, что видно на картинке, а картинку здесь никто не читал.
    """
    trade = payload.get("trade", {})
    zone = payload.get("zone", {})
    ctx = payload.get("context", {})
    d = _fallback(payload)

    lower, upper = sorted(zone.get("ote", [0, 0]))
    rr = (trade.get("rr") or [0])[0]
    last = ctx.get("last_close")

    recs = [f"Лимитный ордер в зоне OTE {lower}–{upper}", f"R:R первой цели {rr}"]
    risks = [*d.risks, note]

    # цена вне размеченной зоны — план построен на структуре, которой уже нет
    outside = (last is not None and zone.get("lower") is not None
               and not (zone["lower"] <= last <= zone["upper"]))
    if outside:
        recs.insert(0, "Цена вне площади работы — переразметить структуру, "
                       "прежде чем работать по этому плану")
        risks.insert(0, "последняя нога вышла за границы зоны: разметка устарела")

    return AgentAnalysis(
        verdict="skip" if outside else d.decision,
        confidence=d.confidence,
        summary=(f"Структура {payload.get('structure') or payload.get('bias')}: зона "
                 f"{zone.get('lower')}–{zone.get('upper')}, цена {last} "
                 f"в {ctx.get('price_location')}. {d.reasons[0] if d.reasons else ''}"),
        structure_read=(f"Последняя нога {payload.get('swing', {}).get('leg_direction')}, "
                        f"equilibrium {zone.get('equilibrium')}."),
        key_levels=[f"вход {trade.get('entry')}", f"стоп {trade.get('stop_loss')}",
                    f"цель {(trade.get('take_profit') or [None])[0]}",
                    f"инвалидация {trade.get('invalidation')}"],
        recommendations=recs,
        risks=risks,
        invalidation=f"пробой {trade.get('invalidation')}",
        chart_notes=[],
    )


def analyze(payload: dict, image: dict | None = None) -> AgentAnalysis:
    """Разбор ситуации агентом. image — {media_type, data(base64)} или None."""
    if not os.getenv("ANTHROPIC_API_KEY"):
        log.info("ANTHROPIC_API_KEY не задан — разбор собран по правилам")
        return _fallback_analysis(payload, "разбор без ИИ-агента: ключ API не задан")

    try:
        import anthropic

        client = anthropic.Anthropic()

        content: list[dict] = []
        if image:
            content.append({
                "type": "image",
                "source": {
                    "type": "base64",
                    "media_type": image["media_type"],
                    "data": image["data"],
                },
            })
            content.append({"type": "text", "text":
                            "Скриншот графика с разметкой: линии и подписи нанёс дашборд."})

        content.append({"type": "text", "text":
                        "Разбери ситуацию и дай рекомендации.\n\n"
                        + json.dumps(payload, ensure_ascii=False, indent=2)})

        response = client.messages.parse(
            model=MODEL,
            max_tokens=8000,
            system=ANALYSIS_SYSTEM,
            thinking={"type": "adaptive"},
            output_config={"effort": EFFORT},
            output_format=AgentAnalysis,
            messages=[{"role": "user", "content": content}],
        )

        if response.stop_reason == "refusal":
            log.warning("Модель отклонила разбор: %s", response.stop_details)
            return _fallback_analysis(payload, "модель отклонила запрос")

        parsed = response.parsed_output
        if parsed is None:
            return _fallback_analysis(payload, "пустой ответ модели")
        return parsed

    except Exception as exc:  # noqa: BLE001 — разбор не должен ронять сервис
        log.exception("Сбой разбора (%s)", exc)
        return _fallback_analysis(payload, f"сбой обращения к модели: {exc}")
