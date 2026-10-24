/* global window, document, fetch, FormData, URLSearchParams */
(() => {
  "use strict";

  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));

  const view = $("#main");
  const topbar = $("#topbar");
  const mobileNav = $("#mobile-nav");
  const modalRoot = $("#modal-root");
  const toastRoot = $("#toast-root");

  const state = {
    meta: null,
    me: null,
    route: { name: "discover", id: null },
    backTo: "#/discover",
    home: { recs: [], upcoming: [], personalized: false, reason: "" },
    explore: {
      items: [],
      count: 0,
      loading: false,
      filters: { q: "", category: "", city: "", when: "" },
    },
    mine: null,
    mineTab: "joined",
    detail: null,
    participants: null,
    routeToken: 0,
    exploreToken: 0,
    authTab: "login",
    matchCache: new Map(),
  };

  let modalCleanup = null;
  let exploreTimer = null;
  let scrollTicking = false;

  const NAV_ITEMS = [
    { name: "discover", label: "发现", icon: "compass", href: "#/discover" },
    { name: "explore", label: "活动广场", icon: "grid", href: "#/explore" },
    { name: "publish", label: "发布活动", icon: "plus", href: "#/publish" },
  ];

  const EXTRA_TAGS = [
    "户外",
    "亲子",
    "线上",
    "陪伴",
    "技能分享",
    "阅读",
    "摄影",
    "健康",
    "公益",
    "周末",
  ];

  const AVATAR_COLORS = [
    "#1f5a43",
    "#b45d44",
    "#4c6f8e",
    "#80627a",
    "#9a6d2e",
    "#3d7a78",
    "#5b6c3a",
    "#6f5541",
  ];

  /* ------------------------------------------------------------------ utils */

  const ESC_MAP = {
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  };

  function esc(value) {
    return String(value ?? "").replace(/[&<>"']/g, (char) => ESC_MAP[char]);
  }

  function icon(name, className = "") {
    return `<svg class="icon ${className}" aria-hidden="true"><use href="#i-${name}"></use></svg>`;
  }

  function avatar(name, size = "") {
    const label = String(name || "微").trim() || "微";
    const chars = Array.from(label);
    let hash = 0;
    for (const char of chars) hash = (hash * 31 + char.codePointAt(0)) >>> 0;
    const color = AVATAR_COLORS[hash % AVATAR_COLORS.length];
    const sizeClass = size ? ` avatar--${size}` : "";
    return `<span class="avatar${sizeClass}" style="--avatar-bg:${color}" aria-hidden="true">${esc(chars[0] || "微")}</span>`;
  }

  function catOf(name) {
    const categories = state.meta?.categories || [];
    return (
      categories.find((item) => item.name === name) || {
        name: name || "公益活动",
        color: "#1f5a43",
        icon: "spark",
        tagline: "",
      }
    );
  }

  function greeting() {
    const hour = new Date().getHours();
    if (hour >= 5 && hour < 11) return "早上好";
    if (hour >= 11 && hour < 14) return "中午好";
    if (hour >= 14 && hour < 18) return "下午好";
    return "晚上好";
  }

  function pad(value) {
    return String(value).padStart(2, "0");
  }

  function toLocalInput(date) {
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
  }

  function defaultStartDate() {
    const date = new Date();
    date.setSeconds(0, 0);
    let diff = (6 - date.getDay() + 7) % 7;
    if (diff === 0) diff = 7;
    date.setDate(date.getDate() + diff);
    date.setHours(9, 0, 0, 0);
    return date;
  }

  function addHours(date, hours) {
    const copy = new Date(date.getTime());
    copy.setHours(copy.getHours() + hours);
    return copy;
  }

  function parseInputDate(value) {
    if (!value) return null;
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
  }

  function weekdayCn(date) {
    return ["周日", "周一", "周二", "周三", "周四", "周五", "周六"][date.getDay()];
  }

  function truncate(value, length) {
    const chars = Array.from(String(value || ""));
    return chars.length > length ? `${chars.slice(0, length).join("")}…` : chars.join("");
  }

  function formatJoined(value) {
    if (!value) return "";
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "";
    return `${date.getMonth() + 1}月${date.getDate()}日`;
  }

  function hasExploreFilters() {
    const filters = state.explore.filters;
    return Boolean(filters.q || filters.category || filters.city || filters.when);
  }

  function emptyState(title, description, action = "") {
    return `
      <div class="empty-state">
        <span class="empty-icon">${icon("spark")}</span>
        <h3>${esc(title)}</h3>
        <p>${esc(description)}</p>
        ${action}
      </div>`;
  }

  function authGate(title, description, iconName = "user", foot = "") {
    return `
      <div class="page">
        <div class="container">
          <section class="auth-gate reveal">
            <div class="auth-gate-icon">${icon(iconName)}</div>
            <h1>${title}</h1>
            <p>${esc(description)}</p>
            <div class="auth-gate-actions">
              <button class="btn btn-primary btn-lg" type="button" data-action="open-auth" data-tab="register">
                加入微光 ${icon("arrow-right")}
              </button>
              <button class="btn btn-ghost btn-lg" type="button" data-action="open-auth" data-tab="login">
                已有账号，登录
              </button>
            </div>
            <p class="auth-gate-foot">${foot || "账号与活动数据只保存在这台电脑上"}</p>
          </section>
        </div>
      </div>`;
  }

  function skeletonGrid(count = 3) {
    return `<div class="skeleton-grid">${Array.from({ length: count }, () => `
      <div class="skeleton-card">
        <div class="skeleton-lines">
          <span></span><span></span><span></span><span></span>
        </div>
      </div>`).join("")}</div>`;
  }

  function rememberMatches(items) {
    for (const item of items) {
      if (item?.match) state.matchCache.set(item.id, item.match);
    }
  }

  function getMatch(id) {
    return state.matchCache.get(Number(id)) || null;
  }

  /* -------------------------------------------------------------------- API */

  async function api(path, { method = "GET", body = null } = {}) {
    const options = {
      method,
      credentials: "same-origin",
      headers: { Accept: "application/json" },
    };
    if (body !== null) {
      options.headers["Content-Type"] = "application/json";
      options.body = JSON.stringify(body);
    }
    let response;
    try {
      response = await fetch(`/api${path}`, options);
    } catch (error) {
      const networkError = new Error("无法连接本地服务，请确认 app.py 正在运行");
      networkError.cause = error;
      throw networkError;
    }
    let data = null;
    try {
      data = await response.json();
    } catch (error) {
      data = null;
    }
    if (!response.ok) {
      const requestError = new Error(data?.error || `请求失败（${response.status}）`);
      requestError.status = response.status;
      throw requestError;
    }
    return data;
  }

  /* ------------------------------------------------------------------- toast */

  function toast(message, type = "success") {
    const item = document.createElement("div");
    item.className = `toast toast--${type}`;
    const iconName = type === "error" ? "alert" : type === "info" ? "info" : "check";
    item.innerHTML = `${icon(iconName)}<span>${esc(message)}</span>`;
    toastRoot.appendChild(item);
    requestAnimationFrame(() => item.classList.add("is-visible"));
    window.setTimeout(() => {
      item.classList.remove("is-visible");
      window.setTimeout(() => item.remove(), 320);
    }, 3800);
  }

  function showFormError(element, message) {
    if (!element) return;
    element.hidden = false;
    element.innerHTML = `${icon("alert")}<span>${esc(message)}</span>`;
  }

  function clearFormError(element) {
    if (!element) return;
    element.hidden = true;
    element.innerHTML = "";
  }

  function setButtonBusy(button, busy, label = "处理中…") {
    if (!button) return;
    if (busy) {
      if (!button.dataset.originalHtml) button.dataset.originalHtml = button.innerHTML;
      button.disabled = true;
      button.classList.add("is-loading");
      button.innerHTML = `<span class="btn-spinner"></span><span class="btn-label">${esc(label)}</span>`;
    } else {
      button.disabled = false;
      button.classList.remove("is-loading");
      if (button.dataset.originalHtml) {
        button.innerHTML = button.dataset.originalHtml;
        delete button.dataset.originalHtml;
      }
    }
  }

  /* ------------------------------------------------------------------ modals */

  function openModal(html) {
    modalRoot.innerHTML = html;
    document.body.classList.add("modal-open");
    window.requestAnimationFrame(() => {
      const target =
        modalRoot.querySelector("[autofocus]") ||
        modalRoot.querySelector("input:not([type=hidden]), textarea, select, button");
      target?.focus();
    });
  }

  function closeModal() {
    if (!modalRoot.innerHTML) return;
    modalRoot.innerHTML = "";
    document.body.classList.remove("modal-open");
    if (modalCleanup) {
      const cleanup = modalCleanup;
      modalCleanup = null;
      cleanup();
    }
  }

  function trapFocus(event) {
    if (event.key !== "Tab" || !modalRoot.innerHTML) return;
    const focusables = $$(
      'a[href], button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])',
      modalRoot
    ).filter((element) => element.offsetParent !== null);
    if (!focusables.length) return;
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  function confirmDialog({
    title,
    message,
    confirmText = "确定",
    cancelText = "再想想",
    danger = false,
    iconName = "info",
    points = "",
  }) {
    return new Promise((resolve) => {
      let settled = false;
      openModal(`
        <div class="modal-backdrop" data-modal-backdrop>
          <div class="modal-card" role="dialog" aria-modal="true" aria-labelledby="confirm-title">
            <button class="modal-close" type="button" data-action="close-modal" aria-label="关闭">${icon("x")}</button>
            <div class="confirm-icon ${danger ? "confirm-icon--danger" : ""}">${icon(iconName)}</div>
            <h2 id="confirm-title">${esc(title)}</h2>
            <p class="modal-sub">${esc(message)}</p>
            ${points ? `<div class="confirm-points">${icon("info")}<span>${esc(points)}</span></div>` : ""}
            <div class="modal-actions">
              <button class="btn btn-ghost" type="button" data-confirm-no>${esc(cancelText)}</button>
              <button class="btn ${danger ? "btn-accent" : "btn-primary"}" type="button" data-confirm-yes>${esc(confirmText)}</button>
            </div>
          </div>
        </div>`);
      modalCleanup = () => {
        if (!settled) {
          settled = true;
          resolve(false);
        }
      };
      const finish = (value) => {
        if (settled) return;
        settled = true;
        modalCleanup = null;
        closeModal();
        resolve(value);
      };
      modalRoot.querySelector("[data-confirm-yes]")?.addEventListener("click", () => finish(true));
      modalRoot.querySelector("[data-confirm-no]")?.addEventListener("click", () => finish(false));
    });
  }

  /* --------------------------------------------------------------- navigation */

  function parseRoute() {
    const raw = window.location.hash.replace(/^#\/?/, "");
    if (!raw) return { name: "discover", id: null };
    const [name, id] = raw.split("/");
    const allowed = ["discover", "explore", "publish", "mine", "activity"];
    if (!allowed.includes(name)) return { name: "discover", id: null };
    if (name === "activity") {
      return /^\d+$/.test(id || "") ? { name, id: Number(id) } : { name: "explore", id: null };
    }
    return { name, id: null };
  }

  function navigate(name, id = null) {
    const hash = `#/${name}${id ? `/${id}` : ""}`;
    if (window.location.hash === hash) {
      closeModal();
      renderRoute();
    } else {
      window.location.hash = hash;
    }
  }

  function markNavigation() {
    const active = state.route.name === "activity" ? "explore" : state.route.name;
    $$(".nav-link", topbar).forEach((link) => {
      const isActive = link.dataset.nav === active;
      link.classList.toggle("is-active", isActive);
      if (isActive) link.setAttribute("aria-current", "page");
      else link.removeAttribute("aria-current");
    });
    $$(".mobile-link", mobileNav).forEach((link) => {
      const isActive = link.dataset.nav === active;
      link.classList.toggle("is-active", isActive);
      if (isActive) link.setAttribute("aria-current", "page");
      else link.removeAttribute("aria-current");
    });
  }

  /* ------------------------------------------------------------------ chrome */

  function renderChrome() {
    const me = state.me;
    const nav = NAV_ITEMS.map(
      (item) => `<a class="nav-link" data-nav="${item.name}" href="${item.href}">
        ${icon(item.icon)}<span>${item.label}</span>
      </a>`
    ).join("");

    const actions = me
      ? `<a class="user-chip" href="#/mine" aria-label="进入我的主页">
           ${avatar(me.display_name)}
           <span class="user-chip-copy">
             <strong>${esc(me.display_name)}</strong>
             <small>@${esc(me.username)}</small>
           </span>
         </a>
         <button class="icon-btn" type="button" data-action="logout" title="退出登录" aria-label="退出登录">
           ${icon("logout")}
         </button>`
      : `<button class="btn btn-ghost btn-sm" type="button" data-action="open-auth" data-tab="login">登录</button>
         <button class="btn btn-primary btn-sm" type="button" data-action="open-auth" data-tab="register">加入微光</button>`;

    topbar.innerHTML = `
      <div class="topbar-inner">
        <a class="brand" href="#/discover" aria-label="微光首页">
          <span class="brand-mark">${icon("logo")}</span>
          <span class="brand-name">微光</span>
          <span class="brand-sub">VOLUNTEER</span>
        </a>
        <nav class="main-nav" aria-label="主导航">${nav}</nav>
        <div class="topbar-actions">${actions}</div>
      </div>`;

    mobileNav.innerHTML = `
      <a class="mobile-link" data-nav="discover" href="#/discover">
        ${icon("compass")}<span>发现</span>
      </a>
      <a class="mobile-link" data-nav="explore" href="#/explore">
        ${icon("grid")}<span>广场</span>
      </a>
      <a class="mobile-link mobile-link--publish" data-nav="publish" href="#/publish">
        <span class="mobile-publish-icon">${icon("plus")}</span><span>发布</span>
      </a>
      <a class="mobile-link" data-nav="mine" href="#/mine">
        ${icon("user")}<span>我的</span>
      </a>`;

    markNavigation();
    topbar.classList.toggle("is-scrolled", window.scrollY > 8);
  }

  /* -------------------------------------------------------------- activity card */

  function activityCard(item, { showReason = false, compact = false } = {}) {
    const cat = catOf(item.category);
    const ended = Boolean(item.is_past);
    let statusBadge = "";
    if (item.match?.score) {
      statusBadge = `<span class="match-pill">${icon("spark")}${item.match.score}% 合拍</span>`;
    } else if (item.status === "cancelled") {
      statusBadge = `<span class="status-pill status-pill--cancelled">已取消</span>`;
    } else if (ended) {
      statusBadge = `<span class="status-pill">已结束</span>`;
    } else if (item.status === "closed") {
      statusBadge = `<span class="status-pill status-pill--closed">已截止</span>`;
    } else if (item.is_full) {
      statusBadge = `<span class="status-pill status-pill--closed">已满员</span>`;
    }

    let spotsLabel;
    let spotsClass = "";
    if (item.status === "cancelled") {
      spotsLabel = "活动已取消";
      spotsClass = "spots--full";
    } else if (ended) {
      spotsLabel = "活动已结束";
      spotsClass = "spots--full";
    } else if (item.status === "closed") {
      spotsLabel = "报名已截止";
      spotsClass = "spots--full";
    } else if (item.is_joined) {
      spotsLabel = "已报名";
    } else if (item.is_full) {
      spotsLabel = "名额已满";
      spotsClass = "spots--full";
    } else {
      spotsLabel = `余 ${item.spots_left} 位`;
      if (item.spots_left <= 3) spotsClass = "spots--urgent";
    }

    const reason =
      showReason && item.match?.reasons?.length
        ? `<div class="card-reason">${icon("spark")}<span>${esc(item.match.reasons[0])}</span></div>`
        : "";

    return `
      <a class="activity-card reveal" href="#/activity/${item.id}" style="--cat:${cat.color}"
         aria-label="${esc(item.title)}，${esc(item.start_display)}，${esc(item.location)}">
        <div class="card-cover">
          <span class="cover-icon">${icon(cat.icon)}</span>
          <div class="cover-top">
            <span class="cat-badge">${icon(cat.icon)}${esc(item.category)}</span>
            ${statusBadge}
          </div>
          <div class="date-tile">
            <strong>${esc(item.day_label)}</strong>
            <span>${esc(item.month_label)}<b>${esc(item.weekday_label)}</b></span>
          </div>
        </div>
        <div class="card-body">
          <h3 class="card-title">${esc(item.title)}</h3>
          <div class="card-meta">
            <span class="card-location">${icon("pin")}${esc(item.city)} · ${esc(item.location)}</span>
            <span>${icon("clock")}${esc(item.time_label)}</span>
          </div>
          ${reason}
          ${compact ? "" : `<p class="card-desc">${esc(truncate(item.description, 58))}</p>`}
          <div class="card-foot">
            <span class="host">${avatar(item.creator_name, "sm")}<span>${esc(item.creator_name)} 发起</span></span>
            <span class="spots ${spotsClass}"><span class="dot"></span>${esc(spotsLabel)}</span>
          </div>
          <div class="card-progress" aria-hidden="true"><span style="width:${item.fill_percent}%"></span></div>
        </div>
      </a>`;
  }

  function upcomingRows(items) {
    if (!items.length) {
      return emptyState(
        "暂时没有更多活动",
        "成为第一个发起行动的人，给这座城市增加一个新的见面理由。",
        `<a class="btn btn-primary btn-sm" href="#/publish">${icon("plus")} 发起活动</a>`
      );
    }
    return `<div class="upcoming-list">${items
      .map((item) => {
        const cat = catOf(item.category);
        return `
          <a class="upcoming-row reveal" href="#/activity/${item.id}" style="--cat:${cat.color}">
            <div class="up-date">
              <strong>${esc(item.day_label)}</strong>
              <span>${esc(item.month_label)} · ${esc(item.weekday_label)}</span>
            </div>
            <div class="up-main">
              <div class="up-kicker"><span class="chip-dot"></span>${esc(item.category)}<span>·</span><span>${esc(item.creator_name)} 发起</span></div>
              <h3>${esc(item.title)}</h3>
              <p>
                <span>${icon("clock")}${esc(item.date_label)} ${esc(item.time_label)}</span>
                <span>${icon("pin")}${esc(item.city)} · ${esc(item.location)}</span>
              </p>
            </div>
            <div class="up-side">
              <span class="up-spots">
                ${item.is_full ? "名额已满" : `还剩 <strong>${item.spots_left}</strong> 位`}
              </span>
              <span class="circle-arrow">${icon("arrow-right")}</span>
            </div>
          </a>`;
      })
      .join("")}</div>`;
  }

  /* -------------------------------------------------------------------- views */

  function discoverView() {
    const me = state.me;
    const stats = state.meta?.stats || {};
    const recs = state.home.recs || [];
    const upcoming = state.home.upcoming || [];
    const featured = recs[0] || upcoming[0] || null;
    const firstName = me?.display_name || "朋友";
    const interestText = me?.interests?.length
      ? me.interests.slice(0, 3).map((item) => `「${item}」`).join("、")
      : "";

    const heroTitle = me
      ? `${greeting()}，${esc(firstName)}。<br><span class="marker">今天，想为谁发光？</span>`
      : `把一点时间，<br><span class="marker">变成别人的光。</span>`;

    let heroLead;
    if (me && interestText) {
      heroLead = `你喜欢的 ${interestText} 里，有新活动正在等待同行者。先从一件小事开始，让周末多一点意义。`;
    } else if (me) {
      heroLead = "告诉我们你在意的议题和空闲时间，微光会把真正适合你的活动送到面前。";
    } else {
      heroLead = "从西湖边的清晨捡拾，到社区里的一堂手机课。找到一件你在意的小事，和一群认真生活的人一起完成它。";
    }

    const heroActions = me
      ? `<button class="btn btn-primary btn-lg" type="button" data-action="scroll-to" data-target="recommendations">
           看看我的推荐 ${icon("arrow-right")}
         </button>
         <a class="btn btn-ghost btn-lg" href="#/publish">${icon("plus")} 发起活动</a>`
      : `<button class="btn btn-primary btn-lg" type="button" data-action="open-auth" data-tab="register">
           找到适合我的活动 ${icon("arrow-right")}
         </button>
         <a class="btn btn-ghost btn-lg" href="#/explore">先随便逛逛</a>`;

    const peopleNames = Array.from(
      new Set([...recs, ...upcoming].map((item) => item.creator_name))
    ).slice(0, 4);
    const proofNames = peopleNames.length ? peopleNames : ["林晓", "陈默", "苏月", "志愿小暖"];
    const proofAvatars = proofNames
      .map((name) => avatar(name, "sm"))
      .join("");

    const heroArt = `
      <div class="hero-art" aria-hidden="true">
        <div class="hero-orbit"></div>
        <div class="hero-orbit hero-orbit--inner"></div>
        <div class="hero-sun">
          ${icon("logo")}
          <span class="hero-sun-label">LET IT SHINE</span>
        </div>
        ${
          featured
            ? `<div class="float-card float-card--date">
                 <div class="mini-date">
                   <strong>${esc(featured.day_label)}</strong>
                   <span>${esc(featured.weekday_label)}</span>
                 </div>
                 <div class="float-card-copy">
                   <strong>${esc(truncate(featured.title, 14))}</strong>
                   <small>${esc(featured.time_label)} · ${esc(featured.city)}</small>
                 </div>
               </div>`
            : ""
        }
        <div class="float-card float-card--match">
          <strong>${featured?.match?.score || 94}%</strong>
          <span>与你合拍</span>
        </div>
        <div class="float-card float-card--people">
          <div class="avatar-stack">${proofAvatars}</div>
          <div class="float-card-copy">
            <strong>${stats.volunteers || 1} 位伙伴</strong>
            <small>已经在这里相遇</small>
          </div>
        </div>
        <span class="hero-side-note">SCROLL TO EXPLORE</span>
      </div>`;

    const causeChips = (state.meta?.categories || [])
      .map(
        (item) => `<a class="chip chip--category" href="#/explore" data-cause="${esc(item.name)}" style="--cat:${item.color}">
          <span class="chip-dot"></span>${esc(item.name)}
        </a>`
      )
      .join("");

    const recHead = me ? "为你推荐" : "本周值得参与";
    const recSub = me
      ? state.home.reason || "根据你的兴趣、城市和时间偏好排序"
      : "登录并完善偏好后，微光会按你的兴趣重新排序";
    const recSection = `
      <section class="section" id="recommendations">
        <div class="section-head">
          <div class="section-head-copy">
            <span class="eyebrow">${me ? "JUST FOR YOU" : "THIS WEEK"}</span>
            <h2 class="section-title">${recHead}</h2>
            <p class="section-sub">${esc(recSub)}</p>
          </div>
          <a class="text-link" href="#/explore">查看全部 ${icon("arrow-right")}</a>
        </div>
        ${
          recs.length
            ? `<div class="activity-grid">${recs.slice(0, 3).map((item) => activityCard(item, { showReason: true })).join("")}</div>`
            : emptyState(
                "开放的活动都被你报名啦",
                "新的活动还在路上。你也可以先发起一场，邀请其他伙伴加入。",
                `<a class="btn btn-primary btn-sm" href="#/publish">${icon("plus")} 发起活动</a>`
              )
        }
      </section>`;

    const upcomingSection = `
      <section class="section">
        <div class="section-head">
          <div class="section-head-copy">
            <span class="eyebrow">ON THE CALENDAR</span>
            <h2 class="section-title">即将发生</h2>
            <p class="section-sub">把善意提前排进日程，给周末一个更好的答案</p>
          </div>
          <a class="text-link" href="#/explore">浏览活动广场 ${icon("arrow-right")}</a>
        </div>
        ${upcomingRows(upcoming.slice(0, 4))}
      </section>`;

    const guestNudge = !me
      ? `<section class="nudge reveal">
           <div class="nudge-copy">
             <span class="eyebrow eyebrow--light">YOUR LITTLE LIGHT</span>
             <h2>让微光记住你的喜好。</h2>
             <p>花一分钟建立账号，选择你在意的议题和方便的时间。之后每一次打开，都会看到更合拍的志愿活动。</p>
           </div>
           <button class="btn btn-cream btn-lg" type="button" data-action="open-auth" data-tab="register">
             加入微光 ${icon("arrow-right")}
           </button>
         </section>`
      : "";

    const prefsNudge =
      me && !me.interests?.length
        ? `<section class="nudge reveal">
             <div class="nudge-copy">
               <span class="eyebrow eyebrow--light">MAKE IT YOURS</span>
               <h2>还有一点点，就能更懂你。</h2>
               <p>选择你关心的议题和空闲时段，下一次推荐会更接近你真正想做的事。</p>
             </div>
             <a class="btn btn-cream btn-lg" href="#/mine">完善我的偏好 ${icon("arrow-right")}</a>
           </section>`
        : "";

    return `
      <div class="page">
        <div class="container">
          <section class="hero">
            <div class="hero-copy">
              <span class="eyebrow reveal">VOLUNTEER · TOGETHER · LOCAL</span>
              <h1 class="reveal reveal-1">${heroTitle}</h1>
              <p class="hero-lead reveal reveal-2">${esc(heroLead)}</p>
              <div class="hero-actions reveal reveal-3">${heroActions}</div>
              <div class="hero-proof reveal reveal-3">
                <div class="avatar-stack">${proofAvatars}</div>
                <span>已经有 <strong>${stats.volunteers || 1}</strong> 位伙伴，在这里把想法变成行动</span>
              </div>
            </div>
            ${heroArt}
          </section>

          <section class="stats-strip reveal" aria-label="平台数据">
            <div class="stat">
              <span class="stat-num">${stats.open_activities || 0}</span>
              <span class="stat-copy"><strong>场开放活动</strong><span>正在等待同行者</span></span>
            </div>
            <div class="stat">
              <span class="stat-num">${stats.volunteers || 1}</span>
              <span class="stat-copy"><strong>位社区伙伴</strong><span>认真生活，也认真帮忙</span></span>
            </div>
            <div class="stat">
              <span class="stat-num">${stats.cities || 1}</span>
              <span class="stat-copy"><strong>座城市相连</strong><span>线上也可以一起做</span></span>
            </div>
          </section>

          <div class="cause-row">
            <span class="cause-label">从关心出发</span>
            ${causeChips}
          </div>

          ${recSection}
          ${upcomingSection}
          ${guestNudge}
          ${prefsNudge}
        </div>
      </div>`;
  }

  function exploreView() {
    const filters = state.explore.filters;
    const categories = state.meta?.categories || [];
    const cities = state.meta?.cities || [];
    const items = state.explore.items || [];

    const categoryChips = [
      { name: "", label: "全部活动", color: "", icon: "" },
      ...categories,
    ]
      .map((item) => {
        const active = filters.category === item.name;
        const categoryClass = item.name ? " chip--category" : "";
        const dot = item.name
          ? `<span class="chip-dot"></span>`
          : "";
        return `<button class="chip${categoryClass}${active ? " is-active" : ""}" type="button"
          data-category-filter="${esc(item.name)}" aria-pressed="${active}"
          ${item.color ? `style="--cat:${item.color}"` : ""}>${dot}${esc(item.label || item.name)}</button>`;
      })
      .join("");

    const cityOptions = cities
      .map(
        (city) =>
          `<option value="${esc(city)}" ${filters.city === city ? "selected" : ""}>${esc(city)}</option>`
      )
      .join("");

    return `
      <div class="page">
        <div class="container">
          <header class="page-head">
            <div class="page-head-copy reveal">
              <span class="eyebrow">EXPLORE · 活动广场</span>
              <h1>把善意，<em>排进日程。</em></h1>
              <p>按议题、城市和时间找到下一场行动。每一场活动都由真实的伙伴发起，报名后就可以和发起人联系。</p>
            </div>
            <div class="page-head-side reveal reveal-1">
              <span class="page-stamp">${state.explore.count || 0} 场活动正在招募</span>
              <a class="text-link" href="#/publish">没有合适的？自己发起一场 ${icon("arrow-right")}</a>
            </div>
          </header>

          <div class="explore-toolbar reveal">
            <label class="search-box">
              <span class="sr-only">搜索活动</span>
              ${icon("search")}
              <input class="input" id="explore-search" type="search" placeholder="搜索活动、地点或发起人…" value="${esc(filters.q)}" autocomplete="off">
            </label>
            <select class="select" id="city-filter" aria-label="筛选城市">
              <option value="">全部城市</option>
              ${cityOptions}
            </select>
            <select class="select" id="when-filter" aria-label="筛选时间">
              <option value="" ${!filters.when ? "selected" : ""}>全部时间</option>
              <option value="weekend" ${filters.when === "weekend" ? "selected" : ""}>本周末</option>
              <option value="week" ${filters.when === "week" ? "selected" : ""}>7 天内</option>
              <option value="online" ${filters.when === "online" ? "selected" : ""}>线上参与</option>
            </select>
          </div>

          <div class="filter-row" role="group" aria-label="按议题筛选">
            ${categoryChips}
            <span class="filter-spacer"></span>
            <a class="chip" href="#/publish">${icon("plus")} 发起活动</a>
          </div>

          <div class="results-line">
            <span class="results-count" id="result-count">找到 <strong>${state.explore.count || 0}</strong> 场活动</span>
            <button class="text-button" id="clear-filters" type="button" ${hasExploreFilters() ? "" : "hidden"}>清除筛选</button>
          </div>

          <div class="explore-grid" id="explore-grid">
            ${
              items.length
                ? `<div class="activity-grid">${items.map((item) => activityCard(item)).join("")}</div>`
                : emptyState(
                    "没有找到匹配的活动",
                    "换一个关键词或筛选条件试试。也许你想做的事，还没有人发起。",
                    `<a class="btn btn-primary btn-sm" href="#/publish">${icon("plus")} 发起活动</a>`
                  )
            }
          </div>
        </div>
      </div>`;
  }

  function publishView() {
    if (!state.me) {
      return authGate(
        "登录后，发起你的第一场行动。",
        "写下活动的时间、地点和想做的事，就能邀请其他人一起参与。发布后可以查看报名名单，并随时管理报名状态。",
        "plus",
        "发布、报名和管理都需要一个本地账号"
      );
    }

    const me = state.me;
    const categories = state.meta?.categories || [];
    const defaultCategory =
      categories.find((item) => me.interests?.includes(item.name))?.name ||
      categories[0]?.name ||
      "社区服务";
    const start = defaultStartDate();
    const end = addHours(start, 3);
    const extraTags = Array.from(
      new Set([...(me.interests || []), ...EXTRA_TAGS])
    ).slice(0, 10);
    const tagButtons = extraTags
      .map(
        (tag) =>
          `<button class="tag-option" type="button" data-tag="${esc(tag)}" aria-pressed="false"># ${esc(tag)}</button>`
      )
      .join("");
    const categoryOptions = categories
      .map(
        (item) => `
          <label class="category-option" style="--cat:${item.color}">
            <input type="radio" name="category" value="${esc(item.name)}" ${item.name === defaultCategory ? "checked" : ""}>
            <span class="category-option-icon">${icon(item.icon)}</span>
            <span>${esc(item.name)}</span>
          </label>`
      )
      .join("");
    const cityList = (state.meta?.cities || [])
      .map((city) => `<option value="${esc(city)}"></option>`)
      .join("");

    return `
      <div class="page">
        <div class="container">
          <header class="page-head">
            <div class="page-head-copy reveal">
              <span class="eyebrow">HOST · 发起活动</span>
              <h1>让一个想法，<em>变成一次相遇。</em></h1>
              <p>不需要完美的计划，只需要一个明确的开始。写下你能提供的陪伴、时间和地点，微光会把它交给想参与的人。</p>
            </div>
            <div class="page-head-side reveal reveal-1">
              <span class="page-stamp">发布即开放报名</span>
              <span class="page-sub-note">发布后可在「我的」里管理报名</span>
            </div>
          </header>

          <div class="publish-layout">
            <form class="publish-form" id="publish-form" novalidate>
              <section class="form-card reveal">
                <div class="form-section-head">
                  <span class="form-step">01</span>
                  <div><h2>先说说这场活动</h2><p>一个清楚的名字，会让对的人更容易找到你。</p></div>
                </div>
                <div class="form-stack">
                  <label class="field">
                    <span>活动名称 <small>4–50 字</small></span>
                    <input class="input" name="title" id="pub-title" maxlength="50" placeholder="例如：周末社区花园共建计划" autocomplete="off" autofocus>
                  </label>
                  <div class="field">
                    <span>活动类别</span>
                    <div class="category-picker">${categoryOptions}</div>
                  </div>
                  <div class="field">
                    <span>活动标签 <small>最多 6 个</small></span>
                    <div class="tag-picker" id="tag-picker">${tagButtons}</div>
                  </div>
                  <label class="field">
                    <span>活动介绍 <small>20–2000 字</small></span>
                    <textarea class="textarea" name="description" id="pub-description" maxlength="2000"
                      placeholder="这场活动会做什么？需要参与者具备什么？你会提供哪些支持？把它们写下来，让伙伴们安心加入。"></textarea>
                  </label>
                </div>
              </section>

              <section class="form-card reveal">
                <div class="form-section-head">
                  <span class="form-step">02</span>
                  <div><h2>时间、地点和人数</h2><p>具体的信息，是一次顺利见面的开始。</p></div>
                </div>
                <div class="form-stack">
                  <div class="form-row">
                    <label class="field">
                      <span>所在城市</span>
                      <input class="input" name="city" id="pub-city" list="city-options" maxlength="20" value="${esc(me.city || "杭州")}" placeholder="杭州 / 线上" autocomplete="off">
                      <datalist id="city-options">${cityList}<option value="线上"></option></datalist>
                    </label>
                    <label class="field">
                      <span>具体地点</span>
                      <input class="input" name="location" id="pub-location" maxlength="80" placeholder="例如：西湖区北山街集合点" autocomplete="off">
                    </label>
                  </div>
                  <div class="form-row">
                    <label class="field">
                      <span>开始时间</span>
                      <input class="input" type="datetime-local" name="start_at" id="pub-start" value="${toLocalInput(start)}" min="${toLocalInput(new Date())}">
                    </label>
                    <label class="field">
                      <span>结束时间</span>
                      <input class="input" type="datetime-local" name="end_at" id="pub-end" value="${toLocalInput(end)}">
                    </label>
                  </div>
                  <div class="form-row">
                    <label class="field">
                      <span>招募人数</span>
                      <input class="input" type="number" name="capacity" min="1" max="500" value="20" inputmode="numeric">
                    </label>
                    <label class="field">
                      <span>联系方式 <small>选填，仅报名者可见</small></span>
                      <input class="input" name="contact" maxlength="80" placeholder="微信号 / 电话 / 活动群说明" autocomplete="off">
                    </label>
                  </div>
                  <div class="field-hint">报名者会在活动详情页看到时间地点；联系方式只用于活动沟通。</div>
                </div>
              </section>

              <div class="form-error" id="publish-error" hidden></div>
              <div class="form-actions">
                <p>发布即表示你愿意作为发起人，与报名伙伴保持联系。<br>活动数据只保存在这台电脑。</p>
                <button class="btn btn-primary btn-lg" type="submit" id="publish-submit">
                  ${icon("send")} 发布活动
                </button>
              </div>
            </form>

            <aside class="publish-aside" aria-label="活动预览">
              <span class="aside-label">LIVE PREVIEW · 实时预览</span>
              <div id="preview-card"></div>
              <div class="preview-tips">
                <h4>${icon("spark")} 一个让报名更顺利的小建议</h4>
                <ul>
                  <li>把「需要做什么」写得具体，比宏大的口号更有吸引力。</li>
                  <li>说明是否需要自备物品、是否有培训，能减少参与者的犹豫。</li>
                  <li>留下一个真实可联系的方式，让报名的人更安心。</li>
                </ul>
              </div>
            </aside>
          </div>
        </div>
      </div>`;
  }

  function mineView() {
    if (!state.me) {
      return authGate(
        "登录后，收好你的每一份善意。",
        "在这里查看已报名的活动、发起的行动，以及完善兴趣偏好。微光会根据这些信息，为你推荐更合适的机会。",
        "user",
        "你的报名记录和个人偏好只保存在本机"
      );
    }
    if (!state.mine) {
      return `<div class="page"><div class="container">${emptyState("正在整理你的志愿记录", "请稍候。")}</div></div>`;
    }

    const me = state.me;
    const mine = state.mine;
    const stats = mine.stats;
    const isJoinedTab = state.mineTab === "joined";
    const items = isJoinedTab ? mine.joined : mine.created;
    const joinedCount = mine.joined.length;
    const createdCount = mine.created.length;

    const listMarkup = items.length
      ? `<div class="mine-list">${items
          .map((item) => activityCard(item, { compact: true }))
          .join("")}</div>`
      : emptyState(
          isJoinedTab ? "还没有报名活动" : "还没有发起活动",
          isJoinedTab
            ? "去广场看看，找一个你愿意花时间的活动。报名后，它会出现在这里。"
            : "写下一个你想做的事，邀请其他人一起完成。微光会帮你把信息整理清楚。",
          isJoinedTab
            ? `<a class="btn btn-primary btn-sm" href="#/explore">${icon("compass")} 去逛活动广场</a>`
            : `<a class="btn btn-primary btn-sm" href="#/publish">${icon("plus")} 发起第一场活动</a>`
        );

    const interestChecks = (state.meta?.interests || [])
      .map(
        (interest) => `
          <label class="chip-check">
            <input type="checkbox" name="interests" value="${esc(interest)}" ${me.interests?.includes(interest) ? "checked" : ""}>
            <span>${esc(interest)}</span>
          </label>`
      )
      .join("");

    const availabilityChecks = (state.meta?.availability || [])
      .map(
        (slot) => `
          <label class="chip-check">
            <input type="checkbox" name="availability" value="${esc(slot)}" ${me.availability?.includes(slot) ? "checked" : ""}>
            <span>${esc(slot)}</span>
          </label>`
      )
      .join("");

    return `
      <div class="page">
        <div class="container">
          <section class="profile-hero reveal">
            <div class="profile-top">
              <div class="profile-id">
                ${avatar(me.display_name, "lg")}
                <div class="profile-copy">
                  <span class="eyebrow eyebrow--light">MY LITTLE LIGHT</span>
                  <h1>${esc(me.display_name)}</h1>
                  <p>@${esc(me.username)}${me.city ? ` · ${esc(me.city)}` : ""}${me.bio ? ` · ${esc(me.bio)}` : ""}</p>
                </div>
              </div>
              <div class="profile-actions">
                <button class="btn btn-cream" type="button" data-action="scroll-prefs">${icon("settings")} 编辑偏好</button>
                <button class="btn btn-ghost" type="button" data-action="logout">${icon("logout")} 退出登录</button>
              </div>
            </div>
            <div class="profile-stats">
              <div class="profile-stat"><strong>${stats.joined_total}</strong><span>报名过的活动</span></div>
              <div class="profile-stat"><strong>${stats.created_total}</strong><span>发起的行动</span></div>
              <div class="profile-stat"><strong>${stats.hours || 0}<small>h</small></strong><span>累计志愿时长</span></div>
            </div>
          </section>

          <div class="mine-layout">
            <div class="mine-main">
              <div class="mine-tabs" role="tablist" aria-label="我的活动">
                <button class="mine-tab ${isJoinedTab ? "is-active" : ""}" type="button" role="tab" aria-selected="${isJoinedTab}" data-action="mine-tab" data-tab="joined">
                  我报名的 <span>${joinedCount}</span>
                </button>
                <button class="mine-tab ${!isJoinedTab ? "is-active" : ""}" type="button" role="tab" aria-selected="${!isJoinedTab}" data-action="mine-tab" data-tab="created">
                  我发起的 <span>${createdCount}</span>
                </button>
              </div>
              ${listMarkup}
            </div>

            <aside class="prefs-card" id="preferences">
              <div class="prefs-head">
                <span class="prefs-head-icon">${icon("settings")}</span>
                <div>
                  <h2>让推荐更懂你</h2>
                  <p>偏好越具体，推荐越接近你真正想做的事。</p>
                </div>
              </div>
              <form class="prefs-form" id="prefs-form">
                <label class="field">
                  <span>昵称</span>
                  <input class="input" name="display_name" value="${esc(me.display_name)}" maxlength="20" required>
                </label>
                <label class="field">
                  <span>常驻城市</span>
                  <input class="input" name="city" value="${esc(me.city)}" maxlength="20" placeholder="例如：杭州">
                </label>
                <label class="field">
                  <span>一句话介绍自己</span>
                  <textarea class="textarea" name="bio" maxlength="160" placeholder="例如：喜欢在周末做点让城市变温柔的小事。">${esc(me.bio)}</textarea>
                </label>
                <div class="prefs-group">
                  <span>我关心的议题</span>
                  <div class="prefs-checks">${interestChecks}</div>
                </div>
                <div class="prefs-group">
                  <span>我方便的时间</span>
                  <div class="prefs-checks">${availabilityChecks}</div>
                </div>
                <div class="form-error" id="prefs-error" hidden></div>
                <div class="prefs-submit">
                  <button class="btn btn-primary" type="submit" id="prefs-submit">保存偏好</button>
                </div>
                <p class="prefs-note">保存后，首页推荐会立即按新偏好更新。</p>
              </form>
            </aside>
          </div>
        </div>
      </div>`;
  }

  function detailView() {
    const item = state.detail;
    if (!item) {
      return `<div class="page"><div class="container">${emptyState("活动不见了", "它可能已经被发起人删除。", `<a class="btn btn-primary btn-sm" href="#/explore">回到活动广场</a>`)}</div></div>`;
    }
    const cat = catOf(item.category);
    const match = getMatch(item.id);
    const me = state.me;
    const isCreator = Boolean(me && item.is_creator);
    const isJoined = Boolean(me && item.is_joined);
    const preview = item.participants_preview || [];
    const previewAvatars = preview.map((person) => avatar(person.display_name, "sm")).join("");
    const participantCount = item.joined_count;

    let statusLabel = "正在招募";
    let statusClass = "";
    if (item.status === "cancelled") {
      statusLabel = "活动已取消";
      statusClass = "status-pill--cancelled";
    } else if (item.is_past) {
      statusLabel = "活动已结束";
      statusClass = "status-pill--closed";
    } else if (item.status === "closed") {
      statusLabel = "报名已截止";
      statusClass = "status-pill--closed";
    } else if (item.is_full) {
      statusLabel = "名额已满";
      statusClass = "status-pill--closed";
    }

    let joinActions = "";
    if (!me) {
      joinActions = `<button class="btn btn-cream btn-block" type="button" data-action="open-auth" data-tab="login">${icon("user")} 登录后报名</button>`;
    } else if (isCreator) {
      joinActions = `<span class="join-owner-note">${icon("check")} 你是这场活动的发起人</span>`;
    } else if (item.status === "cancelled") {
      joinActions = `<button class="btn btn-cream btn-block" type="button" disabled>活动已取消</button>`;
    } else if (item.is_past) {
      joinActions = `<button class="btn btn-cream btn-block" type="button" disabled>活动已结束</button>`;
    } else if (isJoined) {
      joinActions = `
        <button class="btn btn-cream btn-block" type="button" disabled>${icon("check")} 已报名，期待见面</button>
        <button class="btn btn-ghost btn-block" type="button" data-action="leave-activity" data-id="${item.id}">取消报名</button>`;
    } else if (item.status === "closed") {
      joinActions = `<button class="btn btn-cream btn-block" type="button" disabled>报名已截止</button>`;
    } else if (item.is_full) {
      joinActions = `<button class="btn btn-cream btn-block" type="button" disabled>名额已满</button>`;
    } else {
      joinActions = `<button class="btn btn-cream btn-block" type="button" data-action="join-activity" data-id="${item.id}">
        ${icon("send")} 报名参加
      </button>`;
    }

    let manageActions = "";
    if (isCreator && !item.is_past) {
      if (item.status === "cancelled") {
        manageActions = `<button class="btn btn-ghost btn-block btn-sm" type="button" data-action="manage-status" data-id="${item.id}" data-status="open">${icon("refresh")} 恢复活动</button>`;
      } else {
        if (item.status === "open") {
          manageActions += `<button class="btn btn-ghost btn-block btn-sm" type="button" data-action="manage-status" data-id="${item.id}" data-status="closed">${icon("user")} 停止报名</button>`;
        }
        if (item.status === "closed") {
          manageActions += `<button class="btn btn-ghost btn-block btn-sm" type="button" data-action="manage-status" data-id="${item.id}" data-status="open">${icon("refresh")} 重新开放报名</button>`;
        }
        manageActions += `<button class="btn btn-ghost btn-block btn-sm join-danger" type="button" data-action="manage-status" data-id="${item.id}" data-status="cancelled">${icon("x")} 取消活动</button>`;
      }
    }

    const contact = item.contact || "报名成功后由发起人联系";

    const participantSection = `
      <section class="detail-section">
        <h2>已经加入的伙伴</h2>
        ${
          participantCount > 0
            ? `<div class="participant-strip">
                 <div class="participant-strip-left">
                   <div class="avatar-stack">${previewAvatars}</div>
                   <p><strong>${participantCount} 位伙伴已报名</strong>${item.spots_left > 0 ? `还有 ${item.spots_left} 个名额` : "名额已经满了"}</p>
                 </div>
                 <span class="spots ${item.spots_left <= 3 ? "spots--urgent" : ""}"><span class="dot"></span>${item.spots_left > 0 ? `余 ${item.spots_left} 位` : "已满员"}</span>
               </div>`
            : `<p class="participant-empty">还没有人报名。来成为第一位同行者吧。</p>`
        }
      </section>`;

    let creatorPanel = "";
    if (isCreator) {
      const participants = state.participants?.participants || [];
      creatorPanel = `
        <section class="detail-section">
          <h2>报名名单${participants.length ? ` · ${participants.length}` : ""}</h2>
          ${
            participants.length
              ? `<div class="participants-panel">${participants
                  .map(
                    (person) => `
                      <div class="participant-item">
                        ${avatar(person.display_name, "md")}
                        <div class="participant-item-copy">
                          <div class="participant-item-head">
                            <strong>${esc(person.display_name)}</strong>
                            <span>@${esc(person.username)} · ${formatJoined(person.created_at)} 报名</span>
                          </div>
                          ${person.message ? `<p>“${esc(person.message)}”</p>` : `<p class="muted">没有留言</p>`}
                          ${person.city ? `<span class="tag-mini">${esc(person.city)}</span>` : ""}
                        </div>
                      </div>`
                  )
                  .join("")}</div>`
              : `<p class="participant-empty">还没有人报名。活动发布后，可以在这里看到报名伙伴和留言。</p>`
          }
        </section>`;
    }

    const matchBox = match
      ? `<div class="join-match">
           <div class="join-match-head">${icon("spark")} 为你匹配 ${match.score}%</div>
           <p>${esc(match.reasons.join(" · "))}</p>
         </div>`
      : "";
    const backLabels = {
      "#/explore": "活动广场",
      "#/mine": "我的微光",
      "#/discover": "发现",
    };

    return `
      <div class="detail-page">
        <div class="container">
          <a class="back-link" href="${state.backTo}">${icon("arrow-left")} 返回${esc(backLabels[state.backTo] || "上一页")}</a>
          <div class="detail-grid">
            <article class="detail-main reveal">
              <div class="detail-cover" style="--cat:${cat.color}">
                <span class="detail-cover-icon">${icon(cat.icon)}</span>
                <div class="detail-cover-top">
                  <span class="cat-badge">${icon(cat.icon)}${esc(item.category)}</span>
                  <span class="status-pill ${statusClass}">${esc(statusLabel)}</span>
                </div>
                <span class="detail-cover-note">${esc(item.city)} · ${esc(item.weekday_label)} ${esc(item.time_label)}</span>
                <div class="date-tile">
                  <strong>${esc(item.day_label)}</strong>
                  <span>${esc(item.month_label)}<b>${esc(item.year_label)}</b></span>
                </div>
              </div>
              <div class="detail-content">
                <div class="detail-kicker">
                  <span class="chip-dot" style="--cat:${cat.color}"></span>
                  <span>${esc(item.category)}</span>
                  <span>·</span>
                  <span>${esc(item.creator_name)} 发起</span>
                  <span>·</span>
                  <span>${esc(item.duration_label)}</span>
                </div>
                <h1>${esc(item.title)}</h1>

                <div class="detail-meta-grid">
                  <div class="detail-meta-item">
                    ${icon("calendar")}
                    <div><span>活动时间</span><strong>${esc(item.start_display)}</strong></div>
                  </div>
                  <div class="detail-meta-item">
                    ${icon("pin")}
                    <div><span>集合地点</span><strong>${esc(item.city)} · ${esc(item.location)}</strong></div>
                  </div>
                  <div class="detail-meta-item">
                    ${icon("users")}
                    <div><span>招募人数</span><strong>${item.capacity} 人 · ${item.is_full ? "已满员" : `还差 ${item.spots_left} 人`}</strong></div>
                  </div>
                  <div class="detail-meta-item">
                    ${icon("mail")}
                    <div><span>联系方式</span><strong>${esc(contact)}</strong></div>
                  </div>
                </div>

                <section class="detail-section">
                  <h2>关于这场活动</h2>
                  <p class="detail-description">${esc(item.description)}</p>
                  ${item.tags?.length ? `<div class="detail-tags">${item.tags.map((tag) => `<span class="chip"># ${esc(tag)}</span>`).join("")}</div>` : ""}
                </section>

                ${participantSection}
                ${creatorPanel}

                <div class="detail-note">
                  ${icon("shield")}
                  <span>请按约定时间到达，并注意出行安全。报名后如无法参加，请尽早取消，把名额留给其他伙伴。活动由个人发起，请在参与前与发起人确认具体安排。</span>
                </div>
              </div>
            </article>

            <aside class="join-card reveal reveal-1">
              <div class="join-kicker">
                <span>${esc(statusLabel)}</span>
                ${item.status === "open" && !item.is_past ? `<span class="live-dot">可报名</span>` : ""}
              </div>
              <div class="join-spots">
                <strong>${item.spots_left}</strong>
                <span>/ ${item.capacity} 个名额剩余</span>
              </div>
              <div class="join-progress" aria-hidden="true"><span style="width:${item.fill_percent}%"></span></div>
              <div class="join-mini">
                <div class="join-mini-row">${icon("calendar")}<div><strong>${esc(item.date_label)} ${esc(item.weekday_label)}</strong>${esc(item.time_label)}</div></div>
                <div class="join-mini-row">${icon("pin")}<div><strong>${esc(item.city)}</strong>${esc(item.location)}</div></div>
                <div class="join-mini-row">${icon("users")}<div><strong>${participantCount} 位伙伴已加入</strong>${item.status === "open" && !item.is_past ? "报名后即可与发起人联系" : "报名已结束"}</div></div>
              </div>
              ${matchBox}
              <div class="join-actions">
                ${joinActions}
                ${manageActions}
              </div>
              <div class="host-block">
                ${avatar(item.creator_name, "md")}
                <div class="host-block-copy">
                  <strong>${esc(item.creator_name)}</strong>
                  <span>活动发起人${item.creator_city ? ` · ${esc(item.creator_city)}` : ""}</span>
                </div>
              </div>
              <p class="join-note">${icon("shield")} 请与发起人确认活动细节，注意人身与财物安全。</p>
            </aside>
          </div>
        </div>
      </div>`;
  }

  /* ------------------------------------------------------------------ render */

  function setRouteLoading(label = "正在准备…") {
    view.innerHTML = `
      <div class="page">
        <div class="container">
          <div class="boot-screen" style="min-height:52vh">
            <span class="boot-mark">${icon("logo")}</span>
            <p>${esc(label)}</p>
          </div>
        </div>
      </div>`;
  }

  function renderView() {
    const { name } = state.route;
    let markup;
    if (name === "discover") markup = discoverView();
    else if (name === "explore") markup = exploreView();
    else if (name === "publish") markup = publishView();
    else if (name === "mine") markup = mineView();
    else if (name === "activity") markup = detailView();
    else markup = discoverView();
    view.innerHTML = markup;
    updateDocumentTitle();
    bindPage(name);
  }

  function updateDocumentTitle() {
    const titles = {
      discover: "发现 · 微光",
      explore: "活动广场 · 微光",
      publish: "发起活动 · 微光",
      mine: "我的微光",
      activity: state.detail ? `${state.detail.title} · 微光` : "活动详情 · 微光",
    };
    document.title = titles[state.route.name] || "微光 · 让善意遇见彼此";
  }

  function renderRouteError(error) {
    const message =
      error?.status === 404 ? "没有找到这个活动，它可能已被发起人删除。" : error?.message || "加载失败，请稍后再试。";
    view.innerHTML = `
      <div class="page">
        <div class="container">
          <section class="auth-gate">
            <div class="auth-gate-icon">${icon("alert")}</div>
            <h1>这一页暂时没有亮起来。</h1>
            <p>${esc(message)}</p>
            <div class="auth-gate-actions">
              <button class="btn btn-primary" type="button" data-action="retry-route">${icon("refresh")} 再试一次</button>
              <a class="btn btn-ghost" href="#/discover">回到发现</a>
            </div>
          </section>
        </div>
      </div>`;
    updateDocumentTitle();
  }

  async function renderRoute() {
    const token = ++state.routeToken;
    state.route = parseRoute();
    const { name, id } = state.route;
    if (["discover", "explore", "mine"].includes(name)) {
      state.backTo = `#/${name}`;
    }
    renderChrome();
    closeModal();
    window.scrollTo({ top: 0, left: 0, behavior: "auto" });

    try {
      if (name === "discover") {
        setRouteLoading("正在为你寻找合适的活动…");
        const [recs, list] = await Promise.all([
          api("/recommendations?limit=3"),
          api("/activities?limit=6"),
        ]);
        if (token !== state.routeToken) return;
        rememberMatches(recs.recommendations || []);
        const recIds = new Set((recs.recommendations || []).map((item) => item.id));
        const upcoming = (list.activities || []).filter((item) => !recIds.has(item.id)).slice(0, 4);
        state.home = {
          recs: recs.recommendations || [],
          upcoming: upcoming.length ? upcoming : (list.activities || []).slice(0, 4),
          personalized: Boolean(recs.personalized),
          reason: recs.reason || "",
        };
      } else if (name === "explore") {
        setRouteLoading("正在打开活动广场…");
        const data = await api(`/activities?${exploreParams().toString()}`);
        if (token !== state.routeToken) return;
        state.explore.items = data.activities || [];
        state.explore.count = data.count || 0;
        state.explore.loading = false;
      } else if (name === "publish") {
        setRouteLoading("正在准备发布表单…");
      } else if (name === "mine") {
        if (!state.me) {
          renderView();
          return;
        }
        setRouteLoading("正在整理你的志愿记录…");
        const data = await api("/my/activities");
        if (token !== state.routeToken) return;
        state.mine = data;
      } else if (name === "activity") {
        setRouteLoading("正在打开活动详情…");
        const data = await api(`/activities/${id}`);
        if (token !== state.routeToken) return;
        state.detail = data.activity;
        state.participants = null;
        if (state.me && data.activity.is_creator) {
          try {
            const participants = await api(`/activities/${id}/participants`);
            if (token !== state.routeToken) return;
            state.participants = participants;
          } catch (error) {
            if (error.status !== 403) throw error;
          }
        }
      }
    } catch (error) {
      if (token !== state.routeToken) return;
      renderRouteError(error);
      return;
    }

    if (token !== state.routeToken) return;
    renderView();
  }

  /* ---------------------------------------------------------- explore binding */

  function exploreParams() {
    const params = new URLSearchParams();
    const filters = state.explore.filters;
    if (filters.q) params.set("q", filters.q);
    if (filters.category) params.set("category", filters.category);
    if (filters.city) params.set("city", filters.city);
    if (filters.when) params.set("when", filters.when);
    params.set("limit", "60");
    return params;
  }

  function renderExploreGrid() {
    const grid = $("#explore-grid");
    if (!grid) return;
    const count = $("#result-count");
    if (state.explore.loading) {
      grid.innerHTML = skeletonGrid(3);
      if (count) count.innerHTML = "正在寻找合适的活动…";
      return;
    }
    const items = state.explore.items || [];
    if (!items.length) {
      grid.innerHTML = emptyState(
        "没有找到匹配的活动",
        "换一个关键词或筛选条件试试。也许你想做的事，还没有人发起。",
        `<a class="btn btn-primary btn-sm" href="#/publish">${icon("plus")} 发起活动</a>`
      );
    } else {
      grid.innerHTML = `<div class="activity-grid">${items.map((item) => activityCard(item)).join("")}</div>`;
    }
    if (count) count.innerHTML = `找到 <strong>${state.explore.count}</strong> 场活动`;
    const clear = $("#clear-filters");
    if (clear) clear.hidden = !hasExploreFilters();
  }

  async function refreshExplore() {
    const token = ++state.exploreToken;
    state.explore.loading = true;
    renderExploreGrid();
    try {
      const data = await api(`/activities?${exploreParams().toString()}`);
      if (token !== state.exploreToken) return;
      state.explore.items = data.activities || [];
      state.explore.count = data.count || 0;
      state.explore.loading = false;
      renderExploreGrid();
    } catch (error) {
      if (token !== state.exploreToken) return;
      state.explore.loading = false;
      state.explore.items = [];
      state.explore.count = 0;
      renderExploreGrid();
      toast(error.message || "筛选失败，请稍后再试", "error");
    }
  }

  function bindExplore() {
    const search = $("#explore-search");
    const city = $("#city-filter");
    const when = $("#when-filter");
    const clear = $("#clear-filters");

    if (search) {
      search.addEventListener("input", () => {
        state.explore.filters.q = search.value.trim();
        window.clearTimeout(exploreTimer);
        exploreTimer = window.setTimeout(refreshExplore, 280);
      });
    }
    city?.addEventListener("change", () => {
      state.explore.filters.city = city.value;
      refreshExplore();
    });
    when?.addEventListener("change", () => {
      state.explore.filters.when = when.value;
      refreshExplore();
    });
    $$("[data-category-filter]", view).forEach((button) => {
      button.addEventListener("click", () => {
        state.explore.filters.category = button.dataset.categoryFilter || "";
        $$("[data-category-filter]", view).forEach((item) => {
          const active = item.dataset.categoryFilter === state.explore.filters.category;
          item.classList.toggle("is-active", active);
          item.setAttribute("aria-pressed", String(active));
        });
        refreshExplore();
      });
    });
    clear?.addEventListener("click", () => {
      state.explore.filters = { q: "", category: "", city: "", when: "" };
      if (search) search.value = "";
      if (city) city.value = "";
      if (when) when.value = "";
      $$("[data-category-filter]", view).forEach((item) => {
        const active = !item.dataset.categoryFilter;
        item.classList.toggle("is-active", active);
        item.setAttribute("aria-pressed", String(active));
      });
      refreshExplore();
    });
  }

  /* ---------------------------------------------------------- publish binding */

  function getPublishDraft() {
    const form = $("#publish-form");
    if (!form) return null;
    const data = new FormData(form);
    const tags = $$(".tag-option.is-active", form).map((button) => button.dataset.tag);
    return {
      title: String(data.get("title") || "").trim(),
      category: String(data.get("category") || ""),
      description: String(data.get("description") || "").trim(),
      city: String(data.get("city") || "").trim(),
      location: String(data.get("location") || "").trim(),
      start_at: String(data.get("start_at") || ""),
      end_at: String(data.get("end_at") || ""),
      capacity: Number(data.get("capacity") || 0),
      contact: String(data.get("contact") || "").trim(),
      tags,
    };
  }

  function previewMarkup(draft) {
    const cat = catOf(draft.category);
    const start = parseInputDate(draft.start_at);
    const end = parseInputDate(draft.end_at);
    const day = start ? pad(start.getDate()) : "--";
    const month = start ? `${pad(start.getMonth() + 1)}月` : "--月";
    const weekday = start ? weekdayCn(start) : "待定";
    const time =
      start && end
        ? `${pad(start.getHours())}:${pad(start.getMinutes())}–${pad(end.getHours())}:${pad(end.getMinutes())}`
        : "时间待定";
    const place = [draft.city, draft.location].filter(Boolean).join(" · ") || "地点待定";
    const title = draft.title || "给活动起一个温暖的名字";
    const description = draft.description || "写下这场活动会做什么、需要怎样的伙伴，以及你会提供的支持。";
    const tags = draft.tags.length
      ? draft.tags.slice(0, 3).map((tag) => `#${tag}`).join("  ")
      : "# 等待添加标签";

    return `
      <div class="preview-wrap">
        <div class="preview-cover" style="--cat:${cat.color}">
          <span class="cover-icon">${icon(cat.icon)}</span>
          <span class="cat-badge">${icon(cat.icon)}${esc(draft.category || "活动类别")}</span>
          <div class="date-tile">
            <strong>${day}</strong>
            <span>${month}<b>${weekday}</b></span>
          </div>
        </div>
        <div class="preview-body">
          <h3>${esc(title)}</h3>
          <div class="preview-meta">
            <span>${icon("clock")}${esc(time)}</span>
            <span>${icon("pin")}${esc(place)}</span>
            <span>${icon("users")}招募 ${draft.capacity || 0} 人</span>
          </div>
          <p class="preview-desc">${esc(description)}</p>
          <div class="preview-foot">
            <span>${esc(tags)}</span>
            <strong>${draft.capacity || 0} 个名额</strong>
          </div>
        </div>
      </div>`;
  }

  let publishPreviewFrame = 0;

  function updatePublishPreview() {
    window.cancelAnimationFrame(publishPreviewFrame);
    publishPreviewFrame = window.requestAnimationFrame(() => {
      const container = $("#preview-card");
      const draft = getPublishDraft();
      if (!container || !draft) return;
      container.innerHTML = previewMarkup(draft);
    });
  }

  function bindPublish() {
    const form = $("#publish-form");
    if (!form) return;
    form.addEventListener("input", updatePublishPreview);
    form.addEventListener("change", updatePublishPreview);
    $$(".tag-option", form).forEach((button) => {
      button.addEventListener("click", () => {
        const wasActive = button.classList.contains("is-active");
        if (!wasActive && $$(".tag-option.is-active", form).length >= 6) {
          toast("活动标签最多选择 6 个", "info");
          return;
        }
        button.classList.toggle("is-active");
        button.setAttribute("aria-pressed", String(button.classList.contains("is-active")));
        updatePublishPreview();
      });
    });
    const start = $("#pub-start");
    const end = $("#pub-end");
    start?.addEventListener("change", () => {
      const startDate = parseInputDate(start.value);
      const endDate = parseInputDate(end?.value);
      if (startDate && (!endDate || endDate <= startDate)) {
        if (end) end.value = toLocalInput(addHours(startDate, 3));
      }
      updatePublishPreview();
    });
    updatePublishPreview();
  }

  /* ------------------------------------------------------------- auth modals */

  function authModalMarkup(tab) {
    const isLogin = tab === "login";
    const stats = state.meta?.stats || {};
    return `
      <div class="modal-backdrop" data-modal-backdrop>
        <div class="auth-panel" role="dialog" aria-modal="true" aria-labelledby="auth-title">
          <button class="modal-close" type="button" data-action="close-modal" aria-label="关闭">${icon("x")}</button>
          <aside class="auth-art">
            <a class="brand" href="#/discover" aria-label="微光首页">
              <span class="brand-mark">${icon("logo")}</span>
              <span class="brand-name">微光</span>
              <span class="brand-sub">VOLUNTEER</span>
            </a>
            <div class="auth-art-copy">
              ${icon("quote")}
              <blockquote>每一次伸手，<br>都让城市<em>柔软一点。</em></blockquote>
              <p>微光是一个只在本机运行的志愿活动空间。账号、偏好和报名记录都留在这台电脑上，不会被上传到任何地方。</p>
            </div>
            <div class="auth-art-foot">
              <div class="avatar-stack">
                ${["林晓", "陈默", "苏月"].map((name) => avatar(name, "sm")).join("")}
              </div>
              <p><strong>${stats.volunteers || 1} 位伙伴已经在这里</strong>把一点时间，变成了别人的光</p>
            </div>
          </aside>

          <div class="auth-form-wrap">
            <div class="auth-tabs" role="tablist" aria-label="登录或注册">
              <button class="auth-tab ${isLogin ? "is-active" : ""}" type="button" role="tab" aria-selected="${isLogin}" data-action="auth-tab" data-tab="login">登录</button>
              <button class="auth-tab ${!isLogin ? "is-active" : ""}" type="button" role="tab" aria-selected="${!isLogin}" data-action="auth-tab" data-tab="register">注册</button>
            </div>
            <h2 id="auth-title">${isLogin ? "欢迎回来。" : "很高兴遇见你。"}</h2>
            <p class="auth-sub">${isLogin ? "登录后，微光会继续记得你的兴趣和报名记录。" : "创建一个本地账号，开始接收属于你的志愿推荐。"}</p>
            ${
              isLogin
                ? `<form class="auth-form" id="login-form" novalidate>
                     <label class="field"><span>账号</span><input class="input" name="username" autocomplete="username" placeholder="例如 demo" required autofocus></label>
                     <label class="field"><span>密码</span><input class="input" name="password" type="password" autocomplete="current-password" placeholder="输入你的密码" required></label>
                     <div class="form-error auth-error" id="auth-error" hidden></div>
                     <button class="btn btn-primary btn-block" type="submit">${icon("arrow-right")} 登录并继续</button>
                   </form>`
                : `<form class="auth-form" id="register-form" novalidate>
                     <div class="form-row">
                       <label class="field"><span>账号</span><input class="input" name="username" autocomplete="username" placeholder="字母/数字，3–20 位" required autofocus></label>
                       <label class="field"><span>昵称</span><input class="input" name="display_name" autocomplete="nickname" placeholder="大家怎么称呼你" required></label>
                     </div>
                     <div class="form-row">
                       <label class="field"><span>常驻城市 <small>选填</small></span><input class="input" name="city" autocomplete="address-level2" placeholder="例如：杭州"></label>
                       <label class="field"><span>密码</span><input class="input" name="password" type="password" autocomplete="new-password" placeholder="至少 6 位" required></label>
                     </div>
                     <label class="field"><span>确认密码</span><input class="input" name="confirm" type="password" autocomplete="new-password" placeholder="再输入一次密码" required></label>
                     <div class="form-error auth-error" id="auth-error" hidden></div>
                     <button class="btn btn-primary btn-block" type="submit">${icon("spark")} 加入微光</button>
                   </form>`
            }
            <div class="auth-switch">
              ${isLogin ? "还没有账号？" : "已经有账号？"}
              <button type="button" data-action="auth-tab" data-tab="${isLogin ? "register" : "login"}">${isLogin ? "创建一个" : "去登录"}</button>
            </div>
            <div class="demo-box">
              <div>
                <strong>想先看看？</strong>
                <span>演示账号 <code>demo</code> / <code>demo1234</code></span>
              </div>
              <button class="text-button" type="button" data-action="demo-login">一键体验 ${icon("arrow-right")}</button>
            </div>
            <p class="auth-privacy">${icon("shield")} 数据仅保存在本机 · 不上传云端</p>
          </div>
        </div>
      </div>`;
  }

  function openAuth(tab = "login") {
    state.authTab = tab === "register" ? "register" : "login";
    modalCleanup = null;
    openModal(authModalMarkup(state.authTab));
  }

  async function finishAuth(user, message) {
    state.me = user;
    state.mine = null;
    state.home.recs = [];
    state.home.upcoming = [];
    state.matchCache.clear();
    closeModal();
    renderChrome();
    toast(message, "success");
    await renderRoute();
  }

  async function handleAuthSubmit(form, mode) {
    const data = new FormData(form);
    const errorBox = $("#auth-error");
    const button = form.querySelector('button[type="submit"]');
    clearFormError(errorBox);
    const username = String(data.get("username") || "").trim();
    const password = String(data.get("password") || "");
    if (!username || !password) {
      showFormError(errorBox, "请输入账号和密码");
      return;
    }
    if (mode === "register") {
      if (password !== String(data.get("confirm") || "")) {
        showFormError(errorBox, "两次输入的密码不一致");
        return;
      }
      if (password.length < 6) {
        showFormError(errorBox, "密码至少需要 6 位");
        return;
      }
    }
    setButtonBusy(button, true, mode === "register" ? "正在创建账号…" : "正在登录…");
    try {
      let result;
      if (mode === "register") {
        result = await api("/auth/register", {
          method: "POST",
          body: {
            username,
            password,
            display_name: String(data.get("display_name") || "").trim(),
            city: String(data.get("city") || "").trim(),
          },
        });
        await finishAuth(result.user, "欢迎加入微光，先去看看适合你的活动吧。");
      } else {
        result = await api("/auth/login", { method: "POST", body: { username, password } });
        await finishAuth(result.user, `欢迎回来，${result.user.display_name}。`);
      }
    } catch (error) {
      showFormError(errorBox, error.message || "操作失败，请稍后再试");
      setButtonBusy(button, false);
    }
  }

  async function handleDemoLogin(button) {
    setButtonBusy(button, true, "正在进入…");
    try {
      const result = await api("/auth/login", {
        method: "POST",
        body: { username: "demo", password: "demo1234" },
      });
      await finishAuth(result.user, "已进入演示账号，慢慢逛。");
    } catch (error) {
      toast(error.message || "演示账号暂不可用", "error");
      setButtonBusy(button, false);
    }
  }

  /* ------------------------------------------------------------ join & manage */

  function joinModalMarkup(item) {
    return `
      <div class="modal-backdrop" data-modal-backdrop>
        <div class="modal-card" role="dialog" aria-modal="true" aria-labelledby="join-title">
          <button class="modal-close" type="button" data-action="close-modal" aria-label="关闭">${icon("x")}</button>
          <div class="confirm-icon">${icon("send")}</div>
          <h2 id="join-title">报名「${esc(item.title)}」</h2>
          <p class="modal-sub">${esc(item.start_display)} · ${esc(item.location)}。<br>报名后，发起人可以看到你的留言，并与你确认具体安排。</p>
          <form class="modal-form" id="join-form" novalidate>
            <label class="field">
              <span>给发起人留言 <small>选填，最多 200 字</small></span>
              <textarea class="textarea" name="message" maxlength="200" style="min-height:90px" placeholder="例如：我可以提前到场帮忙布置，也可以带一些物资。"></textarea>
            </label>
            <div class="form-error" id="join-error" hidden></div>
            <div class="modal-actions">
              <button class="btn btn-ghost" type="button" data-action="close-modal">再想想</button>
              <button class="btn btn-primary" type="submit" id="join-submit">${icon("check")} 确认报名</button>
            </div>
          </form>
        </div>
      </div>`;
  }

  function openJoinModal(item) {
    if (!state.me) {
      openAuth("login");
      return;
    }
    modalCleanup = null;
    openModal(joinModalMarkup(item));
  }

  async function handleJoinSubmit(form) {
    const item = state.detail;
    if (!item) return;
    const data = new FormData(form);
    const errorBox = $("#join-error");
    const button = $("#join-submit");
    clearFormError(errorBox);
    setButtonBusy(button, true, "正在报名…");
    try {
      const result = await api(`/activities/${item.id}/registrations`, {
        method: "POST",
        body: { message: String(data.get("message") || "").trim() },
      });
      state.detail = result.activity;
      state.mine = null;
      state.home.recs = [];
      state.home.upcoming = [];
      closeModal();
      renderView();
      toast("报名成功，记得把时间留出来。", "success");
    } catch (error) {
      showFormError(errorBox, error.message || "报名失败，请稍后再试");
      setButtonBusy(button, false);
    }
  }

  async function handleLeave(item) {
    const confirmed = await confirmDialog({
      title: "取消这次报名？",
      message: `你即将取消「${item.title}」的报名。名额会重新释放给其他伙伴。`,
      confirmText: "取消报名",
      cancelText: "保留报名",
      danger: true,
      iconName: "alert",
      points: "如果只是时间有变动，也可以先联系发起人确认是否还能参加。",
    });
    if (!confirmed) return;
    try {
      const result = await api(`/activities/${item.id}/registrations`, { method: "DELETE" });
      state.detail = result.activity;
      state.mine = null;
      state.home.recs = [];
      state.home.upcoming = [];
      renderView();
      toast("已取消报名，名额留给下一位伙伴。", "info");
    } catch (error) {
      toast(error.message || "取消报名失败", "error");
    }
  }

  async function handleManageStatus(item, status) {
    const config = {
      closed: {
        title: "停止这场活动的报名？",
        message: "已经报名的伙伴会保留在名单里，但新的伙伴将无法再报名。你之后可以重新开放。",
        confirmText: "停止报名",
        danger: false,
        iconName: "users",
      },
      open: {
        title: "重新开放报名？",
        message: "活动会再次出现在活动广场，并允许新的伙伴报名。",
        confirmText: "重新开放",
        danger: false,
        iconName: "refresh",
      },
      cancelled: {
        title: "取消这场活动？",
        message: "活动会被标记为已取消，并从活动广场移除。请尽量提前告知已经报名的伙伴。",
        confirmText: "取消活动",
        danger: true,
        iconName: "alert",
        points: "取消后，活动详情仍会保留在已报名伙伴的记录里。",
      },
    }[status];
    if (!config) return;
    const confirmed = await confirmDialog({ ...config, cancelText: "先不操作" });
    if (!confirmed) return;
    try {
      const result = await api(`/activities/${item.id}`, {
        method: "PATCH",
        body: { status },
      });
      state.detail = result.activity;
      if (state.me && result.activity.is_creator) {
        try {
          state.participants = await api(`/activities/${item.id}/participants`);
        } catch (error) {
          state.participants = null;
        }
      }
      renderView();
      toast(
        status === "cancelled"
          ? "活动已取消。记得告知已经报名的伙伴。"
          : status === "closed"
            ? "报名已停止，已报名的伙伴会保留在名单里。"
            : "活动已重新开放报名。",
        status === "cancelled" ? "info" : "success"
      );
    } catch (error) {
      toast(error.message || "操作失败", "error");
    }
  }

  /* --------------------------------------------------------------- profile save */

  async function handlePrefsSubmit(form) {
    const data = new FormData(form);
    const errorBox = $("#prefs-error");
    const button = $("#prefs-submit");
    clearFormError(errorBox);
    setButtonBusy(button, true, "正在保存…");
    try {
      const result = await api("/profile", {
        method: "PUT",
        body: {
          display_name: String(data.get("display_name") || "").trim(),
          city: String(data.get("city") || "").trim(),
          bio: String(data.get("bio") || "").trim(),
          interests: data.getAll("interests").map(String),
          availability: data.getAll("availability").map(String),
        },
      });
      state.me = result.user;
      state.home.recs = [];
      state.home.upcoming = [];
      state.matchCache.clear();
      renderChrome();
      renderView();
      toast("偏好已保存，推荐已经更新。", "success");
    } catch (error) {
      showFormError(errorBox, error.message || "保存失败，请稍后再试");
      setButtonBusy(button, false);
    }
  }

  /* ---------------------------------------------------------------- publish */

  async function handlePublishSubmit(form) {
    const draft = getPublishDraft();
    const errorBox = $("#publish-error");
    const button = $("#publish-submit");
    if (!draft) return;
    clearFormError(errorBox);

    let message = "";
    if (draft.title.length < 4) message = "活动名称至少需要 4 个字符";
    else if (!draft.category) message = "请选择一个活动类别";
    else if (draft.description.length < 20) message = "活动介绍至少需要 20 个字符，把安排写得更具体一些";
    else if (!draft.city) message = "请填写所在城市，线上活动可以填写「线上」";
    else if (draft.location.length < 2) message = "请填写具体的活动地点";
    else if (!Number.isFinite(draft.capacity) || draft.capacity < 1 || draft.capacity > 500) message = "招募人数需在 1–500 人之间";

    const start = parseInputDate(draft.start_at);
    const end = parseInputDate(draft.end_at);
    if (!message) {
      if (!start || !end) message = "请选择有效的开始和结束时间";
      else if (start <= new Date()) message = "开始时间需要晚于现在";
      else if (end <= start) message = "结束时间需要晚于开始时间";
    }
    if (message) {
      showFormError(errorBox, message);
      errorBox.scrollIntoView({ behavior: "smooth", block: "center" });
      return;
    }

    setButtonBusy(button, true, "正在发布…");
    try {
      const result = await api("/activities", { method: "POST", body: draft });
      state.explore.items = [];
      state.explore.count = 0;
      state.home.recs = [];
      state.home.upcoming = [];
      state.backTo = "#/mine";
      toast("活动已发布，正在等待第一位同行者。", "success");
      navigate("activity", result.activity.id);
    } catch (error) {
      showFormError(errorBox, error.message || "发布失败，请稍后再试");
      errorBox.scrollIntoView({ behavior: "smooth", block: "center" });
      setButtonBusy(button, false);
    }
  }

  /* ------------------------------------------------------------------ logout */

  async function handleLogout() {
    const confirmed = await confirmDialog({
      title: "要退出登录吗？",
      message: "你的偏好、报名和发起记录都会保留在本机，下次登录还能继续。",
      confirmText: "退出登录",
      cancelText: "继续留下",
      danger: false,
      iconName: "logout",
    });
    if (!confirmed) return;
    try {
      await api("/auth/logout", { method: "POST" });
      state.me = null;
      state.mine = null;
      state.detail = null;
      state.home = { recs: [], upcoming: [], personalized: false, reason: "" };
      state.matchCache.clear();
      renderChrome();
      toast("已退出登录，随时回来。", "info");
      if (state.route.name === "discover") await renderRoute();
      else navigate("discover");
    } catch (error) {
      toast(error.message || "退出登录失败", "error");
    }
  }

  /* ------------------------------------------------------------------- binds */

  function bindPage(name) {
    if (name === "explore") bindExplore();
    else if (name === "publish") bindPublish();
  }

  function bindGlobalEvents() {
    window.addEventListener("hashchange", () => {
      renderRoute();
    });

    window.addEventListener(
      "scroll",
      () => {
        if (scrollTicking) return;
        scrollTicking = true;
        window.requestAnimationFrame(() => {
          topbar.classList.toggle("is-scrolled", window.scrollY > 8);
          scrollTicking = false;
        });
      },
      { passive: true }
    );

    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && modalRoot.innerHTML) {
        event.preventDefault();
        closeModal();
        return;
      }
      trapFocus(event);
    });

    document.addEventListener("click", async (event) => {
      const backdrop = event.target.closest("[data-modal-backdrop]");
      if (backdrop && event.target === backdrop) {
        closeModal();
        return;
      }

      const cause = event.target.closest("[data-cause]");
      if (cause) {
        event.preventDefault();
        const category = cause.dataset.cause || "";
        state.explore.filters.category = category;
        if (state.route.name === "explore") {
          $$("[data-category-filter]", view).forEach((item) => {
            const active = (item.dataset.categoryFilter || "") === category;
            item.classList.toggle("is-active", active);
            item.setAttribute("aria-pressed", String(active));
          });
          refreshExplore();
        } else {
          navigate("explore");
        }
        return;
      }

      const actionElement = event.target.closest("[data-action]");
      if (!actionElement) return;
      const action = actionElement.dataset.action;

      if (action === "open-auth") {
        event.preventDefault();
        openAuth(actionElement.dataset.tab || "login");
      } else if (action === "close-modal") {
        event.preventDefault();
        closeModal();
      } else if (action === "auth-tab") {
        event.preventDefault();
        openAuth(actionElement.dataset.tab || "login");
      } else if (action === "demo-login") {
        event.preventDefault();
        handleDemoLogin(actionElement);
      } else if (action === "logout") {
        event.preventDefault();
        handleLogout();
      } else if (action === "scroll-to") {
        event.preventDefault();
        const target = document.getElementById(actionElement.dataset.target || "");
        if (target) {
          const top = target.getBoundingClientRect().top + window.scrollY - 92;
          window.scrollTo({ top, behavior: "smooth" });
        }
      } else if (action === "scroll-prefs") {
        event.preventDefault();
        const prefs = document.getElementById("preferences");
        if (prefs) {
          const top = prefs.getBoundingClientRect().top + window.scrollY - 92;
          window.scrollTo({ top, behavior: "smooth" });
          const firstInput = prefs.querySelector("input, textarea");
          window.setTimeout(() => firstInput?.focus({ preventScroll: true }), 450);
        }
      } else if (action === "mine-tab") {
        state.mineTab = actionElement.dataset.tab === "created" ? "created" : "joined";
        renderView();
      } else if (action === "join-activity") {
        event.preventDefault();
        if (state.detail) openJoinModal(state.detail);
      } else if (action === "leave-activity") {
        event.preventDefault();
        if (state.detail) handleLeave(state.detail);
      } else if (action === "manage-status") {
        event.preventDefault();
        if (state.detail) handleManageStatus(state.detail, actionElement.dataset.status);
      } else if (action === "retry-route") {
        event.preventDefault();
        renderRoute();
      }
    });

    document.addEventListener("submit", async (event) => {
      const form = event.target;
      if (form.id === "login-form") {
        event.preventDefault();
        await handleAuthSubmit(form, "login");
      } else if (form.id === "register-form") {
        event.preventDefault();
        await handleAuthSubmit(form, "register");
      } else if (form.id === "join-form") {
        event.preventDefault();
        await handleJoinSubmit(form);
      } else if (form.id === "publish-form") {
        event.preventDefault();
        await handlePublishSubmit(form);
      } else if (form.id === "prefs-form") {
        event.preventDefault();
        await handlePrefsSubmit(form);
      }
    });
  }

  /* -------------------------------------------------------------------- boot */

  async function boot() {
    bindGlobalEvents();
    try {
      const [meta, auth] = await Promise.all([api("/meta"), api("/auth/me")]);
      state.meta = meta;
      state.me = auth.user || null;
      document.body.classList.remove("is-booting");
      renderChrome();
      await renderRoute();
    } catch (error) {
      document.body.classList.remove("is-booting");
      view.innerHTML = `
        <div class="page">
          <div class="container">
            <section class="auth-gate">
              <div class="auth-gate-icon">${icon("alert")}</div>
              <h1>微光暂时没有亮起来。</h1>
              <p>${esc(error.message || "无法连接本地服务。请确认 app.py 正在运行，然后刷新页面。")}</p>
              <div class="auth-gate-actions">
                <a class="btn btn-primary" href="/">重新加载</a>
              </div>
            </section>
          </div>
        </div>`;
    }
  }

  boot();
})();
