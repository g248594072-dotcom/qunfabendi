const els = {
  accountList: document.getElementById("accountList"),
  runStatus: document.getElementById("runStatus"),
  logs: document.getElementById("logs"),
  emptyHint: document.getElementById("emptyHint"),
  btnLoginConfirm: document.getElementById("btnLoginConfirm"),
  btnResetJob: document.getElementById("btnResetJob"),
  novncPanel: document.getElementById("novncPanel"),
  novncLink: document.getElementById("novncLink"),
  newAccountName: document.getElementById("newAccountName"),
  btnAddAccount: document.getElementById("btnAddAccount"),
  proxyModal: document.getElementById("proxyModal"),
  proxyModalTitle: document.getElementById("proxyModalTitle"),
  proxyProtocol: document.getElementById("proxyProtocol"),
  proxyHost: document.getElementById("proxyHost"),
  proxyPort: document.getElementById("proxyPort"),
  proxyUser: document.getElementById("proxyUser"),
  proxyPass: document.getElementById("proxyPass"),
  proxyPreview: document.getElementById("proxyPreview"),
  btnProxySave: document.getElementById("btnProxySave"),
  btnProxyClear: document.getElementById("btnProxyClear"),
  btnCopyLogs: document.getElementById("btnCopyLogs"),
  btnExportAll: document.getElementById("btnExportAll"),
};

let proxyEditAccountId = "";
let lastAccounts = [];

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
    return `<p class="note" style="margin:0">未设置代理：登录将走服务器本机出口 IP（直连）。需要独立 IP 时再点「设置代理 IP」。</p>`;
  }
  return `<table class="proxy-table">
    <tr><th>协议</th><td><code>${escapeHtml(s.protocol)}</code></td></tr>
    <tr><th>服务器地址</th><td><code>${escapeHtml(s.host)}</code></td></tr>
    <tr><th>端口号</th><td><code>${escapeHtml(String(s.port))}</code></td></tr>
    <tr><th>账号</th><td><code>${escapeHtml(s.username || "（无）")}</code></td></tr>
    <tr><th>密码</th><td><code>${escapeHtml(s.password || "（无）")}</code></td></tr>
  </table>`;
}

function updateProxyPreview() {
  if (!els.proxyPreview) return;
  const protocol = els.proxyProtocol?.value || "socks5";
  const host = (els.proxyHost?.value || "").trim();
  const port = (els.proxyPort?.value || "").trim();
  const user = (els.proxyUser?.value || "").trim();
  if (!host || !port) {
    els.proxyPreview.textContent = "预览：请填写服务器地址与端口";
    return;
  }
  els.proxyPreview.textContent = `预览：${protocol}://${host}:${port}${
    user ? " · 账号 " + user : ""
  }`;
}

function openProxyModal(accountId, current, accountName) {
  proxyEditAccountId = accountId;
  const s = parseProxyStructured(current);
  if (els.proxyModalTitle) {
    els.proxyModalTitle.textContent = `设置代理 IP · ${accountName || accountId}`;
  }
  if (els.proxyProtocol) els.proxyProtocol.value = s?.protocol || "socks5";
  if (els.proxyHost) els.proxyHost.value = s?.host || "";
  if (els.proxyPort) els.proxyPort.value = s?.port ? String(s.port) : "";
  if (els.proxyUser) els.proxyUser.value = s?.username || current?.username || "";
  if (els.proxyPass) els.proxyPass.value = s?.password || current?.password || "";
  updateProxyPreview();
  if (els.proxyModal) els.proxyModal.hidden = false;
}

function closeProxyModal() {
  proxyEditAccountId = "";
  if (els.proxyModal) els.proxyModal.hidden = true;
}

function collectStructuredProxy() {
  const host = (els.proxyHost?.value || "").trim();
  const port = Number(els.proxyPort?.value);
  if (!host || !Number.isFinite(port) || port <= 0) {
    throw new Error("请填写服务器地址和有效端口");
  }
  return {
    protocol: els.proxyProtocol?.value || "socks5",
    host,
    port: Math.floor(port),
    username: (els.proxyUser?.value || "").trim() || undefined,
    password: (els.proxyPass?.value || "").trim() || undefined,
  };
}

async function postAccounts(body) {
  const res = await fetch("/api/accounts", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (data.error) throw new Error(data.error);
  return data;
}

function renderAccounts(accountsFile, state) {
  const accounts = accountsFile?.accounts || [];
  lastAccounts = accounts;
  if (els.emptyHint) els.emptyHint.hidden = accounts.length > 0;
  if (!els.accountList) return;
  if (!accounts.length) {
    els.accountList.innerHTML = "";
    return;
  }
  const targetId = state.loginTargetAccountId || "";
  const running = state.running;
  els.accountList.innerHTML = accounts
    .map((a) => {
      const status = a.loginStatus === "logged_in" ? "logged_in" : "pending";
      const statusLabel = status === "logged_in" ? "已登录（已保存）" : "待登录";
      const isTarget = targetId === a.id && running === "login";
      const last = a.lastLoginAt
        ? `<span class="note">保存时间：${escapeHtml(
            new Date(a.lastLoginAt).toLocaleString(),
          )}</span>`
        : "";
      return `<div class="helper-card ${isTarget ? "busy" : ""}" data-id="${escapeHtml(a.id)}">
        <div class="helper-card-top">
          <div>
            <h3>${escapeHtml(a.name)}
              <span class="login-status ${status}">${statusLabel}</span>
            </h3>
            ${last}
          </div>
        </div>
        ${proxyTableHtml(a.proxy)}
        <div class="helper-actions">
          <button type="button" data-proxy="${escapeHtml(a.id)}" ${running ? "disabled" : ""}>
            设置代理 IP
          </button>
          <button type="button" class="primary" data-login="${escapeHtml(a.id)}" ${
            running ? "disabled" : ""
          }>
            打开登录
          </button>
          <button type="button" data-rename="${escapeHtml(a.id)}" ${running ? "disabled" : ""}>
            改名
          </button>
        </div>
        <p class="note">登录完成后点上方绿色「确认已登录」，信息会保存在服务器。</p>
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
      // 本机有界面弹出时不必显示远程桌面；仅服务器模式显示
      if (data.serverMode && data.novncUrl) {
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
  // 仅服务器模式才自动打开远程桌面；本机会直接弹出 Chrome 窗口
  if (
    els.novncPanel &&
    !els.novncPanel.hidden &&
    els.novncLink?.href &&
    els.novncLink.href !== "#"
  ) {
    window.open(els.novncLink.href, "_blank", "noopener");
  }
  const res = await fetch("/api/job/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ accountId }),
  });
  const data = await res.json();
  if (data.error) alert(data.error);
  else {
    alert(
      "已开始打开浏览器。\n\n本机：请到任务栏找新弹出的 Chrome/Chromium 窗口登录。\n服务器：请点「打开远程浏览器」。\n\n登进消息框后，回到本页点「确认已登录」。",
    );
  }
  await refresh();
}

els.btnAddAccount?.addEventListener("click", async () => {
  try {
    const name = (els.newAccountName?.value || "").trim();
    await postAccounts({ action: "add", name });
    if (els.newAccountName) els.newAccountName.value = "";
    await refresh();
  } catch (err) {
    alert(err instanceof Error ? err.message : String(err));
  }
});

els.newAccountName?.addEventListener("keydown", (ev) => {
  if (ev.key === "Enter") els.btnAddAccount?.click();
});

els.accountList?.addEventListener("click", async (ev) => {
  const btn = ev.target?.closest?.("button");
  if (!btn) return;
  const loginId = btn.getAttribute("data-login");
  const proxyId = btn.getAttribute("data-proxy");
  const renameId = btn.getAttribute("data-rename");
  try {
    if (loginId) {
      await startLogin(loginId);
    } else if (proxyId) {
      const acc = lastAccounts.find((a) => a.id === proxyId);
      openProxyModal(proxyId, acc?.proxy, acc?.name);
    } else if (renameId) {
      const acc = lastAccounts.find((a) => a.id === renameId);
      const name = prompt("新名称", acc?.name || "");
      if (!name) return;
      await postAccounts({ action: "rename", id: renameId, name });
      await refresh();
    }
  } catch (err) {
    alert(err instanceof Error ? err.message : String(err));
  }
});

["proxyProtocol", "proxyHost", "proxyPort", "proxyUser", "proxyPass"].forEach((id) => {
  els[id]?.addEventListener("input", updateProxyPreview);
  els[id]?.addEventListener("change", updateProxyPreview);
});

els.proxyModal?.addEventListener("click", (ev) => {
  if (ev.target?.closest?.("[data-close-proxy]")) closeProxyModal();
});

els.btnProxySave?.addEventListener("click", async () => {
  if (!proxyEditAccountId) return;
  try {
    const structuredProxy = collectStructuredProxy();
    await postAccounts({
      action: "setProxy",
      id: proxyEditAccountId,
      structuredProxy,
    });
    closeProxyModal();
    await refresh();
  } catch (err) {
    alert(err instanceof Error ? err.message : String(err));
  }
});

els.btnProxyClear?.addEventListener("click", async () => {
  if (!proxyEditAccountId) return;
  if (!confirm("清除该账号代理，改为直连？")) return;
  try {
    await postAccounts({
      action: "setProxy",
      id: proxyEditAccountId,
      proxy: null,
    });
    closeProxyModal();
    await refresh();
  } catch (err) {
    alert(err instanceof Error ? err.message : String(err));
  }
});

els.btnLoginConfirm?.addEventListener("click", async () => {
  await fetch("/api/login/confirm", { method: "POST" });
  await refresh();
  alert("已确认，登录信息已保存在服务器。");
});

els.btnResetJob?.addEventListener("click", async () => {
  await fetch("/api/job/reset", { method: "POST" });
  await refresh();
});

async function copyText(text, btn) {
  const value = (text || "").trim() || "(空)";
  try {
    await navigator.clipboard.writeText(value);
  } catch {
    const ta = document.createElement("textarea");
    ta.value = value;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand("copy");
    ta.remove();
  }
  if (btn) {
    const old = btn.textContent;
    btn.textContent = "已复制";
    setTimeout(() => {
      btn.textContent = old;
    }, 1200);
  }
}

els.btnCopyLogs?.addEventListener("click", () => {
  copyText(els.logs?.textContent || "", els.btnCopyLogs);
});

els.btnExportAll?.addEventListener("click", () => {
  // 走下载链接，包含账号+登录态+主页客户等，供服务器导入后发送
  window.location.href = "/api/sync/export";
});

refresh();
setInterval(refresh, 1500);
