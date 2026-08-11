"""
Чтение графика со скриншота.

Разделение труда осознанное:

* модель читает то, что написано буквами — тикер, таймфрейм, подписи ценовой
  шкалы и их положение по вертикали. Это OCR, и здесь модель сильна;
* пиксели свечей считает сам браузер (web/vision.js). Модель плохо оценивает
  точные координаты, а нам нужна цена с точностью до пикселя.

Вместе это даёт калибровку «пиксель → цена» без ручных кликов по двум уровням.
Если ключа API нет, эндпоинт честно отвечает, что авточтение недоступно, и
пользователь размечает скриншот руками — этот путь никуда не делся.
"""

from __future__ import annotations

import json
import logging
import os

from pydantic import BaseModel, Field

log = logging.getLogger("swing-zone-bot.vision")

MODEL = os.getenv("ANTHROPIC_MODEL", "claude-opus-5")
EFFORT = os.getenv("ANTHROPIC_VISION_EFFORT", "medium")


class AxisLabel(BaseModel):
    """Подпись ценовой шкалы и её положение по вертикали."""

    price: float = Field(description="Число с подписи, без пробелов и запятых")
    y_fraction: float = Field(
        ge=0.0, le=1.0,
        description="Центр подписи по вертикали: 0 — верх картинки, 1 — низ")


class ChartVision(BaseModel):
    """Что удалось прочитать на скриншоте."""

    readable: bool = Field(description="False, если это не график или ничего не разобрать")
    symbol: str | None = Field(default=None, description="Тикер, например XAUUSD")
    timeframe: str | None = Field(default=None, description="Таймфрейм, например 4H")
    last_candle_time: str | None = Field(
        default=None, description="Время последней свечи в ISO 8601, если видно")

    axis_labels: list[AxisLabel] = Field(
        default=[], description="Подписи ценовой шкалы сверху вниз, минимум две")

    plot_right_fraction: float | None = Field(
        default=None, ge=0.0, le=1.0,
        description="Левая граница ценовой шкалы по горизонтали: где кончаются свечи")

    price_digits: int | None = Field(default=None, description="Знаков после запятой в ценах")
    bullish_color: str | None = Field(default=None, description="Цвет растущих свечей, hex")
    bearish_color: str | None = Field(default=None, description="Цвет падающих свечей, hex")

    notes: list[str] = Field(default=[], description="Что мешало чтению")


SYSTEM = """Ты читаешь скриншот торгового графика. Твоя работа — распознать текст и
границы, а не оценивать рынок.

Что нужно:
1. axis_labels — подписи ЦЕНОВОЙ шкалы (обычно справа). Для каждой: число и
   y_fraction — вертикальный центр подписи как доля высоты картинки сверху вниз.
   Нужно минимум две, лучше все видимые. Порядок — сверху вниз.
   y_fraction измеряй по центру текста, а не по краю строки.
2. plot_right_fraction — где заканчивается поле свечей и начинается ценовая
   шкала, как доля ширины картинки.
3. symbol, timeframe, last_candle_time, price_digits — если видно.
4. bullish_color / bearish_color — цвета растущей и падающей свечи в hex.

Правила:
- Не выдумывай. Не видишь подписи — не пиши её. Меньше двух подписей —
  readable=false и объясни причину в notes.
- Числа читай как есть: «3 892,31» → 3892.31, «1,845.5» → 1845.5.
- Не пытайся определить свинги, тренд или уровни: пиксели свечей посчитает
  другая программа, ей нужна только твоя калибровка."""


def _unreadable(note: str) -> ChartVision:
    return ChartVision(readable=False, notes=[note])


def read_chart(image: dict) -> ChartVision:
    """image — {media_type, data(base64)}."""
    if not os.getenv("ANTHROPIC_API_KEY"):
        return _unreadable("авточтение недоступно: ANTHROPIC_API_KEY не задан")

    try:
        import anthropic

        client = anthropic.Anthropic()
        response = client.messages.parse(
            model=MODEL,
            max_tokens=4000,
            system=SYSTEM,
            output_config={"effort": EFFORT},
            output_format=ChartVision,
            messages=[{
                "role": "user",
                "content": [
                    {"type": "image", "source": {
                        "type": "base64",
                        "media_type": image["media_type"],
                        "data": image["data"],
                    }},
                    {"type": "text", "text":
                     "Прочитай ценовую шкалу и границы поля свечей на этом графике."},
                ],
            }],
        )

        if response.stop_reason == "refusal":
            log.warning("Модель отклонила чтение графика: %s", response.stop_details)
            return _unreadable("модель отклонила запрос")

        parsed = response.parsed_output
        if parsed is None:
            return _unreadable("пустой ответ модели")

        # калибровка возможна только по двум различным уровням
        uniq = {round(a.y_fraction, 4): a for a in parsed.axis_labels}
        if parsed.readable and len(uniq) < 2:
            parsed.readable = False
            parsed.notes.append("на шкале меньше двух различимых подписей — калибровка невозможна")

        log.info("Скриншот прочитан: %s %s, подписей шкалы %d",
                 parsed.symbol, parsed.timeframe, len(parsed.axis_labels))
        return parsed

    except Exception as exc:  # noqa: BLE001 — чтение не должно ронять сервис
        log.exception("Сбой чтения графика (%s)", exc)
        return _unreadable(f"сбой обращения к модели: {exc}")


def to_json(v: ChartVision) -> str:
    return json.dumps(v.model_dump(), ensure_ascii=False)
