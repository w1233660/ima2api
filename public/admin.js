const $ = (id) => document.getElementById(id);

const loginCard = $("loginCard");
const dash = $("dash");
const loginErr = $("loginErr");
const statusBox = $("statusBox");
const jobMsg = $("jobMsg");
const qrImg = $("qrImg");
const keyList = $("keyList");

let pollTimer = null;

function showDash(on) {
  loginCard.classList.toggle("hidden", on);
  dash.classList.toggle("hidden", !on);
  $("logoutBtn").classList.toggle("hidden", !on);
}

function fmtTime(ts) {
  if (!ts) return "还没有";
  return new Date(ts).toLocaleString();
}

function renderAccounts(status) {
  const list = $("accountList");
  if (!list) return;
  list.innerHTML = "";
  const accounts = status.accounts || [];
  if (!accounts.length) {
    const li = document.createElement("li");
    li.textContent = "还没有账号，先导入一份 App 抓包。";
    list.appendChild(li);
    return;
  }
  for (const acc of accounts) {
    const li = document.createElement("li");
    if (acc.active) li.className = "active";
    const info = document.createElement("div");
    const title = document.createElement("div");
    title.textContent = (acc.nickname || "未命名") + (acc.active ? "（正在用）" : "");
    const meta = document.createElement("div");
    meta.className = "meta";
    meta.textContent = (acc.app_keepalive ? "App 账号" : "网页账号") + "  " + (acc.user_id || "") + (acc.cooling ? "  · 冷却中" : "");
    info.appendChild(title);
    info.appendChild(meta);
    const actions = document.createElement("div");
    actions.className = "actions";
    if (!acc.active) {
      const useBtn = document.createElement("button");
      useBtn.type = "button";
      useBtn.className = "btn";
      useBtn.textContent = "使用";
      useBtn.addEventListener("click", () => switchAccount(acc.user_id_full));
      actions.appendChild(useBtn);
    }
    const delBtn = document.createElement("button");
    delBtn.type = "button";
    delBtn.className = "btn";
    delBtn.textContent = "删除";
    delBtn.addEventListener("click", () => deleteAccount(acc.user_id_full));
    actions.appendChild(delBtn);
    li.appendChild(info);
    li.appendChild(actions);
    list.appendChild(li);
  }
}

function renderStatus(status) {
  if (!status) return;
  const keepHint = $("keepHint");
  if (status.logged_in) {
    statusBox.className = "ok";
    const kind = status.app_keepalive ? "App 账号" : "网页账号";
    statusBox.textContent = `${status.nickname || "已登录"} · ${kind} · 共 ${status.account_count || 0} 个 · 上次续期 ${fmtTime(status.last_refresh_ok_at)} · 下次大约 ${fmtTime(status.next_refresh_at)}`;
  } else {
    statusBox.className = "bad";
    statusBox.textContent = "还没有账号";
  }
  if (keepHint) {
    keepHint.textContent = status.last_refresh_error
      ? "续期失败：" + status.last_refresh_error
      : (status.keepalive_hint || "");
    keepHint.className = status.last_refresh_error ? "err" : "hint";
  }
  renderAccounts(status);
  keyList.innerHTML = "";
  for (const k of status.api_keys || []) {
    const li = document.createElement("li");
    li.textContent = k;
    keyList.appendChild(li);
  }
}

function renderJob(job) {
  if (!job) return;
  jobMsg.textContent = job.message || "";
  if (job.qr) {
    qrImg.src = job.qr;
    qrImg.classList.remove("hidden");
  } else {
    qrImg.classList.add("hidden");
  }
}

async function api(path, opts = {}) {
  const res = await fetch(path, {
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    ...opts,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || "请求失败");
    err.status = res.status;
    throw err;
  }
  return data;
}

async function refreshOnce() {
  const data = await api("/admin/api/status");
  renderStatus(data.status);
  renderJob(data.job);
}

function startPoll() {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = setInterval(() => {
    refreshOnce().catch((e) => {
      if (e.status === 401) {
        showDash(false);
        clearInterval(pollTimer);
      }
    });
  }, 1500);
}

async function switchAccount(userId) {
  const accountMsg = $("accountMsg");
  try {
    const data = await api("/admin/api/accounts/activate", {
      method: "POST",
      body: JSON.stringify({ user_id: userId }),
    });
    renderStatus(data.status);
    if (accountMsg) accountMsg.textContent = "已切换。";
  } catch (err) {
    if (accountMsg) accountMsg.textContent = err.message;
  }
}

async function deleteAccount(userId) {
  const accountMsg = $("accountMsg");
  try {
    const data = await api("/admin/api/accounts/delete", {
      method: "POST",
      body: JSON.stringify({ user_id: userId }),
    });
    renderStatus(data.status);
    if (accountMsg) accountMsg.textContent = "已删除。";
  } catch (err) {
    if (accountMsg) accountMsg.textContent = err.message;
  }
}

async function importHarFile(file) {
  const harMsg = $("harMsg");
  if (!file) return;
  try {
    if (harMsg) harMsg.textContent = "正在读取…";
    const text = await file.text();
    const data = await api("/admin/api/import-har", {
      method: "POST",
      body: JSON.stringify({ har: text }),
    });
    renderStatus(data.status);
    if (harMsg) harMsg.textContent = "已导入，并切换到这个账号。";
  } catch (err) {
    if (harMsg) harMsg.textContent = err.message;
  }
}

$("loginForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  loginErr.textContent = "";
  try {
    const data = await api("/admin/api/login", {
      method: "POST",
      body: JSON.stringify({ password: $("password").value }),
    });
    showDash(true);
    renderStatus(data.status);
    startPoll();
    refreshOnce().catch(() => {});
  } catch (err) {
    loginErr.textContent = err.message;
  }
});

$("logoutBtn").addEventListener("click", async () => {
  await api("/admin/api/logout", { method: "POST", body: "{}" }).catch(() => {});
  showDash(false);
  if (pollTimer) clearInterval(pollTimer);
});

$("startBtn").addEventListener("click", async () => {
  jobMsg.textContent = "正在打开登录页…";
  try {
    await api("/admin/api/qr/start", { method: "POST", body: "{}" });
    refreshOnce();
  } catch (err) {
    jobMsg.textContent = err.message;
  }
});

$("keepBtn").addEventListener("click", async () => {
  $("keepHint").textContent = "正在续期…";
  try {
    const data = await api("/admin/api/keepalive", { method: "POST", body: "{}" });
    renderStatus(data.status);
    $("keepHint").textContent = "续期成功。";
  } catch (err) {
    $("keepHint").textContent = err.message;
    $("keepHint").className = "err";
  }
});

$("cancelBtn").addEventListener("click", async () => {
  await api("/admin/api/qr/cancel", { method: "POST", body: "{}" }).catch(() => {});
  refreshOnce().catch(() => {});
});

$("keyForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const key = $("newKey").value.trim();
  if (!key) return;
  try {
    const data = await api("/admin/api/keys", {
      method: "POST",
      body: JSON.stringify({ key }),
    });
    $("newKey").value = "";
    renderStatus(data.status);
  } catch (err) {
    jobMsg.textContent = err.message;
  }
});

$("manualBtn").addEventListener("click", async () => {
  try {
    const data = await api("/admin/api/manual", {
      method: "POST",
      body: JSON.stringify({
        cookie: $("cookie").value,
        refresh_token: $("refresh").value,
        registration_id: $("registration").value,
      }),
    });
    renderStatus(data.status);
    $("accountMsg").textContent = "已保存。";
  } catch (err) {
    $("accountMsg").textContent = err.message;
  }
});

const harDrop = $("harDrop");
const harFile = $("harFile");
if (harDrop && harFile) {
  harDrop.addEventListener("click", () => harFile.click());
  harDrop.addEventListener("dragover", (e) => {
    e.preventDefault();
    harDrop.classList.add("over");
  });
  harDrop.addEventListener("dragleave", () => harDrop.classList.remove("over"));
  harDrop.addEventListener("drop", (e) => {
    e.preventDefault();
    harDrop.classList.remove("over");
    const file = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
    importHarFile(file);
  });
  harFile.addEventListener("change", () => {
    importHarFile(harFile.files && harFile.files[0]);
    harFile.value = "";
  });
}

refreshOnce()
  .then(() => {
    showDash(true);
    startPoll();
  })
  .catch(() => showDash(false));
