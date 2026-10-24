"""A zero-dependency local web app for discovering and hosting volunteer activities."""

from __future__ import annotations

import argparse
import json
import mimetypes
import os
import re
import secrets
import sqlite3
import sys
import threading
import traceback
import webbrowser
from datetime import datetime, timedelta, timezone
from http.cookies import SimpleCookie
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlsplit

import db

BASE_DIR = Path(__file__).resolve().parent
STATIC_DIR = BASE_DIR / "static"
SESSION_COOKIE = "weiguang_session"
SESSION_DAYS = 7
MAX_BODY_BYTES = 256 * 1024

USERNAME_RE = re.compile(r"^[A-Za-z0-9_]{3,20}$")
WEEKDAY_NAMES = ["周一", "周二", "周三", "周四", "周五", "周六", "周日"]


class ApiError(Exception):
    def __init__(self, status: int, message: str):
        super().__init__(message)
        self.status = status
        self.message = message


def parse_local_datetime(value: str) -> datetime:
    """Parse a naive local ISO datetime (the format emitted by datetime-local)."""
    if not isinstance(value, str) or not value.strip():
        raise ValueError("empty datetime")
    text = value.strip()
    if text.endswith("Z"):
        text = text[:-1]
    parsed = datetime.fromisoformat(text)
    if parsed.tzinfo is not None:
        parsed = parsed.astimezone().replace(tzinfo=None)
    return parsed.replace(second=0, microsecond=0)


def clean_text(value, label: str, min_len: int, max_len: int) -> str:
    if not isinstance(value, str):
        raise ApiError(400, f"请填写{label}")
    text = value.strip()
    if len(text) < min_len:
        raise ApiError(400, f"{label}至少需要 {min_len} 个字符")
    if len(text) > max_len:
        raise ApiError(400, f"{label}不能超过 {max_len} 个字符")
    return text


def clean_choice_list(value, label: str, max_items: int = 8) -> list[str]:
    if value is None:
        return []
    if not isinstance(value, list):
        raise ApiError(400, f"{label}格式不正确")
    result: list[str] = []
    for item in value:
        if not isinstance(item, str):
            continue
        text = item.strip()
        if text and text not in result and len(text) <= 20:
            result.append(text)
    if len(result) > max_items:
        raise ApiError(400, f"{label}最多选择 {max_items} 项")
    return result


def user_payload(row: sqlite3.Row) -> dict:
    def load_list(value: str) -> list[str]:
        try:
            parsed = json.loads(value or "[]")
            return parsed if isinstance(parsed, list) else []
        except (TypeError, ValueError):
            return []

    return {
        "id": row["id"],
        "username": row["username"],
        "display_name": row["display_name"],
        "city": row["city"],
        "bio": row["bio"],
        "interests": load_list(row["interests"]),
        "availability": load_list(row["availability"]),
        "created_at": row["created_at"],
    }


def weekday_label(value: datetime) -> str:
    return WEEKDAY_NAMES[value.weekday()]


def activity_slots(value: datetime) -> set[str]:
    slots = {"周末" if value.weekday() >= 5 else "工作日"}
    hour = value.hour
    if 5 <= hour < 12:
        slots.add("上午")
    elif 12 <= hour < 18:
        slots.add("下午")
    else:
        slots.add("晚上")
    return slots


class VolunteerHandler(BaseHTTPRequestHandler):
    server_version = "WeiGuang/1.0"
    protocol_version = "HTTP/1.1"

    def do_GET(self) -> None:
        self._dispatch("GET")

    def do_POST(self) -> None:
        self._dispatch("POST")

    def do_PUT(self) -> None:
        self._dispatch("PUT")

    def do_PATCH(self) -> None:
        self._dispatch("PATCH")

    def do_DELETE(self) -> None:
        self._dispatch("DELETE")

    def do_HEAD(self) -> None:
        self._dispatch("HEAD")

    def handle_one_request(self) -> None:
        try:
            super().handle_one_request()
        except (ConnectionResetError, ConnectionAbortedError, BrokenPipeError):
            self.close_connection = True

    # ------------------------------------------------------------------ routing

    def _dispatch(self, method: str) -> None:
        self._set_cookie_header: str | None = None
        self._current_user: dict | None = None
        self._current_user_loaded = False
        parsed = urlsplit(self.path)
        path = unquote(parsed.path)
        try:
            if path == "/api" or path.startswith("/api/"):
                conn = db.connect()
                try:
                    self._handle_api(method, path, parse_qs(parsed.query), conn)
                finally:
                    conn.close()
            else:
                if method not in ("GET", "HEAD"):
                    raise ApiError(405, "不支持的请求方法")
                self._serve_static(path, head_only=(method == "HEAD"))
        except ApiError as exc:
            self._send_json({"error": exc.message}, status=exc.status)
        except (BrokenPipeError, ConnectionResetError):
            return
        except Exception:
            traceback.print_exc()
            self._send_json({"error": "服务器开小差了，请稍后再试"}, status=500)

    def _handle_api(self, method: str, path: str, query: dict, conn) -> None:
        parts = [part for part in path.split("/") if part]
        if len(parts) < 2:
            raise ApiError(404, "接口不存在")
        route = parts[1:]

        if method == "GET" and route == ["health"]:
            self._send_json({"ok": True, "name": "微光", "time": db.utc_now_iso()})
            return

        if method == "GET" and route == ["meta"]:
            self._send_json(self._meta(conn))
            return

        if method == "GET" and route == ["auth", "me"]:
            user = self._user(conn)
            self._send_json({"authenticated": bool(user), "user": user})
            return

        if method == "POST" and route == ["auth", "register"]:
            self._register(conn)
            return

        if method == "POST" and route == ["auth", "login"]:
            self._login(conn)
            return

        if method == "POST" and route == ["auth", "logout"]:
            self._logout(conn)
            return

        if method == "GET" and route == ["activities"]:
            self._list_activities(conn, query)
            return

        if method == "POST" and route == ["activities"]:
            self._create_activity(conn)
            return

        if len(route) >= 2 and route[0] == "activities" and route[1].isdigit():
            activity_id = int(route[1])
            if len(route) == 2 and method == "GET":
                self._activity_detail(conn, activity_id)
                return
            if len(route) == 2 and method == "PATCH":
                self._update_activity(conn, activity_id)
                return
            if len(route) == 3 and route[2] == "registrations":
                if method == "POST":
                    self._join_activity(conn, activity_id)
                    return
                if method == "DELETE":
                    self._leave_activity(conn, activity_id)
                    return
            if len(route) == 3 and route[2] == "participants" and method == "GET":
                self._participants(conn, activity_id)
                return

        if method == "GET" and route == ["recommendations"]:
            self._recommendations(conn, query)
            return

        if method == "GET" and route == ["my", "activities"]:
            self._my_activities(conn)
            return

        if method == "PUT" and route == ["profile"]:
            self._update_profile(conn)
            return

        raise ApiError(404, "接口不存在")

    # ------------------------------------------------------------------- helpers

    def _read_json(self) -> dict:
        length_header = self.headers.get("Content-Length", "0")
        try:
            length = int(length_header)
        except ValueError:
            raise ApiError(400, "请求格式不正确")
        if length <= 0:
            return {}
        if length > MAX_BODY_BYTES:
            raise ApiError(413, "提交内容过大")
        raw = self.rfile.read(length)
        try:
            data = json.loads(raw.decode("utf-8"))
        except (UnicodeDecodeError, ValueError):
            raise ApiError(400, "请求内容不是有效的 JSON")
        if not isinstance(data, dict):
            raise ApiError(400, "请求内容必须是 JSON 对象")
        return data

    def _send_json(self, payload: dict, status: int = 200) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        if self._set_cookie_header:
            self.send_header("Set-Cookie", self._set_cookie_header)
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def _cookie(self, value: str, max_age: int) -> None:
        self._set_cookie_header = (
            f"{SESSION_COOKIE}={value}; Path=/; HttpOnly; SameSite=Lax; "
            f"Max-Age={max_age}"
        )

    def _user(self, conn) -> dict | None:
        if self._current_user_loaded:
            return self._current_user
        self._current_user_loaded = True
        raw_cookie = self.headers.get("Cookie", "")
        if not raw_cookie:
            return None
        cookie = SimpleCookie()
        try:
            cookie.load(raw_cookie)
        except Exception:
            return None
        morsel = cookie.get(SESSION_COOKIE)
        if not morsel:
            return None
        token = morsel.value
        row = conn.execute(
            """
            SELECT u.*
            FROM sessions s
            JOIN users u ON u.id = s.user_id
            WHERE s.token = ? AND s.expires_at > ?
            """,
            (token, db.utc_now_iso()),
        ).fetchone()
        if row:
            self._current_user = user_payload(row)
        return self._current_user

    def _require_user(self, conn) -> dict:
        user = self._user(conn)
        if not user:
            raise ApiError(401, "请先登录后再继续")
        return user

    def _make_session(self, conn, user_id: int) -> None:
        token = secrets.token_urlsafe(32)
        now = datetime.now(timezone.utc).replace(microsecond=0)
        expires = now + timedelta(days=SESSION_DAYS)
        conn.execute(
            "INSERT INTO sessions (token, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)",
            (
                token,
                user_id,
                expires.isoformat().replace("+00:00", "Z"),
                now.isoformat().replace("+00:00", "Z"),
            ),
        )
        conn.execute("DELETE FROM sessions WHERE expires_at <= ?", (db.utc_now_iso(),))
        conn.commit()
        self._cookie(token, SESSION_DAYS * 86400)
        self._current_user_loaded = False
        self._current_user = None

    def _get_activity_row(self, conn, activity_id: int):
        row = conn.execute(
            """
            SELECT a.*, u.display_name AS creator_name, u.city AS creator_city,
                   (SELECT COUNT(*) FROM registrations r WHERE r.activity_id = a.id)
                       AS joined_count
            FROM activities a
            JOIN users u ON u.id = a.creator_id
            WHERE a.id = ?
            """,
            (activity_id,),
        ).fetchone()
        if not row:
            raise ApiError(404, "没有找到这个活动")
        return row

    def _activity_payload(self, conn, row, viewer_id: int | None = None) -> dict:
        try:
            tags = json.loads(row["tags"] or "[]")
            if not isinstance(tags, list):
                tags = []
        except (TypeError, ValueError):
            tags = []
        try:
            start = parse_local_datetime(row["start_at"])
            end = parse_local_datetime(row["end_at"])
        except ValueError:
            start = datetime.now()
            end = start + timedelta(hours=1)

        now = datetime.now()
        joined_count = int(row["joined_count"] if "joined_count" in row.keys() else 0)
        capacity = int(row["capacity"])
        is_joined = False
        if viewer_id:
            is_joined = bool(
                conn.execute(
                    "SELECT 1 FROM registrations WHERE activity_id = ? AND user_id = ?",
                    (row["id"], viewer_id),
                ).fetchone()
            )
        is_creator = bool(viewer_id and row["creator_id"] == viewer_id)
        is_past = start < now
        status = row["status"]
        spots_left = max(0, capacity - joined_count)
        contact_visible = bool(is_joined or is_creator)
        can_join = (
            status == "open"
            and not is_past
            and not is_joined
            and not is_creator
            and spots_left > 0
        )
        status_labels = {"open": "报名中", "closed": "已截止", "cancelled": "已取消"}
        duration_minutes = max(0, int((end - start).total_seconds() // 60))
        return {
            "id": row["id"],
            "creator_id": row["creator_id"],
            "creator_name": row["creator_name"],
            "creator_city": row["creator_city"],
            "title": row["title"],
            "description": row["description"],
            "category": row["category"],
            "tags": tags,
            "city": row["city"],
            "location": row["location"],
            "start_at": row["start_at"],
            "end_at": row["end_at"],
            "date_label": f"{start.month}月{start.day}日",
            "day_label": f"{start.day:02d}",
            "month_label": f"{start.month:02d}月",
            "weekday_label": weekday_label(start),
            "time_label": f"{start.strftime('%H:%M')}–{end.strftime('%H:%M')}",
            "year_label": str(start.year),
            "start_display": (
                f"{start.month}月{start.day}日 {weekday_label(start)} · "
                f"{start.strftime('%H:%M')}–{end.strftime('%H:%M')}"
            ),
            "duration_minutes": duration_minutes,
            "duration_label": (
                f"{duration_minutes // 60} 小时"
                if duration_minutes >= 60 and duration_minutes % 60 == 0
                else f"{duration_minutes} 分钟"
            ),
            "capacity": capacity,
            "joined_count": joined_count,
            "spots_left": spots_left,
            "fill_percent": min(100, round(joined_count / capacity * 100)) if capacity else 0,
            "status": status,
            "status_label": status_labels.get(status, status),
            "is_full": spots_left == 0,
            "is_past": is_past,
            "is_joined": is_joined,
            "is_creator": is_creator,
            "can_join": can_join,
            "is_online": row["city"] == "线上" or "线上" in row["location"],
            "contact": row["contact"] if contact_visible else "",
            "contact_visible": contact_visible,
            "created_at": row["created_at"],
        }

    def _participant_preview(self, conn, activity_id: int, limit: int = 5) -> list[dict]:
        rows = conn.execute(
            """
            SELECT u.id, u.display_name, u.username
            FROM registrations r
            JOIN users u ON u.id = r.user_id
            WHERE r.activity_id = ?
            ORDER BY r.created_at ASC
            LIMIT ?
            """,
            (activity_id, limit),
        ).fetchall()
        return [dict(row) for row in rows]

    # ---------------------------------------------------------------------- meta

    def _meta(self, conn) -> dict:
        now = datetime.now().strftime("%Y-%m-%dT%H:%M")
        open_activities = conn.execute(
            "SELECT COUNT(*) FROM activities WHERE status = 'open' AND start_at > ?",
            (now,),
        ).fetchone()[0]
        volunteers = conn.execute("SELECT COUNT(*) FROM users").fetchone()[0]
        participations = conn.execute("SELECT COUNT(*) FROM registrations").fetchone()[0]
        cities = [
            row[0]
            for row in conn.execute(
                """
                SELECT city FROM (
                    SELECT city FROM activities WHERE city != ''
                    UNION
                    SELECT city FROM users WHERE city != ''
                )
                WHERE city != '线上'
                ORDER BY city
                """
            ).fetchall()
        ]
        if conn.execute("SELECT 1 FROM activities WHERE city = '线上' LIMIT 1").fetchone():
            cities.append("线上")
        return {
            "app_name": "微光",
            "categories": db.CATEGORIES,
            "interests": db.INTEREST_OPTIONS,
            "availability": db.AVAILABILITY_OPTIONS,
            "cities": cities,
            "stats": {
                "open_activities": open_activities,
                "volunteers": volunteers,
                "participations": participations,
                "cities": max(0, len(cities) - (1 if "线上" in cities else 0)),
            },
        }

    # ---------------------------------------------------------------------- auth

    def _register(self, conn) -> None:
        data = self._read_json()
        username = clean_text(data.get("username"), "账号", 3, 20)
        if not USERNAME_RE.match(username):
            raise ApiError(400, "账号需为 3–20 位字母、数字或下划线")
        password = data.get("password")
        if not isinstance(password, str) or not (6 <= len(password) <= 72):
            raise ApiError(400, "密码长度需为 6–72 位")
        display_name = clean_text(data.get("display_name"), "昵称", 2, 20)
        city = clean_text(data.get("city"), "城市", 1, 20) if data.get("city") else ""
        salt, digest = db.hash_password(password)
        try:
            cur = conn.execute(
                """
                INSERT INTO users
                    (username, display_name, password_hash, salt, city, bio,
                     interests, availability, created_at)
                VALUES (?, ?, ?, ?, ?, '', '[]', '[]', ?)
                """,
                (username, display_name, digest, salt, city, db.utc_now_iso()),
            )
        except sqlite3.IntegrityError:
            raise ApiError(409, "这个账号已经被注册了，换一个试试")
        conn.commit()
        self._make_session(conn, int(cur.lastrowid))
        row = conn.execute("SELECT * FROM users WHERE id = ?", (cur.lastrowid,)).fetchone()
        self._send_json({"user": user_payload(row)}, status=201)

    def _login(self, conn) -> None:
        data = self._read_json()
        username = data.get("username")
        password = data.get("password")
        if not isinstance(username, str) or not isinstance(password, str):
            raise ApiError(400, "请输入账号和密码")
        row = conn.execute(
            "SELECT * FROM users WHERE username = ? COLLATE NOCASE",
            (username.strip(),),
        ).fetchone()
        if not row or not db.verify_password(
            password, row["salt"], row["password_hash"]
        ):
            raise ApiError(401, "账号或密码不正确")
        self._make_session(conn, row["id"])
        self._send_json({"user": user_payload(row)})

    def _logout(self, conn) -> None:
        raw_cookie = self.headers.get("Cookie", "")
        cookie = SimpleCookie()
        try:
            cookie.load(raw_cookie)
            morsel = cookie.get(SESSION_COOKIE)
            if morsel:
                conn.execute("DELETE FROM sessions WHERE token = ?", (morsel.value,))
                conn.commit()
        except Exception:
            pass
        self._cookie("", 0)
        self._current_user = None
        self._current_user_loaded = False
        self._send_json({"ok": True})

    def _update_profile(self, conn) -> None:
        user = self._require_user(conn)
        data = self._read_json()
        display_name = clean_text(
            data.get("display_name", user["display_name"]), "昵称", 2, 20
        )
        city = data.get("city", user["city"])
        if not isinstance(city, str) or len(city.strip()) > 20:
            raise ApiError(400, "城市名称格式不正确")
        bio = data.get("bio", user["bio"])
        if not isinstance(bio, str) or len(bio.strip()) > 160:
            raise ApiError(400, "个人介绍不能超过 160 个字符")
        interests = clean_choice_list(
            data.get("interests", user["interests"]), "兴趣标签", 8
        )
        availability = clean_choice_list(
            data.get("availability", user["availability"]), "空闲时间", 5
        )
        conn.execute(
            """
            UPDATE users
            SET display_name = ?, city = ?, bio = ?, interests = ?, availability = ?
            WHERE id = ?
            """,
            (
                display_name,
                city.strip(),
                bio.strip(),
                json.dumps(interests, ensure_ascii=False),
                json.dumps(availability, ensure_ascii=False),
                user["id"],
            ),
        )
        conn.commit()
        row = conn.execute("SELECT * FROM users WHERE id = ?", (user["id"],)).fetchone()
        self._current_user = user_payload(row)
        self._current_user_loaded = True
        self._send_json({"user": self._current_user})

    # ---------------------------------------------------------------- activities

    def _list_activities(self, conn, query: dict) -> None:
        viewer = self._user(conn)
        now = datetime.now()
        q = (query.get("q", [""])[0] or "").strip()
        category = (query.get("category", [""])[0] or "").strip()
        city = (query.get("city", [""])[0] or "").strip()
        when = (query.get("when", [""])[0] or "").strip()
        include_past = query.get("include_past", ["0"])[0] == "1"
        try:
            limit = max(1, min(100, int(query.get("limit", ["60"])[0])))
        except ValueError:
            limit = 60

        rows = conn.execute(
            """
            SELECT a.*, u.display_name AS creator_name, u.city AS creator_city,
                   (SELECT COUNT(*) FROM registrations r WHERE r.activity_id = a.id)
                       AS joined_count
            FROM activities a
            JOIN users u ON u.id = a.creator_id
            WHERE a.status != 'cancelled'
            ORDER BY a.start_at ASC
            """
        ).fetchall()

        activities = []
        q_lower = q.casefold()
        for row in rows:
            item = self._activity_payload(conn, row, viewer["id"] if viewer else None)
            if not include_past and item["is_past"]:
                continue
            if not include_past and item["status"] != "open":
                continue
            if category and item["category"] != category:
                continue
            if city and item["city"] != city:
                continue
            if when == "week":
                try:
                    start = parse_local_datetime(item["start_at"])
                except ValueError:
                    continue
                if not (now <= start <= now + timedelta(days=7)):
                    continue
            elif when == "weekend":
                try:
                    start = parse_local_datetime(item["start_at"])
                except ValueError:
                    continue
                if start.weekday() < 5 or start > now + timedelta(days=21):
                    continue
            elif when == "online" and not item["is_online"]:
                continue
            if q_lower:
                haystack = " ".join(
                    [
                        item["title"],
                        item["description"],
                        item["location"],
                        item["category"],
                        item["creator_name"],
                        " ".join(item["tags"]),
                    ]
                ).casefold()
                if q_lower not in haystack:
                    continue
            activities.append(item)
            if len(activities) >= limit:
                break

        self._send_json({"activities": activities, "count": len(activities)})

    def _create_activity(self, conn) -> None:
        user = self._require_user(conn)
        data = self._read_json()
        title = clean_text(data.get("title"), "活动名称", 4, 50)
        description = clean_text(data.get("description"), "活动介绍", 20, 2000)
        category = data.get("category")
        if category not in db.CATEGORY_NAMES:
            raise ApiError(400, "请选择一个活动类别")
        city = clean_text(data.get("city"), "城市", 1, 20)
        location = clean_text(data.get("location"), "活动地点", 2, 80)
        contact = data.get("contact", "")
        if not isinstance(contact, str) or len(contact.strip()) > 80:
            raise ApiError(400, "联系方式格式不正确")
        tags = clean_choice_list(data.get("tags", []), "活动标签", 6)
        try:
            capacity = int(data.get("capacity"))
        except (TypeError, ValueError):
            raise ApiError(400, "招募人数必须是数字")
        if not (1 <= capacity <= 500):
            raise ApiError(400, "招募人数需在 1–500 人之间")
        try:
            start = parse_local_datetime(data.get("start_at"))
            end = parse_local_datetime(data.get("end_at"))
        except (TypeError, ValueError):
            raise ApiError(400, "请选择有效的开始和结束时间")
        if start <= datetime.now():
            raise ApiError(400, "开始时间需要晚于现在")
        if end <= start:
            raise ApiError(400, "结束时间需要晚于开始时间")
        if end - start > timedelta(hours=24):
            raise ApiError(400, "单次活动时长不能超过 24 小时")

        cur = conn.execute(
            """
            INSERT INTO activities
                (creator_id, title, description, category, tags, city, location,
                 start_at, end_at, capacity, contact, status, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?)
            """,
            (
                user["id"],
                title,
                description,
                category,
                json.dumps(tags, ensure_ascii=False),
                city,
                location,
                start.strftime("%Y-%m-%dT%H:%M"),
                end.strftime("%Y-%m-%dT%H:%M"),
                capacity,
                contact.strip(),
                db.utc_now_iso(),
            ),
        )
        conn.commit()
        row = self._get_activity_row(conn, int(cur.lastrowid))
        self._send_json(
            {"activity": self._activity_payload(conn, row, user["id"])}, status=201
        )

    def _activity_detail(self, conn, activity_id: int) -> None:
        viewer = self._user(conn)
        row = self._get_activity_row(conn, activity_id)
        item = self._activity_payload(conn, row, viewer["id"] if viewer else None)
        item["participants_preview"] = self._participant_preview(conn, activity_id)
        self._send_json({"activity": item})

    def _update_activity(self, conn, activity_id: int) -> None:
        user = self._require_user(conn)
        row = self._get_activity_row(conn, activity_id)
        if row["creator_id"] != user["id"]:
            raise ApiError(403, "只有活动发起人可以管理这个活动")
        data = self._read_json()
        status = data.get("status")
        if status not in ("open", "closed", "cancelled"):
            raise ApiError(400, "活动状态不正确")
        if status == "open":
            try:
                start = parse_local_datetime(row["start_at"])
            except ValueError:
                start = datetime.now()
            if start <= datetime.now():
                raise ApiError(400, "活动已经开始了，无法重新开放报名")
        conn.execute(
            "UPDATE activities SET status = ? WHERE id = ?", (status, activity_id)
        )
        conn.commit()
        fresh = self._get_activity_row(conn, activity_id)
        self._send_json({"activity": self._activity_payload(conn, fresh, user["id"])})

    def _join_activity(self, conn, activity_id: int) -> None:
        user = self._require_user(conn)
        row = self._get_activity_row(conn, activity_id)
        if row["creator_id"] == user["id"]:
            raise ApiError(400, "这是你发起的活动，不需要再报名")
        if row["status"] != "open":
            raise ApiError(400, "这个活动已经停止报名")
        try:
            start = parse_local_datetime(row["start_at"])
        except ValueError:
            start = datetime.now()
        if start <= datetime.now():
            raise ApiError(400, "活动已经开始，无法报名")
        joined = conn.execute(
            "SELECT 1 FROM registrations WHERE activity_id = ? AND user_id = ?",
            (activity_id, user["id"]),
        ).fetchone()
        if joined:
            raise ApiError(409, "你已经报名过这个活动")
        count = conn.execute(
            "SELECT COUNT(*) FROM registrations WHERE activity_id = ?",
            (activity_id,),
        ).fetchone()[0]
        if count >= row["capacity"]:
            raise ApiError(409, "活动名额已满")
        data = self._read_json()
        message = data.get("message", "")
        if not isinstance(message, str) or len(message.strip()) > 200:
            raise ApiError(400, "留言不能超过 200 个字符")
        conn.execute(
            """
            INSERT INTO registrations (activity_id, user_id, message, created_at)
            VALUES (?, ?, ?, ?)
            """,
            (activity_id, user["id"], message.strip(), db.utc_now_iso()),
        )
        try:
            conn.commit()
        except sqlite3.IntegrityError as exc:
            conn.rollback()
            if "full" in str(exc).lower():
                raise ApiError(409, "活动名额已满")
            raise ApiError(409, "你已经报名过这个活动")
        fresh = self._get_activity_row(conn, activity_id)
        payload = self._activity_payload(conn, fresh, user["id"])
        payload["participants_preview"] = self._participant_preview(conn, activity_id)
        self._send_json({"activity": payload})

    def _leave_activity(self, conn, activity_id: int) -> None:
        user = self._require_user(conn)
        row = self._get_activity_row(conn, activity_id)
        try:
            start = parse_local_datetime(row["start_at"])
        except ValueError:
            start = datetime.now()
        if start <= datetime.now():
            raise ApiError(400, "活动已经开始，无法取消报名")
        cur = conn.execute(
            "DELETE FROM registrations WHERE activity_id = ? AND user_id = ?",
            (activity_id, user["id"]),
        )
        conn.commit()
        if cur.rowcount == 0:
            raise ApiError(404, "你还没有报名这个活动")
        fresh = self._get_activity_row(conn, activity_id)
        payload = self._activity_payload(conn, fresh, user["id"])
        payload["participants_preview"] = self._participant_preview(conn, activity_id)
        self._send_json({"activity": payload})

    def _participants(self, conn, activity_id: int) -> None:
        user = self._require_user(conn)
        row = self._get_activity_row(conn, activity_id)
        if row["creator_id"] != user["id"]:
            raise ApiError(403, "只有活动发起人可以看到报名名单")
        rows = conn.execute(
            """
            SELECT u.id, u.display_name, u.username, u.city,
                   r.message, r.created_at
            FROM registrations r
            JOIN users u ON u.id = r.user_id
            WHERE r.activity_id = ?
            ORDER BY r.created_at ASC
            """,
            (activity_id,),
        ).fetchall()
        self._send_json(
            {
                "participants": [dict(item) for item in rows],
                "count": len(rows),
            }
        )

    # -------------------------------------------------------------- personalized

    def _recommendations(self, conn, query: dict) -> None:
        viewer = self._user(conn)
        try:
            limit = max(1, min(12, int(query.get("limit", ["6"])[0])))
        except ValueError:
            limit = 6
        now = datetime.now()
        rows = conn.execute(
            """
            SELECT a.*, u.display_name AS creator_name, u.city AS creator_city,
                   (SELECT COUNT(*) FROM registrations r WHERE r.activity_id = a.id)
                       AS joined_count
            FROM activities a
            JOIN users u ON u.id = a.creator_id
            WHERE a.status = 'open' AND a.start_at > ?
            ORDER BY a.start_at ASC
            """,
            (now.strftime("%Y-%m-%dT%H:%M"),),
        ).fetchall()

        if not viewer:
            candidates = []
            for row in rows:
                item = self._activity_payload(conn, row)
                item["match"] = None
                candidates.append(item)
            candidates.sort(
                key=lambda item: (
                    -item["joined_count"],
                    item["start_at"],
                )
            )
            self._send_json(
                {
                    "recommendations": candidates[:limit],
                    "personalized": False,
                    "reason": "登录并完善偏好后，可以获得专属推荐",
                }
            )
            return

        joined_ids = {
            row[0]
            for row in conn.execute(
                "SELECT activity_id FROM registrations WHERE user_id = ?",
                (viewer["id"],),
            ).fetchall()
        }
        history_categories = {
            row[0]
            for row in conn.execute(
                """
                SELECT DISTINCT a.category
                FROM registrations r JOIN activities a ON a.id = r.activity_id
                WHERE r.user_id = ?
                """,
                (viewer["id"],),
            ).fetchall()
        }
        interests = set(viewer["interests"])
        availability = set(viewer["availability"])
        has_preferences = bool(interests or viewer["city"] or availability)

        scored = []
        for row in rows:
            if row["creator_id"] == viewer["id"] or row["id"] in joined_ids:
                continue
            item = self._activity_payload(conn, row, viewer["id"])
            score = 58
            reasons: list[str] = []
            if item["category"] in interests:
                score += 20
                reasons.append(f"符合你对「{item['category']}」的兴趣")
            tag_matches = [tag for tag in item["tags"] if tag in interests]
            if tag_matches and item["category"] not in interests:
                score += min(12, 6 * len(tag_matches))
                reasons.append("标签合你心意：" + "、".join(tag_matches[:2]))
            if viewer["city"] and item["city"] == viewer["city"]:
                score += 13
                reasons.append(f"就在你常驻的{item['city']}")
            elif item["is_online"]:
                score += 9
                reasons.append("线上参与，不受城市限制")
            elif viewer["city"]:
                score -= 5
            slots = activity_slots(parse_local_datetime(item["start_at"]))
            overlap = slots & availability
            if overlap:
                score += 8
                reasons.append("时间适合你的「" + "、".join(sorted(overlap)) + "」")
            if item["category"] in history_categories:
                score += 4
                reasons.append("延续你参与过的公益方向")
            if item["spots_left"] >= 5:
                score += 3
            if item["joined_count"] >= 3:
                score += 2
            if not reasons:
                reasons.append("新鲜上架，等待第一位同行者")
                score += 4
            score = max(60, min(99, score))
            item["match"] = {
                "score": score,
                "reasons": reasons[:3],
                "personalized": has_preferences,
            }
            scored.append(item)

        scored.sort(key=lambda item: (-item["match"]["score"], item["start_at"]))
        self._send_json(
            {
                "recommendations": scored[:limit],
                "personalized": has_preferences,
                "reason": (
                    "根据你的兴趣、城市和时间偏好排序"
                    if has_preferences
                    else "完善兴趣和时间偏好，推荐会更准确"
                ),
            }
        )

    def _my_activities(self, conn) -> None:
        user = self._require_user(conn)
        rows = conn.execute(
            """
            SELECT a.*, u.display_name AS creator_name, u.city AS creator_city,
                   (SELECT COUNT(*) FROM registrations r WHERE r.activity_id = a.id)
                       AS joined_count
            FROM activities a
            JOIN users u ON u.id = a.creator_id
            WHERE a.creator_id = ?
            ORDER BY a.start_at DESC
            """,
            (user["id"],),
        ).fetchall()
        created = [self._activity_payload(conn, row, user["id"]) for row in rows]

        rows = conn.execute(
            """
            SELECT a.*, u.display_name AS creator_name, u.city AS creator_city,
                   (SELECT COUNT(*) FROM registrations r WHERE r.activity_id = a.id)
                       AS joined_count,
                   reg.created_at AS registered_at
            FROM registrations reg
            JOIN activities a ON a.id = reg.activity_id
            JOIN users u ON u.id = a.creator_id
            WHERE reg.user_id = ?
            ORDER BY a.start_at DESC
            """,
            (user["id"],),
        ).fetchall()
        joined = []
        for row in rows:
            item = self._activity_payload(conn, row, user["id"])
            item["registered_at"] = row["registered_at"]
            joined.append(item)

        total_minutes = sum(
            item["duration_minutes"]
            for item in joined
            if item["status"] != "cancelled" and item["is_past"]
        )
        upcoming_joined = sum(1 for item in joined if not item["is_past"] and item["status"] == "open")
        created_open = sum(1 for item in created if item["status"] == "open" and not item["is_past"])
        self._send_json(
            {
                "created": created,
                "joined": joined,
                "stats": {
                    "joined_total": len(joined),
                    "upcoming_joined": upcoming_joined,
                    "created_total": len(created),
                    "created_open": created_open,
                    "hours": round(total_minutes / 60, 1),
                },
            }
        )

    # -------------------------------------------------------------------- static

    def _serve_static(self, path: str, head_only: bool = False) -> None:
        root = STATIC_DIR.resolve()
        relative = path.lstrip("/")
        if relative in ("", "index.html"):
            relative = "index.html"
        candidate = (root / relative).resolve()
        if candidate != root and root not in candidate.parents:
            raise ApiError(403, "禁止访问")
        if not candidate.is_file():
            if "." in Path(relative).name:
                raise ApiError(404, "文件不存在")
            candidate = root / "index.html"
        if not candidate.is_file():
            raise ApiError(404, "页面不存在")
        content = candidate.read_bytes()
        content_type = mimetypes.guess_type(str(candidate))[0] or "application/octet-stream"
        if candidate.suffix in (".html", ".css", ".js", ".svg"):
            content_type += "; charset=utf-8"
        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(content)))
        self.send_header("Cache-Control", "no-cache")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header(
            "Content-Security-Policy",
            "default-src 'self'; img-src 'self' data:; "
            "style-src 'self' 'unsafe-inline'; script-src 'self'; "
            "connect-src 'self'; font-src 'self'; base-uri 'none'; "
            "form-action 'self'; frame-ancestors 'none'",
        )
        self.end_headers()
        if not head_only:
            self.wfile.write(content)

    def log_message(self, format: str, *args) -> None:
        if os.environ.get("VOLUNTEER_LOG") == "1":
            super().log_message(format, *args)


def main() -> None:
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
        sys.stderr.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass
    parser = argparse.ArgumentParser(description="微光 · 本地志愿活动平台")
    parser.add_argument("--host", default=os.environ.get("VOLUNTEER_HOST", "127.0.0.1"))
    parser.add_argument(
        "--port", type=int, default=int(os.environ.get("VOLUNTEER_PORT", "8000"))
    )
    parser.add_argument(
        "--no-seed", action="store_true", help="不写入演示账号和活动"
    )
    parser.add_argument("--open", action="store_true", help="启动后自动打开浏览器")
    args = parser.parse_args()

    if args.no_seed:
        os.environ["VOLUNTEER_SEED"] = "0"
    db.init_db(seed=not args.no_seed)
    server = ThreadingHTTPServer((args.host, args.port), VolunteerHandler)
    server.daemon_threads = True
    host, port = server.server_address[:2]
    display_host = "localhost" if host in ("127.0.0.1", "0.0.0.0") else host
    print("", flush=True)
    print("  ✦ 微光 · 本地志愿活动平台已启动", flush=True)
    print(f"  → http://{display_host}:{port}", flush=True)
    print("  → 演示账号：demo / demo1234", flush=True)
    print("  → 按 Ctrl+C 停止服务", flush=True)
    print("", flush=True)
    if args.open:
        threading.Timer(
            0.9, lambda: webbrowser.open(f"http://{display_host}:{port}")
        ).start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n  服务已停止，下次见。", flush=True)
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
