const els = {
  runStatus: document.getElementById("runStatus"),
  statusText: document.getElementById("statusText"),
  logs: document.getElementById("logs"),
  btnResetJob: document.getElementById("btnResetJob"),
  btnCopyLogs: document.getElementById("btnCopyLogs"),
};

async function refresh() {
  try {
    const res = await fetch("/api/agent/state");
    const data = await res.json();
    if (data.error) throw new Error(data.error);
    const running = Boolean(data.running);
    if (els.runStatus) {
      els.runStatus.textContent = running ? `进行中：${data.running}` : "空闲";
      els.runStatus.classList.toggle("busy", running);
    }
    if (els.statusText) {
      els.statusText.textContent = running
        ? `正在执行「${data.running}」…`
        : data.lastMessage || "空闲，等待本机推送资料并发送。";
    }
    if (els.logs) {
      els.logs.textContent = (data.logs || []).join("\n") || "暂无日志";
    }
  } catch (err) {
    if (els.runStatus) {
      els.runStatus.textContent = "连接失败";
      els.runStatus.classList.add("busy");
    }
    console.error(err);
  }
}

els.btnResetJob?.addEventListener("click", async () => {
  await fetch("/api/job/reset", { method: "POST" });
  await refresh();
});

els.btnCopyLogs?.addEventListener("click", async () => {
  const value = (els.logs?.textContent || "").trim() || "(空)";
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
  if (els.btnCopyLogs) {
    const old = els.btnCopyLogs.textContent;
    els.btnCopyLogs.textContent = "已复制";
    setTimeout(() => {
      els.btnCopyLogs.textContent = old;
    }, 1200);
  }
});

refresh();
setInterval(refresh, 1500);
