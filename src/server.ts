import http from "node:http";
import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  addAccount,
  getActiveAccount,
  loadAccounts,
  markAccountLoggedIn,
  removeAccount,
  renameAccount,
  setAccountAssignee,
  setAccountProxy,
  setActiveAccount,
} from "./accounts.js";
import { checkBasicAuth } from "./auth.js";
import type { ProxyConfig } from "./proxy.js";
import { buildProxyFromStructured, type StructuredProxy } from "./proxy.js";
import { config } from "./config.js";
import {
  isNovncPath,
  proxyNovncHttp,
  proxyNovncUpgrade,
} from "./novnc-proxy.js";
import { packAccountProfile, unpackAccountProfile } from "./profile-pack.js";
import { packSyncBundle, unpackSyncBundle } from "./sync-pack.js";
import { loadSettings, saveSettings, type AppSettings } from "./settings.js";
import {
  getDashboardState,
  jobDetectAllAccounts,
  jobDetectFbPages,
  jobLogin,
  jobLoginAllAccounts,
  jobSend,
  jobSyncBlacklist,
  jobSyncContacts,
  jobSyncPages,
} from "./jobs.js";

const DEFAULT_NOVNC_PATH =
  "/novnc/vnc.html?autoconnect=1&resize=remote&path=websockify";

async function readBodyBuffer(req: http.IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

function serverPublicInfo() {
  return {
    serverMode: config.serverMode,
    authRequired: Boolean(config.uiPassword),
    // 同源反代，无需再在 1Panel 单独配 6080
    novncUrl: config.novncUrl || DEFAULT_NOVNC_PATH,
    loginHelperPath: "/login.html",
    hasDisplay: Boolean(process.env.DISPLAY),
  };
}

type JobName =
  | "login"
  | "login-all"
  | "sync-pages"
  | "detect-fb-pages"
  | "detect-fb-pages-all"
  | "sync-blacklist"
  | "sync-contacts"
  | "send-dry"
  | "send";

const state = {
  running: false as false | JobName,
  logs: [] as string[],
  loginConfirm: null as null | (() => void),
  detectConfirm: null as null | (() => void),
  confirmHint: "",
  /** 单账号登录时的目标 id（确认后可标记已登录） */
  loginTargetAccountId: "" as string,
  lastMessage: "",
};

function pushLog(line: string): void {
  const time = `[${new Date().toLocaleTimeString()}] `;
  const parts = String(line).split(/\r?\n/);
  for (let i = 0; i < parts.length; i += 1) {
    const stamped =
      i === 0 ? `${time}${parts[i]}` : `${" ".repeat(time.length)}${parts[i]}`;
    state.logs.push(stamped);
    console.log(stamped);
  }
  if (state.logs.length > 500) state.logs.splice(0, state.logs.length - 500);
}

async function readBody(req: http.IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

function sendJson(
  res: http.ServerResponse,
  status: number,
  data: unknown,
): void {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(JSON.stringify(data));
}

function contentType(filePath: string): string {
  if (filePath.endsWith(".html")) return "text/html; charset=utf-8";
  if (filePath.endsWith(".css")) return "text/css; charset=utf-8";
  if (filePath.endsWith(".js")) return "text/javascript; charset=utf-8";
  if (filePath.endsWith(".svg")) return "image/svg+xml";
  return "application/octet-stream";
}

async function serveStatic(
  res: http.ServerResponse,
  urlPath: string,
): Promise<void> {
  // 服务器代理模式：默认只展示精简状态页，不提供完整操作台
  let safe = urlPath === "/" ? "/index.html" : urlPath;
  if (config.serverMode) {
    if (safe === "/index.html" || safe === "/login.html") {
      safe = "/agent.html";
    }
  }
  const filePath = path.join(config.paths.publicDir, safe);
  if (!filePath.startsWith(config.paths.publicDir)) {
    res.writeHead(403).end("Forbidden");
    return;
  }
  try {
    const buf = await readFile(filePath);
    res.writeHead(200, { "Content-Type": contentType(filePath) });
    res.end(buf);
  } catch {
    res.writeHead(404).end("Not Found");
  }
}

function waitLoginConfirm(hint: string): Promise<void> {
  return new Promise<void>((resolve) => {
    state.confirmHint = hint;
    state.loginConfirm = () => {
      state.loginConfirm = null;
      state.confirmHint = "";
      resolve();
    };
    pushLog(hint);
  });
}

function waitDetectConfirm(hint: string): Promise<void> {
  return new Promise<void>((resolve) => {
    state.confirmHint = hint;
    state.detectConfirm = () => {
      state.detectConfirm = null;
      state.confirmHint = "";
      resolve();
    };
    pushLog(hint);
  });
}

function resolveProxyInput(
  body: {
    proxy?: ProxyConfig | null;
    structuredProxy?: Partial<StructuredProxy> | null;
  },
): ProxyConfig | null | undefined {
  if (body.structuredProxy) {
    const built = buildProxyFromStructured(body.structuredProxy);
    return built ?? null;
  }
  if ("proxy" in body) return body.proxy;
  return undefined;
}

async function runJob(
  name: JobName,
  opts?: { accountId?: string },
): Promise<void> {
  if (state.running) {
    throw new Error(`已有任务在运行：${state.running}`);
  }
  if (config.serverMode && name !== "send") {
    throw new Error("服务器代理模式仅允许执行发送。请在本机完成准备后推送。");
  }
  state.running = name;
  state.logs = [];
  state.loginTargetAccountId = "";
  state.lastMessage = `开始任务：${name}`;
  const log = (line: string) => pushLog(line);

  try {
    if (name === "login") {
      const accountId =
        opts?.accountId || (await getActiveAccount()).id || undefined;
      state.loginTargetAccountId = accountId || "";
      await jobLogin(
        log,
        () =>
          waitLoginConfirm(
            "浏览器已打开。登录进「消息框」后，点页面上的「确认已登录」。",
          ),
        accountId,
      );
      if (accountId) {
        await markAccountLoggedIn(accountId, true);
        pushLog(`已标记账号为「已登录」。`);
      }
    } else if (name === "login-all") {
      await jobLoginAllAccounts(log, () =>
        waitLoginConfirm(
          "多个浏览器已打开。各窗口登录对应 Facebook 号后，点「确认已登录」。",
        ),
      );
      const file = await loadAccounts();
      for (const a of file.accounts) {
        await markAccountLoggedIn(a.id, true);
      }
      pushLog("已标记全部账号为「已登录」。");
    } else if (name === "sync-pages") {
      await jobSyncPages(log);
    } else if (name === "detect-fb-pages") {
      await jobDetectFbPages(log, () =>
        waitDetectConfirm(
          ">>> 请展开「企业资产」右侧主页列表后，点「确认已打开企业资产列表」",
        ),
      );
    } else if (name === "detect-fb-pages-all") {
      await jobDetectAllAccounts(log, () =>
        waitDetectConfirm(
          ">>> 请在每个浏览器窗口都展开「企业资产」主页列表后，点一次「确认已打开企业资产列表」",
        ),
      );
    } else if (name === "sync-blacklist") {
      await jobSyncBlacklist(log);
    } else if (name === "sync-contacts") {
      await jobSyncContacts(log);
    } else if (name === "send-dry") {
      await jobSend({ dryRun: true }, log);
    } else if (name === "send") {
      await jobSend({ dryRun: false }, log);
    }
    pushLog("✓ 完成");
    state.lastMessage = `任务完成：${name}`;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    pushLog(`✗ ${msg}`);
    state.lastMessage = `任务失败：${msg}`;
    throw err;
  } finally {
    state.running = false;
    state.loginConfirm = null;
    state.detectConfirm = null;
    state.confirmHint = "";
    state.loginTargetAccountId = "";
  }
}

async function agentPushAndSend(buf: Buffer): Promise<void> {
  if (state.running) {
    throw new Error(`已有任务在运行：${state.running}`);
  }
  pushLog("收到本机推送，正在导入资料包…");
  state.lastMessage = "正在导入本机资料包…";
  const result = await unpackSyncBundle(buf);
  pushLog(`导入完成：${result.restored.join("、")}`);
  await saveSettings(config.rootDir, { headless: true });
  pushLog("已强制开启无头模式，开始发送…");
  state.lastMessage = "导入完成，开始发送…";
  void runJob("send").catch(() => undefined);
}

function lanAddresses(): string[] {
  const out: string[] = [];
  const ifaces = os.networkInterfaces();
  for (const list of Object.values(ifaces)) {
    for (const info of list || []) {
      if (info.family === "IPv4" && !info.internal) out.push(info.address);
    }
  }
  return out;
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
    const { pathname } = url;

    if (req.method === "GET" && pathname === "/api/health") {
      sendJson(res, 200, { ok: true, ...serverPublicInfo() });
      return;
    }

    if (!checkBasicAuth(req, res)) return;

    // 把 /novnc/* 与 /websockify 转到容器内 6080（1Panel 只需反代 3789）
    if (isNovncPath(pathname)) {
      proxyNovncHttp(req, res, pathname, url.search);
      return;
    }

    if (req.method === "GET" && pathname === "/api/state") {
      const dash = await getDashboardState();
      sendJson(res, 200, {
        ...dash,
        running: state.running,
        logs: state.logs,
        waitingLoginConfirm: Boolean(state.loginConfirm),
        waitingDetectConfirm: Boolean(state.detectConfirm),
        confirmHint: state.confirmHint,
        loginTargetAccountId: state.loginTargetAccountId,
        ...serverPublicInfo(),
      });
      return;
    }

    if (req.method === "POST" && pathname === "/api/settings") {
      const body = JSON.parse(await readBody(req)) as Partial<AppSettings>;
      const saved = await saveSettings(config.rootDir, body);
      sendJson(res, 200, { ok: true, settings: saved });
      return;
    }

    if (req.method === "POST" && pathname === "/api/accounts") {
      const body = JSON.parse(await readBody(req)) as {
        action:
          | "add"
          | "remove"
          | "rename"
          | "setActive"
          | "setProxy"
          | "setAssignee"
          | "markLoggedIn"
          | "markPending";
        id?: string;
        name?: string;
        assignee?: string | null;
        loggedIn?: boolean;
        proxy?: ProxyConfig | null;
        structuredProxy?: Partial<StructuredProxy> | null;
      };
      let file;
      if (body.action === "add") {
        const proxy = resolveProxyInput(body);
        file = await addAccount(body.name || "", {
          proxy: proxy === undefined ? undefined : proxy,
          assignee: body.assignee || undefined,
        });
      } else if (body.action === "remove") {
        if (!body.id) throw new Error("缺少 id");
        file = await removeAccount(body.id);
      } else if (body.action === "rename") {
        if (!body.id) throw new Error("缺少 id");
        file = await renameAccount(body.id, body.name || "");
      } else if (body.action === "setActive") {
        if (!body.id) throw new Error("缺少 id");
        file = await setActiveAccount(body.id);
      } else if (body.action === "setProxy") {
        if (!body.id) throw new Error("缺少 id");
        const proxy = resolveProxyInput(body);
        file = await setAccountProxy(
          body.id,
          proxy === undefined ? null : proxy,
        );
      } else if (body.action === "setAssignee") {
        if (!body.id) throw new Error("缺少 id");
        file = await setAccountAssignee(body.id, body.assignee);
      } else if (body.action === "markLoggedIn") {
        if (!body.id) throw new Error("缺少 id");
        file = await markAccountLoggedIn(body.id, body.loggedIn !== false);
      } else if (body.action === "markPending") {
        if (!body.id) throw new Error("缺少 id");
        file = await markAccountLoggedIn(body.id, false);
      } else {
        throw new Error("未知 action");
      }
      sendJson(res, 200, { ok: true, accounts: file });
      return;
    }

    if (req.method === "GET" && pathname === "/api/accounts") {
      sendJson(res, 200, await loadAccounts());
      return;
    }

    /** 登录助手专用精简状态（不含发送设置等） */
    if (req.method === "GET" && pathname === "/api/login-helper/state") {
      const accounts = await loadAccounts();
      sendJson(res, 200, {
        accounts,
        running: state.running,
        logs: state.logs.slice(-80),
        waitingLoginConfirm: Boolean(state.loginConfirm),
        confirmHint: state.confirmHint,
        loginTargetAccountId: state.loginTargetAccountId,
        ...serverPublicInfo(),
      });
      return;
    }

    /** 导出账号浏览器资料夹（.tar.gz），便于本机登录后上传到服务器 */
    if (req.method === "GET" && pathname.startsWith("/api/accounts/") && pathname.endsWith("/profile")) {
      const id = pathname.slice("/api/accounts/".length, -"/profile".length);
      if (!id) throw new Error("缺少账号 id");
      const packed = await packAccountProfile(id);
      res.writeHead(200, {
        "Content-Type": "application/gzip",
        "Content-Disposition": `attachment; filename="${encodeURIComponent(packed.fileName)}"`,
        "Cache-Control": "no-store",
      });
      res.end(packed.buffer);
      return;
    }

    /** 上传资料夹覆盖服务器上的登录态 */
    if (req.method === "POST" && pathname.startsWith("/api/accounts/") && pathname.endsWith("/profile")) {
      const id = pathname.slice("/api/accounts/".length, -"/profile".length);
      if (!id) throw new Error("缺少账号 id");
      const buf = await readBodyBuffer(req);
      if (!buf.length) throw new Error("上传内容为空");
      if (buf.length > 200 * 1024 * 1024) {
        throw new Error("资料包过大（超过 200MB）");
      }
      const dir = await unpackAccountProfile(id, buf);
      await markAccountLoggedIn(id, true);
      pushLog(`已导入账号 ${id} 的登录资料 → ${dir}`);
      sendJson(res, 200, { ok: true, profileDir: dir });
      return;
    }

    /** 一键导出：账号+登录态+主页客户黑名单设置（本机准备 → 服务器发送） */
    if (req.method === "GET" && pathname === "/api/sync/export") {
      const packed = await packSyncBundle();
      pushLog(`已导出同步包 ${packed.fileName}（${Math.round(packed.buffer.length / 1024)} KB）`);
      res.writeHead(200, {
        "Content-Type": "application/gzip",
        "Content-Disposition": `attachment; filename="${encodeURIComponent(packed.fileName)}"`,
        "Cache-Control": "no-store",
      });
      res.end(packed.buffer);
      return;
    }

    /** 一键导入同步包 */
    if (req.method === "POST" && pathname === "/api/sync/import") {
      const buf = await readBodyBuffer(req);
      const result = await unpackSyncBundle(buf);
      pushLog(`已导入同步包：${result.restored.join("、")}`);
      sendJson(res, 200, { ok: true, ...result });
      return;
    }

    /** 服务器代理：接收资料包并立即发送 */
    if (req.method === "POST" && pathname === "/api/agent/push-send") {
      if (state.running) {
        sendJson(res, 409, { error: `已有任务在运行：${state.running}` });
        return;
      }
      const buf = await readBodyBuffer(req);
      if (!buf.length) throw new Error("资料包为空");
      await agentPushAndSend(buf);
      sendJson(res, 200, { ok: true, started: "send" });
      return;
    }

    if (req.method === "GET" && pathname === "/api/agent/state") {
      sendJson(res, 200, {
        running: state.running,
        logs: state.logs.slice(-120),
        lastMessage: state.lastMessage,
        ...serverPublicInfo(),
      });
      return;
    }

    /**
     * 本机控制台：打包当前数据并推送到远程服务器执行发送
     * （避免浏览器跨域，由本机 Node 代发）
     */
    if (req.method === "POST" && pathname === "/api/remote/push-send") {
      if (config.serverMode) {
        throw new Error("服务器代理模式不能再向外推送");
      }
      const settings = await loadSettings(config.rootDir);
      const remoteUrl = (settings.remoteServerUrl || "").replace(/\/$/, "");
      if (!remoteUrl) throw new Error("请先填写远程服务器地址并保存设置");
      const packed = await packSyncBundle();
      pushLog(
        `正在推送到 ${remoteUrl}（${Math.round(packed.buffer.length / 1024)} KB）…`,
      );
      const auth = Buffer.from(
        `${settings.remoteServerUser || "admin"}:${settings.remoteServerPassword || ""}`,
      ).toString("base64");
      const resp = await fetch(`${remoteUrl}/api/agent/push-send`, {
        method: "POST",
        headers: {
          Authorization: `Basic ${auth}`,
          "Content-Type": "application/gzip",
        },
        body: packed.buffer,
      });
      const text = await resp.text();
      let data: { ok?: boolean; error?: string; started?: string } = {};
      try {
        data = JSON.parse(text) as typeof data;
      } catch {
        throw new Error(`远程服务器响应异常 HTTP ${resp.status}: ${text.slice(0, 200)}`);
      }
      if (!resp.ok || data.error) {
        throw new Error(data.error || `远程推送失败 HTTP ${resp.status}`);
      }
      pushLog("✓ 已推送到服务器并开始发送。可打开服务器状态页查看日志。");
      sendJson(res, 200, {
        ok: true,
        remote: data,
        bytes: packed.buffer.length,
        statusUrl: `${remoteUrl}/`,
      });
      return;
    }

    if (req.method === "GET" && pathname === "/api/remote/state") {
      if (config.serverMode) {
        throw new Error("服务器代理模式无远程状态");
      }
      const settings = await loadSettings(config.rootDir);
      const remoteUrl = (settings.remoteServerUrl || "").replace(/\/$/, "");
      if (!remoteUrl) throw new Error("未配置远程服务器地址");
      const auth = Buffer.from(
        `${settings.remoteServerUser || "admin"}:${settings.remoteServerPassword || ""}`,
      ).toString("base64");
      const resp = await fetch(`${remoteUrl}/api/agent/state`, {
        headers: { Authorization: `Basic ${auth}` },
      });
      const data = await resp.json();
      if (!resp.ok) {
        throw new Error(
          (data as { error?: string }).error || `远程状态失败 HTTP ${resp.status}`,
        );
      }
      sendJson(res, 200, { ok: true, remoteUrl, ...(data as object) });
      return;
    }

    if (req.method === "POST" && pathname === "/api/login/confirm") {
      if (state.loginConfirm) {
        state.loginConfirm();
        sendJson(res, 200, { ok: true });
      } else {
        sendJson(res, 400, { ok: false, error: "当前没有等待确认的登录" });
      }
      return;
    }

    if (req.method === "POST" && pathname === "/api/detect/confirm") {
      if (state.detectConfirm) {
        state.detectConfirm();
        sendJson(res, 200, { ok: true });
      } else {
        sendJson(res, 400, {
          ok: false,
          error: "当前没有等待确认的探测，请先点「探测」",
        });
      }
      return;
    }

    if (req.method === "POST" && pathname === "/api/job/reset") {
      const prev = state.running;
      if (state.loginConfirm) {
        state.loginConfirm();
        state.loginConfirm = null;
      }
      if (state.detectConfirm) {
        state.detectConfirm();
        state.detectConfirm = null;
      }
      state.running = false;
      state.confirmHint = "";
      state.loginTargetAccountId = "";
      pushLog(
        prev
          ? `已强制解除任务占用（原任务：${prev}）。可重新点击操作按钮。`
          : "当前没有占用中的任务。",
      );
      sendJson(res, 200, { ok: true, cleared: prev || null });
      return;
    }

    if (req.method === "POST" && pathname.startsWith("/api/job/")) {
      const name = pathname.replace("/api/job/", "") as JobName;
      const allowed: JobName[] = config.serverMode
        ? ["send"]
        : [
            "login",
            "login-all",
            "sync-pages",
            "detect-fb-pages",
            "detect-fb-pages-all",
            "sync-blacklist",
            "sync-contacts",
            "send-dry",
            "send",
          ];
      if (!allowed.includes(name)) {
        sendJson(res, 403, {
          error: config.serverMode
            ? "服务器仅接受本机推送后的发送，请用本机「推送到服务器并发送」"
            : "未知任务",
        });
        return;
      }
      if (state.running) {
        sendJson(res, 409, {
          error: `已有任务在运行：${state.running}。请先点「解除卡住」。`,
        });
        return;
      }
      let accountId: string | undefined;
      const raw = await readBody(req);
      if (raw.trim()) {
        try {
          const body = JSON.parse(raw) as { accountId?: string };
          accountId = body.accountId || undefined;
        } catch {
          /* 无 body 亦可 */
        }
      }
      void runJob(name, { accountId }).catch(() => undefined);
      sendJson(res, 200, { ok: true, started: name, accountId: accountId || null });
      return;
    }

    if (req.method === "GET") {
      await serveStatic(res, pathname);
      return;
    }

    sendJson(res, 404, { error: "Not Found" });
  } catch (err) {
    sendJson(res, 500, {
      error: err instanceof Error ? err.message : String(err),
    });
  }
});

server.on("upgrade", (req, socket, head) => {
  try {
    const url = new URL(req.url || "/", "http://localhost");
    if (!isNovncPath(url.pathname)) {
      socket.destroy();
      return;
    }
    // WebSocket 也走同一套 Basic 认证（浏览器通常会带上已保存的账号密码）
    if (config.uiPassword) {
      const header = String(req.headers.authorization || "");
      let ok = false;
      if (header.startsWith("Basic ")) {
        try {
          const decoded = Buffer.from(header.slice(6), "base64").toString("utf8");
          const i = decoded.indexOf(":");
          const user = i >= 0 ? decoded.slice(0, i) : decoded;
          const pass = i >= 0 ? decoded.slice(i + 1) : "";
          ok = user === config.uiUser && pass === config.uiPassword;
        } catch {
          ok = false;
        }
      }
      if (!ok) {
        socket.write(
          "HTTP/1.1 401 Unauthorized\r\nWWW-Authenticate: Basic realm=\"FB Broadcast\"\r\nConnection: close\r\n\r\n",
        );
        socket.destroy();
        return;
      }
    }
    proxyNovncUpgrade(req, socket, head);
  } catch {
    socket.destroy();
  }
});

server.listen(config.uiPort, config.uiHost, () => {
  const host = config.uiHost;
  console.log(`可视化控制台已启动: http://127.0.0.1:${config.uiPort}`);
  console.log(`登录助手: http://127.0.0.1:${config.uiPort}/login.html`);
  console.log(`远程浏览器: ${config.novncUrl || DEFAULT_NOVNC_PATH}`);
  if (config.uiPassword) {
    console.log(`已启用访问密码（用户 ${config.uiUser}）`);
  } else if (host === "0.0.0.0") {
    console.log("⚠ 已监听 0.0.0.0 但未设置 UI_PASSWORD，公网不安全，请尽快在 .env 设置。");
  }
  if (host === "0.0.0.0") {
    const lans = lanAddresses();
    for (const ip of lans) {
      console.log(`对外访问: http://${ip}:${config.uiPort}/`);
      console.log(`登录助手: http://${ip}:${config.uiPort}/login.html`);
    }
  } else if (host !== "127.0.0.1") {
    console.log(`监听 ${host}:${config.uiPort}`);
  }
  if (config.serverMode && !process.env.DISPLAY) {
    console.log(
      "提示：当前无 DISPLAY。发送请勾选无头模式；登录走 Docker/noVNC。",
    );
  }
  console.log("Ctrl+C 结束。");
});
