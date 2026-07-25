const els = {
  messageText: document.getElementById("messageText"),
  messageImage: document.getElementById("messageImage"),
  delayMinSec: document.getElementById("delayMinSec"),
  delayMaxSec: document.getElementById("delayMaxSec"),
  maxSendPerPage: document.getElementById("maxSendPerPage"),
  contactDays: document.getElementById("contactDays"),
  headless: document.getElementById("headless"),
  pageListAccessible: document.getElementById("pageListAccessible"),
  pageListUnavailable: document.getElementById("pageListUnavailable"),
  pageListUnknown: document.getElementById("pageListUnknown"),
  pageListUnknownWrap: document.getElementById("pageListUnknownWrap"),
  fbDetectHint: document.getElementById("fbDetectHint"),
  contactTotal: document.getElementById("contactTotal"),
  sendableTotal: document.getElementById("sendableTotal"),
  blacklistCount: document.getElementById("blacklistCount"),
  blacklistUpdated: document.getElementById("blacklistUpdated"),
  tagList: document.getElementById("tagList"),
  logs: document.getElementById("logs"),
  results: document.getElementById("results"),
  btnCopyLogs: document.getElementById("btn-copy-logs"),
  btnCopyResults: document.getElementById("btn-copy-results"),
  runStatus: document.getElementById("runStatus"),
  saveMsg: document.getElementById("saveMsg"),
  ssWarn: document.getElementById("ssWarn"),
  btnLoginConfirm: document.getElementById("btnLoginConfirm"),
  btnDetectConfirm: document.getElementById("btnDetectConfirm"),
  btnResetJob: document.getElementById("btnResetJob"),
  accountList: document.getElementById("accountList"),
  newAccountName: document.getElementById("newAccountName"),
};

let settingsHydrated = false;
let lastPagesKey = "";
let lastAccountsKey = "";

function setJobButtonsDisabled(disabled) {
  document.querySelectorAll("[data-job]").forEach((btn) => {
    btn.disabled = Boolean(disabled);
  });
}

function fillSettings(s) {
  if (!s) return;
  if (els.messageText) els.messageText.value = s.messageText ?? "";
  if (els.messageImage) els.messageImage.value = s.messageImage ?? "";
  if (els.delayMinSec) els.delayMinSec.value = s.delayMinSec ?? 2;
  if (els.delayMaxSec) els.delayMaxSec.value = s.delayMaxSec ?? 6;
  if (els.maxSendPerPage) els.maxSendPerPage.value = s.maxSendPerPage ?? 2;
  if (els.contactDays) els.contactDays.value = s.contactDays ?? 365;
  if (els.headless) els.headless.checked = Boolean(s.headless);
}

function collectSettings(selectedPageIds) {
  return {
    messageText: els.messageText?.value ?? "",
    messageImage: (els.messageImage?.value ?? "").trim(),
    delayMinSec: Number(els.delayMinSec?.value ?? 2),
    delayMaxSec: Number(els.delayMaxSec?.value ?? 6),
    maxSendPerPage: Number(els.maxSendPerPage?.value ?? 2),
    contactDays: Number(els.contactDays?.value ?? 365),
    headless: Boolean(els.headless?.checked),
    selectedPageIds,
  };
}

function selectedIds() {
  return [...document.querySelectorAll(".page-item input:checked")].map(
    (el) => el.value,
  );
}

function pageItemHtml(p, { checked, disabled }) {
  return `
    <label class="page-item ${disabled ? "disabled" : ""}">
      ${
        disabled
          ? ""
          : `<input type="checkbox" value="${p.pageId}" ${
              checked ? "checked" : ""
            } />`
      }
      <div>
        <strong>${escapeHtml(p.pageName)}</strong>
        <span>page_id=${escapeHtml(p.pageId)} · 客户 ${p.contactCount ?? 0}${
          p.accountName
            ? ` · <span class="acc-badge">${escapeHtml(p.accountName)}</span>`
            : ""
        }${disabled ? " · 当前探测未覆盖（可再探其它账号）" : ""}${
          p.bannedByRemark
            ? ` · <b style="color:#b42318">封号(备注含「封」，发送跳过)</b>${
                p.remark ? `「${escapeHtml(String(p.remark).slice(0, 24))}」` : ""
              }`
            : ""
        }</span>
      </div>
    </label>`;
}

function renderSplitLists(data) {
  const selected = new Set(data.settings?.selectedPageIds || selectedIds());
  const accessible = data.pagesAccessible || [];
  const unavailable = data.pagesUnavailable || [];
  const unknown = data.pagesUnknown || [];

  if (els.pageListAccessible) {
    els.pageListAccessible.innerHTML = accessible.length
      ? accessible
          .map((p) =>
            pageItemHtml(p, {
              checked: selected.has(p.pageId),
              disabled: false,
            }),
          )
          .join("")
      : '<div class="page-item"><span>暂无。请先探测，或换账号登录后再探测。</span></div>';
  }

  if (els.pageListUnavailable) {
    els.pageListUnavailable.innerHTML = unavailable.length
      ? unavailable
          .map((p) => pageItemHtml(p, { checked: false, disabled: true }))
          .join("")
      : '<div class="page-item"><span>没有不可用主页（或尚未探测）。</span></div>';
  }

  if (els.pageListUnknownWrap && els.pageListUnknown) {
    if (unknown.length) {
      els.pageListUnknownWrap.hidden = false;
      els.pageListUnknown.innerHTML = unknown
        .map((p) =>
          pageItemHtml(p, {
            checked: selected.has(p.pageId),
            disabled: false,
          }),
        )
        .join("");
    } else {
      els.pageListUnknownWrap.hidden = true;
      els.pageListUnknown.innerHTML = "";
    }
  }

    if (els.fbDetectHint) {
      if (data.fbDetectedAt) {
        const accN = (data.fbSessionAccounts || []).length;
        els.fbDetectHint.textContent = `上次探测：${data.fbDetectedAt} · 账号切片 ${accN} · 可管理 ${accessible.length} · 未覆盖 ${unavailable.length}`;
      } else {
        els.fbDetectHint.textContent =
          "尚未探测：添加账号 → 登录全部 → 同步 Sale →「探测全部账号」。每个窗口打开「企业资产」右侧主页列表。";
      }
    }
}

function renderAccounts(accountsFile) {
  if (!els.accountList) return;
  const accounts = accountsFile?.accounts || [];
  const active = accountsFile?.activeAccountId || "";
  if (!accounts.length) {
    els.accountList.innerHTML =
      '<div class="account-item"><span>暂无账号</span></div>';
    return;
  }
  els.accountList.innerHTML = accounts
    .map((a) => {
      const isActive = a.id === active;
      const proxyText = a.proxy?.server
        ? `代理 ${a.proxy.server}${a.proxy.username ? " · " + a.proxy.username : ""}`
        : "直连（未设代理）";
      return `<div class="account-item ${isActive ? "active" : ""}" data-id="${escapeHtml(a.id)}">
        <label class="check" style="margin:0">
          <input type="radio" name="activeAccount" value="${escapeHtml(a.id)}" ${
            isActive ? "checked" : ""
          } />
          <span class="acc-name">${escapeHtml(a.name)}${
            isActive ? "（当前）" : ""
          }</span>
        </label>
        <span class="acc-meta">${escapeHtml(proxyText)}<br />${escapeHtml(
          a.profileDir || "",
        )}</span>
        <div class="acc-actions">
          <button type="button" data-acc-proxy="${escapeHtml(a.id)}">代理IP</button>
          <button type="button" data-acc-rename="${escapeHtml(a.id)}">改名</button>
          <button type="button" data-acc-remove="${escapeHtml(
            a.id,
          )}" class="danger" ${accounts.length <= 1 ? "disabled" : ""}>删除</button>
        </div>
      </div>`;
    })
    .join("");
}

/** 弹窗收集代理；空 server 表示清除 */
function promptProxy(title, current) {
  const server = prompt(
    `${title}\n代理地址（http://ip:port 或 socks5://ip:port）\n留空=清除/直连`,
    current?.server || "",
  );
  if (server === null) return undefined; // 取消
  if (!String(server).trim()) return null; // 清除
  const username = prompt("代理用户名（可空）", current?.username || "") ?? "";
  const password = prompt("代理密码（可空）", current?.password || "") ?? "";
  return {
    server: String(server).trim(),
    username: String(username).trim() || undefined,
    password: String(password).trim() || undefined,
  };
}

function renderResults(results) {
  if (!els.results) return;
  if (!results?.length) {
    els.results.innerHTML = '<div class="result">暂无记录</div>';
    return;
  }
  els.results.innerHTML = results
    .map((r) => {
      const ok = r.ok;
      const mode = r.dryRun ? "定位" : "发送";
      return `<div class="result ${ok ? "ok" : "bad"}">
        [${escapeHtml(String(r.at || ""))}] ${escapeHtml(String(r.pageName || ""))}
        → ${escapeHtml(String(r.customerName || ""))}
        · ${mode}${ok ? "成功" : "失败"}
        ${r.error ? " · " + escapeHtml(String(r.error)) : ""}
      </div>`;
    })
    .join("");
}

function escapeHtml(s) {
  return s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

async function refresh() {
  let running = false;
  try {
    const res = await fetch("/api/state");
    const data = await res.json();
    if (data.error && !data.settings) throw new Error(data.error);

    running = Boolean(data.running);

    if (!settingsHydrated) {
      fillSettings(data.settings);
      settingsHydrated = true;
    }

    if (els.tagList && Array.isArray(data.blacklistTags)) {
      els.tagList.textContent = data.blacklistTags.join("、");
    }

    const pagesKey = JSON.stringify({
      a: (data.pagesAccessible || []).map((p) => [
        p.pageId,
        p.contactCount,
        p.accountName,
      ]),
      u: (data.pagesUnavailable || []).map((p) => p.pageId),
      k: (data.pagesUnknown || []).map((p) => p.pageId),
      d: data.fbDetectedAt || "",
      s: data.settings?.selectedPageIds || [],
    });
    if (pagesKey !== lastPagesKey) {
      renderSplitLists(data);
      lastPagesKey = pagesKey;
    }

    const accountsKey = JSON.stringify(data.accounts || {});
    if (accountsKey !== lastAccountsKey) {
      renderAccounts(data.accounts);
      lastAccountsKey = accountsKey;
    }

    if (els.contactTotal) {
      els.contactTotal.textContent = String(data.contactTotal ?? 0);
    }
    if (els.sendableTotal) {
      els.sendableTotal.textContent = String(data.sendableTotal ?? 0);
    }
    if (els.blacklistCount) {
      els.blacklistCount.textContent = String(data.blacklistCount ?? 0);
    }
    if (els.blacklistUpdated) {
      els.blacklistUpdated.textContent = data.blacklistUpdatedAt
        ? `（更新于 ${data.blacklistUpdatedAt}）`
        : "";
    }
    if (els.logs) {
      els.logs.textContent = (data.logs || []).join("\n") || "等待操作…";
    }
    renderResults(data.results || []);
    if (els.ssWarn) els.ssWarn.hidden = Boolean(data.hasSaleSmartly);

    if (els.runStatus) {
      if (running) {
        els.runStatus.textContent = `运行中：${data.running}（若卡住请点解除）`;
        els.runStatus.classList.add("busy");
      } else {
        els.runStatus.textContent = "空闲";
        els.runStatus.classList.remove("busy");
      }
    }

    if (els.btnLoginConfirm) {
      els.btnLoginConfirm.hidden = !data.waitingLoginConfirm;
    }
    if (els.btnDetectConfirm) {
      els.btnDetectConfirm.hidden = !data.waitingDetectConfirm;
    }
  } catch (err) {
    console.error("refresh failed", err);
    if (els.runStatus) {
      els.runStatus.textContent = "状态刷新失败，按钮已强制可用";
      els.runStatus.classList.add("busy");
    }
    running = false;
  } finally {
    setJobButtonsDisabled(running);
  }
}

document.getElementById("btnSave")?.addEventListener("click", async () => {
  const body = collectSettings(selectedIds());
  const res = await fetch("/api/settings", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (data.ok && data.settings) {
    fillSettings(data.settings);
    if (els.saveMsg) els.saveMsg.textContent = "设置已保存";
  } else if (els.saveMsg) {
    els.saveMsg.textContent = data.error || "保存失败";
  }
  lastPagesKey = "";
  await refresh();
});

document
  .getElementById("btnSelectAllAccessible")
  ?.addEventListener("click", () => {
    document
      .querySelectorAll("#pageListAccessible input[type=checkbox]")
      .forEach((el) => {
        el.checked = true;
      });
  });

document.getElementById("btnSelectNone")?.addEventListener("click", () => {
  document
    .querySelectorAll(".page-item input[type=checkbox]")
    .forEach((el) => {
      el.checked = false;
    });
});

document.getElementById("btnLoginConfirm")?.addEventListener("click", async () => {
  await fetch("/api/login/confirm", { method: "POST" });
  await refresh();
});

document.getElementById("btnDetectConfirm")?.addEventListener("click", async () => {
  await fetch("/api/detect/confirm", { method: "POST" });
  await refresh();
});

document.getElementById("btnResetJob")?.addEventListener("click", async () => {
  await fetch("/api/job/reset", { method: "POST" });
  setJobButtonsDisabled(false);
  await refresh();
});

async function postAccounts(body) {
  const res = await fetch("/api/accounts", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (data.error) throw new Error(data.error);
  lastAccountsKey = "";
  await refresh();
  return data;
}

document.getElementById("btnAddAccount")?.addEventListener("click", async () => {
  try {
    const name = (els.newAccountName?.value || "").trim();
    await postAccounts({ action: "add", name });
    if (els.newAccountName) els.newAccountName.value = "";
  } catch (err) {
    alert(err instanceof Error ? err.message : String(err));
  }
});

els.accountList?.addEventListener("change", async (ev) => {
  const t = ev.target;
  if (t && t.name === "activeAccount" && t.value) {
    try {
      await postAccounts({ action: "setActive", id: t.value });
    } catch (err) {
      alert(err instanceof Error ? err.message : String(err));
    }
  }
});

els.accountList?.addEventListener("click", async (ev) => {
  const btn = ev.target?.closest?.("button");
  if (!btn) return;
  const renameId = btn.getAttribute("data-acc-rename");
  const removeId = btn.getAttribute("data-acc-remove");
  const proxyId = btn.getAttribute("data-acc-proxy");
  try {
    if (renameId) {
      const name = prompt("新名称");
      if (!name) return;
      await postAccounts({ action: "rename", id: renameId, name });
    } else if (removeId) {
      if (!confirm("删除该账号记录？（资料夹文件不会自动删）")) return;
      await postAccounts({ action: "remove", id: removeId });
    } else if (proxyId) {
      const res = await fetch("/api/state");
      const data = await res.json();
      const acc = (data.accounts?.accounts || []).find((a) => a.id === proxyId);
      const next = promptProxy(`账号「${acc?.name || proxyId}」默认代理`, acc?.proxy);
      if (next === undefined) return;
      await postAccounts({ action: "setProxy", id: proxyId, proxy: next });
    }
  } catch (err) {
    alert(err instanceof Error ? err.message : String(err));
  }
});

async function copyText(text, btn) {
  const value = (text || "").trim() || "(空)";
  try {
    await navigator.clipboard.writeText(value);
    if (btn) {
      const old = btn.textContent;
      btn.textContent = "已复制";
      setTimeout(() => {
        btn.textContent = old;
      }, 1200);
    }
  } catch {
    // 兜底：选中文本
    const ta = document.createElement("textarea");
    ta.value = value;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand("copy");
    ta.remove();
    if (btn) {
      const old = btn.textContent;
      btn.textContent = "已复制";
      setTimeout(() => {
        btn.textContent = old;
      }, 1200);
    }
  }
}

els.btnCopyLogs?.addEventListener("click", () => {
  copyText(els.logs?.textContent || "", els.btnCopyLogs);
});

els.btnCopyResults?.addEventListener("click", () => {
  copyText(els.results?.innerText || "", els.btnCopyResults);
});

document.querySelectorAll("[data-job]").forEach((btn) => {
  btn.addEventListener("click", async () => {
    try {
      await fetch("/api/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(collectSettings(selectedIds())),
      });
      const job = btn.getAttribute("data-job");
      if (job === "send") {
        const max = Number(els.maxSendPerPage?.value ?? 0);
        const tip =
          max === 0
            ? "将按名单尽量发完（已排除黑名单）。确定？"
            : `每页最多 ${max} 条（已排除黑名单）。确定？`;
        if (!confirm(tip)) return;
      }
      if (
        selectedIds().length === 0 &&
        ![
          "login",
          "login-all",
          "sync-pages",
          "detect-fb-pages",
          "detect-fb-pages-all",
        ].includes(job)
      ) {
        alert("请先在「可管理」列表勾选主页，并保存设置");
        return;
      }
      const res = await fetch(`/api/job/${job}`, { method: "POST" });
      const data = await res.json();
      if (data.error) alert(data.error);
      lastPagesKey = "";
      await refresh();
    } catch (err) {
      alert(err instanceof Error ? err.message : String(err));
      setJobButtonsDisabled(false);
    }
  });
});

setJobButtonsDisabled(false);
refresh();
setInterval(refresh, 1500);
