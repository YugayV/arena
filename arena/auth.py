"""
Регистрация, вход и сессии участников.

Автор: Vitaliy Yugay · vamp.09.94@gmail.com · https://github.com/YugayV

Пароли хранятся только как хеш Argon2id. Сессия — случайный токен в базе,
а не подписанная кука с user_id: так вход можно отозвать (сменил пароль —
все сессии умерли), и утечка ключа подписи не даёт входа под чужим именем.
"""

from __future__ import annotations

import re
import secrets
import time

from argon2 import PasswordHasher
from argon2.exceptions import VerifyMismatchError, VerificationError, InvalidHashError

from .db import ex, new_id, q1

_ph = PasswordHasher()

COOKIE = "arena_session"
SESSION_DAYS = 30

EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s.]+\.[^@\s]+$")
NICK_RE = re.compile(r"^[A-Za-zА-Яа-яЁё0-9_\- ]{2,24}$")


class AuthError(Exception):
    """Ошибка, текст которой можно показать пользователю."""


def now_ms() -> int:
    return int(time.time() * 1000)


# ------------------------------------------------------------------ проверки

def validate_registration(email: str, nickname: str, password: str) -> tuple[str, str]:
    email = (email or "").strip().lower()
    nickname = (nickname or "").strip()

    if not EMAIL_RE.match(email):
        raise AuthError("Почта выглядит неправильно")
    if not NICK_RE.match(nickname):
        raise AuthError("Имя: 2–24 символа, буквы, цифры, пробел, дефис, подчёркивание")
    if len(password or "") < 8:
        raise AuthError("Пароль короче 8 символов")
    if len(password) > 200:
        raise AuthError("Пароль длиннее 200 символов")
    # частая причина угона аккаунта на мелких площадках
    if password.lower() in {"password", "12345678", "qwertyui", "parol123", "11111111"}:
        raise AuthError("Такой пароль подберут за секунду")
    return email, nickname


# --------------------------------------------------------------- операции

def register(email: str, nickname: str, password: str) -> dict:
    email, nickname = validate_registration(email, nickname, password)

    if q1("SELECT id FROM users WHERE email = :e", e=email):
        raise AuthError("Такая почта уже зарегистрирована")
    if q1("SELECT id FROM users WHERE nickname_lc = :n", n=nickname.casefold()):
        raise AuthError("Такое имя уже занято")

    uid = new_id()
    ex(
        "INSERT INTO users (id, email, nickname, nickname_lc, pw_hash, created_ms,"
        " is_admin, ai_used, ai_window_ms)"
        " VALUES (:id, :e, :n, :nlc, :h, :t, 0, 0, 0)",
        id=uid, e=email, n=nickname, nlc=nickname.casefold(),
        h=_ph.hash(password), t=now_ms(),
    )
    return {"id": uid, "email": email, "nickname": nickname, "is_admin": 0}


def login(login_field: str, password: str) -> tuple[dict, str]:
    """Вход по почте или по имени. Возвращает (пользователь, токен сессии)."""
    ident = (login_field or "").strip()
    user = q1("SELECT * FROM users WHERE email = :v OR nickname_lc = :lv",
              v=ident.casefold(), lv=ident.casefold())

    if not user:
        # Считаем хеш даже для несуществующего пользователя: иначе по времени
        # ответа видно, какие имена зарегистрированы.
        _ph.hash(password or "x")
        raise AuthError("Неверный логин или пароль")

    try:
        _ph.verify(user["pw_hash"], password or "")
    except (VerifyMismatchError, VerificationError, InvalidHashError):
        raise AuthError("Неверный логин или пароль")

    if _ph.check_needs_rehash(user["pw_hash"]):
        ex("UPDATE users SET pw_hash = :h WHERE id = :id",
           h=_ph.hash(password), id=user["id"])

    return public(user), open_session(user["id"])


def open_session(user_id: str) -> str:
    token = secrets.token_urlsafe(32)
    t = now_ms()
    ex("INSERT INTO sessions (token, user_id, created_ms, expires_ms)"
       " VALUES (:tok, :uid, :t, :exp)",
       tok=token, uid=user_id, t=t, exp=t + SESSION_DAYS * 86400_000)
    return token


def close_session(token: str) -> None:
    if token:
        ex("DELETE FROM sessions WHERE token = :tok", tok=token)


def user_by_token(token: str | None) -> dict | None:
    if not token:
        return None
    row = q1(
        "SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id"
        " WHERE s.token = :tok AND s.expires_ms > :now",
        tok=token, now=now_ms(),
    )
    return public(row) if row else None


def public(user: dict) -> dict:
    """Наружу отдаём только то, что не жалко: без хеша и без почты чужим."""
    return {
        "id": user["id"],
        "email": user["email"],
        "nickname": user["nickname"],
        "is_admin": int(user.get("is_admin", 0)),
        "created_ms": user["created_ms"],
    }
