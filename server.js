
"use strict";

const https = require("https");
const http = require("http");
const crypto = require("crypto");

// ============================================================
// 1. 配置
// ============================================================
const CONFIG = require("./config.json");
const BASE_HOST = "ima.qq.com";
const BASE_URL = "https://ima.qq.com";
const COOKIE = CONFIG.auth.cookie;
const API_KEYS = new Set(CONFIG.api_keys || []);

const IMA_TOKEN = (() => {
  const m = COOKIE.match(/IMA-TOKEN=([^;]+)/);
  return m ? m[1] : "";
})();

const BKN = (() => {
  let h = 5381;
  for (let i = 0; i < IMA_TOKEN.length; i++) h += (h << 5) + IMA_TOKEN.charCodeAt(i);
  return String(h & 0x7fffffff);
})();

function maskKey(k) {
  if (!k || k.length < 12) return "***";
  return k.slice(0, 6) + "..." + k.slice(-4);
}

// ============================================================
// 2. HTTP 客户端
// ============================================================
const IMA_HEADERS = {
  "from_browser_ima": "1",
  "x-ima-cookie": COOKIE,
  "x-ima-bkn": BKN,
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

async function* parseSSE(readable) {
  let buf = "";
  for await (const chunk of readable) {
    buf += chunk.toString("utf-8");
    const parts = buf.split("\n\n"); buf = parts.pop() || "";
    for (const part of parts) {
      if (!part.trim()) continue;
      const evt = { event: "", data: "" };
      for (const line of part.split("\n")) {
        if (line.startsWith("event:")) evt.event = line.slice(6).trim();
        else if (line.startsWith("data:")) evt.data = line.slice(5).trim();
      }
      if (evt.event) yield evt;
    }
  }
  if (buf.trim()) {
    const evt = { event: "", data: "" };
    for (const line of buf.split("\n")) {
      if (line.startsWith("event:")) evt.event = line.slice(6).trim();
      else if (line.startsWith("data:")) evt.data = line.slice(5).trim();
    }
    if (evt.event) yield evt;
  }
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

async function collectResponseText(events) {
  let text = "";
  for await (const evt of events) {
    if (evt.event === "MESSAGE") {
      try { const d = JSON.parse(evt.data); if (d.Text) text += d.Text; } catch {}
    } else if (evt.event === "COMPLETED" || evt.event === "CLOSE" || evt.event === "INNER_EXCEPTION") {
      break;
    }
  }
  return text;
}

// ============================================================
// 4. 会话缓存
// ============================================================
const sessions = new Map();
const SESSION_TTL = 30 * 60 * 1000;

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
  let sessionId = await ensureSession(convId, question);
  const events = await imaQaStream(sessionId, question, modelType, modelId);
  // 收集并检测是否触发会话限制错误（INNER_EXCEPTION 含 session limit）
  return (async function*() {
    let hitLimit = false;
    for await (const evt of events) {
      if (evt.event === "INNER_EXCEPTION") {
        // IMA 会话满了通常返回 INNER_EXCEPTION，此时重建 session 重试一次
        try {
          const newId = await ensureSession(convId, question, true);
          const retryEvents = await imaQaStream(newId, question, modelType, modelId);
          for await (const e2 of retryEvents) yield e2;
        } catch (_) {
          yield evt; // 重试也失败，把原始事件透传出去
        }
        return;
      }
      yield evt;
    }
  })();
}

// ============================================================
// 5. 模型
// ============================================================
const MODELS = CONFIG.models;
const DEFAULT_MODEL = CONFIG.default_model;

function resolveModel(requested) {
  if (!requested) return MODELS[DEFAULT_MODEL];
  if (MODELS[requested]) return MODELS[requested];
  const lower = requested.toLowerCase();
  for (const [k, v] of Object.entries(MODELS)) {
    if (k.toLowerCase() === lower || String(v.type) === lower) return v;
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

// ============================================================
// 7. Function Calling — Prompt 注入引擎
// ============================================================

// 修复 LLM 常见的 JSON 错误 (未转义引号、尾逗号、缺括号)
function tryRepairJson(raw) {
  try { return JSON.parse(raw); } catch (e) { /* continue */ }
  let fixed = raw;
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
or "I don't have the ability". ALWAYS use a function instead.

${funcDefs}

## HOW TO CALL A FUNCTION

Output EXACTLY this format, then STOP:

<function_call>
{"name": "<function_name>", "arguments": {<args_as_json>}}
</function_call>

Rules:
- The JSON MUST be on a SINGLE line
- arguments MUST be a valid JSON object matching the function's parameters
- Do NOT add any text before or after the <function_call> block`;
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
      // 不完整的 function_call — 丢弃
      this._buf = '';
      this._inFunc = false;
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
        // JSON 修复失败 — 保留原文避免对话中断
        this._emitted += '\n[Function call (malformed JSON)]:\n' + raw + '\n';
      }
    }
    return calls;
  }

  get cleanText() { return this._emitted; }
  get hasFunc() { return this._funcBlocks.length > 0; }
}

function parseFunctionCalls(text) {
  if (!text) return { found: false, text: "" };

  // 也匹配 ```json {...} ``` 格式 (模型可能输出 JSON 代码块)
  const jsonBlockRegex = /```(?:json)?\s*\n?\s*(\{(?:[^{}]|\{(?:[^{}]|\{[^{}]*\})*\})*\})\s*\n?\s*```/g;

  const regex = /<function_call>\s*\n?\s*(\{[\s\S]*?\})\s*\n?\s*<\/function_call>/g;
  const calls = [];
  let cleanText = text;

  // 尝试两种格式: <function_call> 和 ```json name/arguments
  const patterns = [
    regex,
    /```(?:json)?\s*\n?\s*\{[^{}]*"name"\s*:\s*"[^"]+"[^{}]*"arguments"\s*:\s*\{[\s\S]*?\}\s*\}\s*\n?\s*```/g,
  ];

  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(text)) !== null) {
      const parsed = tryRepairJson(match[1].trim());
      if (parsed && parsed.name) {
        calls.push({
          id: "toolu_" + crypto.randomUUID().slice(0, 12),
          type: "function",
          function: {
            name: parsed.name || "",
            arguments: JSON.stringify(parsed.arguments || parsed.parameters || {}),
          },
        });
      }
    }
    if (calls.length > 0) break;
  }

  if (calls.length > 0) {
    cleanText = text.replace(regex, "").replace(/```(?:json)?\s*\n?\s*\{[\s\S]*?\}\s*\n?\s*```/g, "").trim();
    return { found: true, calls, text: cleanText };
  }

  // 调试: 检查模型是否输出了近似的 function call 格式
  if (text.includes('function') || text.includes('tool') || text.includes('bash') || text.includes('read_file')) {
  }
  return { found: false, text };
}

// ============================================================
// 8. OpenAI /v1/chat/completions
// ============================================================
async function openaiChat(req, res, body) {
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
  const MAX_TOOLS_OAI = 8;
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

    if (cjkOAI) {
      question = "⚠️ 系统通知：你刚才调用了以下函数，返回结果如下：\n\n";
      for (let i = 0; i < calledOAI.length; i++) {
        question += "函数调用: " + calledOAI[i] + "\n返回结果:\n\"\"\"\n" + (resultsOAI[i] || "") + "\n\"\"\"\n\n";
      }
      question += "用户原始提问: \"" + origQ + "\"\n\n请用简体中文直接回答用户的问题。说出答案即可。不要说\"你分享了\"或\"看起来像是\"。上面用 \"\"\" 包裹的内容是你自己调用函数得到的返回结果。";
    } else {
      question = "⚠️ SYSTEM: You just called these functions and received these outputs:\n\n";
      for (let i = 0; i < calledOAI.length; i++) {
        question += "Function: " + calledOAI[i] + "\nOutput:\n\"\"\"\n" + (resultsOAI[i] || "") + "\n\"\"\"\n\n";
      }
      question += "User's original question: \"" + origQ + "\"\n\nAnswer DIRECTLY based on the outputs. Do NOT say \"you shared\" or \"it looks like\". The \"\"\" content is YOUR function output, NOT user input.";
    }

    // 工具结果回传轮: 不携带完整 sysPrompt, 仅 5 个核心工具
    const minimalOAI = buildToolsPrompt(
      (effectiveTools || []).filter(t => ESSENTIAL_OAI.has(t.function?.name)).slice(0, 5)
    );
    question = minimalOAI + "\n\n---\n" + question;
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

    if (nonSys.length > 1 && realUserMsgs.length >= 1) {
      const realMsgs = nonSys.filter(m => {
        const c = extractContent(m);
        return c.length > 10 && !c.startsWith('<session') && !c.startsWith('<system-reminder');
      });
      if (realMsgs.length > 1) {
        // ⭐ 修复: 扩展到 20 条，按字符数动态裁剪
        const MAX_HISTORY_CHARS = 6000;
        const recentMsgs = realMsgs
          .filter(m => m.role === "user" || m.role === "assistant")
          .slice(-20);
        let historyParts = [];
        let historyLen = 0;
        for (let i = recentMsgs.length - 1; i >= 0; i--) {
          const m = recentMsgs[i];
          const line = `${m.role === "user" ? "User" : "Assistant"}: ${extractContent(m)}`;
          if (historyLen + line.length > MAX_HISTORY_CHARS && historyParts.length > 0) break;
          historyParts.unshift(line);
          historyLen += line.length + 1;
        }
        const history = historyParts.join("\n");
        question = (sysPrompt ? sysPrompt + "\n\n" : "") + (toolsPrompt ? toolsPrompt + "\n\n---\n" : "") + history;
      } else {
        question = `${sysPrompt ? "(Background)\n" + sysPrompt + "\n\n" : ""}${toolsPrompt}\n\n---\nUser message (respond to this):\n${lastUserMsg}`;
      }
    } else {
      // ⭐ 智能压缩 system prompt (保留 toolsPrompt 完整)
      let context = sysPrompt;
      const overhead = toolsPrompt.length + lastUserMsg.length + 200;
      const remaining = MAX_QUESTION - overhead;

      if (context && context.length > remaining && remaining > 0) {
        // ⭐ 修复: 保留头尾，中间裁剪（保留核心规则 + 最新文件信息）
        const layoutMatch = context.match(/<project_layout>([\s\S]*?)<\/project_layout>/);
        const layoutSummary = layoutMatch
          ? layoutMatch[1].trim().split("\n").slice(0, 30).join("\n")
          : "";
        const headLen = Math.min(800, Math.floor(remaining * 0.6));
        const tailLen = Math.min(400, remaining - headLen);
        const head = context.slice(0, headLen);
        const tail = context.length > headLen + tailLen ? context.slice(-tailLen) : "";
        const layoutPart = layoutSummary ? "\n\nDirectory (summary):\n" + layoutSummary.slice(0, Math.min(300, remaining - headLen - tailLen - 50)) : "";
        context = tail ? head + "\n...[truncated]..." + layoutPart + "\n" + tail : head + layoutPart;
        context = context.slice(0, remaining);
      }

      question = `${context ? "(Background)\n" + context + "\n\n" : ""}${toolsPrompt}\n\n---\nUser message (respond to this):\n${lastUserMsg}`;
    }

    // ⭐ 注入语言提示 & 截断 (工具结果回传轮跳过)
    if (!toolResultPathOAI) {
      question += langHintOAI;

      // 最终截断 — 始终保留 toolsPrompt，否则模型看不到 function 定义
      if (question.length > MAX_QUESTION) {
        const minTemplate = "\n\n---\nUser message (respond to this):\n";
        const compact = toolsPrompt + minTemplate + lastUserMsg + langHintOAI;
        if (compact.length > MAX_QUESTION) {
          const availForUser = Math.max(500, MAX_QUESTION - toolsPrompt.length - minTemplate.length - langHintOAI.length);
          question = toolsPrompt + minTemplate + lastUserMsg.slice(0, Math.max(0, availForUser)) + langHintOAI;
        } else {
          question = compact;
        }
      }
    }
  }

  if (!question) {
    return json(res, 400, { error: { message: "Empty question", type: "invalid_request_error" } });
  }


  // 会话 — 复用 IMA session 保持对话记忆
  // ⭐ 修复: 用系统 prompt 作为稳定锚点（同 Anthropic 路径保持一致）
  let oaiConvId = req.headers["x-conversation-id"] || req.headers["x-session-id"] || "";
  if (!oaiConvId && messages.length > 0) {
    const sysMsg = messages.find(m => m.role === "system");
    const anchor = sysMsg
      ? extractContent(sysMsg).slice(0, 200)
      : extractContent(messages[0]).slice(0, 200);
    oaiConvId = "conv-" + crypto.createHash("md5").update(anchor).digest("hex").slice(0, 12);
  }
  let sessionId;
  try {
    sessionId = await ensureSession(oaiConvId, question.slice(0, 100));
  } catch (e) {
    return json(res, 502, { error: { message: "Session init failed: " + e.message, type: "api_error" } });
  }

  // --- 非流式 ---
  if (!stream) {
    try {
      const events = await imaQaStreamWithRetry(oaiConvId, question, model.type, model.id);
      const text = await collectResponseText(events);
      const parsed = parseFunctionCalls(text);

      const choice = { index: 0, message: {}, finish_reason: "stop" };

      if (parsed.found && parsed.calls.length > 0) {
        choice.message = {
          role: "assistant",
          content: parsed.text || null,
          tool_calls: parsed.calls,
        };
        choice.finish_reason = "tool_calls";
      } else {
        choice.message = { role: "assistant", content: text };
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
  res.on('close', () => { resClosed = true; });

  function emit(delta, finishReason, toolCalls) {
    if (resClosed) return;
    try {
      const d = toolCalls && toolCalls.length > 0
        ? { role: "assistant", tool_calls: toolCalls }
        : { role: "assistant", content: delta };
      res.write("data: " + JSON.stringify({
        id: chatId, object: "chat.completion.chunk", created, model: modelKey,
        choices: [{ index: 0, delta: d, finish_reason: finishReason }],
      }) + "\n\n");
    } catch (e) { resClosed = true; }
  }

  try {
    const events = await imaQaStreamWithRetry(oaiConvId, question, model.type, model.id);
    const filter = new StreamFilter();
    let done = false;

    for await (const evt of events) {
      if (resClosed) break;
      if (evt.event === "MESSAGE") {
        try {
          const d = JSON.parse(evt.data);
          if (d.Text) {
            const clean = filter.feed(d.Text);
            if (clean) emit(clean, null, null);
          }
        } catch {}
      } else if (evt.event === "COMPLETED" || evt.event === "CLOSE") {
        done = true;
        break;
      } else if (evt.event === "INNER_EXCEPTION") {
        break;
      }
    }

    // 冲刷残留缓冲
    const flushed = filter.flush();
    if (flushed && !resClosed) emit(flushed, null, null);

    // 检测并发送函数调用
    if (!resClosed) {
      const calls = filter.parseCalls();
      if (calls.length > 0) {
        // ⭐ OpenAI streaming tool_calls: 逐个发送
        for (let i = 0; i < calls.length; i++) {
          const tc = calls[i];
          if (resClosed) break;
          try {
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
  const MAX_TOOLS = 8;
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

    // 构建通知: 系统消息 + 函数调用 + 结果
    if (isCJK) {
      question = "⚠️ 系统通知：你刚才调用了以下函数，返回结果如下：\n\n";
      for (let i = 0; i < calledFuncs.length; i++) {
        question += "函数调用: " + calledFuncs[i] + "\n";
        question += "返回结果:\n\"\"\"\n" + (results[i] || "") + "\n\"\"\"\n\n";
      }
      question += "用户原始提问: \"" + originalQuestion + "\"\n\n";
      question += "请用简体中文直接回答用户的问题。说出答案即可。不要说\"你分享了\"或\"看起来像是\"或\"I see you've shared\"。上面用 \"\"\" 包裹的内容是你自己调用函数得到的返回结果，不是用户发给你的。";
    } else {
      question = "⚠️ SYSTEM: You just called these functions and received these outputs:\n\n";
      for (let i = 0; i < calledFuncs.length; i++) {
        question += "Function: " + calledFuncs[i] + "\n";
        question += "Output:\n\"\"\"\n" + (results[i] || "") + "\n\"\"\"\n\n";
      }
      question += "User's original question: \"" + originalQuestion + "\"\n\n";
      question += "Answer the user's question DIRECTLY based on the outputs above. Do NOT say \"you shared\" or \"I see you've shared\" or \"it looks like\". The content inside \"\"\" blocks is YOUR function output, NOT content the user sent you.";
    }

    // ⭐ 工具结果回传轮: 不携带完整 sysPrompt 和大量 tools (⚠️ 通知已提供足够上下文)
    // 仅保留 5 个核心工具, 确保总长度 < 10000 不会被后面的通用截断逻辑破坏
    const minimalToolsPrompt = buildToolsPrompt(
      displayTools.filter(t => ESSENTIAL_TOOLS.has(t.name)).slice(0, 5)
        .map(t => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.input_schema || {} } }))
    );
    question = minimalToolsPrompt + "\n\n---\n" + question;
    // 跳过后续的 langHint 注入和通用截断 — 此路径的 question 已包含语言指令且 < 10000
  } else if (nonSys.length > 1 && realUserMsgs.length >= 1) {
    // 取真正的用户消息（过滤掉系统注入的元数据）
    const realMsgs = nonSys
      .filter(m => {
        const c = stripMetadata(extractContent(m));
        return c.length > 5;
      });
    if (realMsgs.length > 1) {
      // ⭐ 修复: 从 6 条扩展到 20 条，并按总字符限制动态裁剪（保留最新的消息）
      const MAX_HISTORY_CHARS = 6000; // 留出空间给 sysPrompt + toolsPrompt
      const recentMsgs = realMsgs.slice(-20);
      let historyParts = [];
      let historyLen = 0;
      for (let i = recentMsgs.length - 1; i >= 0; i--) {
        const m = recentMsgs[i];
        const line = (m.role === "user" ? "User" : "Assistant") + ": " + stripMetadata(extractContent(m));
        if (historyLen + line.length > MAX_HISTORY_CHARS && historyParts.length > 0) break;
        historyParts.unshift(line);
        historyLen += line.length + 1;
      }
      question = historyParts.join("\n");
      question = (sysPrompt ? sysPrompt + "\n\n" : "") + (toolsPrompt ? toolsPrompt + "\n\n---\n" : "") + question;
    } else {
      // 只有一条真正消息，走单轮路径
      question = (sysPrompt ? "(Background)\n" + sysPrompt + "\n\n" : "") + toolsPrompt + "\n\n---\nUser message (respond to this):\n" + lastUserMsg;
    }
  } else {
    let context = sysPrompt;
    const overhead = toolsPrompt.length + lastUserMsg.length + 200;
    const remaining = MAX_QUESTION - overhead;
    if (context && context.length > remaining && remaining > 0) {
      // ⭐ 修复: 保留头部（核心规则）+ 尾部（最新文件列表），中间裁剪
      // 而非旧逻辑的"只保留前500字+目录"，那样会丢失大量重要指令
      const layoutMatch = context.match(/<project_layout>([\s\S]*?)<\/project_layout>/);
      const layoutSummary = layoutMatch ? layoutMatch[1].trim().split("\n").slice(0, 30).join("\n") : "";
      const headLen = Math.min(800, Math.floor(remaining * 0.6));
      const tailLen = Math.min(400, remaining - headLen);
      const head = context.slice(0, headLen);
      const tail = context.length > headLen + tailLen ? context.slice(-tailLen) : "";
      const layoutPart = layoutSummary ? "\n\nDirectory (summary):\n" + layoutSummary.slice(0, Math.min(300, remaining - headLen - tailLen - 50)) : "";
      context = tail ? head + "\n...[truncated]..." + layoutPart + "\n" + tail : head + layoutPart;
      context = context.slice(0, remaining);
    }
    question = (context ? "(Background)\n" + context + "\n\n" : "") + toolsPrompt + "\n\n---\nUser message (respond to this):\n" + lastUserMsg;
  }

  // ⭐ 注入语言提示 & 截断 (工具结果回传轮跳过 — 已自带语言指令且 < 10000)
  if (!toolResultPath) {
    question += langHint;

    if (question.length > MAX_QUESTION) {
      const minTemplate = "\n\n---\nUser message (respond to this):\n";
      const compact = toolsPrompt + minTemplate + lastUserMsg + langHint;
      if (compact.length > MAX_QUESTION) {
        const availForUser = Math.max(500, MAX_QUESTION - toolsPrompt.length - minTemplate.length - langHint.length);
        question = toolsPrompt + minTemplate + lastUserMsg.slice(0, Math.max(0, availForUser)) + langHint;
      } else {
        question = compact;
      }
    }
  }


  // 会话 — ⭐ 关键: 必须复用 IMA session 才能保持对话记忆
  const convId = req.headers["x-conversation-id"] || req.headers["x-session-id"] || "";
  // ⭐ 修复: 用系统 prompt + 第一条用户消息的 hash 作为稳定会话锚点
  // Claude Code 不发 x-conversation-id, 但同一对话的 system prompt 内容固定
  let effectiveConvId = convId;
  if (!effectiveConvId && messages.length > 0) {
    // 优先用 system prompt (Claude Code 在 system 里放项目路径等固定信息)
    const sysMsg = messages.find(m => m.role === "system");
    const anchor = sysMsg
      ? extractContent(sysMsg).slice(0, 200)           // system prompt 前200字，通常含项目路径
      : extractContent(messages[0]).slice(0, 200);      // fallback: 第一条消息
    effectiveConvId = "conv-" + crypto.createHash("md5").update(anchor).digest("hex").slice(0, 12);
  }
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
      const events = await imaQaStreamWithRetry(effectiveConvId, question, model.type, model.id);
      const text = await collectResponseText(events);
      const parsed = parseFunctionCalls(text);

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
        content: [{ type: "text", text }],
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
  const filter = new StreamFilter();
  let calls = [];  // 在 try 外声明，供后续 tool_use 发送使用
  try {
    const events = await imaQaStreamWithRetry(effectiveConvId, question, model.type, model.id);

    for await (const evt of events) {
      if (resClosed) break;
      if (evt.event === "MESSAGE") {
        try {
          const d = JSON.parse(evt.data);
          if (d.Text) {
            const clean = filter.feed(d.Text);
            if (clean) em("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: clean } });
          }
        } catch {}
      } else if (evt.event === "COMPLETED" || evt.event === "CLOSE") {
        done = true;
        break;
      } else if (evt.event === "INNER_EXCEPTION") {
        break;
      }
    }

    // 冲刷残留缓冲
    const flushed = filter.flush();
    if (flushed && !resClosed) em("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: flushed } });

    calls = filter.parseCalls();
  } catch (e) {
    console.error(`[ANTHROPIC-STREAM-ERR] ${e.message}`);
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
async function router(req, res) {
  cors(res);
  if (req.method === "OPTIONS") { res.writeHead(204); return res.end(); }

  const url = req.url;
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

http.createServer(router).listen(PORT, HOST, () => {
  for (const [id] of Object.entries(MODELS)) {
  }
  for (const k of API_KEYS) console.log(`║    ${maskKey(k).padEnd(44)}║`);
});
