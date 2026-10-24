"""SQLite data layer for the 微光 volunteer platform."""

from __future__ import annotations

import hashlib
import hmac
import json
import os
import secrets
import sqlite3
from datetime import datetime, timedelta, timezone
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent
DEFAULT_DB_PATH = BASE_DIR / "data" / "volunteer.db"

CATEGORIES = [
    {
        "name": "社区服务",
        "icon": "hands",
        "color": "#D96C4E",
        "tagline": "让生活的街区更有人情味",
    },
    {
        "name": "环保公益",
        "icon": "leaf",
        "color": "#4F7A5B",
        "tagline": "把干净和绿意留给明天",
    },
    {
        "name": "教育助学",
        "icon": "book",
        "color": "#4C6F8E",
        "tagline": "陪一个孩子看见更大的世界",
    },
    {
        "name": "助老扶幼",
        "icon": "heart",
        "color": "#B47A36",
        "tagline": "用陪伴接住每一份需要",
    },
    {
        "name": "动物保护",
        "icon": "paw",
        "color": "#80627A",
        "tagline": "为不会说话的生命发声",
    },
    {
        "name": "文化传播",
        "icon": "spark",
        "color": "#3D7A78",
        "tagline": "让好故事被更多人听见",
    },
]

CATEGORY_NAMES = [item["name"] for item in CATEGORIES]

AVAILABILITY_OPTIONS = ["工作日", "周末", "上午", "下午", "晚上"]

INTEREST_OPTIONS = [
    "社区服务",
    "环保公益",
    "教育助学",
    "助老扶幼",
    "动物保护",
    "文化传播",
    "户外",
    "亲子",
    "线上",
    "技能分享",
    "阅读",
    "摄影",
]

SCHEMA = """
PRAGMA journal_mode = WAL;

CREATE TABLE IF NOT EXISTS users (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    username      TEXT NOT NULL UNIQUE COLLATE NOCASE,
    display_name  TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    salt          TEXT NOT NULL,
    city          TEXT NOT NULL DEFAULT '',
    bio           TEXT NOT NULL DEFAULT '',
    interests     TEXT NOT NULL DEFAULT '[]',
    availability  TEXT NOT NULL DEFAULT '[]',
    created_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
    token      TEXT PRIMARY KEY,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at TEXT NOT NULL,
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS activities (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    creator_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    title       TEXT NOT NULL,
    description TEXT NOT NULL,
    category    TEXT NOT NULL,
    tags        TEXT NOT NULL DEFAULT '[]',
    city        TEXT NOT NULL,
    location    TEXT NOT NULL,
    start_at    TEXT NOT NULL,
    end_at      TEXT NOT NULL,
    capacity    INTEGER NOT NULL CHECK (capacity > 0),
    contact     TEXT NOT NULL DEFAULT '',
    status      TEXT NOT NULL DEFAULT 'open'
                CHECK (status IN ('open', 'closed', 'cancelled')),
    created_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS registrations (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    activity_id INTEGER NOT NULL REFERENCES activities(id) ON DELETE CASCADE,
    user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    message     TEXT NOT NULL DEFAULT '',
    created_at  TEXT NOT NULL,
    UNIQUE (activity_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_expiry ON sessions(expires_at);
CREATE INDEX IF NOT EXISTS idx_activities_start ON activities(start_at);
CREATE INDEX IF NOT EXISTS idx_activities_creator ON activities(creator_id);
CREATE INDEX IF NOT EXISTS idx_registrations_activity ON registrations(activity_id);
CREATE INDEX IF NOT EXISTS idx_registrations_user ON registrations(user_id);

CREATE TRIGGER IF NOT EXISTS trg_registration_capacity
BEFORE INSERT ON registrations
WHEN (
    SELECT COUNT(*) FROM registrations WHERE activity_id = NEW.activity_id
) >= (
    SELECT capacity FROM activities WHERE id = NEW.activity_id
)
BEGIN
    SELECT RAISE(ABORT, 'activity full');
END;
"""


def now_local() -> datetime:
    return datetime.now().replace(second=0, microsecond=0)


def utc_now_iso() -> str:
    return (
        datetime.now(timezone.utc)
        .replace(microsecond=0)
        .isoformat()
        .replace("+00:00", "Z")
    )


def hash_password(password: str, salt: str | None = None) -> tuple[str, str]:
    """Return (salt, pbkdf2 digest) using a per-user random salt."""
    salt = salt or secrets.token_hex(16)
    digest = hashlib.pbkdf2_hmac(
        "sha256", password.encode("utf-8"), bytes.fromhex(salt), 220_000
    )
    return salt, digest.hex()


def verify_password(password: str, salt: str, expected: str) -> bool:
    _, digest = hash_password(password, salt)
    return hmac.compare_digest(digest, expected)


def database_path() -> Path:
    configured = os.environ.get("VOLUNTEER_DB_PATH")
    return Path(configured).expanduser().resolve() if configured else DEFAULT_DB_PATH


def connect() -> sqlite3.Connection:
    path = database_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(path, timeout=10)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    conn.execute("PRAGMA busy_timeout = 5000")
    return conn


def init_db(seed: bool = True) -> None:
    conn = connect()
    try:
        conn.executescript(SCHEMA)
        conn.commit()
        if seed and os.environ.get("VOLUNTEER_SEED", "1") != "0":
            count = conn.execute("SELECT COUNT(*) FROM users").fetchone()[0]
            if count == 0:
                seed_demo_data(conn)
    finally:
        conn.close()


def _create_user(
    conn: sqlite3.Connection,
    username: str,
    display_name: str,
    password: str,
    city: str,
    bio: str,
    interests: list[str],
    availability: list[str],
) -> int:
    salt, digest = hash_password(password)
    cur = conn.execute(
        """
        INSERT INTO users
            (username, display_name, password_hash, salt, city, bio,
             interests, availability, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            username,
            display_name,
            digest,
            salt,
            city,
            bio,
            json.dumps(interests, ensure_ascii=False),
            json.dumps(availability, ensure_ascii=False),
            utc_now_iso(),
        ),
    )
    return int(cur.lastrowid)


def _future(days: int, hour: int, minute: int = 0) -> str:
    base = now_local().replace(hour=hour, minute=minute)
    return (base + timedelta(days=days)).strftime("%Y-%m-%dT%H:%M")


def _create_activity(
    conn: sqlite3.Connection,
    creator_id: int,
    title: str,
    description: str,
    category: str,
    tags: list[str],
    city: str,
    location: str,
    start_at: str,
    end_at: str,
    capacity: int,
    contact: str = "",
) -> int:
    cur = conn.execute(
        """
        INSERT INTO activities
            (creator_id, title, description, category, tags, city, location,
             start_at, end_at, capacity, contact, status, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?)
        """,
        (
            creator_id,
            title,
            description,
            category,
            json.dumps(tags, ensure_ascii=False),
            city,
            location,
            start_at,
            end_at,
            capacity,
            contact,
            utc_now_iso(),
        ),
    )
    return int(cur.lastrowid)


def _register(
    conn: sqlite3.Connection,
    activity_id: int,
    user_id: int,
    message: str = "",
    joined_at: str | None = None,
) -> None:
    conn.execute(
        """
        INSERT OR IGNORE INTO registrations
            (activity_id, user_id, message, created_at)
        VALUES (?, ?, ?, ?)
        """,
        (activity_id, user_id, message, joined_at or utc_now_iso()),
    )


def seed_demo_data(conn: sqlite3.Connection) -> None:
    """Create friendly demo content dated relative to the first launch."""
    demo_id = _create_user(
        conn,
        "demo",
        "志愿小暖",
        "demo1234",
        "杭州",
        "喜欢在周末做点让城市变温柔的小事。",
        ["环保公益", "动物保护", "社区服务"],
        ["周末", "下午"],
    )
    lin_id = _create_user(
        conn,
        "lin",
        "林晓",
        "demo1234",
        "杭州",
        "独立书店店员，相信阅读和陪伴的力量。",
        ["教育助学", "文化传播", "阅读"],
        ["工作日", "晚上"],
    )
    chen_id = _create_user(
        conn,
        "chen",
        "陈默",
        "demo1234",
        "上海",
        "产品设计师，周末常去社区做志愿者。",
        ["助老扶幼", "社区服务", "摄影"],
        ["周末", "上午"],
    )
    yue_id = _create_user(
        conn,
        "yue",
        "苏月",
        "demo1234",
        "杭州",
        "大学生，动物救助站长期志愿者。",
        ["动物保护", "环保公益", "户外"],
        ["周末", "上午"],
    )
    member_specs = [
        ("muyu", "沐雨", "杭州", ["社区服务", "文化传播"], ["周末", "下午"]),
        ("zhouzhou", "周舟", "上海", ["环保公益", "户外"], ["工作日", "晚上"]),
        ("anan", "安安", "杭州", ["教育助学", "亲子"], ["周末", "上午"]),
        ("xiaohe", "小禾", "杭州", ["动物保护", "摄影"], ["周末", "下午"]),
        ("tianye", "田野", "上海", ["助老扶幼", "社区服务"], ["工作日", "上午"]),
        ("ningning", "宁宁", "杭州", ["文化传播", "阅读"], ["工作日", "晚上"]),
        ("akai", "阿凯", "上海", ["社区服务", "健康"], ["周末", "上午"]),
        ("lulu", "陆路", "杭州", ["环保公益", "户外"], ["周末", "上午"]),
    ]
    member_ids = {}
    for username, display_name, city, interests, availability in member_specs:
        member_ids[username] = _create_user(
            conn,
            username,
            display_name,
            "demo1234",
            city,
            "",
            interests,
            availability,
        )

    activities = [
        {
            "creator": lin_id,
            "title": "西湖晨光环保捡拾计划",
            "description": (
                "沿着北山街到曲院风荷走一圈，顺手带走沿途的塑料瓶和纸屑。"
                "我们会提供手套、夹子和可降解垃圾袋，也会准备热豆浆。"
                "不需要专业经验，带上轻松的心情来就好；亲子家庭也欢迎参加。"
            ),
            "category": "环保公益",
            "tags": ["户外", "亲子", "运动"],
            "city": "杭州",
            "location": "西湖区 · 北山街集合点",
            "start": _future(1, 8, 30),
            "end": _future(1, 11, 0),
            "capacity": 30,
            "contact": "活动群将在报名后发送",
        },
        {
            "creator": demo_id,
            "title": "社区长者智能手机小课堂",
            "description": (
                "教社区里的爷爷奶奶使用视频通话、预约挂号、识别诈骗短信。"
                "两人一组，一位志愿者陪伴一位长者，现场有社工协助。"
                "希望你有耐心、愿意慢慢讲，也欢迎带上自己的笔记本电脑。"
            ),
            "category": "助老扶幼",
            "tags": ["技能分享", "陪伴", "社区"],
            "city": "杭州",
            "location": "拱墅区 · 小河社区活动中心",
            "start": _future(3, 14, 0),
            "end": _future(3, 16, 0),
            "capacity": 12,
            "contact": "社工小周 0571-8888 1200",
        },
        {
            "creator": yue_id,
            "title": "流浪猫救助站周末义工",
            "description": (
                "帮忙清洁猫舍、更换饮水、整理捐赠物资，并陪刚救助的小猫做社会化训练。"
                "救助站会提供围裙和手套。对猫毛过敏的朋友请谨慎报名，"
                "也可以帮忙折宣传单、拍摄领养照片。"
            ),
            "category": "动物保护",
            "tags": ["公益", "动物", "周末"],
            "city": "杭州",
            "location": "西湖区 · 转塘流浪动物之家",
            "start": _future(5, 9, 0),
            "end": _future(5, 12, 0),
            "capacity": 15,
            "contact": "站长阿月 138-0000-6621",
        },
        {
            "creator": lin_id,
            "title": "城市书房绘本共读会",
            "description": (
                "为 5-8 岁的小朋友读一本关于友谊的绘本，再一起完成一张拼贴画。"
                "我们准备了书和材料，你只需要准备一个有趣的开场问题。"
                "有和孩子相处经验优先，但不是必须，现场会有领读老师。"
            ),
            "category": "教育助学",
            "tags": ["阅读", "亲子", "技能分享"],
            "city": "杭州",
            "location": "滨江区 · 闻涛路城市书房",
            "start": _future(6, 15, 0),
            "end": _future(6, 17, 0),
            "capacity": 20,
            "contact": "书房前台 0571-8666 3320",
        },
        {
            "creator": chen_id,
            "title": "无障碍电影放映陪伴",
            "description": (
                "陪视障朋友一起看一场无障碍电影。影片配有专业解说，"
                "志愿者负责接送引导、座位协助和映后交流。"
                "请提前 20 分钟到场，我们会做一次简短的陪伴培训。"
            ),
            "category": "文化传播",
            "tags": ["陪伴", "电影", "公益"],
            "city": "上海",
            "location": "徐汇区 · 文化馆小剧场",
            "start": _future(2, 18, 30),
            "end": _future(2, 20, 30),
            "capacity": 18,
            "contact": "领队陈默 139-0000-2388",
        },
        {
            "creator": chen_id,
            "title": "旧衣回收分拣工作坊",
            "description": (
                "把居民捐赠的旧衣按季节、材质和成色分类，挑出可以再穿着的衣物，"
                "其余交给合作机构做再生处理。现场会有称重和打包工作，"
                "建议穿耐脏的衣服和舒适的鞋。"
            ),
            "category": "环保公益",
            "tags": ["环保", "公益", "周末"],
            "city": "上海",
            "location": "杨浦区 · 创智天地公益仓库",
            "start": _future(8, 13, 30),
            "end": _future(8, 16, 30),
            "capacity": 25,
            "contact": "",
        },
        {
            "creator": demo_id,
            "title": "医院门诊导诊志愿服务",
            "description": (
                "在门诊大厅协助患者使用自助挂号机、指引科室位置、维持排队秩序。"
                "上岗前会进行 30 分钟培训，提供志愿者马甲和午餐。"
                "需要能连续站立两小时，欢迎有医院志愿服务经验的朋友。"
            ),
            "category": "社区服务",
            "tags": ["社区", "健康", "技能分享"],
            "city": "上海",
            "location": "静安区 · 中心医院门诊大厅",
            "start": _future(4, 8, 0),
            "end": _future(4, 11, 30),
            "capacity": 10,
            "contact": "医务社工部 021-6000 1188",
        },
        {
            "creator": lin_id,
            "title": "乡村小学线上伴读计划",
            "description": (
                "通过视频会议陪伴云南一所村小的孩子读课外书，每周一次，每次 45 分钟。"
                "本期需要 8 位长期志愿者，连续参加四周。"
                "我们会提供书单和伴读手册，并在第一次活动前组织线上培训。"
            ),
            "category": "教育助学",
            "tags": ["线上", "阅读", "陪伴"],
            "city": "线上",
            "location": "线上 · 腾讯会议（报名后发送链接）",
            "start": _future(7, 19, 0),
            "end": _future(7, 20, 0),
            "capacity": 40,
            "contact": "项目组微信：weiguang-read",
        },
        {
            "creator": yue_id,
            "title": "秋日植物园自然导赏",
            "description": (
                "跟着植物学专业的志愿者逛植物园，认识秋天开花的植物和常见的鸟。"
                "活动适合零基础的自然爱好者，也会给小朋友准备观察任务卡。"
                "请自备水杯，穿适合步行的鞋。"
            ),
            "category": "文化传播",
            "tags": ["户外", "亲子", "摄影"],
            "city": "杭州",
            "location": "西湖区 · 杭州植物园南门",
            "start": _future(10, 9, 30),
            "end": _future(10, 11, 30),
            "capacity": 24,
            "contact": "",
        },
        {
            "creator": demo_id,
            "title": "独居老人秋日探访日",
            "description": (
                "和社区网格员一起探访 6 户独居老人，送去秋季健康包，"
                "陪他们聊聊天，检查家里的用电安全。"
                "每组 2 位志愿者，探访前会提供名单和注意事项。"
                "这是一次安静但有分量的陪伴。"
            ),
            "category": "助老扶幼",
            "tags": ["陪伴", "社区", "健康"],
            "city": "杭州",
            "location": "上城区 · 清波街道集合",
            "start": _future(12, 14, 0),
            "end": _future(12, 16, 30),
            "capacity": 12,
            "contact": "清波街道社工站 0571-8700 5521",
        },
    ]

    ids: dict[str, int] = {}
    for item in activities:
        ids[item["title"]] = _create_activity(
            conn,
            item["creator"],
            item["title"],
            item["description"],
            item["category"],
            item["tags"],
            item["city"],
            item["location"],
            item["start"],
            item["end"],
            item["capacity"],
            item["contact"],
        )

    _register(conn, ids["西湖晨光环保捡拾计划"], chen_id, "会带相机记录现场，也可以帮忙搬物资。")
    _register(conn, ids["西湖晨光环保捡拾计划"], yue_id, "带一位朋友一起参加。")
    _register(conn, ids["西湖晨光环保捡拾计划"], member_ids["muyu"], "第一次参加，会提前十分钟到。")
    _register(conn, ids["西湖晨光环保捡拾计划"], member_ids["anan"], "带孩子一起，可以负责拍照。")
    _register(conn, ids["社区长者智能手机小课堂"], chen_id, "之前做过类似的课程，可以带投影转接头。")
    _register(conn, ids["社区长者智能手机小课堂"], member_ids["tianye"], "经常陪家里老人，有耐心。")
    _register(conn, ids["流浪猫救助站周末义工"], demo_id, "家里养猫，清洁和喂药都比较熟。")
    _register(conn, ids["流浪猫救助站周末义工"], member_ids["xiaohe"], "可以帮忙拍领养照片。")
    _register(conn, ids["流浪猫救助站周末义工"], member_ids["lulu"], "力气大，可以搬物资。")
    _register(conn, ids["城市书房绘本共读会"], demo_id, "可以负责签到和拍照。")
    _register(conn, ids["城市书房绘本共读会"], member_ids["anan"], "女儿也喜欢这本绘本。")
    _register(conn, ids["城市书房绘本共读会"], member_ids["ningning"], "想学习如何给小朋友讲绘本。")
    _register(conn, ids["无障碍电影放映陪伴"], lin_id, "想了解无障碍电影，愿意提前到场。")
    _register(conn, ids["无障碍电影放映陪伴"], member_ids["zhouzhou"], "可以负责地铁站接送引导。")
    _register(conn, ids["旧衣回收分拣工作坊"], member_ids["akai"], "周末有空，可以早到布置。")
    _register(conn, ids["乡村小学线上伴读计划"], demo_id, "希望长期参加，时间可以协调。")
    _register(conn, ids["乡村小学线上伴读计划"], member_ids["ningning"], "做过线上支教，熟悉会议软件。")
    _register(conn, ids["秋日植物园自然导赏"], member_ids["muyu"], "喜欢植物，会带一本图鉴。")
    _register(conn, ids["独居老人秋日探访日"], member_ids["tianye"], "社区工作经验，可以带新人。")
    _register(conn, ids["独居老人秋日探访日"], member_ids["lulu"], "会基础的家电安全检查。")

    conn.commit()
