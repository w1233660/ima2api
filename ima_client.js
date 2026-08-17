"use strict";

const https = require("https");
const zlib = require("zlib");
const crypto = require("crypto");

const BASE_HOST = "ima.qq.com";
const WX_APPID_WEB = "wx0d63f5de059f1d52";

function calcBkn(token) {
  let h = 5381;
  for (let i = 0; i < String(token || "").length; i++) {
    h += (h << 5) + String(token).charCodeAt(i);
  }
  return String(h & 0x7fffffff);
}

function parseCookie(cookieStr) {
  const fields = {};
  for (const part of String(cookieStr || "").split(";")) {
    const idx = part.indexOf("=");
    if (idx < 0) continue;
    fields[part.slice(0, idx).trim()] = part.slice(idx + 1).trim();
  }
  return fields;
}

function buildCookie(fields) {
  const order = [
    "IMA-GUID", "APP-VERSION", "IMA-Q36", "IMA-IUA",
    "UID-TYPE", "IMA-UID", "IMA-TOKEN", "IMA-TOKEN-TYPE",
    "IMA-REFRESH-TOKEN", "TOKEN-TYPE", "CLIENT-TYPE",
    "PLATFORM", "WEB-VERSION",
  ];
  const seen = new Set();
  const parts = [];
  for (const k of order) {
    if (fields[k] == null || fields[k] === "") continue;
    parts.push(`${k}=${fields[k]}`);
    seen.add(k);
  }
  for (const [k, v] of Object.entries(fields)) {
    if (seen.has(k) || v == null || v === "") continue;
    parts.push(`${k}=${v}`);
  }
  return parts.join(";");
}

function toSnake(value) {
  if (Array.isArray(value)) return value.map(toSnake);
  if (!value || typeof value !== "object" || value instanceof Date) return value;
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    const nk = k.replace(/[A-Z]/g, (ch) => `_${ch.toLowerCase()}`);
    out[nk] = toSnake(v);
  }
  return out;
}

function decodeImaBody(res, raw) {
  const encoding = (res.headers["content-encoding"] || "").toLowerCase();
  let buf = raw;
  if (encoding === "gzip") buf = zlib.gunzipSync(raw);
  else if (encoding === "deflate") buf = zlib.inflateSync(raw);
  const text = buf.toString("utf-8");
  try { return JSON.parse(text); } catch { return { raw: text }; }
}

function isAppCookie(cookie, auth = {}) {
  const fields = parseCookie(cookie || "");
  const clientType = String(fields["CLIENT-TYPE"] || auth.client_type || "");
  const source = String(auth.login_source || "");
  return source.includes("app") || clientType === "256002" || Boolean(auth.registration_id);
}

function appUserAgent(auth = {}) {
  return auth.user_agent || "ima/1369 CFNetwork/1399 Darwin/22.1.0";
}

function authRequestHeaders(auth = {}) {
  const fields = parseCookie(auth.cookie || "");
  const extra = {
    "x-ima-cookie": auth.cookie || "",
    "x-ima-bkn": calcBkn(fields["IMA-TOKEN"] || ""),
  };
  if (isAppCookie(auth.cookie, auth)) extra["user-agent"] = appUserAgent(auth);
  return extra;
}

function imaRequest(path, body, extraHeaders = {}, timeout = 20000) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body || {});
    const req = https.request({
      hostname: BASE_HOST,
      port: 443,
      path,
      method: "POST",
      headers: {
        origin: "https://ima.qq.com",
        referer: "https://ima.qq.com/",
        "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
        "content-type": "application/json; charset=utf-8",
        "accept-encoding": "gzip, deflate",
        "content-length": Buffer.byteLength(payload),
        from_browser_ima: "1",
        ...extraHeaders,
      },
      timeout,
    }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        try {
          resolve({ status: res.statusCode, data: decodeImaBody(res, Buffer.concat(chunks)), headers: res.headers });
        } catch (e) {
          reject(e);
        }
      });
    });
    req.on("error", reject);
    req.on("timeout", () => { req.destroy(); reject(new Error("timeout")); });
    req.write(payload);
    req.end();
  });
}

function randomDevice() {
  const guid = crypto.randomBytes(16).toString("hex");
  const q36 = crypto.randomBytes(16).toString("hex");
  return { guid, q36 };
}

function accountToCookie(account, extra = {}) {
  const fields = {
    "IMA-UID": account.userId || extra.userId || "",
    "IMA-TOKEN": account.token || "",
    "IMA-REFRESH-TOKEN": account.refreshToken || extra.refreshToken || "",
    "UID-TYPE": String(account.idType ?? extra.idType ?? ""),
    "TOKEN-TYPE": String(account.tokenType ?? extra.tokenType ?? ""),
    "IMA-GUID": account.guid || extra.guid || "",
    "IMA-Q36": extra.q36 || "",
    "IMA-IUA": extra.iua || extra.qua || "",
    PLATFORM: "H5",
    "CLIENT-TYPE": extra.clientType || "7",
    "WEB-VERSION": extra.webVersion || "1.0.0",
  };
  return buildCookie(fields);
}

function parseAccountFromLogin(data) {
  const payload = data && typeof data === "object" && data.data && typeof data.data === "object"
    ? { ...data, ...data.data }
    : (data || {});
  const userInfo = payload.userInfo || payload.user_info || {};
  const openInfo = userInfo.openInfo || userInfo.open_info || {};
  const customInfo = userInfo.customInfo || userInfo.custom_info || {};
  return {
    code: payload.code,
    msg: payload.msg || payload.message || "",
    token: payload.token || "",
    refreshToken: payload.refreshToken || payload.refresh_token || "",
    userId: payload.userId || payload.user_id || "",
    idType: payload.idType ?? payload.id_type ?? 0,
    tokenType: payload.tokenType ?? payload.token_type ?? 1,
    tokenValidTime: payload.tokenValidTime ?? payload.token_valid_time ?? 0,
    refreshTokenValidTime: payload.refreshTokenValidTime ?? payload.refresh_token_valid_time ?? 0,
    nickname: customInfo.nick || openInfo.nickname || openInfo.nickName || "",
    avatarUrl: customInfo.head || openInfo.avatarUrl || openInfo.avatar_url || "",
    openId: openInfo.openid || openInfo.openId || "",
    guid: openInfo.guid || payload.guid || "",
    accountType: openInfo.type ?? payload.accountType ?? 2,
    raw: payload,
  };
}

async function webLoginWithWxCode(wxCode, device = randomDevice()) {
  const body = toSnake({
    accountType: 2,
    code: wxCode,
    authAppid: WX_APPID_WEB,
    clientInfo: {
      guid: device.guid,
      platform: 4,
      qimei36: device.q36,
    },
  });
  const res = await imaRequest("/auth_login/login", body);
  const account = parseAccountFromLogin(res.data);
  account.httpStatus = res.status;
  account.device = device;
  if (!account.token) {
    const err = new Error(account.msg || `login failed: ${JSON.stringify(res.data).slice(0, 240)}`);
    err.payload = res.data;
    err.status = res.status;
    throw err;
  }
  return account;
}

const KNOWN_MODELS = {
  0: { key: "hy-2.0", name: "Tencent HY 2.0" },
  1: { key: "deepseek-r1", name: "DeepSeek R1" },
  2: { key: "hy-2.0-think", name: "Tencent HY 2.0 Think" },
  3: { key: "deepseek-v3", name: "DeepSeek V3" },
  4: { key: "deepseek-v3.2", name: "DeepSeek V3.2" },
  5: { key: "deepseek-v3.2-think", name: "DeepSeek V3.2 Think" },
  3000: { key: "glm-5.3", name: "智谱 GLM-5.3" },
  3001: { key: "glm-5.3-think", name: "智谱 GLM-5.3 Think" },
  4000: { key: "kimi-k2.5", name: "Kimi K2.5" },
  4001: { key: "kimi-k2.5-think", name: "Kimi K2.5 Think" },
};

const MODEL_ALIASES = {
  "glm-5": "glm-5.3",
  "glm-5.2": "glm-5.3",
  "glm-5.2-think": "glm-5.3-think",
  "hy3-preview": "hy-2.0",
  "hy3-preview-think": "hy-2.0-think",
  "deepseek-v4-flash": "deepseek-v3.2",
  "deepseek-v4-flash-think": "deepseek-v3.2-think",
};

function builtInModels() {
  const models = {};
  for (const [type, meta] of Object.entries(KNOWN_MODELS)) {
    models[meta.key] = {
      type: Number(type),
      id: `official_${type}`,
      name: meta.name,
    };
  }
  return models;
}

function slugModel(item) {
  const type = Number(item.model_type);
  const known = KNOWN_MODELS[type];
  if (known) return known;
  const raw = String(item.model_name || item.short_model_name || `model-${type}`)
    .toLowerCase()
    .replace(/智谱\s*/g, "")
    .replace(/tencent\s*/g, "")
    .replace(/[^a-z0-9.]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return { key: raw || `model-${type}`, name: item.model_name || `model-${type}` };
}

function mergeOfficialModels(payload = {}) {
  const models = builtInModels();
  const liveIds = new Set();
  let liveDefaultKey = "";
  for (const item of payload.models || []) {
    const meta = slugModel(item);
    models[meta.key] = {
      type: Number(item.model_type),
      id: item.model_id || `official_${item.model_type}`,
      name: item.model_name || meta.name,
    };
    liveIds.add(item.model_id || `official_${item.model_type}`);
    if (item.is_default) liveDefaultKey = meta.key;
  }
  const preferred = payload.preferred_model_id || "";
  let defaultKey = liveDefaultKey || "deepseek-v3.2";
  if (preferred && liveIds.has(preferred)) {
    for (const [key, info] of Object.entries(models)) {
      if (info.id === preferred) {
        defaultKey = key;
        break;
      }
    }
  }
  return { models, default_model: defaultKey, preferred_model_id: preferred || "" };
}

async function fetchOfficialModels(auth = {}) {
  const res = await imaRequest("/cgi-bin/model_manage/get_models", {}, authRequestHeaders(auth));
  if (!res.data || res.data.code !== 0) {
    throw new Error((res.data && (res.data.msg || res.data.message)) || `get_models failed: ${res.status}`);
  }
  return mergeOfficialModels(res.data);
}

async function webRefresh(auth) {
  const fields = parseCookie(auth.cookie || "");
  const userId = auth.user_id || fields["IMA-UID"] || "";
  const refreshToken = auth.refresh_token || fields["IMA-REFRESH-TOKEN"] || "";
  const parsedType = Number(auth.token_type);
  const tokenType = Number.isFinite(parsedType) && parsedType > 0 ? parsedType : 14;
  const body = {
    user_id: userId,
    refresh_token: refreshToken,
    token_type: tokenType,
  };
  if (auth.registration_id) body.registration_id = auth.registration_id;
  const res = await imaRequest("/auth_login/refresh", body, authRequestHeaders(auth));
  const next = parseAccountFromLogin(res.data);
  next.httpStatus = res.status;
  if (!next.token) {
    const err = new Error(next.msg || `refresh failed: ${JSON.stringify(res.data).slice(0, 240)}`);
    err.payload = res.data;
    err.status = res.status;
    throw err;
  }
  const merged = {
    ...fields,
    "IMA-TOKEN": next.token,
    "IMA-UID": next.userId || userId,
    "IMA-REFRESH-TOKEN": next.refreshToken || refreshToken,
    "TOKEN-TYPE": String(next.tokenType || tokenType),
  };
  return {
    cookie: buildCookie(merged),
    refresh_token: next.refreshToken || refreshToken,
    user_id: next.userId || userId,
    token_type: next.tokenType || tokenType,
    token_valid_time: next.tokenValidTime,
    nickname: next.nickname,
    raw: next.raw,
  };
}

function headerOf(entry, name) {
  const want = String(name || "").toLowerCase();
  for (const h of (entry.request && entry.request.headers) || []) {
    if (String(h.name || "").toLowerCase() === want) return h.value || "";
  }
  return "";
}

function entryJson(entry, which) {
  try {
    if (which === "req") return JSON.parse((entry.request && entry.request.postData && entry.request.postData.text) || "");
  } catch {}
  try {
    if (which === "res") return JSON.parse((entry.response && entry.response.content && entry.response.content.text) || "");
  } catch {}
  return null;
}

function extractAuthFromHar(har) {
  const entries = (har && har.log && har.log.entries) || [];
  if (!entries.length) throw new Error("空文件");
  let loginRes = null;
  let loginReq = null;
  let refreshReq = null;
  let cookie = "";
  let ua = "";
  for (const entry of entries) {
    const url = (entry.request && entry.request.url) || "";
    if (!url.includes("ima.qq.com")) continue;
    const path = url.split("?")[0];
    const c = headerOf(entry, "x-ima-cookie") || headerOf(entry, "cookie");
    const thisUa = headerOf(entry, "user-agent");
    if (c && /IMA-TOKEN=/.test(c) && /IMA-UID=[^;]+/.test(c)) {
      cookie = c;
      if (thisUa) ua = thisUa;
    }
    if (path.endsWith("/auth_login/login")) {
      loginReq = entryJson(entry, "req") || loginReq;
      const data = entryJson(entry, "res");
      if (data && (data.token || (data.data && data.data.token))) loginRes = data;
    }
    if (path.endsWith("/auth_login/refresh")) {
      refreshReq = entryJson(entry, "req") || refreshReq;
    }
  }
  if (!cookie && loginRes) {
    const account = parseAccountFromLogin(loginRes);
    const device = {
      guid: (loginReq && loginReq.client_info && loginReq.client_info.guid) || account.guid || "",
      q36: (loginReq && loginReq.client_info && loginReq.client_info.qimei36) || "",
    };
    cookie = accountToCookie(account, { ...device, clientType: "256002", webVersion: "" });
  }
  if (!cookie || !/IMA-TOKEN=/.test(cookie)) {
    throw new Error("这包里没有登录信息，用 App 重新抓一份");
  }
  const fields = parseCookie(cookie);
  const account = loginRes ? parseAccountFromLogin(loginRes) : {};
  const refreshToken = (refreshReq && (refreshReq.refresh_token || refreshReq.refreshToken))
    || account.refreshToken
    || fields["IMA-REFRESH-TOKEN"]
    || "";
  const registrationId = (refreshReq && (refreshReq.registration_id || refreshReq.registrationId)) || "";
  if (!refreshToken) throw new Error("没有 refresh_token，登录后再抓一次");
  return {
    cookie,
    refresh_token: refreshToken,
    registration_id: registrationId,
    token_type: Number((refreshReq && refreshReq.token_type) || account.tokenType || 14) || 14,
    user_id: (refreshReq && refreshReq.user_id) || account.userId || fields["IMA-UID"] || "",
    nickname: account.nickname || "",
    login_source: registrationId ? "ios-app" : "har",
    user_agent: ua || (registrationId ? appUserAgent() : ""),
    guid: (loginReq && loginReq.client_info && loginReq.client_info.guid) || fields["IMA-GUID"] || "",
    q36: (loginReq && loginReq.client_info && loginReq.client_info.qimei36) || fields["IMA-Q36"] || "",
  };
}

module.exports = {
  WX_APPID_WEB,
  KNOWN_MODELS,
  MODEL_ALIASES,
  calcBkn,
  parseCookie,
  buildCookie,
  toSnake,
  randomDevice,
  accountToCookie,
  parseAccountFromLogin,
  webLoginWithWxCode,
  webRefresh,
  isAppCookie,
  appUserAgent,
  authRequestHeaders,
  builtInModels,
  mergeOfficialModels,
  fetchOfficialModels,
  extractAuthFromHar,
};
