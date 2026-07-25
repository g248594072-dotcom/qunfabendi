import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { normalizeProxy, type ProxyConfig } from "./proxy.js";
import { ensureDir } from "./utils/delay.js";

export type AppSettings = {
  messageText: string;
  messageImage: string;
  delayMinSec: number;
  delayMaxSec: number;
  /** 每个主页最多发几条；0 = 不限制（正式群发用） */
  maxSendPerPage: number;
  /** 同步发送客户时，按 updated_time 回溯天数 */
  contactDays: number;
  headless: boolean;
  selectedPageIds: string[];
  /** 同时打开的主页标签数（并发），默认 2；太多会卡在转圈 */
  maxPageConcurrency: number;
  /**
   * 主页级代理覆盖（pageId → proxy）。
   * 有则优先于账号默认代理；空/缺省则用账号代理或直连。
   */
  pageProxies: Record<string, ProxyConfig>;
  /** 本机推送到远程发送服务器（仅本机控制台使用） */
  remoteServerUrl: string;
  remoteServerUser: string;
  remoteServerPassword: string;
};

const defaults: AppSettings = {
  messageText: "你好，这是一条测试消息。",
  messageImage: "",
  delayMinSec: 2,
  delayMaxSec: 6,
  maxSendPerPage: 2,
  contactDays: 365,
  headless: false,
  selectedPageIds: [],
  maxPageConcurrency: 6,
  pageProxies: {},
  remoteServerUrl: "",
  remoteServerUser: "admin",
  remoteServerPassword: "",
};

function sanitizePageProxies(
  raw: unknown,
): Record<string, ProxyConfig> {
  if (!raw || typeof raw !== "object") return {};
  const out: Record<string, ProxyConfig> = {};
  for (const [pageId, val] of Object.entries(
    raw as Record<string, ProxyConfig>,
  )) {
    const n = normalizeProxy(val);
    if (n && pageId) out[pageId] = n;
  }
  return out;
}

function settingsPath(rootDir: string): string {
  return path.join(rootDir, "data", "settings.json");
}

export async function loadSettings(rootDir: string): Promise<AppSettings> {
  try {
    const raw = await readFile(settingsPath(rootDir), "utf8");
    const data = JSON.parse(raw) as Partial<AppSettings>;
    return {
      ...defaults,
      ...data,
      pageProxies: sanitizePageProxies(data.pageProxies ?? defaults.pageProxies),
    };
  } catch {
    return { ...defaults };
  }
}

export async function saveSettings(
  rootDir: string,
  patch: Partial<AppSettings>,
): Promise<AppSettings> {
  const current = await loadSettings(rootDir);
  const next: AppSettings = {
    ...current,
    ...patch,
    delayMinSec: Number(patch.delayMinSec ?? current.delayMinSec),
    delayMaxSec: Number(patch.delayMaxSec ?? current.delayMaxSec),
    maxSendPerPage: Number(patch.maxSendPerPage ?? current.maxSendPerPage),
    contactDays: Number(patch.contactDays ?? current.contactDays),
    maxPageConcurrency: Math.max(
      1,
      Math.min(Number(patch.maxPageConcurrency ?? current.maxPageConcurrency) || 6, 12),
    ),
    selectedPageIds: Array.isArray(patch.selectedPageIds)
      ? patch.selectedPageIds.map(String)
      : current.selectedPageIds,
    pageProxies:
      patch.pageProxies !== undefined
        ? sanitizePageProxies(patch.pageProxies)
        : current.pageProxies,
    remoteServerUrl:
      patch.remoteServerUrl !== undefined
        ? String(patch.remoteServerUrl || "").trim().replace(/\/$/, "")
        : current.remoteServerUrl,
    remoteServerUser:
      patch.remoteServerUser !== undefined
        ? String(patch.remoteServerUser || "").trim() || "admin"
        : current.remoteServerUser,
    remoteServerPassword:
      patch.remoteServerPassword !== undefined
        ? String(patch.remoteServerPassword || "")
        : current.remoteServerPassword,
  };

  if (next.delayMaxSec < next.delayMinSec) {
    throw new Error("发送间隔最大值不能小于最小值");
  }

  await ensureDir(path.join(rootDir, "data"));
  await writeFile(settingsPath(rootDir), JSON.stringify(next, null, 2), "utf8");
  return next;
}

export { defaults as defaultSettings };
