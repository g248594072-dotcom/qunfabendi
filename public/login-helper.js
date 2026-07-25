const els = {
  accountList: document.getElementById("accountList"),
  runStatus: document.getElementById("runStatus"),
  logs: document.getElementById("logs"),
  emptyHint: document.getElementById("emptyHint"),
  btnLoginConfirm: document.getElementById("btnLoginConfirm"),
  btnResetJob: document.getElementById("btnResetJob"),
  novncPanel: document.getElementById("novncPanel"),
  novncLink: document.getElementById("novncLink"),
  profileFile: document.getElementById("profileFile"),
  serverHint: document.getElementById("serverHint"),
};

let uploadTargetId = "";

function escapeHtml(s) {
  return String(s || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function parseProxyStructured(proxy) {
  const server = String(proxy?.server || "").trim();
  if (!server) return null;
  try {
    const raw = server.includes("://") ? server : `http://${server}`;
    const u = new URL(raw);
    const protocol = (u.protocol.replace(":", "") || "socks5").toLowerCase();
    const host = u.hostname;
    const port = Number(u.port);
    if (!host || !port) return null;
    return {
      protocol:
        protocol === "http" || protocol === "https" || protocol === "socks5"
          ? protocol
          : "socks5",
      host,
      port,
      username: proxy?.username || "",
      password: proxy?.password || "",
    };
  } catch {
    return null;
  }
}

function proxyTableHtml(proxy) {
  const s = parseProxyStructured(proxy);
  if (!s) {
    return `<p class="warn" style="margin:0">未设置代理（直连）。请让管理员先配置独立 IP。</p>`;
  }
  return `<table class="proxy-table">
    <tr><th>协议</th><td><code>${escapeHtml(s.protocol)}</code></td></tr>
    <tr><th>服务器地址</th><td><code>${escapeHtml(s.host)}</code></td></tr>
    <tr><th>端口号</th><td><code>${escapeHtml(String(s.port))}</code></td></tr>
    <tr><th>账号</th><td><code>${escapeHtml(s.username || "（无）")}</code></td></tr>
    <tr><th>密码</th><td><code>${escapeHtml(s.password || "（无）")}</code></td></tr>
  </table>`;
}

function renderAccounts(accountsFile, state) {
  const accounts = accountsFile?.accounts || [];
  if (els.emptyHint) els.emptyHint.hidden = accounts.length > 0;
  if (!els.accountList) return;
  if (!accounts.length) {
    els.accountList.innerHTML = "";
    return;
  }
  const targetId = state.loginTargetAccountId || "";
  const running = state.running;
  const canOpenBrowser = Boolean(state.novncUrl || state.hasDisplay);
  els.accountList.innerHTML = accounts
    .map((a) => {
      const status = a.loginStatus === "logged_in" ? "logged_in" : "pending";
      const statusLabel = status === "logged_in" ? "已登录" : "待登录";
      const isTarget = targetId === a.id && running === "login";
      const assignee = a.assignee
        ? `<span class="note">负责人：${escapeHtml(a.assignee)}</span>`
        : "";
      const last = a.lastLoginAt
        ? `<span class="note">上次确认：${escapeHtml(
            new Date(a.lastLoginAt).toLocaleString(),
          )}</span>`
        : "";
      const openDisabled = running || !canOpenBrowser ? "disabled" : "";
      return `<div class="helper-card ${isTarget ? "busy" : ""}" data-id="${escapeHtml(a.id)}">
        <div class="helper-card-top">
          <div>
            <h3>${escapeHtml(a.name)}
              <span class="login-status ${status}">${statusLabel}</span>
            </h3>
            ${assignee}
            ${last}
          </div>
        </div>
        ${proxyTableHtml(a.proxy)}
        <div class="helper-actions">
          <button type="button" class="primary" data-login="${escapeHtml(a.id)}" ${openDisabled}>
            打开登录
          </button>
          <button type="button" data-upload="${escapeHtml(a.id)}" ${running ? "disabled" : ""}>
            上传资料包
          </button>
          <a class="button-link" href="/api/accounts/${encodeURIComponent(a.id)}/profile">
            导出资料包
          </a>
          <button type="button" data-mark-pending="${escapeHtml(a.id)}" ${
            running ? "disabled" : ""
          }>标为待登录</button>
          <button type="button" data-mark-done="${escapeHtml(a.id)}" ${
            running ? "disabled" : ""
          }>手动标已登录</button>
        </div>
        ${
          !canOpenBrowser
            ? `<p class="note">当前服务器无图形界面：请用「上传资料包」，或部署 Docker（含 noVNC）。</p>`
            : ""
        }
      </div>`;
    })
    .join("");
}

async function refresh() {
  try {
    const res = await fetch("/api/login-helper/state");
    const data = await res.json();
    if (data.error) throw new Error(data.error);

    const running = Boolean(data.running);
    if (els.runStatus) {
      els.runStatus.textContent = running
        ? `进行中：${data.running}${data.confirmHint ? " · 等待确认" : ""}`
        : "空闲";
      els.runStatus.classList.toggle("busy", running);
    }
    if (els.btnLoginConfirm) {
      els.btnLoginConfirm.hidden = !data.waitingLoginConfirm;
    }
    if (els.logs) els.logs.textContent = (data.logs || []).join("\n") || "暂无日志";

    if (els.novncPanel && els.novncLink) {
      if (data.novncUrl) {
        els.novncPanel.hidden = false;
        els.novncLink.href = data.novncUrl;
      } else {
        els.novncPanel.hidden = true;
      }
    }

    renderAccounts(data.accounts, data);
  } catch (err) {
    if (els.runStatus) {
      els.runStatus.textContent = "连接失败";
      els.runStatus.classList.add("busy");
    }
    console.error(err);
  }
}

async function startLogin(accountId) {
  if (els.novncLink?.href && els.novncLink.href !== "#") {
    window.open(els.novncLink.href, "_blank", "noopener");
  }
  const res = await fetch("/api/job/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ accountId }),
  });
  const data = await res.json();
  if (data.error) alert(data.error);
  await refresh();
}

async function uploadProfile(accountId, file) {
  const res = await fetch(`/api/accounts/${encodeURIComponent(accountId)}/profile`, {
    method: "POST",
    headers: { "Content-Type": "application/gzip" },
    body: file,
  });
  const data = await res.json();
  if (data.error) throw new Error(data.error);
  alert("资料包已导入，该账号已标为已登录。");
  await refresh();
}

els.accountList?.addEventListener("click", async (ev) => {
  const btn = ev.target?.closest?.("button, a");
  if (!btn || btn.tagName === "A") return;
  const loginId = btn.getAttribute("data-login");
  const pendingId = btn.getAttribute("data-mark-pending");
  const doneId = btn.getAttribute("data-mark-done");
  const uploadId = btn.getAttribute("data-upload");
  try {
    if (loginId) {
      await startLogin(loginId);
    } else if (uploadId) {
      uploadTargetId = uploadId;
      els.profileFile?.click();
    } else if (pendingId) {
      await fetch("/api/accounts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "markPending", id: pendingId }),
      });
      await refresh();
    } else if (doneId) {
      await fetch("/api/accounts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "markLoggedIn", id: doneId }),
      });
      await refresh();
    }
  } catch (err) {
    alert(err instanceof Error ? err.message : String(err));
  }
});

els.profileFile?.addEventListener("change", async () => {
  const file = els.profileFile.files?.[0];
  const id = uploadTargetId;
  uploadTargetId = "";
  if (!file || !id) return;
  try {
    await uploadProfile(id, file);
  } catch (err) {
    alert(err instanceof Error ? err.message : String(err));
  } finally {
    els.profileFile.value = "";
  }
});

els.btnLoginConfirm?.addEventListener("click", async () => {
  await fetch("/api/login/confirm", { method: "POST" });
  await refresh();
});

els.btnResetJob?.addEventListener("click", async () => {
  await fetch("/api/job/reset", { method: "POST" });
  await refresh();
});

refresh();
setInterval(refresh, 1500);
