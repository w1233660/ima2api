# ima2api

逆向 IMA App 的 AI API，封装为 **OpenAI Chat Completions** 和 **Anthropic Messages** 兼容格式，支持 **tool calling**（prompt 注入方式）。

一次抓包即可，之后都会自动刷新cookie。

## 快速开始

```bash
cd ima2api
npm install
python3 ima_runner.py
```

## 配置

编辑 `config.json`：

```json5
{
  "server": { "port": 8080, "host": "0.0.0.0" },
  "auth": {
    // 从 IMA App 抓包获取的完整 Cookie
    "cookie": "IMA-GUID=...;IMA-TOKEN=...;...",
    "refresh_token": "抓包https://ima.qq.com/auth_login/refresh请求获取",
    "registration_id": "抓包https://ima.qq.com/auth_login/refresh请求获取"
  },
  "api_keys": ["sk-ima-demo-key-change-me"],
  "default_model": "glm-5.2"
}
```

### 获取 Cookie

1. 手机安装 IMA App，QQ/微信登录
2. 配置 HTTPS 代理（mitmproxy / Charles / Fiddler）
3. 发送任意消息，复制请求中的 `x-ima-cookie` 值
4. 填入 `config.json` → `auth.cookie`
5. 将 https://ima.qq.com/auth_login/refresh 这条请求里的refresh_token和registration_id也填入config.json (用于自动刷新cookie)

## API 端点

### OpenAI 兼容 (`/v1`)

```bash
# 模型列表
curl http://localhost:8080/v1/models -H "Authorization: Bearer YOUR_KEY"

# 普通对话
curl http://localhost:8080/v1/chat/completions \
  -H "Authorization: Bearer YOUR_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"glm-5.2","messages":[{"role":"user","content":"你好"}]}'

# 流式
curl http://localhost:8080/v1/chat/completions \
  -H "Authorization: Bearer YOUR_KEY" \
  -d '{"model":"glm-5.2","messages":[{"role":"user","content":"你好"}],"stream":true}'

# Tool calling
curl http://localhost:8080/v1/chat/completions \
  -H "Authorization: Bearer YOUR_KEY" \
  -d '{
    "model":"glm-5.2",
    "messages":[{"role":"user","content":"执行 uname -a"}],
    "tools":[{
      "type":"function",
      "function":{"name":"Bash","description":"执行命令","parameters":{"type":"object","properties":{"command":{"type":"string"}},"required":["command"]}}
    }],
    "tool_choice":"auto"
  }'

# Tool 结果回传 (多轮)
curl http://localhost:8080/v1/chat/completions \
  -H "Authorization: Bearer YOUR_KEY" \
  -d '{
    "model":"glm-5.2",
    "messages":[
      {"role":"user","content":"执行 uname -a"},
      {"role":"assistant","tool_calls":[{"id":"call_1","type":"function","function":{"name":"Bash","arguments":"{\"command\":\"uname -a\"}"}}]},
      {"role":"tool","tool_call_id":"call_1","content":"Linux ..."}
    ]
  }'
```

### Anthropic 兼容 (`/v1`)

```bash
# 流式对话
curl http://localhost:8080/v1/messages \
  -H "Authorization: Bearer YOUR_KEY" \
  -d '{"model":"glm-5.2","max_tokens":1024,"messages":[{"role":"user","content":"你好"}],"stream":true}'

# Tool use
curl http://localhost:8080/v1/messages \
  -H "Authorization: Bearer YOUR_KEY" \
  -d '{
    "model":"glm-5.2",
    "max_tokens":1024,
    "messages":[{"role":"user","content":"执行 pwd"}],
    "tools":[{"name":"Bash","description":"执行命令","input_schema":{"type":"object","properties":{"command":{"type":"string"}},"required":["command"]}}]
  }'
```

## Tool Calling 机制

采用 **prompt 注入** 方式实现 function calling：

```
## CRITICAL — YOU MUST USE FUNCTION CALLING

<function name="Bash">
<description>执行 bash 命令</description>
<parameters>{"type":"object","properties":{"command":{"type":"string"}},"required":["command"]}</parameters>
</function>

## HOW TO CALL A FUNCTION
输出 <function_call>{"name":"...","arguments":{...}}</function_call>，然后立即停止。
```

工作流：
1. 客户端发送 `tools` 参数 → 服务器将工具定义注入 prompt
2. IMA 模型输出 `<function_call>…</function_call>` → 服务器解析为 `tool_calls` / `tool_use` 返回
3. 客户端本地执行工具 → 将结果回传
4. 服务器检测到 `tool_use` + `tool_result` → 用 `⚠️ 系统通知` 格式告知模型结果
5. 模型基于结果直接回答用户

特性：
- 最多展示 8 个工具（截断保护）
- Schema 自动压缩（去掉 `$schema`/`$defs`/`$ref` 等元数据）
- 自动检测中文用户 → 要求中文回复
- 会话自动复用（基于首条消息 hash）

## 可用模型

| 模型 ID | 底座 | 说明 |
|---------|------|------|
| `glm-5.2` | GLM-5.2 | 默认 |
| `glm-5.2-think` | GLM-5.2 | 思考模式 |
| `deepseek-v4-flash` | DeepSeek V4 | 快速 |
| `deepseek-v4-flash-think` | DeepSeek V4 | 思考模式 |
| `hy3-preview` | 混元 Hy3 | 预览 |
| `hy3-preview-think` | 混元 Hy3 | 思考模式 |

## 认证

- `Authorization: Bearer <key>` 或 `x-api-key: <key>`
- 支持配置多个 API Key

## 客户端集成

### OpenAI SDK (Python)

```python
from openai import OpenAI
client = OpenAI(base_url="http://localhost:8080/v1", api_key="your-key")
response = client.chat.completions.create(
    model="glm-5.2",
    messages=[{"role": "user", "content": "你好"}],
    tools=[{"type":"function","function":{"name":"Bash","description":"执行命令","parameters":{"type":"object","properties":{"command":{"type":"string"}},"required":["command"]}}}],
    stream=True
)
for chunk in response:
    if chunk.choices[0].delta.content:
        print(chunk.choices[0].delta.content, end="")
```

### Anthropic SDK (Python)

```python
from anthropic import Anthropic
client = Anthropic(base_url="http://localhost:8080/v1", api_key="your-key")
with client.messages.stream(
    model="glm-5.2",
    max_tokens=1024,
    messages=[{"role": "user", "content": "你好"}]
) as stream:
    for text in stream.text_stream:
        print(text, end="")
```

## 局限性

- IMA 模型需要 prompt 注入才能触发 tool calling（非原生支持）
- 流式输出中的 `<function_call>` 块会被服务器端过滤（客户端不可见）
- IMA 会话限制约 10 轮，超出后需重新建立
