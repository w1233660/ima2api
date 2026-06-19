#!/usr/bin/env python3
"""
IMA Cookie 自动刷新 + npm start 管理脚本

config.json 需包含以下字段：
  auth.cookie          - x-ima-cookie 字符串
  auth.refresh_token   - 长期刷新票据
  auth.registration_id - 设备推送注册 ID

可选配置（脚本顶部）：
  CONFIG_PATH - config.json 路径（默认同目录）
  NPM_CWD     - npm start 工作目录（默认同目录）
"""

import json
import os
import signal
import subprocess
import sys
import time
import urllib.request
import urllib.error

# ============================================================
# 路径配置（按需修改）
# ============================================================
CONFIG_PATH = "./config.json"   # config.json 路径
NPM_CWD     = "."               # npm start 工作目录（package.json 所在位置）
NPM_PORT    = 9898              # npm start 监听端口（用于重启时确认端口已释放）

REFRESH_ADVANCE_SECONDS = 300   # 提前多少秒刷新（默认 5 分钟）
CHECK_INTERVAL          = 60    # 主循环检查间隔（秒）
# ============================================================


def ts() -> str:
    return time.strftime("%H:%M:%S")


def read_config() -> dict:
    with open(CONFIG_PATH, "r", encoding="utf-8") as f:
        return json.load(f)


def write_config(data: dict):
    with open(CONFIG_PATH, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
    print(f"[{ts()}] config.json 已更新")


def parse_cookie(cookie_str: str) -> dict:
    fields = {}
    for part in cookie_str.split(";"):
        part = part.strip()
        if "=" in part:
            k, v = part.split("=", 1)
            fields[k.strip()] = v.strip()
    return fields


def build_cookie(fields: dict) -> str:
    order = [
        "IMA-GUID", "APP-VERSION", "IMA-Q36", "IMA-IUA",
        "UID-TYPE", "IMA-UID", "IMA-TOKEN", "IMA-TOKEN-TYPE", "CLIENT-TYPE",
    ]
    parts = [f"{k}={fields[k]}" for k in order if k in fields]
    parts += [f"{k}={v}" for k, v in fields.items() if k not in order]
    return ";".join(parts)


def calc_bkn(token: str) -> int:
    h = 5381
    for ch in token:
        h += (h << 5) + ord(ch)
    return h & 0x7FFFFFFF


def do_refresh(config: dict) -> tuple[str, int] | None:
    """
    使用 config 中的凭据刷新 IMA-TOKEN。
    成功返回 (新cookie字符串, 有效期秒数)，失败返回 None。
    """
    auth         = config["auth"]
    cookie_str   = auth["cookie"]
    refresh_token   = auth.get("refresh_token", "")
    registration_id = auth.get("registration_id", "")

    if not refresh_token:
        print(f"[{ts()}] [ERROR] config.json 中缺少 auth.refresh_token")
        return None
    if not registration_id:
        print(f"[{ts()}] [ERROR] config.json 中缺少 auth.registration_id")
        return None

    fields = parse_cookie(cookie_str)
    token  = fields.get("IMA-TOKEN", "")
    uid    = fields.get("IMA-UID", "")

    if not token or not uid:
        print(f"[{ts()}] [ERROR] cookie 中缺少 IMA-TOKEN 或 IMA-UID")
        return None

    payload = json.dumps({
        "user_id":         uid,
        "refresh_token":   refresh_token,
        "token_type":      14,
        "registration_id": registration_id,
    }).encode("utf-8")

    headers = {
        "from_browser_ima": "1",
        "x-ima-cookie":     cookie_str,
        "x-ima-bkn":        str(calc_bkn(token)),
        "referer":          "https://ima.qq.com",
        "origin":           "https://ima.qq.com",
        "Content-Type":     "application/json; charset=utf-8",
        "User-Agent":       "okhttp/4.12.0",
        "Accept-Encoding":  "identity",
        "Connection":       "Keep-Alive",
    }

    req = urllib.request.Request(
        "https://ima.qq.com/auth_login/refresh",
        data=payload, headers=headers, method="POST"
    )
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            body = json.loads(resp.read().decode("utf-8"))
    except urllib.error.URLError as e:
        print(f"[{ts()}] [ERROR] 网络请求失败: {e}")
        return None

    if body.get("code") != 0:
        print(f"[{ts()}] [ERROR] refresh 返回错误: {body}")
        return None

    new_token  = body["token"]
    valid_time = int(body.get("token_valid_time", 7200))
    print(f"[{ts()}] Token 刷新成功，有效期 {valid_time}s，新 bkn={calc_bkn(new_token)}")

    fields["IMA-TOKEN"] = new_token
    return build_cookie(fields), valid_time


# ============================================================
# npm start 进程管理
# ============================================================

npm_proc: subprocess.Popen | None = None


def start_npm():
    global npm_proc
    print(f"[{ts()}] 启动 npm start（工作目录: {os.path.abspath(NPM_CWD)}）")
    npm_proc = subprocess.Popen(
        ["npm", "start"],
        cwd=NPM_CWD,
        stdout=sys.stdout,
        stderr=sys.stderr,
        start_new_session=True,
    )
    print(f"[{ts()}] npm start 已启动，PID={npm_proc.pid}")


def stop_npm():
    global npm_proc
    if npm_proc and npm_proc.poll() is None:
        pgid = os.getpgid(npm_proc.pid)
        print(f"[{ts()}] 停止 npm start（PID={npm_proc.pid}，PGID={pgid}）")
        try:
            os.killpg(pgid, signal.SIGTERM)
        except ProcessLookupError:
            pass
        try:
            npm_proc.wait(timeout=10)
        except subprocess.TimeoutExpired:
            try:
                os.killpg(pgid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            npm_proc.wait()
        print(f"[{ts()}] npm start 已停止")
    npm_proc = None


def wait_port_free(port: int, timeout: float = 10.0):
    import socket
    deadline = time.time() + timeout
    while time.time() < deadline:
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            s.settimeout(0.5)
            try:
                s.connect(("127.0.0.1", port))
            except (ConnectionRefusedError, OSError):
                return True
        time.sleep(0.3)
    return False


def restart_npm():
    stop_npm()
    if not wait_port_free(NPM_PORT):
        print(f"[{ts()}] [WARN] 端口 {NPM_PORT} 未在超时内释放，仍尝试启动")
    start_npm()


def on_exit(signum, frame):
    print(f"\n[{ts()}] 收到退出信号，清理中...")
    stop_npm()
    sys.exit(0)


# ============================================================
# 主循环
# ============================================================

def main():
    signal.signal(signal.SIGINT, on_exit)
    signal.signal(signal.SIGTERM, on_exit)

    if not os.path.exists(CONFIG_PATH):
        print(f"[ERROR] 找不到 config.json: {os.path.abspath(CONFIG_PATH)}")
        sys.exit(1)

    # 启动前做一次字段校验
    config = read_config()
    auth = config.get("auth", {})
    missing = [f for f in ("cookie", "refresh_token", "registration_id") if not auth.get(f)]
    if missing:
        print(f"[ERROR] config.json 的 auth 中缺少字段: {', '.join(missing)}")
        sys.exit(1)

    fields = parse_cookie(auth["cookie"])
    print(f"[{ts()}] IMA-UID  : {fields.get('IMA-UID', '?')}")
    print(f"[{ts()}] IMA-TOKEN: {fields.get('IMA-TOKEN', '')[:30]}...")

    # 首次立即刷新（验证 refresh_token 可用，同时拿到准确的过期时间）
    token_expire_at = 0

    start_npm()
    print(f"[{ts()}] 进入刷新循环，每 {CHECK_INTERVAL}s 检查一次...")

    while True:
        time.sleep(CHECK_INTERVAL)

        # npm 意外退出时自动拉起
        if npm_proc and npm_proc.poll() is not None:
            print(f"[{ts()}] npm start 意外退出（code={npm_proc.returncode}），重新启动...")
            start_npm()

        # 距过期还早，跳过
        if time.time() < token_expire_at - REFRESH_ADVANCE_SECONDS:
            remaining = int(token_expire_at - time.time())
            print(f"[{ts()}] Token 有效，剩余约 {remaining}s")
            continue

        print(f"[{ts()}] Token 即将过期，开始刷新...")

        config = read_config()  # 重新读取，防止外部改过
        result = do_refresh(config)

        if result is None:
            print(f"[{ts()}] 刷新失败，{CHECK_INTERVAL}s 后重试")
            continue

        new_cookie, valid_time = result
        token_expire_at = time.time() + valid_time

        config["auth"]["cookie"] = new_cookie
        write_config(config)

        print(f"[{ts()}] 重启 npm start 以加载新 cookie...")
        restart_npm()


if __name__ == "__main__":
    main()
