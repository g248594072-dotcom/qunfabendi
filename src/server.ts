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
import { saveSettings, type AppSettings } from "./settings.js";
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
  const safe = urlPath === "/" ? "/index.html" : urlPath;
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
  state.running = name;
  state.logs = [];
  state.loginTargetAccountId = "";
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
  } catch (err) {
    pushLog(`✗ ${err instanceof Error ? err.message : String(err)}`);
    throw err;
  } finally {
    state.running = false;
    state.loginConfirm = null;
    state.detectConfirm = null;
    state.confirmHint = "";
    state.loginTargetAccountId = "";
  }
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
      const allowed: JobName[] = [
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
        sendJson(res, 404, { error: "未知任务" });
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
