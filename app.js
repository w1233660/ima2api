"use strict";

const fs = require("fs");
const path = require("path");
const http = require("http");
const crypto = require("crypto");
const { chromium } = require("playwright-core");
const api = require("./server");
const ima = require("./ima_client");

const CONFIG_PATH = path.resolve(__dirname, "config.json");
const PUBLIC_DIR = path.resolve(__dirname, "public");
const SESSION_COOKIE = "ima_admin";
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const TOKEN_REFRESH_EVERY_MS = 50 * 60 * 1000;
const CHECK_INTERVAL_MS = 60 * 1000;
const REFRESH_RETRY_MS = 2 * 60 * 1000;
const QR_WAIT_MS = 90 * 1000;
const LOGIN_WAIT_MS = 180 * 1000;

const sessions = new Map();
const loginJob = {
  status: "idle",
  message: "",
  qrDataUrl: "",
  startedAt: 0,
  error: "",
  result: null,
  browser: null,
  cancel: false,
};

function now() {
  return Date.now();
}

function readConfigFile() {
  return JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8"));
}

function writeConfigFile(cfg, opts = {}) {
  const prev = api.getRuntime().CONFIG || {};
  const prevUid = (prev.auth && prev.auth.user_id) || "";
  const text = JSON.stringify(cfg, null, 2);
  // Docker 单文件挂载不能用 rename 覆盖，只能直接写进去。
  fs.writeFileSync(CONFIG_PATH, text, "utf-8");
  api.applyConfig(cfg);
  const nextUid = (cfg.auth && cfg.auth.user_id) || "";
  if (opts.clearSessions || (prevUid && nextUid && prevUid !== nextUid)) {
    if (typeof api.clearImaSessions === "function") api.clearImaSessions();
  }
}

function adminPassword() {
  return (api.getRuntime().CONFIG.admin && api.getRuntime().CONFIG.admin.password) || "";
}

function sessionSecret() {
  return (api.getRuntime().CONFIG.admin && api.getRuntime().CONFIG.admin.session_secret) || "ima-admin";
}

function parseCookies(req) {
  const out = {};
  for (const part of String(req.headers.cookie || "").split(";")) {
    const idx = part.indexOf("=");
    if (idx < 0) continue;
    out[part.slice(0, idx).trim()] = decodeURIComponent(part.slice(idx + 1).trim());
  }
  return out;
}

function isAuthed(req) {
  const token = parseCookies(req)[SESSION_COOKIE];
  if (!token) return false;
  const rec = sessions.get(token);
  if (!rec) return false;
  if (rec.exp < now()) {
    sessions.delete(token);
    return false;
  }
  rec.exp = now() + SESSION_TTL_MS;
  return true;
}

function setSession(res) {
  const token = crypto.randomBytes(24).toString("hex");
  sessions.set(token, { exp: now() + SESSION_TTL_MS });
  res.setHeader("Set-Cookie", `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`);
}

function clearSession(res, req) {
  const token = parseCookies(req)[SESSION_COOKIE];
  if (token) sessions.delete(token);
  res.setHeader("Set-Cookie", `${SESSION_COOKIE}=; Path=/; HttpOnly; Max-Age=0`);
}

function sendJson(res, code, obj) {
  res.writeHead(code, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(obj));
}

function sendFile(res, filePath, contentType) {
  fs.readFile(filePath, (err, buf) => {
    if (err) {
      res.writeHead(404);
      res.end("not found");
      return;
    }
    res.writeHead(200, { "Content-Type": contentType });
    res.end(buf);
  });
}

function maskMid(s, head = 6, tail = 4) {
  const t = String(s || "");
  if (!t) return "";
  if (t.length <= head + tail) return "***";
  return `${t.slice(0, head)}...${t.slice(-tail)}`;
}

const ACCOUNT_COOL_MS = 90 * 1000;

function ensureAccounts(cfg) {
  if (!cfg || typeof cfg !== "object") return cfg;
  if (!Array.isArray(cfg.accounts)) cfg.accounts = [];
  const auth = cfg.auth || {};
  if (auth.cookie && (auth.user_id || auth.refresh_token)) {
    mergeAccountRecord(cfg, auth, { activate: false, allowWebOverwriteApp: false });
  }
  return cfg;
}

function publicAccount(acc, activeId) {
  const coolingUntil = Number(acc.cooling_until || 0);
  return {
    user_id: acc.user_id ? maskMid(acc.user_id, 4, 4) : "",
    user_id_full: acc.user_id || "",
    nickname: acc.nickname || "",
    login_source: acc.login_source || "",
    app_keepalive: Boolean(acc.registration_id),
    active: Boolean(acc.user_id && acc.user_id === activeId),
    cooling: coolingUntil > now(),
    cooling_until: coolingUntil,
    last_refresh_ok_at: Number(acc.last_refresh_ok_at || acc.updated_at || 0),
    last_refresh_error: acc.last_refresh_error || "",
    last_rate_limit_at: Number(acc.last_rate_limit_at || 0),
  };
}

function mergeAccountRecord(cfg, incoming, opts = {}) {
  if (!Array.isArray(cfg.accounts)) cfg.accounts = [];
  const userId = String(incoming.user_id || "");
  const idx = userId ? cfg.accounts.findIndex((a) => a.user_id === userId) : -1;
  const prev = idx >= 0 ? cfg.accounts[idx] : null;
  if (prev && prev.registration_id && incoming.login_source === "web-wechat" && !opts.allowWebOverwriteApp) {
    return prev;
  }
  const rec = {
    ...(prev || {}),
    ...incoming,
    user_id: userId || (prev && prev.user_id) || "",
    updated_at: incoming.updated_at || now(),
  };
  if (incoming.login_source === "web-wechat") rec.registration_id = "";
  if (idx >= 0) cfg.accounts[idx] = rec;
  else cfg.accounts.push(rec);
  const currentIsApp = Boolean(cfg.auth && cfg.auth.registration_id);
  const shouldActivate = opts.activate === true
    || (opts.activate !== false && !(currentIsApp && incoming.login_source === "web-wechat"));
  if (shouldActivate) cfg.auth = { ...rec };
  else if (cfg.auth && cfg.auth.user_id && cfg.auth.user_id === rec.user_id) cfg.auth = { ...rec };
  return rec;
}

function publicStatus() {
  const cfg = api.getRuntime().CONFIG;
  const auth = cfg.auth || {};
  const cookieOk = Boolean(auth.cookie && /IMA-TOKEN=/.test(auth.cookie));
  const refreshOk = Boolean(auth.refresh_token);
  const lastOk = Number(auth.last_refresh_ok_at || auth.updated_at || 0);
  const nextAt = lastOk ? lastOk + TOKEN_REFRESH_EVERY_MS : 0;
  const accounts = Array.isArray(cfg.accounts) ? cfg.accounts : [];
  return {
    logged_in: cookieOk && refreshOk,
    nickname: auth.nickname || "",
    user_id: auth.user_id ? maskMid(auth.user_id, 4, 4) : "",
    login_source: auth.login_source || "",
    updated_at: auth.updated_at || 0,
    cookie_ready: cookieOk,
    refresh_ready: refreshOk,
    app_keepalive: Boolean(auth.registration_id),
    last_refresh_ok_at: lastOk,
    last_refresh_error: auth.last_refresh_error || "",
    next_refresh_at: nextAt,
    refresh_fail_count: Number(auth.refresh_fail_count || 0),
    account_count: accounts.length,
    accounts: accounts.map((a) => publicAccount(a, auth.user_id)),
    keepalive_hint: !cookieOk || !refreshOk
      ? "没号。GLM-5.3 丢 App 的 har，网页码基本没用。"
      : auth.registration_id
        ? `大约 50 分钟续一次。池子 ${accounts.length} 个，问太快会换号。`
        : "这是网页号，GLM-5.3 大概率不行。要稳就丢 App 的 har。",
    models: Object.keys(cfg.models || {}),
    default_model: cfg.default_model,
    api_keys: (cfg.api_keys || []).map((k) => api.maskKey(k)),
  };
}

function applyOfficialModels(cfg, official) {
  if (!official || !official.models) return cfg;
  cfg.models = official.models;
  if (official.default_model) cfg.default_model = official.default_model;
  cfg.auth = cfg.auth || {};
  cfg.auth.preferred_model_id = official.preferred_model_id || cfg.auth.preferred_model_id || "";
  return cfg;
}

async function syncOfficialModels(reason = "manual") {
  const cfg = readConfigFile();
  if (!cfg.auth || !cfg.auth.cookie) return null;
  const official = await ima.fetchOfficialModels(cfg.auth);
  applyOfficialModels(cfg, official);
  writeConfigFile(cfg);
  console.log(`[models] synced via ${reason}: ${Object.keys(official.models).join(", ")} default=${official.default_model}`);
  return official;
}

function saveAccount(account, extra = {}) {
  const cfg = readConfigFile();
  ensureAccounts(cfg);
  const cookie = ima.accountToCookie(account, extra.device || account.device || {});
  const rec = {
    cookie,
    refresh_token: account.refreshToken || "",
    registration_id: extra.login_source === "web-wechat" ? "" : (extra.registration_id || ""),
    token_type: account.tokenType || extra.token_type || 14,
    user_id: account.userId || "",
    nickname: account.nickname || "",
    login_source: extra.login_source || "web-wechat",
    updated_at: now(),
    last_refresh_ok_at: now(),
    last_refresh_error: "",
    refresh_fail_count: 0,
    guid: extra.device?.guid || account.guid || "",
    q36: extra.device?.q36 || "",
  };
  mergeAccountRecord(cfg, rec, {
    activate: extra.activate,
    allowWebOverwriteApp: extra.allowWebOverwriteApp,
  });
  writeConfigFile(cfg);
  return cfg.auth;
}

function activateAccount(cfg, userId) {
  const acc = (cfg.accounts || []).find((a) => a.user_id === userId);
  if (!acc) throw new Error("找不到这个账号");
  acc.last_used_at = now();
  cfg.auth = { ...acc };
  writeConfigFile(cfg, { clearSessions: true });
  return acc;
}

function rotateActiveAccount(reason) {
  const cfg = readConfigFile();
  ensureAccounts(cfg);
  const currentId = (cfg.auth && cfg.auth.user_id) || "";
  const ts = now();
  if (currentId) {
    const cur = cfg.accounts.find((a) => a.user_id === currentId);
    if (cur) {
      cur.cooling_until = ts + ACCOUNT_COOL_MS;
      cur.last_rate_limit_at = ts;
      cur.last_rate_limit_msg = String(reason || "提问太快");
    }
  }
  const ready = cfg.accounts.filter((a) => {
    if (!a.cookie || !a.refresh_token || a.disabled) return false;
    if (a.user_id && a.user_id === currentId) return false;
    if (Number(a.cooling_until || 0) > ts) return false;
    return true;
  });
  ready.sort((a, b) => {
    const appDelta = Number(Boolean(b.registration_id)) - Number(Boolean(a.registration_id));
    if (appDelta) return appDelta;
    return Number(a.last_used_at || 0) - Number(b.last_used_at || 0);
  });
  if (!ready.length) {
    writeConfigFile(cfg);
    console.log("[rotate] no spare account");
    return false;
  }
  const next = ready[0];
  next.last_used_at = ts;
  cfg.auth = { ...next };
  writeConfigFile(cfg, { clearSessions: true });
  console.log(`[rotate] switch to user=${next.user_id || "-"} nick=${next.nickname || "-"}`);
  return true;
}

async function closeLoginBrowser() {
  try {
    if (loginJob.browser) await loginJob.browser.close();
  } catch {}
  loginJob.browser = null;
}

function extractWxCode(raw) {
  const text = String(raw || "");
  if (!text) return "";
  try {
    const u = new URL(text);
    const fromQuery = u.searchParams.get("code");
    if (fromQuery) return fromQuery;
    const hash = u.hash || "";
    const qIdx = hash.indexOf("?");
    if (qIdx >= 0) {
      const hp = new URLSearchParams(hash.slice(qIdx + 1));
      if (hp.get("code")) return hp.get("code");
    }
  } catch {}
  const m = text.match(/(?:[?&#]|\/\/)code=([A-Za-z0-9_-]+)/);
  return m ? decodeURIComponent(m[1]) : "";
}

function pickWxCode(...values) {
  for (const value of values) {
    if (!value) continue;
    if (typeof value === "string") {
      const direct = extractWxCode(value) || (/^[A-Za-z0-9_-]{8,}$/.test(value) ? value : "");
      if (direct) return direct;
      continue;
    }
    if (typeof value === "object") {
      const nested = pickWxCode(
        value.code,
        value.wxCode,
        value.wx_code,
        value.data,
        value.payload,
        value.detail,
      );
      if (nested) return nested;
    }
  }
  return "";
}

async function captureQrPng(page) {
  const iframe = page.locator("iframe[src*='open.weixin.qq.com'], iframe[src*='weixin.qq.com']").first();
  if (await iframe.count()) {
    try {
      const buf = await iframe.screenshot({ type: "png" });
      if (buf && buf.length > 800) return buf;
    } catch {}
    try {
      const box = await iframe.boundingBox();
      const view = page.viewportSize() || { width: 520, height: 720 };
      if (box && box.width > 80 && box.height > 80) {
        const clip = {
          x: Math.max(0, Math.floor(box.x - 12)),
          y: Math.max(0, Math.floor(box.y - 12)),
          width: Math.min(view.width, Math.ceil(box.width + 24)),
          height: Math.min(view.height, Math.ceil(box.height + 24)),
        };
        return await page.screenshot({ type: "png", clip });
      }
    } catch {}
  }
  for (const frame of page.frames()) {
    if (!/weixin\.qq\.com/.test(frame.url())) continue;
    const img = frame.locator("img").first();
    if (await img.count()) {
      try {
        const buf = await img.screenshot({ type: "png" });
        if (buf && buf.length > 800) return buf;
      } catch {}
    }
  }
  return null;
}

async function accountFromCookies(context) {
  const cookies = await context.cookies("https://ima.qq.com");
  const map = Object.fromEntries(cookies.map((c) => [c.name, c.value]));
  if (!map["IMA-TOKEN"]) return null;
  return {
    token: map["IMA-TOKEN"],
    refreshToken: map["IMA-REFRESH-TOKEN"] || "",
    userId: map["IMA-UID"] || "",
    tokenType: Number(map["TOKEN-TYPE"] || map["IMA-TOKEN-TYPE"] || 1),
    idType: map["UID-TYPE"] || "",
    guid: map["IMA-GUID"] || "",
    nickname: "",
    device: {
      guid: map["IMA-GUID"] || "",
      q36: map["IMA-Q36"] || "",
    },
  };
}

async function runQrLogin() {
  loginJob.status = "starting";
  loginJob.message = "正在打开官方登录页";
  loginJob.qrDataUrl = "";
  loginJob.error = "";
  loginJob.result = null;
  loginJob.startedAt = now();
  loginJob.cancel = false;

  const chromePath = process.env.CHROME_PATH || "/usr/bin/chromium-browser";
  let context;
  try {
    loginJob.browser = await chromium.launch({
      executablePath: chromePath,
      headless: true,
      args: ["--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu"],
    });
    context = await loginJob.browser.newContext({
      viewport: { width: 520, height: 720 },
      locale: "zh-CN",
      userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
    });
    const page = await context.newPage();
    let wxCode = "";
    let officialAccount = null;

    const takeCode = (raw) => {
      const code = pickWxCode(raw);
      if (code) wxCode = code;
    };

    await page.addInitScript(() => {
      window.__imaWxCode = "";
      window.addEventListener("message", (ev) => {
        try {
          const data = ev && ev.data;
          const pick = (value) => {
            if (!value) return "";
            if (typeof value === "string") {
              const m = value.match(/(?:[?&#]|\/\/)code=([A-Za-z0-9_-]+)/);
              if (m) return m[1];
              if (/^[A-Za-z0-9_-]{8,}$/.test(value)) return value;
              return "";
            }
            if (typeof value === "object") {
              return pick(value.code) || pick(value.wxCode) || pick(value.wx_code)
                || pick(value.data) || pick(value.payload) || pick(value.detail);
            }
            return "";
          };
          const code = pick(data);
          if (code) window.__imaWxCode = code;
        } catch {}
      });
    });

    page.on("framenavigated", (frame) => takeCode(frame.url()));
    page.on("request", (req) => takeCode(req.url()));
    page.on("response", async (res) => {
      takeCode(res.url());
      if (!/\/auth_login\/login/.test(res.url())) return;
      try {
        const data = await res.json();
        const account = ima.parseAccountFromLogin(data);
        if (account.token) {
          officialAccount = account;
          console.log("[qr] captured official login response");
        }
      } catch (e) {
        console.error("[qr] login response parse fail:", e.message);
      }
    });

    await page.goto("https://ima.qq.com/login/#/universal-login-qr-only/?targetOrigin=https%3A%2F%2Fima.qq.com", {
      waitUntil: "domcontentloaded",
      timeout: 45000,
    });

    loginJob.status = "waiting_qr";
    loginJob.message = "正在生成微信二维码";

    const qrStart = now();
    let qrFound = false;
    while (now() - qrStart < QR_WAIT_MS && !loginJob.cancel) {
      const shot = await captureQrPng(page);
      if (shot) {
        loginJob.qrDataUrl = `data:image/png;base64,${shot.toString("base64")}`;
        qrFound = true;
        loginJob.message = "请用微信扫上面的码";
        loginJob.status = "waiting_scan";
        break;
      }
      await page.waitForTimeout(700);
    }
    if (loginJob.cancel) throw new Error("已取消");
    if (!qrFound) throw new Error("官方登录二维码没有出来，请重试");
    console.log("[qr] qr ready, waiting scan");

    const waitStart = now();
    while (now() - waitStart < LOGIN_WAIT_MS && !loginJob.cancel) {
      const shot = await captureQrPng(page);
      if (shot) loginJob.qrDataUrl = `data:image/png;base64,${shot.toString("base64")}`;

      if (!officialAccount) {
        officialAccount = await accountFromCookies(context);
      }
      if (!wxCode) {
        const fromPage = await page.evaluate(() => window.__imaWxCode || "");
        takeCode(fromPage);
      }
      for (const frame of page.frames()) takeCode(frame.url());

      if (officialAccount && officialAccount.token) break;
      if (wxCode) break;
      await page.waitForTimeout(800);
    }
    if (loginJob.cancel) throw new Error("已取消");

    loginJob.status = "exchanging";
    loginJob.message = "扫码成功，正在入库";

    let account = officialAccount && officialAccount.token ? officialAccount : null;
    const device = account?.device || ima.randomDevice();
    if (!account && wxCode) {
      console.log("[qr] exchanging wx code ourselves");
      account = await ima.webLoginWithWxCode(wxCode, device);
    }
    if (!account || !account.token) {
      throw new Error("已经扫过了，但登录信息没接到。请再点一次「开始扫码」");
    }
    if (!account.refreshToken) {
      const fromCookie = await accountFromCookies(context);
      if (fromCookie?.refreshToken) account.refreshToken = fromCookie.refreshToken;
    }

    const auth = saveAccount(account, { device, login_source: "web-wechat" });
    try {
      await syncOfficialModels("login");
    } catch (e) {
      console.error("[models] login sync fail:", e.message);
    }
    loginJob.status = "success";
    loginJob.message = account.nickname ? `已入库：${account.nickname}` : "已入库";
    loginJob.result = {
      nickname: auth.nickname,
      user_id: maskMid(auth.user_id, 4, 4),
    };
    console.log(`[qr] saved user=${auth.user_id || "-"}`);
  } catch (e) {
    loginJob.status = "error";
    loginJob.error = e.message || String(e);
    loginJob.message = loginJob.error;
    console.error("[qr] fail:", loginJob.error);
  } finally {
    await closeLoginBrowser();
  }
}

async function startQrLogin() {
  if (loginJob.status === "starting" || loginJob.status === "waiting_qr" || loginJob.status === "waiting_scan" || loginJob.status === "exchanging") {
    return;
  }
  await closeLoginBrowser();
  runQrLogin();
}

async function cancelQrLogin() {
  loginJob.cancel = true;
  await closeLoginBrowser();
  if (loginJob.status !== "success") {
    loginJob.status = "idle";
    loginJob.message = "已取消";
    loginJob.qrDataUrl = "";
  }
}

let refreshLock = false;

async function refreshOneRecord(rec, force = false) {
  if (!rec || !rec.cookie || !rec.refresh_token) return { ok: false, skipped: true, error: "还没有长期票" };
  const last = Number(rec.last_refresh_ok_at || rec.updated_at || 0);
  const failCount = Number(rec.refresh_fail_count || 0);
  const interval = failCount > 0 ? REFRESH_RETRY_MS : TOKEN_REFRESH_EVERY_MS;
  if (!force && last && now() - last < interval) return { ok: true, skipped: true };
  const next = await ima.webRefresh(rec);
  rec.cookie = next.cookie;
  rec.refresh_token = next.refresh_token || rec.refresh_token;
  rec.user_id = next.user_id || rec.user_id;
  rec.token_type = next.token_type || rec.token_type || 14;
  rec.updated_at = now();
  rec.last_refresh_ok_at = now();
  rec.last_refresh_error = "";
  rec.refresh_fail_count = 0;
  if (next.token_valid_time) rec.token_expire_at = now() + Number(next.token_valid_time) * 1000;
  return { ok: true };
}

async function maybeRefresh(force = false) {
  if (refreshLock) return { ok: false, skipped: true, error: "正在续期" };
  refreshLock = true;
  try {
    const latest = readConfigFile();
    ensureAccounts(latest);
    if (!(latest.accounts || []).length && latest.auth && latest.auth.refresh_token) {
      latest.accounts = [{ ...latest.auth }];
    }
    if (!(latest.accounts || []).some((a) => a.refresh_token)) {
      return { ok: false, error: "还没有长期票，先入库一次" };
    }
    let anyTried = false;
    let anyOk = false;
    let lastErr = "";
    for (const rec of latest.accounts) {
      try {
        const result = await refreshOneRecord(rec, force);
        if (result.skipped) continue;
        anyTried = true;
        if (result.ok) {
          anyOk = true;
          console.log(`[refresh] ok user=${rec.user_id || "-"} source=${rec.login_source || "-"}`);
        }
      } catch (e) {
        anyTried = true;
        rec.last_refresh_error = e.message || String(e);
        rec.refresh_fail_count = Number(rec.refresh_fail_count || 0) + 1;
        lastErr = e.message || String(e);
        console.error(`[refresh] fail user=${rec.user_id || "-"}: ${lastErr}`);
      }
    }
    const activeId = (latest.auth && latest.auth.user_id) || "";
    const active = latest.accounts.find((a) => a.user_id === activeId) || latest.accounts[0];
    if (active) latest.auth = { ...active };
    writeConfigFile(latest);
    if (!anyTried) return { ok: true, skipped: true };
    if (anyOk) {
      try { await ima.fetchOfficialModels(latest.auth); } catch (e) {
        console.error("[keepalive] ping fail:", e.message);
      }
      return { ok: true };
    }
    return { ok: false, error: lastErr || "续期失败" };
  } finally {
    refreshLock = false;
  }
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    req.on("error", reject);
  });
}

async function adminRouter(req, res) {
  const urlPath = (req.url || "/").split("?")[0];

  if (req.method === "GET" && (urlPath === "/" || urlPath === "/admin")) {
    return sendFile(res, path.join(PUBLIC_DIR, "index.html"), "text/html; charset=utf-8");
  }
  if (req.method === "GET" && urlPath === "/admin.css") {
    return sendFile(res, path.join(PUBLIC_DIR, "admin.css"), "text/css; charset=utf-8");
  }
  if (req.method === "GET" && urlPath === "/admin.js") {
    return sendFile(res, path.join(PUBLIC_DIR, "admin.js"), "application/javascript; charset=utf-8");
  }

  if (req.method === "POST" && urlPath === "/admin/api/login") {
    const body = JSON.parse((await readBody(req)) || "{}");
    if (!adminPassword() || body.password !== adminPassword()) {
      return sendJson(res, 401, { ok: false, error: "密码错了" });
    }
    setSession(res);
    return sendJson(res, 200, { ok: true, status: publicStatus() });
  }

  if (req.method === "POST" && urlPath === "/admin/api/logout") {
    clearSession(res, req);
    return sendJson(res, 200, { ok: true });
  }

  if (urlPath.startsWith("/admin/api/") && !isAuthed(req)) {
    return sendJson(res, 401, { ok: false, error: "先登录" });
  }

  if (req.method === "GET" && urlPath === "/admin/api/status") {
    return sendJson(res, 200, { ok: true, status: publicStatus(), job: {
      status: loginJob.status,
      message: loginJob.message,
      qr: loginJob.qrDataUrl,
      error: loginJob.error,
      result: loginJob.result,
    } });
  }

  if (req.method === "POST" && urlPath === "/admin/api/qr/start") {
    await startQrLogin();
    return sendJson(res, 200, { ok: true, status: loginJob.status, message: loginJob.message });
  }

  if (req.method === "POST" && urlPath === "/admin/api/qr/cancel") {
    await cancelQrLogin();
    return sendJson(res, 200, { ok: true });
  }

  if (req.method === "POST" && urlPath === "/admin/api/keepalive") {
    const result = await maybeRefresh(true);
    return sendJson(res, result.ok ? 200 : 502, { ok: result.ok, error: result.error || "", status: publicStatus() });
  }

  if (req.method === "POST" && urlPath === "/admin/api/keys") {
    const body = JSON.parse((await readBody(req)) || "{}");
    const key = String(body.key || "").trim();
    if (!key) return sendJson(res, 400, { ok: false, error: "空的" });
    const cfg = readConfigFile();
    cfg.api_keys = Array.from(new Set([...(cfg.api_keys || []), key]));
    writeConfigFile(cfg);
    return sendJson(res, 200, { ok: true, status: publicStatus() });
  }

  if (req.method === "POST" && urlPath === "/admin/api/manual") {
    const body = JSON.parse((await readBody(req)) || "{}");
    const cookie = String(body.cookie || "").trim();
    const refresh = String(body.refresh_token || "").trim();
    const registration = String(body.registration_id || "").trim();
    if (!cookie || !/IMA-TOKEN=/.test(cookie)) {
      return sendJson(res, 400, { ok: false, error: "cookie 里没有 IMA-TOKEN" });
    }
    const cfg = readConfigFile();
    ensureAccounts(cfg);
    const fields = ima.parseCookie(cookie);
    mergeAccountRecord(cfg, {
      cookie,
      refresh_token: refresh || fields["IMA-REFRESH-TOKEN"] || "",
      registration_id: registration,
      token_type: Number(body.token_type || 14) || 14,
      user_id: fields["IMA-UID"] || "",
      nickname: String(body.nickname || ""),
      login_source: registration ? "ios-app" : "manual",
      user_agent: registration ? ima.appUserAgent() : "",
      guid: fields["IMA-GUID"] || "",
      q36: fields["IMA-Q36"] || "",
      updated_at: now(),
      last_refresh_ok_at: now(),
      last_refresh_error: "",
      refresh_fail_count: 0,
    }, { activate: true });
    writeConfigFile(cfg);
    try { await syncOfficialModels("manual"); } catch (e) { console.error("[models] manual sync fail:", e.message); }
    return sendJson(res, 200, { ok: true, status: publicStatus() });
  }

  if (req.method === "POST" && urlPath === "/admin/api/import-har") {
    const body = JSON.parse((await readBody(req)) || "{}");
    let har = body.har;
    if (typeof har === "string") {
      try { har = JSON.parse(har); } catch { return sendJson(res, 400, { ok: false, error: "这不是一份能读的 HAR 文件" }); }
    }
    if (!har || typeof har !== "object") return sendJson(res, 400, { ok: false, error: "请把 HAR 文件拖进来" });
    let extracted;
    try {
      extracted = ima.extractAuthFromHar(har);
    } catch (e) {
      return sendJson(res, 400, { ok: false, error: e.message || "这份包读不出来" });
    }
    const cfg = readConfigFile();
    ensureAccounts(cfg);
    mergeAccountRecord(cfg, {
      ...extracted,
      updated_at: now(),
      last_refresh_ok_at: now(),
      last_refresh_error: "",
      refresh_fail_count: 0,
      cooling_until: 0,
    }, { activate: true });
    writeConfigFile(cfg);
    try { await syncOfficialModels("har"); } catch (e) { console.error("[models] har sync fail:", e.message); }
    return sendJson(res, 200, { ok: true, status: publicStatus() });
  }

  if (req.method === "POST" && urlPath === "/admin/api/accounts/activate") {
    const body = JSON.parse((await readBody(req)) || "{}");
    const userId = String(body.user_id || "").trim();
    if (!userId) return sendJson(res, 400, { ok: false, error: "没有指定账号" });
    const cfg = readConfigFile();
    ensureAccounts(cfg);
    try { activateAccount(cfg, userId); } catch (e) {
      return sendJson(res, 400, { ok: false, error: e.message });
    }
    return sendJson(res, 200, { ok: true, status: publicStatus() });
  }

  if (req.method === "POST" && urlPath === "/admin/api/accounts/delete") {
    const body = JSON.parse((await readBody(req)) || "{}");
    const userId = String(body.user_id || "").trim();
    if (!userId) return sendJson(res, 400, { ok: false, error: "没有指定账号" });
    const cfg = readConfigFile();
    ensureAccounts(cfg);
    cfg.accounts = (cfg.accounts || []).filter((a) => a.user_id !== userId);
    if (cfg.auth && cfg.auth.user_id === userId) {
      const next = cfg.accounts.find((a) => a.registration_id) || cfg.accounts[0] || {};
      cfg.auth = { ...next };
    }
    writeConfigFile(cfg, { clearSessions: true });
    return sendJson(res, 200, { ok: true, status: publicStatus() });
  }

  return false;
}

async function router(req, res) {
  try {
    if (req.url) {
      const q = req.url.indexOf("?");
      const pathPart = (q >= 0 ? req.url.slice(0, q) : req.url).replace(/\/{2,}/g, "/") || "/";
      req.url = q >= 0 ? `${pathPart}${req.url.slice(q)}` : pathPart;
    }
    const handled = await adminRouter(req, res);
    if (handled === false) return api.router(req, res);
  } catch (e) {
    if (!res.headersSent) sendJson(res, 500, { ok: false, error: e.message || String(e) });
  }
}

const PORT = Number(process.env.PORT || api.getRuntime().CONFIG.server?.port || 8080);
const HOST = process.env.HOST || api.getRuntime().CONFIG.server?.host || "0.0.0.0";

http.createServer(router).listen(PORT, HOST, () => {
  console.log(`ima2api admin+api listening on ${HOST}:${PORT}`);
});

try {
  const boot = readConfigFile();
  ensureAccounts(boot);
  writeConfigFile(boot);
} catch (e) {
  console.error("[boot] accounts:", e.message);
}

if (typeof api.setRotateHandler === "function") {
  api.setRotateHandler(async (reason) => rotateActiveAccount(reason));
}

setInterval(() => {
  maybeRefresh().catch((e) => console.error("[refresh-loop]", e.message));
}, CHECK_INTERVAL_MS);

setTimeout(() => {
  maybeRefresh().catch(() => {});
  syncOfficialModels("startup").catch((e) => console.error("[models] startup sync fail:", e.message));
}, 3000);
