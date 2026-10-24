"""End-to-end smoke tests for the 微光 local volunteer app.

Run with:
    <python> tests/smoke_test.py
"""

from __future__ import annotations

import json
import os
import socket
import subprocess
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime, timedelta
from http.cookiejar import CookieJar
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parents[1]
PASSED = 0


class ApiFailure(Exception):
    def __init__(self, status: int, message: str):
        super().__init__(message)
        self.status = status
        self.message = message


class Client:
    def __init__(self, base_url: str):
        self.base_url = base_url
        self.jar = CookieJar()
        self.opener = urllib.request.build_opener(
            urllib.request.ProxyHandler({}),
            urllib.request.HTTPCookieProcessor(self.jar),
        )

    def request(self, method: str, path: str, body=None):
        data = None
        headers = {"Accept": "application/json"}
        if body is not None:
            data = json.dumps(body, ensure_ascii=False).encode("utf-8")
            headers["Content-Type"] = "application/json"
        request = urllib.request.Request(
            self.base_url + path, data=data, headers=headers, method=method
        )
        try:
            with self.opener.open(request, timeout=8) as response:
                raw = response.read().decode("utf-8")
                return response.status, json.loads(raw) if raw else {}
        except urllib.error.HTTPError as error:
            raw = error.read().decode("utf-8")
            try:
                payload = json.loads(raw)
            except ValueError:
                payload = {"error": raw}
            raise ApiFailure(error.code, payload.get("error", "request failed"))

    def get(self, path):
        return self.request("GET", path)

    def post(self, path, body=None):
        return self.request("POST", path, body)

    def put(self, path, body=None):
        return self.request("PUT", path, body)

    def patch(self, path, body=None):
        return self.request("PATCH", path, body)

    def delete(self, path):
        return self.request("DELETE", path)


def check(condition: bool, label: str) -> None:
    global PASSED
    if not condition:
        raise AssertionError(f"FAILED: {label}")
    PASSED += 1
    print(f"  ok  {label}")


def expect_status(fn, status: int, label: str) -> None:
    try:
        fn()
    except ApiFailure as error:
        check(error.status == status, f"{label} (HTTP {error.status})")
        return
    raise AssertionError(f"FAILED: {label} expected HTTP {status}")


def wait_for_server(base_url: str, timeout: float = 12.0) -> None:
    # Loopback requests must never go through a system/corporate proxy.
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            with opener.open(base_url + "/api/health", timeout=0.5) as response:
                if response.status == 200:
                    return
        except Exception:
            time.sleep(0.15)
    raise RuntimeError("server did not start in time")


def free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind(("127.0.0.1", 0))
        return int(sock.getsockname()[1])


def main() -> None:
    data_root = BASE_DIR / "data"
    data_root.mkdir(exist_ok=True)
    db_file = data_root / f"smoke-test-{os.getpid()}.db"
    for suffix in ("", "-wal", "-shm"):
        path = Path(str(db_file) + suffix)
        if path.exists():
            path.unlink()
    port = free_port()
    env = os.environ.copy()
    env.update(
        {
            "VOLUNTEER_DB_PATH": str(db_file),
            "VOLUNTEER_PORT": str(port),
            "VOLUNTEER_LOG": "0",
            "PYTHONUTF8": "1",
        }
    )
    process = subprocess.Popen(
        [sys.executable, str(BASE_DIR / "app.py")],
        cwd=str(BASE_DIR),
        env=env,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        encoding="utf-8",
        errors="replace",
    )
    base_url = f"http://127.0.0.1:{port}"
    try:
        try:
            wait_for_server(base_url)
        except Exception:
            process.terminate()
            early_output, _ = process.communicate(timeout=5)
            print("server did not become ready; output:\n" + (early_output or ""))
            raise
        print("\n[1] 基础页面与公开接口")
        public = Client(base_url)
        status, health = public.get("/api/health")
        check(status == 200 and health.get("ok") is True, "健康检查可用")
        status, meta = public.get("/api/meta")
        check(status == 200 and len(meta["categories"]) == 6, "读取 6 个活动类别")
        check(meta["stats"]["volunteers"] >= 12, "种子账号数量充足")
        status, listing = public.get("/api/activities?limit=20")
        check(status == 200 and listing["count"] >= 10, "公开活动列表可用")
        check(all(item["contact"] == "" for item in listing["activities"]), "公开列表不泄露联系方式")
        check(all(item["contact_visible"] is False for item in listing["activities"]), "公开列表联系方式可见性为 false")

        featured = listing["activities"][0]
        status, public_detail = public.get(f"/api/activities/{featured['id']}")
        check(status == 200 and public_detail["activity"]["contact"] == "", "未登录详情隐藏联系方式")

        index_request = urllib.request.Request(base_url + "/")
        with public.opener.open(index_request, timeout=5) as response:
            html = response.read().decode("utf-8")
        check(response.status == 200 and "微光" in html and "/app.js" in html, "首页静态资源可访问")

        print("\n[2] 登录与个性化推荐")
        demo = Client(base_url)
        status, login = demo.post("/api/auth/login", {"username": "demo", "password": "demo1234"})
        check(status == 200 and login["user"]["username"] == "demo", "演示账号登录成功")
        status, me = demo.get("/api/auth/me")
        check(me["authenticated"] is True and me["user"]["display_name"] == "志愿小暖", "会话 cookie 生效")
        status, recs = demo.get("/api/recommendations?limit=8")
        check(recs["personalized"] is True and len(recs["recommendations"]) >= 3, "返回个性化推荐")
        check(all("score" in item["match"] and item["match"]["reasons"] for item in recs["recommendations"]), "每条推荐含匹配分与理由")
        check(
            all("contact" not in item or item["contact"] == "" for item in recs["recommendations"]),
            "推荐列表不泄露联系方式",
        )
        status, mine = demo.get("/api/my/activities")
        joined_ids = {item["id"] for item in mine["joined"]}
        check(joined_ids, "演示账号已有报名记录")
        check(all(item["id"] not in joined_ids for item in recs["recommendations"]), "推荐排除已报名活动")
        check(all(item["creator_id"] != me["user"]["id"] for item in recs["recommendations"]), "推荐排除自己发起的活动")

        status, own = demo.get("/api/my/activities")
        own_activity = own["created"][0]
        expect_status(
            lambda: demo.post(f"/api/activities/{own_activity['id']}/registrations", {}),
            400,
            "发起人不能报名自己的活动",
        )
        expect_status(
            lambda: demo.get(f"/api/activities/{featured['id']}/participants"),
            403,
            "非发起人不能查看报名名单",
        )

        print("\n[3] 注册、偏好与推荐联动")
        alice = Client(base_url)
        bob = Client(base_url)
        charlie = Client(base_url)
        suffix = str(int(time.time()))[-5:]
        status, alice_user = alice.post(
            "/api/auth/register",
            {
                "username": f"alice{suffix}",
                "password": "alice123",
                "display_name": "艾丽丝",
                "city": "杭州",
            },
        )
        check(status == 201 and alice_user["user"]["city"] == "杭州", "账号 A 注册成功")
        status, bob_user = bob.post(
            "/api/auth/register",
            {
                "username": f"bob{suffix}",
                "password": "bobbob123",
                "display_name": "鲍勃",
                "city": "杭州",
            },
        )
        check(status == 201 and bob_user["user"]["username"].startswith("bob"), "账号 B 注册成功")
        status, charlie_user = charlie.post(
            "/api/auth/register",
            {
                "username": f"charlie{suffix}",
                "password": "charlie123",
                "display_name": "查理",
                "city": "上海",
            },
        )
        check(status == 201, "账号 C 注册成功")
        expect_status(
            lambda: public.post(
                "/api/auth/register",
                {"username": f"alice{suffix}", "password": "another123", "display_name": "重复"},
            ),
            409,
            "重复账号被拒绝",
        )
        expect_status(
            lambda: public.post("/api/auth/login", {"username": f"alice{suffix}", "password": "wrongpass"}),
            401,
            "错误密码被拒绝",
        )

        status, profile = alice.put(
            "/api/profile",
            {
                "display_name": "艾丽丝",
                "city": "杭州",
                "bio": "喜欢动物和户外。",
                "interests": ["动物保护", "环保公益"],
                "availability": ["周末", "上午"],
            },
        )
        check(status == 200 and profile["user"]["interests"] == ["动物保护", "环保公益"], "偏好保存成功")
        status, alice_recs = alice.get("/api/recommendations?limit=6")
        check(alice_recs["personalized"] is True, "保存偏好后推荐开启个性化")
        check(all(item["match"]["score"] >= 60 for item in alice_recs["recommendations"]), "匹配分在有效区间")

        print("\n[4] 发布活动与报名流程")
        start = (datetime.now() + timedelta(days=3)).replace(hour=10, minute=0, second=0, microsecond=0)
        end = start + timedelta(hours=2)
        payload = {
            "title": "周末流浪动物领养日",
            "description": "协助布置领养现场、介绍待领养动物，并整理捐赠物资。我们会提供培训和饮用水，欢迎喜欢动物的朋友加入。",
            "category": "动物保护",
            "tags": ["动物", "周末"],
            "city": "杭州",
            "location": "西湖区 · 转塘动物之家",
            "start_at": start.strftime("%Y-%m-%dT%H:%M"),
            "end_at": end.strftime("%Y-%m-%dT%H:%M"),
            "capacity": 2,
            "contact": "wx-alice-animal",
        }
        status, created = alice.post("/api/activities", payload)
        activity = created["activity"]
        check(status == 201 and activity["contact"] == "wx-alice-animal", "账号 A 发布活动成功")
        check(activity["is_creator"] is True and activity["joined_count"] == 0, "发起人信息与初始报名数正确")

        status, anonymous_detail = public.get(f"/api/activities/{activity['id']}")
        check(anonymous_detail["activity"]["contact"] == "", "未报名者看不到联系方式")
        status, bob_detail = bob.get(f"/api/activities/{activity['id']}")
        check(bob_detail["activity"]["contact_visible"] is False, "登录但未报名仍看不到联系方式")

        status, joined = bob.post(
            f"/api/activities/{activity['id']}/registrations",
            {"message": "我可以提前到场布置，也会带一些猫粮。"},
        )
        check(status == 200 and joined["activity"]["is_joined"] is True, "账号 B 报名成功")
        check(joined["activity"]["contact"] == "wx-alice-animal", "报名后可见联系方式")
        check(joined["activity"]["spots_left"] == 1, "报名后剩余名额正确")
        expect_status(
            lambda: bob.post(f"/api/activities/{activity['id']}/registrations", {}),
            409,
            "重复报名被拒绝",
        )

        status, roster = alice.get(f"/api/activities/{activity['id']}/participants")
        check(roster["count"] == 1 and roster["participants"][0]["display_name"] == "鲍勃", "发起人可查看报名名单")
        check("猫粮" in roster["participants"][0]["message"], "报名留言传递给发起人")
        expect_status(
            lambda: bob.get(f"/api/activities/{activity['id']}/participants"),
            403,
            "报名者不能查看完整名单",
        )
        status, bob_mine = bob.get("/api/my/activities")
        check(any(item["id"] == activity["id"] for item in bob_mine["joined"]), "报名记录出现在账号 B 的我的活动")

        print("\n[5] 发起人管理与名额控制")
        status, closed = alice.patch(f"/api/activities/{activity['id']}", {"status": "closed"})
        check(closed["activity"]["status"] == "closed", "发起人可停止报名")
        expect_status(
            lambda: charlie.post(f"/api/activities/{activity['id']}/registrations", {}),
            400,
            "停止报名后无法加入",
        )
        status, listing_closed = public.get("/api/activities?limit=60")
        check(all(item["id"] != activity["id"] for item in listing_closed["activities"]), "已截止活动从广场隐藏")
        status, reopened = alice.patch(f"/api/activities/{activity['id']}", {"status": "open"})
        check(reopened["activity"]["status"] == "open", "发起人可重新开放报名")
        status, charlie_join = charlie.post(f"/api/activities/{activity['id']}/registrations", {})
        check(charlie_join["activity"]["is_full"] is True and charlie_join["activity"]["spots_left"] == 0, "满员状态计算正确")
        expect_status(
            lambda: demo.post(f"/api/activities/{activity['id']}/registrations", {}),
            409,
            "满员后其他人无法报名",
        )
        expect_status(
            lambda: bob.patch(f"/api/activities/{activity['id']}", {"status": "closed"}),
            403,
            "非发起人不能管理活动",
        )

        status, cancelled = alice.patch(f"/api/activities/{activity['id']}", {"status": "cancelled"})
        check(cancelled["activity"]["status"] == "cancelled", "发起人可取消活动")
        status, anonymous_cancelled = public.get(f"/api/activities/{activity['id']}")
        check(anonymous_cancelled["activity"]["status"] == "cancelled", "取消状态对访客可见")

        print("\n[6] 取消报名、参数校验与退出")
        second_start = start + timedelta(days=2)
        second_end = second_start + timedelta(hours=2)
        second_payload = dict(payload, title="社区花园共建日", description="一起整理社区花园的篱笆和花圃，学习堆肥知识，并为秋天种下新的花苗。", capacity=5)
        second_payload["start_at"] = second_start.strftime("%Y-%m-%dT%H:%M")
        second_payload["end_at"] = second_end.strftime("%Y-%m-%dT%H:%M")
        status, second = alice.post("/api/activities", second_payload)
        second_id = second["activity"]["id"]
        bob.post(f"/api/activities/{second_id}/registrations", {"message": "会带园艺手套。"})
        status, left = bob.delete(f"/api/activities/{second_id}/registrations")
        check(left["activity"]["is_joined"] is False and left["activity"]["spots_left"] == 5, "取消报名后名额恢复")
        expect_status(
            lambda: bob.delete(f"/api/activities/{second_id}/registrations"),
            404,
            "重复取消报名返回 404",
        )
        expect_status(
            lambda: alice.post("/api/activities", {"title": "太短", "description": "不够长"}),
            400,
            "无效活动参数被拒绝",
        )
        expect_status(
            lambda: alice.post(
                "/api/activities",
                dict(payload, title="过去的活动", start_at="2020-01-01T10:00", end_at="2020-01-01T12:00"),
            ),
            400,
            "过去时间被拒绝",
        )
        status, _ = bob.post("/api/auth/logout")
        status, logged_out = bob.get("/api/auth/me")
        check(logged_out["authenticated"] is False, "退出登录后会话失效")
        expect_status(lambda: public.get("/api/does-not-exist"), 404, "未知接口返回 404")
        expect_status(lambda: public.get("/missing-file.css"), 404, "缺失静态文件返回 404")

        print(f"\n全部通过：{PASSED} 项检查")
    finally:
        process.terminate()
        try:
            output, _ = process.communicate(timeout=5)
        except subprocess.TimeoutExpired:
            process.kill()
            output, _ = process.communicate()
        if process.returncode not in (0, 1, -15):
            print("\nserver output:\n" + (output or ""))
        for suffix in ("", "-wal", "-shm"):
            path = Path(str(db_file) + suffix)
            if path.exists():
                path.unlink()


if __name__ == "__main__":
    main()
