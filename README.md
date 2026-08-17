# ima2api

把腾讯 ima 的对话转成常见 API，方便接到 New API、ChatBox 这类软件里。
同时兼容两套写法：OpenAI 的 `/v1/chat/completions`，以及 Anthropic 的 `/v1/messages`。

模型本身不会真的调工具。软件把工具说明发给本服务后，会写进提问里；模型如果回了调用标记，再帮你解析出来。

**说明：**
- 网页扫码只能拿到网页身份，**GLM-5.3 经常不可用**。
- 要用 GLM-5.3，得用手机官方 App 抓包，拿到 cookie、refresh_token、registration_id。
- 不要伪造 App 登录。
- cookie 大约 2 小时过期，后台会自动续；续不上就重新导入一次抓包。

本仓库在 [1icc0/ima2api](https://github.com/1icc0/ima2api) 基础上加了管理页、HAR 导入、多账号换号。仅供自己研究、自用，别对外公开暴露。

## 功能

- 浏览器打开管理页，导入 App 抓包（HAR），或手动填写三项登录信息
- 多账号；官方提示「提问太快啦」时自动换号
- 后台大约每 50 分钟自动续一次登录
- 兼容 OpenAI / Anthropic 两种请求格式
- 尽量识别模型把命令写成普通文字的情况，转成工具调用

## 部署

先复制一份配置，改管理页密码和接口密钥：

```bash
cp config.example.json config.json
```

本地直接跑：

```bash
npm install
node app.js
```

浏览器打开 `http://localhost:8080`，输入管理页密码。
把 App 抓到的 `.har` 拖进去，或到「手动填写」里贴 cookie、refresh_token、registration_id。

用 Docker：

```bash
cp config.example.json data/config.json
# 同样先改密码和密钥
docker compose up -d --build
```

原来的命令行方式还在：

```bash
npm install
python3 ima_runner.py
```

## 配置

主要改 `config.json`：

```json5
{
  "server": { "port": 8080, "host": "0.0.0.0" },
  "admin": {
    "password": "管理页密码",
    "session_secret": "随便一串，别用默认值"
  },
  "auth": {
    "cookie": "从 App 抓包拿到的完整 Cookie",
    "refresh_token": "从 auth_login/refresh 请求里拿",
    "registration_id": "App 才有，网页登录没有"
  },
  "accounts": [],
  "api_keys": ["sk-ima-demo-key-change-me"],
  "default_model": "glm-5.3"
}
```

`accounts` 一般不用手改，管理页导入账号后会自己写进去。

## 登录信息怎么拿

推荐用管理页导入 HAR，不用手抄。

自己抓的话：

1. 手机装官方 ima，用 QQ / 微信登录。
2. 手机走 HTTPS 抓包（Charles、HttpCanary、Stream 等）。
3. 在 App 里随便发一句，找到请求头里的 `x-ima-cookie`，整段复制。
4. 再找到 `https://ima.qq.com/auth_login/refresh` 这条请求，取出 `refresh_token` 和 `registration_id`。
5. 导入 HAR，或贴到管理页的「手动填写」。

网页管理页里的微信扫码也能入库，但那是网页身份，GLM-5.3 很容易不可用，只当备用。

## 接口

调用时在请求头带密钥：`Authorization: Bearer 你的密钥`，或 `x-api-key: 你的密钥`。
可以配多个密钥。

看有哪些模型：

```bash
curl http://localhost:8080/v1/models -H "Authorization: Bearer YOUR_KEY"
```

普通对话：

```bash
curl http://localhost:8080/v1/chat/completions \
  -H "Authorization: Bearer YOUR_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"glm-5.3","messages":[{"role":"user","content":"你好"}]}'
```

流式对话：

```bash
curl http://localhost:8080/v1/chat/completions \
  -H "Authorization: Bearer YOUR_KEY" \
  -d '{"model":"glm-5.3","messages":[{"role":"user","content":"你好"}],"stream":true}'
```

带工具：

```bash
curl http://localhost:8080/v1/chat/completions \
  -H "Authorization: Bearer YOUR_KEY" \
  -d '{
    "model":"glm-5.3",
    "messages":[{"role":"user","content":"执行 uname -a"}],
    "tools":[{
      "type":"function",
      "function":{"name":"Bash","description":"执行命令","parameters":{"type":"object","properties":{"command":{"type":"string"}},"required":["command"]}}
    }],
    "tool_choice":"auto"
  }'
```

Anthropic 格式走 `/v1/messages`，用法类似。

接 New API 时，渠道地址填本服务，例如 `http://你的机器:8080`，密钥不要多复制一个回车。

## 工具调用是怎么做的

ima 官方没有原生工具接口。软件如果带了 `tools`，本服务会把工具说明写进提问，并要求模型按下面这种格式回答：

```text
<function_call>{"name":"Bash","arguments":{"command":"pwd"}}</function_call>
```

然后把这段转成 OpenAI / Anthropic 认识的工具调用，再等软件把执行结果回传。
模型有时会把命令直接写成普通文字，本服务会尽量认出来。

一次提问里最多带 16 个工具；说明太长会压缩。对话优先留最近几轮，避免把前面内容挤掉。

## 可用模型

| 名称 | 说明 |
|------|------|
| `glm-5.3` | 默认。需要 App 登录信息 |
| `glm-5.3-think` | 思考模式 |
| `deepseek-v3.2` | 较快 |
| `deepseek-v3.2-think` | 思考模式 |
| `hy-2.0` | 混元 |
| `hy-2.0-think` | 思考模式 |
| `kimi-k2.5` | Kimi |
| `kimi-k2.5-think` | 思考模式 |

旧名字 `glm-5.2`、`hy3-preview`、`deepseek-v4-flash` 也会转到现在这几个。

## 用 Python 调用

```python
from openai import OpenAI
client = OpenAI(base_url="http://localhost:8080/v1", api_key="your-key")
response = client.chat.completions.create(
    model="glm-5.3",
    messages=[{"role": "user", "content": "你好"}],
    stream=True
)
for chunk in response:
    if chunk.choices[0].delta.content:
        print(chunk.choices[0].delta.content, end="")
```

```python
from anthropic import Anthropic
client = Anthropic(base_url="http://localhost:8080/v1", api_key="your-key")
with client.messages.stream(
    model="glm-5.3",
    max_tokens=1024,
    messages=[{"role": "user", "content": "你好"}]
) as stream:
    for text in stream.text_stream:
        print(text, end="")
```

## 已知限制

- 工具调用靠往提问里塞说明，不是 ima 官方能力。
- 流式输出时，调用标记会被滤掉，调用方那边看不到那一段。
- ima 单次会话大概 20 轮，超了会重新开一局。
- 官方有提问频率限制。多导几个 App 号，换号才有用；池子里只有一个号，换不了。
- 管理页里的网页扫码不要拿来覆盖已经能用的 App 号。

## 许可证

沿用原项目约定。使用前请自行遵守 ima 用户协议和当地法规，账号风险自负。
