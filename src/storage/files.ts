import { readFile, writeFile, appendFile } from "node:fs/promises";
import { ensureDir } from "../utils/delay.js";
import { config } from "../config.js";
import type {
  BlacklistEntry,
  ContactRow,
  MessengerPage,
} from "../salesmartly/types.js";
import {
  BLACKLIST_TAG_NAMES,
  blacklistKey,
} from "../salesmartly/types.js";

export async function savePages(pages: MessengerPage[]): Promise<void> {
  await ensureDir(config.paths.dataDir);
  await writeFile(
    config.paths.pagesFile,
    JSON.stringify({ syncedAt: new Date().toISOString(), pages }, null, 2),
    "utf8",
  );
}

export async function loadPages(): Promise<MessengerPage[]> {
  const raw = await readFile(config.paths.pagesFile, "utf8");
  const data = JSON.parse(raw) as { pages: MessengerPage[] };
  return data.pages ?? [];
}

export type FbSessionPageRef = {
  pageId: string;
  pageName: string;
  accountId?: string;
  accountName?: string;
};

export type FbSessionAccountSlice = {
  accountId: string;
  accountName: string;
  detectedAt: string;
  pages: FbSessionPageRef[];
};

export type FbSessionPagesFile = {
  detectedAt: string;
  pageIds: string[];
  pages: FbSessionPageRef[];
  /** pageId → accountId（发送时选对应浏览器资料夹） */
  pageToAccount: Record<string, string>;
  accounts: FbSessionAccountSlice[];
};

function rebuildSessionIndex(
  accountSlices: FbSessionAccountSlice[],
): FbSessionPagesFile {
  const pageToAccount: Record<string, string> = {};
  const pages: FbSessionPageRef[] = [];
  for (const slice of accountSlices) {
    for (const p of slice.pages) {
      pageToAccount[p.pageId] = slice.accountId;
      pages.push({
        pageId: p.pageId,
        pageName: p.pageName,
        accountId: slice.accountId,
        accountName: slice.accountName,
      });
    }
  }
  return {
    detectedAt: new Date().toISOString(),
    pageIds: pages.map((p) => p.pageId),
    pages,
    pageToAccount,
    accounts: accountSlices,
  };
}

/** 单账号探测结果写入（覆盖该账号切片，保留其它账号） */
export async function saveFbSessionPagesForAccount(options: {
  accountId: string;
  accountName: string;
  pages: { pageId: string; pageName: string }[];
}): Promise<FbSessionPagesFile> {
  let prev: FbSessionPagesFile | null = null;
  try {
    prev = await loadFbSessionPages();
  } catch {
    prev = null;
  }
  const others = (prev?.accounts || []).filter(
    (a) => a.accountId !== options.accountId,
  );
  const slice: FbSessionAccountSlice = {
    accountId: options.accountId,
    accountName: options.accountName,
    detectedAt: new Date().toISOString(),
    pages: options.pages.map((p) => ({
      pageId: p.pageId,
      pageName: p.pageName,
      accountId: options.accountId,
      accountName: options.accountName,
    })),
  };
  const data = rebuildSessionIndex([...others, slice]);
  await ensureDir(config.paths.dataDir);
  await writeFile(
    config.paths.fbSessionPagesFile,
    JSON.stringify(data, null, 2),
    "utf8",
  );
  return data;
}

/** 兼容旧调用：当作写入 active/default 账号 */
export async function saveFbSessionPages(
  pages: { pageId: string; pageName: string }[],
  account?: { accountId: string; accountName: string },
): Promise<FbSessionPagesFile> {
  return saveFbSessionPagesForAccount({
    accountId: account?.accountId || "default",
    accountName: account?.accountName || "账号1",
    pages,
  });
}

export async function loadFbSessionPages(): Promise<FbSessionPagesFile | null> {
  try {
    const raw = await readFile(config.paths.fbSessionPagesFile, "utf8");
    const data = JSON.parse(raw) as Partial<FbSessionPagesFile>;
    // 兼容旧格式（无 accounts / pageToAccount）
    if (!data.accounts || !data.pageToAccount) {
      const pages = (data.pages || []).map((p) => ({
        pageId: p.pageId,
        pageName: p.pageName,
        accountId: "default",
        accountName: "账号1",
      }));
      return {
        detectedAt: data.detectedAt || new Date().toISOString(),
        pageIds: data.pageIds || pages.map((p) => p.pageId),
        pages,
        pageToAccount: Object.fromEntries(
          pages.map((p) => [p.pageId, "default"]),
        ),
        accounts: [
          {
            accountId: "default",
            accountName: "账号1",
            detectedAt: data.detectedAt || new Date().toISOString(),
            pages,
          },
        ],
      };
    }
    return data as FbSessionPagesFile;
  } catch {
    return null;
  }
}

export async function saveContacts(contacts: ContactRow[]): Promise<void> {
  await ensureDir(config.paths.dataDir);
  await writeFile(
    config.paths.contactsFile,
    JSON.stringify({ syncedAt: new Date().toISOString(), contacts }, null, 2),
    "utf8",
  );
}

export async function loadContacts(): Promise<ContactRow[]> {
  const raw = await readFile(config.paths.contactsFile, "utf8");
  const data = JSON.parse(raw) as { contacts: ContactRow[] };
  return data.contacts ?? [];
}

/**
 * 合并客户：同 pageId+chatUserId（或 name）覆盖更新，其它主页保留。
 */
export async function mergeContacts(incoming: ContactRow[]): Promise<ContactRow[]> {
  let existing: ContactRow[] = [];
  try {
    existing = await loadContacts();
  } catch {
    existing = [];
  }

  const touchedPages = new Set(incoming.map((c) => c.pageId));
  const kept = existing.filter((c) => !touchedPages.has(c.pageId));
  const merged = [...kept, ...incoming];
  await saveContacts(merged);
  return merged;
}

export type BlacklistFile = {
  updatedAt: string;
  tagNames: string[];
  entries: BlacklistEntry[];
};

export async function loadBlacklist(): Promise<BlacklistFile> {
  try {
    const raw = await readFile(config.paths.blacklistFile, "utf8");
    return JSON.parse(raw) as BlacklistFile;
  } catch {
    return {
      updatedAt: "",
      tagNames: [...BLACKLIST_TAG_NAMES],
      entries: [],
    };
  }
}

/**
 * 用本次拉取结果更新黑名单：仅替换「本次涉及主页」的条目，其它主页保留。
 */
export async function updateBlacklistForPages(
  pageIds: string[],
  contacts: ContactRow[],
): Promise<BlacklistFile> {
  const current = await loadBlacklist();
  const pageSet = new Set(pageIds);
  const kept = current.entries.filter((e) => !pageSet.has(e.pageId));

  const now = new Date().toISOString();
  const freshMap = new Map<string, BlacklistEntry>();
  for (const c of contacts) {
    const key = blacklistKey(c.pageId, c.name);
    freshMap.set(key, {
      pageId: c.pageId,
      pageName: c.pageName,
      customerName: c.name,
      chatUserId: c.chatUserId,
      matchedTags: inferMatchedTags(c.labels),
      updatedAt: now,
    });
  }

  const next: BlacklistFile = {
    updatedAt: now,
    tagNames: [...BLACKLIST_TAG_NAMES],
    entries: [...kept, ...freshMap.values()],
  };

  await ensureDir(config.paths.dataDir);
  await writeFile(
    config.paths.blacklistFile,
    JSON.stringify(next, null, 2),
    "utf8",
  );
  return next;
}

function inferMatchedTags(labelsField?: string): string[] {
  if (!labelsField) return [];
  const hit: string[] = [];
  for (const tag of BLACKLIST_TAG_NAMES) {
    if (labelsField.includes(tag)) hit.push(tag);
  }
  return hit;
}

export function buildBlacklistSet(
  entries: BlacklistEntry[],
): Set<string> {
  return new Set(
    entries.map((e) => blacklistKey(e.pageId, e.customerName)),
  );
}

/** 追加一条本地黑名单（例如 FB 提示无法再发送） */
export async function addBlacklistEntry(entry: {
  pageId: string;
  pageName: string;
  customerName: string;
  chatUserId?: string;
  reason?: string;
}): Promise<BlacklistFile> {
  const current = await loadBlacklist();
  const key = blacklistKey(entry.pageId, entry.customerName);
  const now = new Date().toISOString();
  const reasonTag = entry.reason || "FB无法发送";
  const nextEntries = current.entries.filter(
    (e) => blacklistKey(e.pageId, e.customerName) !== key,
  );
  nextEntries.push({
    pageId: entry.pageId,
    pageName: entry.pageName,
    customerName: entry.customerName.trim(),
    chatUserId: entry.chatUserId || "",
    matchedTags: [reasonTag],
    updatedAt: now,
  });

  const next: BlacklistFile = {
    updatedAt: now,
    tagNames: [...BLACKLIST_TAG_NAMES],
    entries: nextEntries,
  };

  await ensureDir(config.paths.dataDir);
  await writeFile(
    config.paths.blacklistFile,
    JSON.stringify(next, null, 2),
    "utf8",
  );
  return next;
}

export async function appendSendResult(row: Record<string, unknown>): Promise<void> {
  await ensureDir(config.paths.dataDir);
  await appendFile(
    config.paths.resultsFile,
    `${JSON.stringify({ ...row, at: new Date().toISOString() })}\n`,
    "utf8",
  );
}

export async function readRecentResults(limit = 80): Promise<Record<string, unknown>[]> {
  try {
    const raw = await readFile(config.paths.resultsFile, "utf8");
    const lines = raw
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);
    return lines
      .slice(-limit)
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .reverse();
  } catch {
    return [];
  }
}
