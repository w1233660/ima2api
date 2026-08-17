
"use strict";

const https = require("https");
const http = require("http");
const crypto = require("crypto");

// ============================================================
// 1. 配置
// ============================================================
let CONFIG = require("./config.json");
const BASE_HOST = "ima.qq.com";
const BASE_URL = "https://ima.qq.com";
let COOKIE = "";
const API_KEYS = new Set();
let IMA_TOKEN = "";
let BKN = "";

function calcBkn(token) {
  let h = 5381;
  for (let i = 0; i < token.length; i++) h += (h << 5) + token.charCodeAt(i);
  return String(h & 0x7fffffff);
}

function applyConfig(next) {
  const prevCookie = COOKIE;
  if (next) CONFIG = next;
  COOKIE = (CONFIG.auth && CONFIG.auth.cookie) || "";
  API_KEYS.clear();
  for (const k of CONFIG.api_keys || []) API_KEYS.add(k);
  const m = String(COOKIE).match(/IMA-TOKEN=([^;]+)/);
  IMA_TOKEN = m ? m[1] : "";
  BKN = calcBkn(IMA_TOKEN);
  IMA_HEADERS["x-ima-cookie"] = COOKIE;
  IMA_HEADERS["x-ima-bkn"] = BKN;
  const clientType = String(COOKIE).match(/CLIENT-TYPE=([^;]+)/);
  const loginSource = (CONFIG.auth && CONFIG.auth.login_source) || "";
  if ((clientType && clientType[1] === "256002") || String(loginSource).includes("app") || (CONFIG.auth && CONFIG.auth.registration_id)) {
    IMA_HEADERS["User-Agent"] = (CONFIG.auth && CONFIG.auth.user_agent) || "ima/1369 CFNetwork/1399 Darwin/22.1.0";
  } else {
    IMA_HEADERS["User-Agent"] = "okhttp/4.12.0";
  }
  MODELS = CONFIG.models || MODELS;
  DEFAULT_MODEL = CONFIG.default_model || DEFAULT_MODEL;
  // 换号后旧会话作废；同一账号只是续期，会话还要留着。
  if (typeof sessions !== "undefined" && prevCookie && COOKIE) {
    const prevUid = (String(prevCookie).match(/IMA-UID=([^;]+)/) || [])[1] || "";
    const nextUid = (String(COOKIE).match(/IMA-UID=([^;]+)/) || [])[1] || "";
    if (prevUid && nextUid && prevUid !== nextUid) sessions.clear();
  }
}

function loadConfigFromDisk() {
  const cfgPath = require("path").resolve(__dirname, "config.json");
  delete require.cache[require.resolve(cfgPath)];
  applyConfig(require(cfgPath));
  return CONFIG;
}

function maskKey(k) {
  if (!k || k.length < 12) return "***";
  return k.slice(0, 6) + "..." + k.slice(-4);
}

// ============================================================
// 2. HTTP 客户端
// ============================================================
const IMA_HEADERS = {
  "from_browser_ima": "1",
  "x-ima-cookie": "",
  "x-ima-bkn": "",
  referer: BASE_URL,
  origin: BASE_URL,
  "User-Agent": "okhttp/4.12.0",
  "Content-Type": "application/json; charset=utf-8",
  "Accept-Encoding": "gzip",  // ⭐ 修复: 与真实 App 请求头一致
};

function imaPost(path, body, extraH = {}, timeout = 30000) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = https.request({
      hostname: BASE_HOST, port: 443, path, method: "POST",
      headers: { ...IMA_HEADERS, ...extraH, "Content-Length": Buffer.byteLength(payload) },
      timeout,
    }, (res) => {
      // ⭐ 修复: 处理 gzip 压缩响应（与 Accept-Encoding: gzip 配套）
      const zlib = require("zlib");
      const encoding = res.headers["content-encoding"] || "";
      let stream = res;
      if (encoding === "gzip") stream = res.pipe(zlib.createGunzip());
      else if (encoding === "deflate") stream = res.pipe(zlib.createInflate());
      const chunks = [];
      stream.on("data", (c) => chunks.push(c));
      stream.on("end", () => {
        const raw = Buffer.concat(chunks).toString("utf-8");
        try { resolve({ status: res.statusCode, data: JSON.parse(raw) }); }
        catch { resolve({ status: res.statusCode, data: raw }); }
      });
      stream.on("error", reject);
    });
    req.on("error", reject);
    req.on("timeout", () => { req.destroy(); reject(new Error("timeout")); });
    req.write(payload); req.end();
  });
}

function imaSse(path, body) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = https.request({
      hostname: BASE_HOST, port: 443, path, method: "POST",
      headers: { ...IMA_HEADERS, Accept: "text/event-stream", "Content-Length": Buffer.byteLength(payload) },
      timeout: 180000,
    }, (res) => {
      if (res.statusCode !== 200) {
        let e = ""; res.on("data", c => e += c);
        res.on("end", () => reject(new Error(`HTTP ${res.statusCode}: ${e}`)));
        return;
      }
      resolve(parseSSE(res));
    });
    req.on("error", reject);
    req.on("timeout", () => { req.destroy(); reject(new Error("SSE timeout")); });
    req.write(payload); req.end();
  });
}

function parseSSEBlock(part) {
  let event = "";
  const dataLines = [];
  for (const line of part.split("\n")) {
    if (line.startsWith("event:")) event = line.slice(6).trim();
    else if (line.startsWith("data:")) dataLines.push(line.slice(5).replace(/^ /, ""));
    else if (line.startsWith("data")) dataLines.push("");
  }
  return { event, data: dataLines.join("\n") };
}

async function* parseSSE(readable) {
  let buf = "";
  for await (const chunk of readable) {
    buf += chunk.toString("utf-8");
    const parts = buf.split(/\r?\n\r?\n/); buf = parts.pop() || "";
    for (const part of parts) {
      if (!part.trim()) continue;
      const evt = parseSSEBlock(part);
      if (evt.event || evt.data) yield evt;
    }
  }
  if (buf.trim()) {
    const evt = parseSSEBlock(buf);
    if (evt.event || evt.data) yield evt;
  }
}

const CONTROL_EVENTS = new Set(["COMPLETED", "CLOSE", "INNER_EXCEPTION", "ERROR", "FAILED"]);
const DEBUG_SSE = process.env.IMA_DEBUG === "1";

function extractEventText(d) {
  if (d == null) return "";
  if (typeof d === "string") return d;
  if (typeof d !== "object") return String(d);
  for (const k of ["Text", "text", "Content", "content", "Delta", "delta", "Msg", "msg", "reply", "Reply", "answer", "Answer"]) {
    const v = d[k];
    if (typeof v === "string" && v) return v;
  }
  return "";
}

function eventText(evt) {
  const raw = evt && evt.data;
  if (!raw) return "";
  let d;
  try { d = JSON.parse(raw); }
  catch { try { d = tryRepairJson(raw); } catch { d = null; } }
  if (d == null) return "";
  return extractEventText(d);
}

// ============================================================
// 3. IMA API
// ============================================================
async function imaInitSession(question) {
  const { data } = await imaPost("/cgi-bin/session_logic/init_session", {
    env_info: { interact_type: 2, robot_type: 10000 },
    name: (question || "新对话").slice(0, 50),
    msgs_limit: 20,  // IMA 上限为 20（超过会报 code=51）
  });
  if (data.code === 0) return data.session_id;
  throw new Error(`InitSession failed: code=${data.code} msg=${data.msg}`);
}

function imaQaStream(sessionId, question, modelType, modelId) {
  return imaSse("/cgi-bin/assistant/qa", {
    session_id: sessionId,
    robot_type: 10000,
    question,
    question_type: 2,
    command_info: { question_info: {} },
    client_id: crypto.randomUUID(),
    model_info: { model_type: modelType, model_id: modelId },
  });
}

function completedError(evt) {
  if (!evt || evt.event !== "COMPLETED" || !evt.data) return "";
  try {
    const d = JSON.parse(evt.data);
    if (d && Number(d.Code) && Number(d.Code) !== 0) {
      return d.Msg || `IMA 模型不可用 (code=${d.Code})`;
    }
  } catch {}
  return "";
}

async function collectResponseText(events) {
  let text = "";
  const seen = [];
  for await (const evt of events) {
    const fail = completedError(evt);
    if (fail) throw new Error(fail);
    if (CONTROL_EVENTS.has(evt.event)) break;
    text += eventText(evt);
    if (DEBUG_SSE) seen.push(evt.event || "(none)");
  }
  if (DEBUG_SSE && !text) console.error(`[SSE-EMPTY] events=${JSON.stringify(seen)}`);
  return text;
}

// ============================================================
// 4. 会话缓存
// ============================================================
const sessions = new Map();
const SESSION_TTL = 30 * 60 * 1000;

function clearImaSessions() {
  sessions.clear();
}

function isDeadSessionMessage(msg) {
  const text = String(msg || "");
  return /会话已失效|会话不存在|会话.*删除|新建会话后重试/.test(text);
}

function isRateLimitMessage(msg) {
  const text = String(msg || "");
  return /提问太快|晚[点点]再来|访问过于频繁|请求过于频繁|稍后再试|too many|rate limit/i.test(text);
}

let rotateAccountHandler = null;
function setRotateHandler(fn) {
  rotateAccountHandler = typeof fn === "function" ? fn : null;
}

let lastAskAt = 0;
const MIN_ASK_GAP_MS = 4000;
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
async function paceAsk() {
  const wait = lastAskAt + MIN_ASK_GAP_MS - Date.now();
  if (wait > 0) await sleep(wait);
  lastAskAt = Date.now();
}

function getCachedSession(convId) {
  const now = Date.now();
  for (const [k, v] of sessions) { if (now - v.ts > SESSION_TTL) sessions.delete(k); }
  if (convId && sessions.has(convId)) { sessions.get(convId).ts = now; return sessions.get(convId).id; }
  return null;
}

async function ensureSession(convId, question, forceNew = false) {
  if (!forceNew) {
    const c = getCachedSession(convId);
    if (c) return c;
  }
  const id = await imaInitSession(question);
  if (convId) sessions.set(convId, { id, ts: Date.now() });
  return id;
}

// ⭐ 修复: IMA 会话达到 msgs_limit 后自动重建，避免"突然结束"
async function imaQaStreamWithRetry(convId, question, modelType, modelId) {
  await paceAsk();
  let sessionId = await ensureSession(convId, question);
  const events = await imaQaStream(sessionId, question, modelType, modelId);
  // 会话满了、换号后旧会话失效时，自动新建会话再问一次。
  return (async function*() {
    for await (const evt of events) {
      const fail = completedError(evt);
      if (isRateLimitMessage(fail)) throw new Error(fail);
      const dead = evt.event === "INNER_EXCEPTION" || evt.event === "ERROR" || evt.event === "FAILED" || isDeadSessionMessage(fail);
      if (dead) {
        try {
          const newId = await ensureSession(convId, question, true);
          const retryEvents = await imaQaStream(newId, question, modelType, modelId);
          for await (const e2 of retryEvents) yield e2;
        } catch (_) {
          yield evt;
        }
        return;
      }
      yield evt;
    }
  })();
}

async function* qaWithRotate(convId, question, modelType, modelId) {
  let lastErr = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const events = await imaQaStreamWithRetry(
        attempt ? `${convId}-r${attempt}` : convId,
        question,
        modelType,
        modelId,
      );
      for await (const evt of events) yield evt;
      return;
    } catch (e) {
      lastErr = e;
      if (!isRateLimitMessage(e.message) || !rotateAccountHandler) throw e;
      const rotated = await rotateAccountHandler(e.message);
      if (!rotated) throw e;
      console.log(`[rotate] retry ask attempt=${attempt + 1}`);
    }
  }
  throw lastErr || new Error("提问太快，账号都在冷却");
}

// ============================================================
// 5. 模型
// ============================================================
let MODELS = CONFIG.models;
let DEFAULT_MODEL = CONFIG.default_model;

const MODEL_ALIASES = {
  "glm-5": "glm-5.3",
  "glm-5.2": "glm-5.3",
  "glm-5.2-think": "glm-5.3-think",
  "hy3-preview": "hy-2.0",
  "hy3-preview-think": "hy-2.0-think",
  "deepseek-v4-flash": "deepseek-v3.2",
  "deepseek-v4-flash-think": "deepseek-v3.2-think",
};

function resolveModel(requested) {
  if (!requested) return MODELS[DEFAULT_MODEL];
  if (MODELS[requested]) return MODELS[requested];
  const lower = String(requested).toLowerCase();
  const alias = MODEL_ALIASES[lower];
  if (alias && MODELS[alias]) return MODELS[alias];
  for (const [k, v] of Object.entries(MODELS)) {
    if (k.toLowerCase() === lower) return v;
    if (String(v.type) === lower) return v;
    if (String(v.id).toLowerCase() === lower) return v;
    if (String(v.name || "").toLowerCase() === lower) return v;
  }
  return MODELS[DEFAULT_MODEL];
}

// ============================================================
// 6. 认证 & 工具
// ============================================================
function checkAuth(req) {
  const bearer = (req.headers["authorization"] || "").replace(/^Bearer\s+/i, "");
  if (bearer && API_KEYS.has(bearer)) return true;
  return API_KEYS.has(req.headers["x-api-key"] || "");
}

function cors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers",
    "Content-Type, Authorization, x-api-key, x-conversation-id, x-session-id, x-request-id, x-stainless-*");
}

function json(res, code, obj) {
  cors(res);
  res.writeHead(code, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(obj));
  if (code >= 400) {
    console.error(`[RESP] ${code} ${JSON.stringify(obj).slice(0, 200)}`);
  }
}

function extractContent(msg) {
  if (typeof msg.content === "string") return msg.content;
  if (Array.isArray(msg.content))
    return msg.content.map(c => {
      if (c.type === "text") return c.text;
      if (c.type === "tool_result") {
        // Anthropic tool_result content 可能是 string 或 content_block[]
        const tc = typeof c.content === "string" ? c.content
          : Array.isArray(c.content) ? c.content.map(cc => cc.text || "").join("") : "";
        return `Tool result:\n${tc}`;
      }
      if (c.type === "tool_use") return `Tool call: ${c.name}(${JSON.stringify(c.input)})`;
      return "";
    }).filter(Boolean).join("\n");
  return String(msg.content || "");
}

function clipText(s, n) {
  const text = String(s || "");
  if (text.length <= n) return text;
  return text.slice(0, Math.max(0, n - 12)) + "\n...[截断]";
}

function compressSysPrompt(sysPrompt, budget) {
  const context = String(sysPrompt || "");
  if (!context || budget <= 0) return "";
  if (context.length <= budget) return context;
  const layoutMatch = context.match(/<project_layout>([\s\S]*?)<\/project_layout>/);
  const layoutSummary = layoutMatch ? layoutMatch[1].trim().split("\n").slice(0, 20).join("\n") : "";
  const headLen = Math.min(500, Math.floor(budget * 0.55));
  const tailLen = Math.min(220, budget - headLen);
  const head = context.slice(0, headLen);
  const tail = context.length > headLen + tailLen ? context.slice(-tailLen) : "";
  const layoutPart = layoutSummary
    ? "\nDirectory:\n" + layoutSummary.slice(0, Math.min(220, Math.max(0, budget - headLen - tailLen - 20)))
    : "";
  return clipText(tail ? head + "\n...[truncated]..." + layoutPart + "\n" + tail : head + layoutPart, budget);
}

function deriveConvId(req, messages) {
  const header = String((req && req.headers && (req.headers["x-conversation-id"] || req.headers["x-session-id"])) || "").trim();
  if (header) return header;
  for (const m of messages || []) {
    if (m.role !== "user") continue;
    const t = extractContent(m).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
    if (t.length > 6) {
      return "conv-" + crypto.createHash("md5").update(t.slice(0, 80)).digest("hex").slice(0, 16);
    }
  }
  const fallback = extractContent((messages || [])[0] || {}).slice(0, 80);
  return "conv-" + crypto.createHash("md5").update(fallback || "ima").digest("hex").slice(0, 16);
}

function packQuestion({ sysPrompt = "", toolsPrompt = "", turns = [], lastUser = "", langHint = "", maxLen = 10000 }) {
  const last = clipText(lastUser, 2400);
  const hint = langHint || "";
  const goOn = toolsPrompt
    ? "\n## Keep going\nIf the user asked you to build/write/package something, checking the environment is NOT done. After a check, immediately write files and finish the deliverable. Do not stop after inspection.\n"
    : "";
  const tail = `\n\n---\nUser message (respond to this):\n${last}${goOn}${hint}`;
  let used = tail.length;
  let tools = "";
  if (toolsPrompt) {
    const toolsBudget = Math.min(2800, Math.max(400, maxLen - used - 2200));
    tools = clipText(toolsPrompt, toolsBudget) + "\n\n";
    used += tools.length;
  }
  const histBudget = Math.min(5200, Math.max(0, maxLen - used - 400));
  const parts = [];
  let histLen = 0;
  for (let i = turns.length - 1; i >= 0; i--) {
    const t = turns[i] || {};
    const text = String(t.text || "").trim();
    if (!text) continue;
    if (text === lastUser && t.role === "user" && i === turns.length - 1) continue;
    let line = `${t.role === "user" ? "User" : "Assistant"}: ${text}`;
    if (line.length > 1400) line = clipText(line, 1400);
    if (histLen + line.length + 1 > histBudget && parts.length > 0) break;
    parts.unshift(line);
    histLen += line.length + 1;
  }
  const history = parts.length ? `Recent conversation:\n${parts.join("\n")}\n` : "";
  used += history.length;
  let sys = "";
  const sysBudget = Math.min(900, Math.max(0, maxLen - used - 20));
  if (sysPrompt && sysBudget > 120) {
    sys = `(Background)\n${compressSysPrompt(sysPrompt, sysBudget)}\n\n`;
  }
  return sys + tools + history + tail;
}

function buildToolContinueQuestion({ origQ, calls, results, chinese, toolsPrompt }) {
  const task = clipText(origQ || "", 1800);
  const lines = [];
  const n = Math.max(calls.length, results.length);
  for (let i = 0; i < n; i++) {
    lines.push(`调用: ${calls[i] || "(unknown)"}\n结果:\n"""\n${clipText(results[i] || "", 2200)}\n"""`);
  }
  const body = chinese
    ? `用户任务还没完成。下面只是中间检查结果，不是最终答案。\n\n用户要的是：${task}\n\n${lines.join("\n\n")}\n\n规则：\n- 检查环境成功后必须立刻写文件、打包、给出成品路径。\n- 禁止只说「接下来我将…」然后停住。\n- 任务没做完就继续发 <function_call>。\n- 全部做完才用简体中文告诉用户结果。`
    : `The user task is NOT finished. The outputs below are intermediate checks, not the final answer.\n\nUser request: ${task}\n\n${lines.join("\n\n")}\n\nRules:\n- After environment checks, immediately write files / package / return the deliverable path.\n- Do not stop after saying what you will do next.\n- If unfinished, emit another <function_call> now.\n- Only reply in plain text when the whole task is done.`;
  return (toolsPrompt ? toolsPrompt + "\n\n---\n" : "") + body;
}

// ============================================================
// 7. Function Calling — Prompt 注入引擎
// ============================================================

function escapeRawCtrlInStrings(s) {
  let out = "", inStr = false, esc = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (esc) { out += c; esc = false; continue; }
    if (c === "\\") { out += c; esc = true; continue; }
    if (c === '"') { inStr = !inStr; out += c; continue; }
    if (inStr) {
      if (c === "\n") { out += "\\n"; continue; }
      if (c === "\r") { out += "\\r"; continue; }
      if (c === "\t") { out += "\\t"; continue; }
    }
    out += c;
  }
  return out;
}

// 修复 LLM 常见的 JSON 错误 (未转义引号、尾逗号、缺括号、字符串内裸换行)
function tryRepairJson(raw) {
  try { return JSON.parse(raw); } catch (e) { /* continue */ }
  let fixed = raw;
  // 0. 转义字符串内的裸控制符 (写文件时 content 含真实换行 → 否则 JSON.parse 失败)
  fixed = escapeRawCtrlInStrings(fixed);
  try { return JSON.parse(fixed); } catch (e) { /* continue */ }
  // 1. 去尾逗号
  fixed = fixed.replace(/,(\s*[}\]])/g, '$1');
  try { return JSON.parse(fixed); } catch (e) { /* continue */ }
  // 2. 补缺失的闭合括号
  let depth = 0;
  for (const c of fixed) {
    if (c === '{' || c === '[') depth++;
    if (c === '}' || c === ']') depth--;
  }
  if (depth > 0) {
    const lastChar = fixed.trim().slice(-1);
    const closer = lastChar === '}' ? ']' : '}';
    fixed += closer.repeat(Math.min(depth, 5));
    try { return JSON.parse(fixed); } catch (e) { /* continue */ }
  }
  // 3. 提取 name + arguments (即使 JSON 破损也能尽可能恢复)
  const nameMatch = fixed.match(/"name"\s*:\s*"([^"]+)"/);
  if (nameMatch) {
    const argsStart = fixed.indexOf('{', fixed.indexOf('"arguments"'));
    if (argsStart >= 0) {
      let d = 0, end = -1;
      for (let i = argsStart; i < fixed.length; i++) {
        if (fixed[i] === '{' || fixed[i] === '[') d++;
        if (fixed[i] === '}' || fixed[i] === ']') { d--; if (d === 0) { end = i + 1; break; } }
      }
      try { return { name: nameMatch[1], arguments: JSON.parse(fixed.slice(argsStart, end)) }; } catch (e) { /* fall through */ }
    }
    return { name: nameMatch[1], arguments: {} };
  }
  return null;
}

// 压缩 JSON Schema: 去掉 $schema/$defs/$ref 等元数据，单行紧凑输出
function compactSchema(schema) {
  if (!schema || typeof schema !== "object") return "{}";
  // 深拷贝后递归清理
  function clean(obj) {
    if (Array.isArray(obj)) return obj.map(clean);
    if (obj && typeof obj === "object") {
      const out = {};
      for (const [k, v] of Object.entries(obj)) {
        if (k.startsWith("$")) continue;  // 去掉 $schema, $defs, $ref, $dynamicAnchor 等
        out[k] = clean(v);
      }
      return out;
    }
    return obj;
  }
  return JSON.stringify(clean(schema));  // 单行，无缩进
}

function buildToolsPrompt(tools) {
  if (!tools || tools.length === 0) return "";

  const funcDefs = tools
    .filter(t => t.type === "function" && t.function)
    .map(t => {
      const fn = t.function;
      const params = compactSchema(fn.parameters);
      return `<function name="${fn.name}">
<description>${fn.description || "No description"}</description>
<parameters>${params}</parameters>
</function>`;
    })
    .join("\n");

  return `## ⚠️ CRITICAL — YOU MUST USE FUNCTION CALLING

You have access to these functions. When the user asks you to do something
that a function can handle, you MUST call the function. NEVER say "I cannot"
or "I don't have the ability". NEVER tell the user to save a file, run a
command, or do any step themselves — DO IT by calling the function (e.g. use
Write to create files, Bash to run commands). ALWAYS use a function instead.

${funcDefs}

## HOW TO CALL A FUNCTION

Output EXACTLY this format, then STOP:

<function_call>
{"name": "<function_name>", "arguments": {<args_as_json>}}
</function_call>

Rules:
- arguments MUST be a valid JSON object matching the function's parameters
- For file content, put the FULL content in the string value (newlines allowed)
- Do NOT add any text before or after the <function_call> block
- NEVER output file content or code for the user to copy — write it via Write`;
}

// ⭐ 工具结果回传轮专用 — "继续行动"版工具提示。
// 修复历史: ① 旧的强制版 ("YOU MUST call / 不要输出任何文本") 让模型回传轮要么再发多余
// 调用要么沉默; ② 过软版 ("有足够信息就用纯文本作答") 又走向另一极端 —— 模型把"让我先读
// 取文件"这种【意图叙述】当成回答然后停手, 多步任务半途而废。
// 本版核心原则: 叙述意图 ≠ 完成任务。只要还有未完成的步骤, 必须【在本轮就发出函数调用】,
// 不能只说"我接下来要做 X"。只有当任务真正全部完成时, 才用纯文本给出最终答复。
function buildToolsPromptSoft(tools) {
  if (!tools || tools.length === 0) return "";

  const funcDefs = tools
    .filter(t => t.type === "function" && t.function)
    .map(t => {
      const fn = t.function;
      return `<function name="${fn.name}">
<description>${fn.description || "No description"}</description>
<parameters>${compactSchema(fn.parameters)}</parameters>
</function>`;
    })
    .join("\n");

  return `## Available functions

${funcDefs}

## CRITICAL — keep going until the task is fully done

The user's request may need MULTIPLE steps. After each function result, decide:
the task is NOT finished yet → call the next function NOW; the task IS fully
finished → give the final answer in plain text.

NEVER reply with only your intention (e.g. "Let me read the file", "I'll now
start the server", "下一步我将…"). Stating intent is NOT an action and NOT an
answer. If you intend to do something, you MUST emit the function call for it
in THIS SAME reply.

## To call a function
Output EXACTLY: <function_call>{"name":"...","arguments":{...}}</function_call> then stop.
(For file content, put the FULL content in the string value; newlines allowed.)

## To finish
Only when every step is done, reply to the user in plain text WITHOUT any
<function_call> block.`;
}

// ⭐ StreamFilter: 实时过滤流式输出中的 <function_call> 块
// 防止 Claude Code 客户端因看到 XML 标记而截停
class StreamFilter {
  constructor() {
    this._buf = '';           // 未决缓冲区
    this._emitted = '';       // 已输出的纯净文本
    this._funcBlocks = [];    // 捕获的 function_call JSON
    this._inFunc = false;     // 是否在 <function_call> 内部
    this._tagLen = 16;        // '<function_call>'.length
    this._leftover = '';      // ⭐ parseCalls 无法解析的残留文本 (供流式层兜底输出)
  }

  // 喂入新文本块，返回应发送给客户端的纯净文本 (可能为空)
  feed(chunk) {
    this._buf += chunk;
    const out = [];
    const startTag = '<function_call>';
    const endTag = '</function_call>';

    while (this._buf.length > 0) {
      if (!this._inFunc) {
        const idx = this._buf.indexOf(startTag);
        if (idx === -1) {
          // 没有发现开始标签 — 但先检查尾部是否部分匹配
          const partialLen = this._partialMatch(startTag);
          if (partialLen > 0) {
            // 保留可能的部分标签在缓冲区
            const safe = this._buf.slice(0, -partialLen);
            if (safe) out.push(safe);
            this._buf = this._buf.slice(-partialLen);
            break;
          }
          // 完全安全，全部输出
          out.push(this._buf);
          this._buf = '';
          break;
        }
        // 发现开始标签 — 输出标签之前的文本
        if (idx > 0) out.push(this._buf.slice(0, idx));
        this._buf = this._buf.slice(idx + startTag.length);
        this._inFunc = true;
      }

      if (this._inFunc) {
        const idx = this._buf.indexOf(endTag);
        if (idx === -1) {
          // 还没找到结束标签 — 全部抑制
          break;
        }
        // 找到结束标签 — 捕获函数调用 JSON
        const json = this._buf.slice(0, idx).trim();
        if (json) this._funcBlocks.push(json);
        this._buf = this._buf.slice(idx + endTag.length);
        this._inFunc = false;
        // 继续循环，可能后面还有文本或更多 function_call
      }
    }

    const text = out.join('');
    if (text) this._emitted += text;
    return text;
  }

  // 检查缓冲区末尾是否部分匹配 tag
  _partialMatch(tag) {
    for (let i = tag.length - 1; i > 0; i--) {
      if (this._buf.endsWith(tag.slice(0, i))) return i;
    }
    return 0;
  }

  // 流结束时调用 — 返回可能残留的缓冲区内容 (不含 function_call 部分)
  flush() {
    if (this._inFunc) {
      // ⭐ 修复: 流在 </function_call> 到达前就结束了 (IMA 截断 / 模型漏写闭合标签)。
      // 旧逻辑直接丢弃缓冲区, 导致"调用命令后无任何回复" — 这里改为把残留 JSON
      // 当作一个 function block 捕获, 交给 parseCalls() 去尽力修复。
      const pending = this._buf.trim();
      if (pending) this._funcBlocks.push(pending);
      this._buf = '';
      this._inFunc = false;
      return '';
    }
    if (this._buf) {
      this._emitted += this._buf;
      const r = this._buf;
      this._buf = '';
      return r;
    }
    return '';
  }

  // 解析已捕获的所有 function_call 块
  parseCalls() {
    const calls = [];
    for (const raw of this._funcBlocks) {
      const parsed = tryRepairJson(raw);
      if (parsed && parsed.name) {
        calls.push({
          id: 'toolu_' + crypto.randomUUID().slice(0, 12),
          type: 'function',
          function: {
            name: parsed.name || '',
            arguments: JSON.stringify(parsed.arguments || parsed.parameters || {}),
          },
        });
      } else if (raw.length > 0) {
        // ⭐ JSON 修复失败 — 累积到 _leftover, 由流式层兜底输出, 避免对话静默中断。
        // (非流式走 cleanText/_emitted; 流式层需读取 leftover 单独 emit)
        const note = '\n[Function call (malformed)]:\n' + raw + '\n';
        this._emitted += note;
        this._leftover += note;
      }
    }
    return calls;
  }

  get cleanText() { return this._emitted; }
  get hasFunc() { return this._funcBlocks.length > 0; }
  get leftover() { return this._leftover; }
}

function makeToolCall(name, args, availableNames) {
  const want = String(name || "").trim();
  const names = availableNames || [];
  let resolved = names.find((n) => n.toLowerCase() === want.toLowerCase()) || want;
  if (!names.some((n) => n.toLowerCase() === resolved.toLowerCase())) {
    if (/^(bash|shell|sh|zsh|cmd|exec)$/i.test(want)) {
      resolved = names.find((n) => /bash|shell|exec/i.test(n)) || resolved;
    } else if (/^write/i.test(want)) {
      resolved = names.find((n) => /^write$/i.test(n)) || resolved;
    }
  }
  return {
    id: "toolu_" + crypto.randomUUID().slice(0, 12),
    type: "function",
    function: {
      name: resolved,
      arguments: typeof args === "string" ? args : JSON.stringify(args || {}),
    },
  };
}

const SHELL_HEAD = String.raw`pwd|ls|cd|python3?|pip3?|pyinstaller|mkdir|cat|echo|head|tail|npm|npx|node|git|curl|wget|chmod|rm|cp|mv|which|where|dir|type|uname|whoami|bash|sh`;

function looksLikeShell(cmd) {
  const t = String(cmd || "").trim();
  if (t.length < 2) return false;
  return new RegExp(`^(?:${SHELL_HEAD})\\b`, "i").test(t) || /&&|\|\||;/.test(t);
}

function firstShellIndex(text) {
  const m = String(text || "").match(new RegExp(String.raw`\b(?:${SHELL_HEAD})\b`, "i"));
  return m ? m.index : -1;
}

function parseFunctionCalls(text, availableNames = []) {
  if (!text) return { found: false, calls: [], text: "" };
  const calls = [];
  let leftover = String(text);

  leftover = leftover.replace(/<function_call>\s*([\s\S]*?)\s*<\/function_call>/gi, (full, inner) => {
    const parsed = tryRepairJson(String(inner || "").trim());
    if (parsed && parsed.name) {
      calls.push(makeToolCall(parsed.name, parsed.arguments || parsed.parameters || {}, availableNames));
      return "";
    }
    return full;
  });

  leftover = leftover.replace(/```(?:json)?\s*\n?\s*(\{[\s\S]*?"name"\s*:[\s\S]*?\})\s*```/gi, (full, json) => {
    const parsed = tryRepairJson(json);
    if (parsed && parsed.name) {
      calls.push(makeToolCall(parsed.name, parsed.arguments || parsed.parameters || {}, availableNames));
      return "";
    }
    return full;
  });

  leftover = leftover.replace(/```(bash|sh|shell|zsh|cmd|powershell)?[ \t]*\n?([\s\S]*?)```/gi, (full, lang, body) => {
    const cmd = String(body || "").trim();
    if (!cmd) return full;
    if (lang || looksLikeShell(cmd)) {
      calls.push(makeToolCall("Bash", { command: cmd }, availableNames));
      return "";
    }
    return full;
  });

  leftover = leftover.replace(/(?:^|\n)\s*(?:RUN|CMD|BASH|SHELL)\s*[:：]\s*([^\n`]+)(?=\n|$)/gi, (full, cmd) => {
    const c = String(cmd || "").trim();
    if (c) {
      calls.push(makeToolCall("Bash", { command: c }, availableNames));
      return "\n";
    }
    return full;
  });

  leftover = leftover.replace(/(?:^|\n)\s*(?:bash|shell)\s*[:：]?\s*\n?([^\n`]+)(?=\n|$)/gi, (full, cmd) => {
    const c = String(cmd || "").trim();
    if (looksLikeShell(c)) {
      calls.push(makeToolCall("Bash", { command: c }, availableNames));
      return "\n";
    }
    return full;
  });

  leftover = leftover.replace(/(?:Write|write_file|writeFile)\s+[^\n]*?((?:[A-Za-z]:\\|\/)[^\s]+)\s*\n```(?:\w+)?\s*\n([\s\S]*?)```/g, (_, filePath, content) => {
    calls.push(makeToolCall("Write", { file_path: filePath.trim(), content }, availableNames));
    return "";
  });

  leftover = leftover.replace(/(?:检查环境|查看环境|先检查|首先检查|Check environment)[:：]?\s*/gi, " ");

  if (!calls.length) {
    const idx = firstShellIndex(leftover);
    if (idx >= 0) {
      const cmd = leftover.slice(idx).replace(/[。．]+$/g, "").trim();
      if (cmd.length >= 3) {
        calls.push(makeToolCall("Bash", { command: cmd }, availableNames));
        leftover = leftover.slice(0, idx).replace(/[:：]\s*$/, "");
      }
    }
  }

  leftover = leftover
    .replace(/Check environment|Write the calculator code/gi, "")
    .replace(/```+/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  if (calls.length) console.log(`[tools] salvaged ${calls.length}: ${calls.map((c) => c.function.name).join(",")}`);
  else console.log(`[tools] none preview=${String(text).replace(/\s+/g, " ").slice(0, 160)}`);
  return { found: calls.length > 0, calls, text: leftover };
}

// ============================================================
// 8. OpenAI /v1/chat/completions
// ============================================================
async function openaiChat(req, res, body) {
  console.log(`[ask] openai model=${body.model || DEFAULT_MODEL} stream=${!!body.stream} msgs=${(body.messages || []).length}`);
  const modelKey = body.model || DEFAULT_MODEL;
  const model = resolveModel(modelKey);
  const stream = !!body.stream;
  const messages = body.messages || [];
  const tools = body.tools || null;
  const toolChoice = body.tool_choice || null;

  // --- 构建 question ---
  const hasToolResults = messages.some(m => m.role === "tool");
  const hasToolCalls = messages.some(m => m.role === "assistant" && m.tool_calls);
  let question;

  // 确定工具集 (两个分支共用)
  let effectiveTools = tools;
  if ((!effectiveTools || effectiveTools.length === 0) && toolChoice !== "none") {
    effectiveTools = [
      {type: "function", function: {name: "Bash", description: "Execute bash command", parameters: {type: "object", properties: {command: {type: "string"}}, required: ["command"]}}},
      {type: "function", function: {name: "Read", description: "Read a file", parameters: {type: "object", properties: {file_path: {type: "string"}}, required: ["file_path"]}}},
      {type: "function", function: {name: "Write", description: "Write to a file", parameters: {type: "object", properties: {file_path: {type: "string"}, content: {type: "string"}}, required: ["file_path", "content"]}}},
      {type: "function", function: {name: "Glob", description: "Find files by pattern", parameters: {type: "object", properties: {pattern: {type: "string"}}, required: ["pattern"]}}},
      {type: "function", function: {name: "Grep", description: "Search file contents", parameters: {type: "object", properties: {pattern: {type: "string"}, path: {type: "string"}}, required: ["pattern"]}}},
    ];
  }
  // ⭐ 标题生成请求不需要 tools
  const _sysParts = messages.filter(m => m.role === "system").map(m => extractContent(m));
  const _sysPrompt = _sysParts.length > 0 ? _sysParts.join("\n") : "";
  const isTitleGenOAI = _sysPrompt.includes('Generate a concise, sentence-case title');

  // ⭐ 限制工具数量，防止 prompt 超出限制
  const MAX_TOOLS_OAI = 16;
  const ESSENTIAL_OAI = new Set(['Bash', 'Read', 'Write', 'Glob', 'Grep']);
  if (isTitleGenOAI) {
    effectiveTools = [];  // 标题生成不需要工具
  } else if (effectiveTools && effectiveTools.length > MAX_TOOLS_OAI) {
    const essential = effectiveTools.filter(t => ESSENTIAL_OAI.has(t.function?.name));
    const others = effectiveTools.filter(t => !ESSENTIAL_OAI.has(t.function?.name));
    const available = MAX_TOOLS_OAI - essential.length;
    effectiveTools = [...essential, ...others.slice(0, Math.max(0, available))];
  }
  const toolsPrompt = (effectiveTools && effectiveTools.length > 0 && toolChoice !== "none")
    ? buildToolsPrompt(effectiveTools) : "";
  const oaiToolNames = (effectiveTools || []).map((t) => t.function?.name || t.name).filter(Boolean);

  let toolResultPathOAI = false;

  if (hasToolResults && hasToolCalls) {
    toolResultPathOAI = true;
    // 工具结果回传轮 — 单段系统通知格式
    const lastUserOAI = messages.filter(m => m.role === "user").pop();
    const lastUserTextOAI = extractContent(lastUserOAI || {});
    const cjkOAI = /[一-鿿㐀-䶿]/.test(lastUserTextOAI);

    // 收集函数调用和结果
    const calledOAI = [], resultsOAI = [];
    for (const m of messages) {
      if (m.role === "assistant" && m.tool_calls) {
        for (const tc of m.tool_calls) calledOAI.push(tc.function.name + "(" + tc.function.arguments + ")");
      }
      if (m.role === "tool") {
        resultsOAI.push(extractContent(m).slice(0, 3000));
      }
    }
    // 找到用户原始提问
    const userQsOAI = [];
    for (const m of messages) {
      if (m.role !== "user") continue;
      if (Array.isArray(m.content) && m.content.some(c => c.type === "tool_result")) continue;
      const q = extractContent(m);
      if (q && !q.startsWith("<session") && !q.startsWith("<system-reminder")) userQsOAI.push(q);
    }
    const origQ = userQsOAI.length > 0 ? userQsOAI[userQsOAI.length - 1] : (lastUserTextOAI || "");

    const minimalOAI = buildToolsPromptSoft(
      (effectiveTools || []).filter(t => ESSENTIAL_OAI.has(t.function?.name)).slice(0, 5)
    );
    question = buildToolContinueQuestion({
      origQ,
      calls: calledOAI,
      results: resultsOAI,
      chinese: cjkOAI,
      toolsPrompt: minimalOAI,
    });
  } else {
    // 普通问答 / 首轮 tool calling
    let sysPrompt = "";
    const sysParts = messages.filter(m => m.role === "system").map(m => extractContent(m));
    if (sysParts.length > 0) sysPrompt = sysParts.join("\n");

    const nonSys = messages.filter(m => m.role !== "system" && m.role !== "tool");
    const userMsgs = nonSys.filter(m => m.role === "user");
    if (userMsgs.length === 0) {
      return json(res, 400, { error: { message: "No user message", type: "invalid_request_error" } });
    }

    // ⭐ 跳过系统注入消息 (<session>, <system-reminder>)
    const realUserMsgs = userMsgs.filter(m => {
      const c = extractContent(m);
      return !c.startsWith('<session') && !c.startsWith('<system-reminder') && c.length > 10;
    });
    const lastUserMsg = realUserMsgs.length > 0
      ? extractContent(realUserMsgs[realUserMsgs.length - 1])
      : extractContent(userMsgs[userMsgs.length - 1]);

    // ⭐ 语言检测
    const hasCJKOAI = /[一-鿿㐀-䶿]/.test(lastUserMsg);
    const langHintOAI = hasCJKOAI ? "\n## Language\nRespond in the same language as the user's message. The user is writing in Chinese — respond in Chinese (简体中文).\n" : "";

    // IMA question 字段限制 10240 字符
    const MAX_QUESTION = 10000;

    const realMsgs = nonSys.filter(m => {
      const c = extractContent(m);
      return c.length > 6 && !c.startsWith('<session') && !c.startsWith('<system-reminder');
    }).filter(m => m.role === "user" || m.role === "assistant");
    const turns = realMsgs.slice(-24).map((m) => ({
      role: m.role,
      text: extractContent(m),
    }));
    question = packQuestion({
      sysPrompt,
      toolsPrompt,
      turns,
      lastUser: lastUserMsg,
      langHint: langHintOAI,
      maxLen: MAX_QUESTION,
    });
  }

  if (!question) {
    return json(res, 400, { error: { message: "Empty question", type: "invalid_request_error" } });
  }


  const oaiConvId = deriveConvId(req, messages);
  let sessionId;
  try {
    sessionId = await ensureSession(oaiConvId, question.slice(0, 100));
  } catch (e) {
    return json(res, 502, { error: { message: "Session init failed: " + e.message, type: "api_error" } });
  }

  // --- 非流式 ---
  if (!stream) {
    try {
      const events = qaWithRotate(oaiConvId, question, model.type, model.id);
      const text = await collectResponseText(events);
      const parsed = parseFunctionCalls(text, oaiToolNames);

      const choice = { index: 0, message: {}, finish_reason: "stop" };

      if (parsed.found && parsed.calls.length > 0) {
        choice.message = {
          role: "assistant",
          content: parsed.text || null,
          tool_calls: parsed.calls,
        };
        choice.finish_reason = "tool_calls";
      } else {
        // ⭐ 兜底: 空文本时给出占位, 避免客户端收到完全空的回复
        choice.message = { role: "assistant", content: text || "(本轮没有生成内容，请重试或换一种问法。)" };
      }

      return json(res, 200, {
        id: "chatcmpl-" + crypto.randomUUID().slice(0, 8),
        object: "chat.completion",
        created: Math.floor(Date.now() / 1000),
        model: modelKey,
        choices: [choice],
        usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
      });
    } catch (e) {
      return json(res, 502, { error: { message: "IMA error: " + e.message, type: "api_error" } });
    }
  }

  // --- 流式 ---
  cors(res);
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "x-request-id": "chatcmpl-" + crypto.randomUUID().slice(0, 8),
  });

  const chatId = "chatcmpl-" + crypto.randomUUID().slice(0, 8);
  const created = Math.floor(Date.now() / 1000);
  let resClosed = false;
  let sentText = false;   // ⭐ 是否已向客户端发送过任何文本/工具内容 (兜底判断)
  res.on('close', () => { resClosed = true; });

  function emit(delta, finishReason, toolCalls) {
    if (resClosed) return;
    try {
      const d = toolCalls && toolCalls.length > 0
        ? { role: "assistant", tool_calls: toolCalls }
        : { role: "assistant", content: delta };
      if ((delta && delta.length > 0) || (toolCalls && toolCalls.length > 0)) sentText = true;
      res.write("data: " + JSON.stringify({
        id: chatId, object: "chat.completion.chunk", created, model: modelKey,
        choices: [{ index: 0, delta: d, finish_reason: finishReason }],
      }) + "\n\n");
    } catch (e) { resClosed = true; }
  }

  try {
    const events = qaWithRotate(oaiConvId, question, model.type, model.id);
    let done = false;
    let rawText = "";

    let sawEvent = false;
    for await (const evt of events) {
      if (resClosed) break;
      const fail = completedError(evt);
      if (fail) throw new Error(fail);
      if (CONTROL_EVENTS.has(evt.event)) {
        if (evt.event === "COMPLETED" || evt.event === "CLOSE") done = true;
        break;
      }
      sawEvent = true;
      const txt = eventText(evt);
      if (txt) rawText += txt;
    }
    if (DEBUG_SSE && !sawEvent) console.error("[SSE-EMPTY] openai stream: no data events");

    const parsed = parseFunctionCalls(rawText, oaiToolNames);
    if (!resClosed) {
      const calls = parsed.calls || [];
      if (parsed.text) emit(parsed.text, null, null);
      if (calls.length > 0) {
        // ⭐ OpenAI streaming tool_calls: 逐个发送
        for (let i = 0; i < calls.length; i++) {
          const tc = calls[i];
          if (resClosed) break;
          try {
            sentText = true;
            res.write("data: " + JSON.stringify({
              id: chatId, object: "chat.completion.chunk", created, model: modelKey,
              choices: [{ index: 0, delta: { tool_calls: [{ index: i, id: tc.id, type: "function", function: { name: tc.function.name, arguments: tc.function.arguments } }] }, finish_reason: null }],
            }) + "\n\n");
          } catch (e) { resClosed = true; }
        }
        if (!resClosed) {
          res.write("data: " + JSON.stringify({
            id: chatId, object: "chat.completion.chunk", created, model: modelKey,
            choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
          }) + "\n\n");
        }
      } else {
        // ⭐ 兜底: 流正常结束但既无文本也无工具调用 (模型只回了被过滤的内容 /
        // 空响应 / 异常中断)。绝不让客户端收到完全空的回复 — 这是"无回复就结束"的根因。
        if (!sentText && !resClosed) {
          const fb = done
            ? "(本轮没有生成内容，请重试或换一种问法。)"
            : "(响应在完成前被中断，请重试。)";
          emit(fb, null, null);
        }
        // done 为 true 表示正常完成
        res.write("data: " + JSON.stringify({
          id: chatId, object: "chat.completion.chunk", created, model: modelKey,
          choices: [{ index: 0, delta: {}, finish_reason: done ? "stop" : "length" }],
        }) + "\n\n");
      }
    }
  } catch (e) {
    if (!resClosed) {
      try { res.write("data: " + JSON.stringify({
        id: chatId, object: "chat.completion.chunk", created, model: modelKey,
        choices: [{ index: 0, delta: {}, finish_reason: "error" }],
      }) + "\n\n"); } catch {}
    }
    console.error(`[STREAM-ERR] ${e.message}`);
  }
  if (!resClosed) {
    try { res.write("data: [DONE]\n\n"); res.end(); } catch {}
  }
}

// ============================================================
// 9. Anthropic /v1/messages
// ============================================================
async function anthropicMessages(req, res, body) {
  const modelKey = body.model || DEFAULT_MODEL;
  const model = resolveModel(modelKey);
  const stream = !!body.stream;
  const messages = body.messages || [];

  // system prompt
  let sysPrompt = "";
  if (typeof body.system === "string") sysPrompt = body.system;
  else if (Array.isArray(body.system))
    sysPrompt = body.system.filter(s => s.type === "text").map(s => s.text).join("\n");

  // tools → prompt injection
  // 如果 Claude Code 没发送 tools，注入默认工具集
  let tools = body.tools;
  if (!tools || tools.length === 0) {
    tools = [
      {name: "Bash", description: "Execute a bash command. Use for: reading files (cat/ls), system info (uname/df/free), git, npm, find, grep, etc.", input_schema: {type: "object", properties: {command: {type: "string", description: "The bash command to execute"}}, required: ["command"]}},
      {name: "Read", description: "Read contents of a file. Use for: inspecting file contents, reading configs, source code.", input_schema: {type: "object", properties: {file_path: {type: "string", description: "Absolute path to the file"}}, required: ["file_path"]}},
      {name: "Write", description: "Write content to a file. Use for: creating new files, overwriting existing files.", input_schema: {type: "object", properties: {file_path: {type: "string", description: "Absolute path"}, content: {type: "string", description: "Content to write"}}, required: ["file_path", "content"]}},
      {name: "Glob", description: "Find files matching a pattern. Use for: searching for files by name.", input_schema: {type: "object", properties: {pattern: {type: "string", description: "Glob pattern like **/*.js"}}, required: ["pattern"]}},
      {name: "Grep", description: "Search file contents for a pattern. Use for: finding code, searching logs.", input_schema: {type: "object", properties: {pattern: {type: "string", description: "Regex pattern to search for"}, path: {type: "string", description: "Directory or file to search in"}}, required: ["pattern"]}},
    ];
  }

  // ⭐ 标题生成请求不需要 tools (Claude Code 首轮请求)
  const isTitleGen = sysPrompt.includes('Generate a concise, sentence-case title');

  // ⭐ 限制工具数量，防止 prompt 超出 IMA 10240 字符限制
  const MAX_TOOLS = 16;
  const ESSENTIAL_TOOLS = new Set(['Bash', 'Read', 'Write', 'Glob', 'Grep']);
  let displayTools = tools;
  if (isTitleGen) {
    displayTools = [];  // 标题生成不需要工具
  } else if (displayTools.length > MAX_TOOLS) {
    // 优先保留核心工具，再按原顺序补充其他工具
    const essential = displayTools.filter(t => ESSENTIAL_TOOLS.has(t.name));
    const others = displayTools.filter(t => !ESSENTIAL_TOOLS.has(t.name));
    const available = MAX_TOOLS - essential.length;
    displayTools = [...essential, ...others.slice(0, Math.max(0, available))];
  }
  const anthropicToolNames = (displayTools || []).map((t) => t.name).filter(Boolean);
  // —— 过滤消息 ——
  // ⭐ 检测 Anthropic 格式的 tool_use / tool_result (多轮回传)
  function msgHasType(msg, type) {
    if (Array.isArray(msg.content)) return msg.content.some(c => c.type === type);
    return false;
  }
  const hasToolUses = messages.some(m => m.role === "assistant" && msgHasType(m, "tool_use"));
  const hasToolResults = messages.some(m => m.role === "user" && msgHasType(m, "tool_result"));

  // ⭐ 清理用户消息中的系统注入元数据
  function stripMetadata(text) {
    return text
      // 删除元数据块 (含内容一起删)
      .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '')
      .replace(/<local-command-caveat>[\s\S]*?<\/local-command-caveat>/g, '')
      .replace(/<local-command-stdout>[\s\S]*?<\/local-command-stdout>/g, '')
      // 删除单行命令元数据
      .replace(/<command-name>[^<]*<\/command-name>/g, '')
      .replace(/<command-message>[^<]*<\/command-message>/g, '')
      .replace(/<command-args>[^<]*<\/command-args>/g, '')
      // ⭐ <session> 只删标签、保留内容 (用户消息在 session 内)
      .replace(/<\/?session>/g, '')
      .trim();
  }

  const nonSys = messages.filter(m => m.role !== "system");
  const userMsgs = nonSys.filter(m => m.role === "user");
  if (userMsgs.length === 0)
    return json(res, 400, { type: "error", error: { type: "invalid_request_error", message: "No user message" } });

  // ⭐ 提取最后一条用户消息的实质内容
  const realUserMsgs = userMsgs.filter(m => {
    const c = stripMetadata(extractContent(m));
    return c.length > 5;
  });
  const lastUserMsg = realUserMsgs.length > 0
    ? stripMetadata(extractContent(realUserMsgs[realUserMsgs.length - 1]))
    : stripMetadata(extractContent(userMsgs[userMsgs.length - 1]));

  if (!lastUserMsg) {
  }

  // ⭐ 语言检测: 用户用中文则要求中文回复
  const hasCJK = /[一-鿿㐀-䶿]/.test(lastUserMsg);
  const langHint = hasCJK ? "\n## Language\nRespond in the same language as the user's message. The user is writing in Chinese — respond in Chinese (简体中文).\n" : "";

  // 工具通过 toolsPrompt 单独注入 (见下方 question 构建)
  const toolsPrompt = (displayTools && displayTools.length > 0) ? buildToolsPrompt(
    displayTools.map(t => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.input_schema || {} } }))
  ) : "";

  let question;
  let toolResultPath = false;  // 工具结果回传轮标记 (跳过 langHint 和截断)
  const MAX_QUESTION = 10000;

  if (hasToolResults && hasToolUses) {
    toolResultPath = true;  // 标记: 后续跳过 langHint 注入和通用截断
    // ⭐ 工具结果回传轮 — 单段系统通知格式，让模型把结果当作系统提供的信息
    const isCJK = hasCJK;

    // 收集工具调用名+结果
    const calledFuncs = [];
    const results = [];
    for (const m of messages) {
      if (m.role === "assistant" && Array.isArray(m.content)) {
        for (const c of m.content) {
          if (c.type === "tool_use") calledFuncs.push(c.name + "(" + JSON.stringify(c.input) + ")");
        }
      }
      if (m.role === "user" && Array.isArray(m.content)) {
        for (const c of m.content) {
          if (c.type === "tool_result") {
            const tc = typeof c.content === "string" ? c.content
              : Array.isArray(c.content) ? c.content.map(cc => cc.text || "").join("") : "";
            results.push(tc);
          }
        }
      }
    }

    // 找到用户的原始提问 (第一条非 tool_result 的用户消息)
    const userQs = [];
    for (const m of messages) {
      if (m.role !== "user") continue;
      if (Array.isArray(m.content) && m.content.some(c => c.type === "tool_result")) continue;
      const q = stripMetadata(extractContent(m));
      if (q) userQs.push(q);
    }
    const originalQuestion = userQs.length > 0 ? userQs[userQs.length - 1] : (lastUserMsg || "");

    const minimalToolsPrompt = buildToolsPromptSoft(
      displayTools.filter(t => ESSENTIAL_TOOLS.has(t.name)).slice(0, 5)
        .map(t => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.input_schema || {} } }))
    );
    question = buildToolContinueQuestion({
      origQ: originalQuestion,
      calls: calledFuncs,
      results,
      chinese: isCJK,
      toolsPrompt: minimalToolsPrompt,
    });
    // 跳过后续的 langHint 注入和通用截断 — 此路径的 question 已包含语言指令且 < 10000
  } else {
    const realMsgs = nonSys
      .filter(m => {
        const c = stripMetadata(extractContent(m));
        return c.length > 5;
      })
      .filter(m => m.role === "user" || m.role === "assistant");
    const turns = realMsgs.slice(-24).map((m) => ({
      role: m.role,
      text: stripMetadata(extractContent(m)),
    }));
    question = packQuestion({
      sysPrompt,
      toolsPrompt,
      turns,
      lastUser: lastUserMsg,
      langHint,
      maxLen: MAX_QUESTION,
    });
  }


  const effectiveConvId = deriveConvId(req, messages);
  let sessionId;
  const isNewSession = !getCachedSession(effectiveConvId);
  try { sessionId = await ensureSession(effectiveConvId, question.slice(0, 100)); }
  catch (e) {
    console.error(`[ANTHROPIC-SESSION] init failed: ${e.message}`);
    return json(res, 502, { type: "error", error: { type: "api_error", message: "Session init failed: " + e.message } });
  }

  // --- 非流式 ---
  if (!stream) {
    try {
      const events = qaWithRotate(effectiveConvId, question, model.type, model.id);
      const text = await collectResponseText(events);
      const parsed = parseFunctionCalls(text, anthropicToolNames);

      if (parsed.found && parsed.calls.length > 0) {
        const content = [];
        if (parsed.text) content.push({ type: "text", text: parsed.text });
        for (const c of parsed.calls) {
          content.push({
            type: "tool_use", id: c.id,
            name: c.function.name,
            input: JSON.parse(c.function.arguments || "{}"),
          });
        }
        return json(res, 200, {
          id: "msg_" + crypto.randomUUID().slice(0, 8),
          type: "message", role: "assistant", model: modelKey,
          content, stop_reason: "tool_use", stop_sequence: null,
          usage: { input_tokens: 0, output_tokens: 0 },
        });
      }

      return json(res, 200, {
        id: "msg_" + crypto.randomUUID().slice(0, 8),
        type: "message", role: "assistant", model: modelKey,
        // ⭐ 兜底: 空文本时给出占位, 避免客户端收到空 content
        content: [{ type: "text", text: text || "(本轮没有生成内容，请重试或换一种问法。)" }],
        stop_reason: "end_turn", stop_sequence: null,
        usage: { input_tokens: 0, output_tokens: 0 },
      });
    } catch (e) {
      console.error(`[ANTHROPIC-NONSTREAM-ERR] ${e.message}`);
      return json(res, 502, { type: "error", error: { type: "api_error", message: "IMA error: " + e.message } });
    }
  }

  // --- 流式 ---
  cors(res);
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });

  const msgId = "msg_" + crypto.randomUUID().slice(0, 8);
  let resClosed = false;
  res.on('close', () => { resClosed = true; });

  const em = (e, d) => {
    if (resClosed) return;
    try {
      if (e) res.write(`event: ${e}\n`);
      res.write(`data: ${JSON.stringify(d)}\n\n`);
    } catch (_) { resClosed = true; }
  };

  em("message_start", {
    type: "message_start",
    message: { id: msgId, type: "message", role: "assistant", model: modelKey, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } },
  });
  em("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });

  let stopReason = "end_turn";
  let done = false;
  let sentText = false;   // ⭐ 是否已发送过任何文本 delta (兜底判断)
  let calls = [];  // 在 try 外声明，供后续 tool_use 发送使用
  try {
    const events = qaWithRotate(effectiveConvId, question, model.type, model.id);
    let rawText = "";

    for await (const evt of events) {
      if (resClosed) break;
      const fail = completedError(evt);
      if (fail) throw new Error(fail);
      if (CONTROL_EVENTS.has(evt.event)) {
        if (evt.event === "COMPLETED" || evt.event === "CLOSE") done = true;
        break;
      }
      const txt = eventText(evt);
      if (txt) rawText += txt;
    }

    const parsed = parseFunctionCalls(rawText, anthropicToolNames);
    calls = parsed.calls || [];
    if (parsed.text && !resClosed) {
      em("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: parsed.text } });
      sentText = true;
    }

    // ⭐ 兜底: 流结束但既无文本也无工具调用 — 绝不让客户端收到完全空的回复。
    // 这是 Claude Code "执行命令后无任何回复就结束" 的最终防线。
    if (!sentText && calls.length === 0 && !resClosed) {
      const fb = done
        ? "(本轮没有生成内容，请重试或换一种问法。)"
        : "(响应在完成前被中断，请重试。)";
      em("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: fb } });
      sentText = true;
    }
  } catch (e) {
    console.error(`[ANTHROPIC-STREAM-ERR] ${e.message}`);
    // ⭐ 异常路径同样兜底, 保证至少有一段文本
    if (!sentText && !resClosed) {
      try { em("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "(响应处理出错，请重试。)" } }); sentText = true; } catch {}
    }
  }

  // 结束文本块 (仅在未截停时)
  if (!resClosed) em("content_block_stop", { type: "content_block_stop", index: 0 });

  // ⭐ 发送函数调用 — 使用上面已解析的 calls (避免重复解析)
  if (!resClosed && calls.length > 0) {
    stopReason = "tool_use";
    for (let i = 0; i < calls.length; i++) {
      const c = calls[i];
      const idx = i + 1;
      if (resClosed) break;
      em("content_block_start", { type: "content_block_start", index: idx, content_block: { type: "tool_use", id: c.id, name: c.function.name, input: {} } });
      em("content_block_delta", { type: "content_block_delta", index: idx, delta: { type: "input_json_delta", partial_json: c.function.arguments } });
      em("content_block_stop", { type: "content_block_stop", index: idx });
    }
  }

  if (!resClosed) {
    em("message_delta", { type: "message_delta", delta: { stop_reason: stopReason, stop_sequence: null }, usage: { output_tokens: 0 } });
    em("message_stop", { type: "message_stop" });
    try { res.end(); } catch {}
  }
}

// ============================================================
// 10. 路由
// ============================================================
function normalizeUrlPath(raw) {
  const text = String(raw || "/");
  const q = text.indexOf("?");
  const pathPart = (q >= 0 ? text.slice(0, q) : text).replace(/\/{2,}/g, "/") || "/";
  return q >= 0 ? `${pathPart}${text.slice(q)}` : pathPart;
}

async function router(req, res) {
  cors(res);
  if (req.method === "OPTIONS") { res.writeHead(204); return res.end(); }

  const url = normalizeUrlPath(req.url);
  req.url = url;
  const urlPath = url.split("?")[0];

  if (urlPath === "/health") return json(res, 200, { status: "ok" });
  if (urlPath === "/") return json(res, 200, {
    service: "ima2api",
    version: "3.0.0",
    endpoints: {
      openai: ["POST /v1/chat/completions (tools / function calling)", "GET /v1/models"],
      anthropic: ["POST /v1/messages (tools / tool_use)"],
    },
    models: Object.keys(MODELS),
    auth: "Bearer <api_key> or x-api-key header",
  });

  if (!checkAuth(req)) {
    return json(res, 401, { error: { type: "authentication_error", message: "Invalid API key" } });
  }

  let body = {};
  if (req.method === "POST") {
    try {
      const raw = await new Promise((resolve, reject) => {
        const chunks = [];
        req.on("data", c => chunks.push(c));
        req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
        req.on("error", reject);
      });
      body = raw ? JSON.parse(raw) : {};

      // body 已解析
    } catch (e) {
      return json(res, 400, { error: { type: "invalid_request_error", message: "Invalid JSON body" } });
    }
  }

  if (req.method === "GET" && urlPath === "/v1/models") {
    const modelList = Object.entries(MODELS).map(([id, info]) => ({
      id, object: "model", created: 1700000000, owned_by: "ima",
      type: "model", display_name: info.name,
      created_at: "2024-01-01T00:00:00Z",
    }));
    const ids = modelList.map(m => m.id);
    return json(res, 200, {
      object: "list",
      data: modelList,
      has_more: false,
      first_id: ids[0] || null,
      last_id: ids[ids.length - 1] || null,
    });
  }

  // Anthropic SDK: GET /v1/models/{model_id}
  if (req.method === "GET" && urlPath.startsWith("/v1/models/")) {
    const modelId = url.slice("/v1/models/".length);
    const model = resolveModel(modelId);
    if (!model) return json(res, 404, { error: { type: "error", error: { type: "not_found_error", message: `Model not found: ${modelId}` } } });
    return json(res, 200, {
      id: modelId,
      type: "model",
      display_name: model.name,
      created_at: "2024-01-01T00:00:00Z",
    });
  }

  if (req.method === "POST" && urlPath === "/v1/chat/completions") {
    try { return await openaiChat(req, res, body); }
    catch (e) {
      console.error(`[OPENAI-FATAL] ${e.message}\n${e.stack}`);
      if (!res.headersSent) return json(res, 500, { error: { type: "api_error", message: e.message } });
      else { try { res.end(); } catch {} }
    }
  }
  if (req.method === "POST" && urlPath === "/v1/messages") {
    try { return await anthropicMessages(req, res, body); }
    catch (e) {
      console.error(`[ANTHROPIC-FATAL] ${e.message}\n${e.stack}`);
      if (!res.headersSent) return json(res, 500, { error: { type: "api_error", message: e.message } });
      else { try { res.end(); } catch {} }
    }
  }

  json(res, 404, { error: { message: `Not found: ${req.method} ${url}` } });
}

// ============================================================
// 11. 启动
// ============================================================
const PORT = CONFIG.server?.port || 8080;
const HOST = CONFIG.server?.host || "0.0.0.0";

applyConfig(CONFIG);

function startApiServer(port = PORT, host = HOST) {
  return http.createServer(router).listen(port, host, () => {
    for (const k of API_KEYS) console.log(`║    ${maskKey(k).padEnd(44)}║`);
  });
}

if (require.main === module) startApiServer();

module.exports = {
  router,
  applyConfig,
  loadConfigFromDisk,
  clearImaSessions,
  setRotateHandler,
  isRateLimitMessage,
  getRuntime: () => ({ CONFIG, COOKIE, IMA_TOKEN, BKN, API_KEYS, MODELS, DEFAULT_MODEL, IMA_HEADERS }),
  startApiServer,
  json,
  checkAuth,
  maskKey,
  calcBkn,
};
