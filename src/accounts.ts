import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { config } from "./config.js";
import { normalizeProxy, type ProxyConfig } from "./proxy.js";
import { ensureDir } from "./utils/delay.js";

export type LoginStatus = "pending" | "logged_in";

export type FbAccount = {
  id: string;
  name: string;
  /** 相对项目根目录的 Playwright 资料夹（类似 Chrome 个人资料，互不串号） */
  profileDir: string;
  createdAt: string;
  /** 该账号默认出口 IP（登录/探测/发送默认走此代理；主页可再覆盖） */
  proxy?: ProxyConfig;
  /** 登录交接：pending=待他人登录；logged_in=已确认登录 */
  loginStatus?: LoginStatus;
  /** 最近一次确认登录时间 */
  lastLoginAt?: string;
  /** 负责登录的人（备注，便于交接） */
  assignee?: string;
};

export type AccountsFile = {
  updatedAt: string;
  /** 当前默认账号（登录/单号探测用） */
  activeAccountId: string;
  accounts: FbAccount[];
};

function accountsPath(): string {
  return path.join(config.paths.dataDir, "accounts.json");
}

function defaultAccount(): FbAccount {
  return {
    id: "default",
    name: "账号1",
    profileDir: path.join("storage", "browser-profile"),
    createdAt: new Date().toISOString(),
  };
}

export async function loadAccounts(): Promise<AccountsFile> {
  try {
    const raw = await readFile(accountsPath(), "utf8");
    const data = JSON.parse(raw) as AccountsFile;
    if (!data.accounts?.length) {
      const a = defaultAccount();
      return {
        updatedAt: new Date().toISOString(),
        activeAccountId: a.id,
        accounts: [a],
      };
    }
    return {
      updatedAt: data.updatedAt || new Date().toISOString(),
      activeAccountId: data.activeAccountId || data.accounts[0].id,
      accounts: data.accounts,
    };
  } catch {
    const a = defaultAccount();
    const file: AccountsFile = {
      updatedAt: new Date().toISOString(),
      activeAccountId: a.id,
      accounts: [a],
    };
    await saveAccounts(file);
    return file;
  }
}

export async function saveAccounts(file: AccountsFile): Promise<void> {
  await ensureDir(config.paths.dataDir);
  file.updatedAt = new Date().toISOString();
  await writeFile(accountsPath(), JSON.stringify(file, null, 2), "utf8");
}

export function resolveProfileDir(account: FbAccount): string {
  return path.isAbsolute(account.profileDir)
    ? account.profileDir
    : path.join(config.rootDir, account.profileDir);
}

export async function getAccount(id: string): Promise<FbAccount> {
  const file = await loadAccounts();
  const a = file.accounts.find((x) => x.id === id);
  if (!a) throw new Error(`找不到账号：${id}`);
  return a;
}

export async function getActiveAccount(): Promise<FbAccount> {
  const file = await loadAccounts();
  return (
    file.accounts.find((x) => x.id === file.activeAccountId) ||
    file.accounts[0]
  );
}

export async function addAccount(
  name: string,
  opts?: { proxy?: ProxyConfig | null; assignee?: string },
): Promise<AccountsFile> {
  const file = await loadAccounts();
  const id = `acc_${Date.now().toString(36)}`;
  const safe = name.trim() || `账号${file.accounts.length + 1}`;
  const account: FbAccount = {
    id,
    name: safe,
    profileDir: path.join("storage", "profiles", id),
    createdAt: new Date().toISOString(),
    loginStatus: "pending",
  };
  const proxy = normalizeProxy(opts?.proxy);
  if (proxy) account.proxy = proxy;
  const assignee = String(opts?.assignee || "").trim();
  if (assignee) account.assignee = assignee;
  file.accounts.push(account);
  file.activeAccountId = id;
  await saveAccounts(file);
  await ensureDir(resolveProfileDir(account));
  return file;
}

export async function setActiveAccount(id: string): Promise<AccountsFile> {
  const file = await loadAccounts();
  if (!file.accounts.some((a) => a.id === id)) {
    throw new Error(`找不到账号：${id}`);
  }
  file.activeAccountId = id;
  await saveAccounts(file);
  return file;
}

export async function removeAccount(id: string): Promise<AccountsFile> {
  const file = await loadAccounts();
  if (file.accounts.length <= 1) {
    throw new Error("至少保留一个账号");
  }
  file.accounts = file.accounts.filter((a) => a.id !== id);
  if (file.activeAccountId === id) {
    file.activeAccountId = file.accounts[0].id;
  }
  await saveAccounts(file);
  return file;
}

export async function renameAccount(
  id: string,
  name: string,
): Promise<AccountsFile> {
  const file = await loadAccounts();
  const a = file.accounts.find((x) => x.id === id);
  if (!a) throw new Error(`找不到账号：${id}`);
  a.name = name.trim() || a.name;
  await saveAccounts(file);
  return file;
}

export async function setAccountProxy(
  id: string,
  proxy?: ProxyConfig | null,
): Promise<AccountsFile> {
  const file = await loadAccounts();
  const a = file.accounts.find((x) => x.id === id);
  if (!a) throw new Error(`找不到账号：${id}`);
  const n = normalizeProxy(proxy);
  if (n) a.proxy = n;
  else delete a.proxy;
  await saveAccounts(file);
  return file;
}

export async function setAccountAssignee(
  id: string,
  assignee?: string | null,
): Promise<AccountsFile> {
  const file = await loadAccounts();
  const a = file.accounts.find((x) => x.id === id);
  if (!a) throw new Error(`找不到账号：${id}`);
  const v = String(assignee || "").trim();
  if (v) a.assignee = v;
  else delete a.assignee;
  await saveAccounts(file);
  return file;
}

export async function markAccountLoggedIn(
  id: string,
  loggedIn = true,
): Promise<AccountsFile> {
  const file = await loadAccounts();
  const a = file.accounts.find((x) => x.id === id);
  if (!a) throw new Error(`找不到账号：${id}`);
  if (loggedIn) {
    a.loginStatus = "logged_in";
    a.lastLoginAt = new Date().toISOString();
  } else {
    a.loginStatus = "pending";
    delete a.lastLoginAt;
  }
  await saveAccounts(file);
  return file;
}
