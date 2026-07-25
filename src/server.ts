import http from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  addAccount,
  loadAccounts,
  removeAccount,
  renameAccount,
  setAccountProxy,
  setActiveAccount,
} from "./accounts.js";
import type { ProxyConfig } from "./proxy.js";
import { config } from "./config.js";
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

async function runJob(name: JobName): Promise<void> {
  if (state.running) {
    throw new Error(`已有任务在运行：${state.running}`);
  }
  state.running = name;
  state.logs = [];
  const log = (line: string) => pushLog(line);

  try {
    if (name === "login") {
      await jobLogin(log, () =>
        waitLoginConfirm(
          "浏览器已打开。登录进「消息框」后，点页面上的「确认已登录」。",
        ),
      );
    } else if (name === "login-all") {
      await jobLoginAllAccounts(log, () =>
        waitLoginConfirm(
          "多个浏览器已打开。各窗口登录对应 Facebook 号后，点「确认已登录」。",
        ),
      );
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
  }
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
    const { pathname } = url;

    if (req.method === "GET" && pathname === "/api/state") {
      const dash = await getDashboardState();
      sendJson(res, 200, {
        ...dash,
        running: state.running,
        logs: state.logs,
        waitingLoginConfirm: Boolean(state.loginConfirm),
        waitingDetectConfirm: Boolean(state.detectConfirm),
        confirmHint: state.confirmHint,
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
        action: "add" | "remove" | "rename" | "setActive" | "setProxy";
        id?: string;
        name?: string;
        proxy?: ProxyConfig | null;
      };
      let file;
      if (body.action === "add") {
        file = await addAccount(body.name || "");
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
        file = await setAccountProxy(body.id, body.proxy);
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
      void runJob(name).catch(() => undefined);
      sendJson(res, 200, { ok: true, started: name });
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

server.listen(config.uiPort, () => {
  console.log(`可视化控制台已启动: http://127.0.0.1:${config.uiPort}`);
  console.log("浏览器打开上面的地址即可设置与调试。Ctrl+C 结束。");
});
