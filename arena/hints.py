"""
Подсказки участникам.

Автор: Vitaliy Yugay · vamp.09.94@gmail.com · https://github.com/YugayV

Два уровня, и это осознанное разделение:

  ПРАВИЛА — бесплатно и всегда. Считаются здесь же по нашему ряду свечей:
  структура, границы площади работы, где сейчас цена, здоров ли задуманный
  участником риск. Это детерминированно, мгновенно и ничего не стоит.

  МОДЕЛЬ — по кнопке и с квотой на участника. Платный вызов, поэтому он
  никогда не происходит сам собой: иначе один активный участник, кликающий
  раз в минуту, съест бюджет всего турнира.

Провайдер выбирается переменной AI_PROVIDER: deepseek | anthropic | off.
Если ключа нет или вызов не удался, участник всё равно получает разбор по
правилам — сайт не ломается из-за внешнего сервиса.
"""

from __future__ import annotations

import json
import logging
import os
import time

import httpx
from pydantic import BaseModel, Field, ValidationError

from .db import ex, new_id, q1

log = logging.getLogger("arena.hints")

PROVIDER = os.getenv("AI_PROVIDER", "off").lower()
DEEPSEEK_MODEL = os.getenv("DEEPSEEK_MODEL", "deepseek-chat")
DEEPSEEK_URL = os.getenv("DEEPSEEK_URL", "https://api.deepseek.com/chat/completions")
ANTHROPIC_MODEL = os.getenv("ANTHROPIC_MODEL", "claude-haiku-4-5")

AI_QUOTA = int(os.getenv("AI_QUOTA_PER_DAY", "10"))
QUOTA_WINDOW_MS = 24 * 3600 * 1000


class HintError(Exception):
    """Ошибка, текст которой показывается участнику."""


class ModelHint(BaseModel):
    """Схема ответа модели. Свободный текст в торговый интерфейс не пускаем."""

    verdict: str = Field(description="enter | wait | skip")
    confidence: float = Field(ge=0.0, le=1.0)
    summary: str
    reasons: list[str] = []
    risks: list[str] = []


# ------------------------------------------------------------------- правила

def _swing(candles: list[dict]) -> tuple[float, float]:
    hi = max(float(k["h"]) for k in candles)
    lo = min(float(k["l"]) for k in candles)
    return hi, lo


def rules_hint(candles: list[dict], *, side: str | None = None,
               entry: float | None = None, sl: float | None = None,
               tp: float | None = None, max_risk_pct: float = 2.0) -> dict:
    """Разбор по правилам. Работает всегда и ничего не стоит."""
    if len(candles) < 20:
        return {"source": "rules", "summary": "Свечей слишком мало для разбора",
                "levels": [], "notes": [], "warnings": []}

    tail = candles[-120:]
    hi, lo = _swing(tail)
    rng = hi - lo
    last = float(candles[-1]["c"])
    eq = lo + rng / 2

    where = "равновесие"
    if rng > 0:
        pos = (last - lo) / rng
        if pos > 0.55:
            where = "премиум (верхняя половина)"
        elif pos < 0.45:
            where = "дискаунт (нижняя половина)"

    notes = [
        f"Площадь работы за последние {len(tail)} свечей: {lo:.2f} – {hi:.2f}"
        f" (высота {rng:.2f})",
        f"Цена {last:.2f} — {where}",
    ]
    levels = [
        {"name": "Swing High", "price": hi},
        {"name": "Равновесие 50%", "price": eq},
        {"name": "Swing Low", "price": lo},
        {"name": "OTE 0.705 сверху", "price": hi - 0.705 * rng},
        {"name": "OTE 0.705 снизу", "price": lo + 0.705 * rng},
    ]

    warnings: list[str] = []

    # разбор задуманной сделки, если участник её описал
    if side and entry and sl:
        risk = abs(float(entry) - float(sl))
        if risk <= 0:
            warnings.append("Стоп совпадает с ценой входа — сделка не имеет смысла")
        else:
            if tp:
                rr = abs(float(tp) - float(entry)) / risk
                notes.append(f"Отношение прибыли к риску: {rr:.2f}")
                if rr < 1.5:
                    warnings.append(
                        f"R:R {rr:.2f} — на дистанции это требует винрейта выше "
                        f"{100 / (1 + rr):.0f}%, что редкость")
            if rng > 0 and risk > rng * 0.5:
                warnings.append("Стоп шире половины площади работы — "
                                "риск не соответствует разметке")
            if rng > 0 and risk < rng * 0.03:
                warnings.append("Стоп очень тесный относительно площади: "
                                "высок шанс выбить шумом")

        if side == "buy" and where.startswith("премиум"):
            warnings.append("Покупка в премиуме: вход в верхней половине "
                            "площади — худшая цена для лонга")
        if side == "sell" and where.startswith("дискаунт"):
            warnings.append("Продажа в дискаунте: вход в нижней половине "
                            "площади — худшая цена для шорта")

    notes.append(f"Предел риска в турнире: {max_risk_pct}% на сделку")

    return {"source": "rules", "summary": "; ".join(notes[:2]),
            "levels": levels, "notes": notes, "warnings": warnings}


# -------------------------------------------------------------------- квота

def quota_state(user_id: str) -> dict:
    u = q1("SELECT ai_used, ai_window_ms FROM users WHERE id = :id", id=user_id)
    if not u:
        raise HintError("Пользователь не найден")
    now = int(time.time() * 1000)
    used = int(u["ai_used"])
    start = int(u["ai_window_ms"])
    if now - start > QUOTA_WINDOW_MS:
        used, start = 0, now
    return {"used": used, "left": max(0, AI_QUOTA - used), "limit": AI_QUOTA,
            "window_start": start, "resets_ms": start + QUOTA_WINDOW_MS}


def _spend_quota(user_id: str) -> None:
    st = quota_state(user_id)
    if st["left"] <= 0:
        raise HintError(
            f"Лимит подсказок исчерпан: {AI_QUOTA} в сутки. "
            f"Разбор по правилам остаётся доступным.")
    ex("UPDATE users SET ai_used = :u, ai_window_ms = :w WHERE id = :id",
       u=st["used"] + 1, w=st["window_start"], id=user_id)


def _log_usage(user_id: str, kind: str, model: str, ok: bool) -> None:
    ex("INSERT INTO ai_usage (id, user_id, ts_ms, kind, model, ok)"
       " VALUES (:id, :u, :t, :k, :m, :ok)",
       id=new_id(), u=user_id, t=int(time.time() * 1000), k=kind, m=model,
       ok=1 if ok else 0)


# ------------------------------------------------------------------ модель

SYSTEM = (
    "Ты помощник трейдера на учебном турнире. Тебе дают разметку структуры "
    "рынка и задуманную сделку. Твоя задача — коротко сказать, разумна ли она, "
    "и предупредить о рисках. Ты НЕ даёшь финансовых советов и не обещаешь "
    "прибыль. Отвечай строго в JSON по схеме: "
    '{"verdict":"enter|wait|skip","confidence":0..1,"summary":"строка",'
    '"reasons":["строка"],"risks":["строка"]}. Только JSON, без пояснений.'
)


def _payload(rules: dict, ctx: dict) -> str:
    return json.dumps({"разбор_по_правилам": rules, "ситуация": ctx},
                      ensure_ascii=False)[:12000]


def _call_deepseek(prompt: str) -> ModelHint:
    key = os.getenv("DEEPSEEK_API_KEY", "")
    if not key:
        raise HintError("DEEPSEEK_API_KEY не задан")

    r = httpx.post(
        DEEPSEEK_URL,
        headers={"Authorization": f"Bearer {key}",
                 "Content-Type": "application/json"},
        json={
            "model": DEEPSEEK_MODEL,
            "messages": [{"role": "system", "content": SYSTEM},
                         {"role": "user", "content": prompt}],
            "response_format": {"type": "json_object"},
            "temperature": 0.2,
            "max_tokens": 700,
        },
        timeout=40.0,
    )
    if r.status_code != 200:
        raise HintError(f"Модель ответила ошибкой {r.status_code}")
    body = r.json()["choices"][0]["message"]["content"]
    return ModelHint.model_validate_json(body)


def _call_anthropic(prompt: str) -> ModelHint:
    key = os.getenv("ANTHROPIC_API_KEY", "")
    if not key:
        raise HintError("ANTHROPIC_API_KEY не задан")

    import anthropic

    client = anthropic.Anthropic(api_key=key)
    resp = client.messages.parse(
        model=ANTHROPIC_MODEL,
        max_tokens=900,
        system=SYSTEM,
        output_format=ModelHint,
        messages=[{"role": "user", "content": prompt}],
    )
    if resp.stop_reason == "refusal":
        raise HintError("Модель отклонила запрос")
    parsed = resp.parsed_output
    if parsed is None:
        raise HintError("Модель вернула пустой ответ")
    return parsed


def model_hint(user_id: str, rules: dict, ctx: dict) -> dict:
    """Платная подсказка. Квота списывается только при реальном вызове."""
    if PROVIDER == "off":
        raise HintError("Подсказки модели отключены на этой площадке")

    _spend_quota(user_id)
    prompt = _payload(rules, ctx)
    model = DEEPSEEK_MODEL if PROVIDER == "deepseek" else ANTHROPIC_MODEL

    try:
        hint = _call_deepseek(prompt) if PROVIDER == "deepseek" else _call_anthropic(prompt)
    except (HintError, ValidationError, httpx.HTTPError, KeyError, ValueError) as e:
        _log_usage(user_id, "model", model, ok=False)
        log.warning("Подсказка модели не удалась: %s", e)
        raise HintError(f"Подсказка модели недоступна: {e}")

    _log_usage(user_id, "model", model, ok=True)
    out = hint.model_dump()
    out["source"] = f"model:{model}"
    return out
