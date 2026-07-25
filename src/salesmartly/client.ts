import { config } from "../config.js";
import { buildExternalSign } from "./sign.js";
import type {
  ApiListResponse,
  ContactRow,
  MessengerPage,
} from "./types.js";
import { BLACKLIST_TAG_NAMES } from "./types.js";

const MESSENGER_CHANNEL = 1;
const FETCH_TIMEOUT_MS = 60_000;

export type ProgressFn = (line: string) => void;

async function getJson<T>(
  path: string,
  params: Record<string, string | number>,
): Promise<T> {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    query.set(key, String(value));
  }

  const sign = buildExternalSign(config.salesmartly.apiToken, params);
  const url = `${config.salesmartly.baseUrl}${path}?${query.toString()}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    const res = await fetch(url, {
      method: "GET",
      headers: {
        "external-sign": sign,
        Accept: "application/json",
      },
      signal: controller.signal,
    });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`SaleSmartly HTTP ${res.status}: ${body}`);
    }

    return (await res.json()) as T;
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      throw new Error(`SaleSmartly 请求超时（${FETCH_TIMEOUT_MS / 1000}s）：${path}`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

function assertOk<T>(payload: ApiListResponse<T>, action: string): void {
  if (payload.code !== 0) {
    throw new Error(
      `SaleSmartly ${action} 失败: code=${payload.code} msg=${payload.msg}`,
    );
  }
}

export async function fetchMessengerPages(): Promise<MessengerPage[]> {
  const pages: MessengerPage[] = [];
  let page = 1;
  const pageSize = 50;

  while (true) {
    const payload = await getJson<
      ApiListResponse<{
        id: number;
        page_id: string;
        page_name: string;
        channel_id: string | number;
        status: number;
        account_status: number;
        remark?: string;
      }>
    >("/api/v2/get-messenger-list", {
      project_id: config.salesmartly.projectId,
      page,
      page_size: pageSize,
    });

    assertOk(payload, "get-messenger-list");
    const list = payload.data?.list ?? [];
    for (const item of list) {
      pages.push({
        id: item.id,
        pageId: String(item.page_id),
        pageName: item.page_name,
        channelId: String(item.channel_id),
        status: item.status,
        accountStatus: item.account_status,
        remark: item.remark ? String(item.remark) : "",
      });
    }

    const total = payload.data?.total ?? list.length;
    if (pages.length >= total || list.length === 0) break;
    page += 1;
  }

  return pages;
}

type RawLabel = {
  id: number;
  label_name: string;
};

/** 解析黑名单标签名 → 标签 ID */
export async function resolveBlacklistLabelIds(
  onProgress?: ProgressFn,
): Promise<{ id: number; name: string }[]> {
  const wanted = new Set(BLACKLIST_TAG_NAMES.map((n) => n));
  const found: { id: number; name: string }[] = [];

  const payload = await getJson<ApiListResponse<RawLabel>>(
    "/api/v2/get-label-list",
    {
      project_id: config.salesmartly.projectId,
      page: 1,
      page_size: 200,
      label_name: BLACKLIST_TAG_NAMES.join(","),
    },
  );
  assertOk(payload, "get-label-list");

  for (const item of payload.data?.list ?? []) {
    if (wanted.has(item.label_name as (typeof BLACKLIST_TAG_NAMES)[number])) {
      found.push({ id: item.id, name: item.label_name });
    }
  }

  // 若逗号筛选未命中全部，再逐个精确查
  const foundNames = new Set(found.map((f) => f.name));
  for (const name of BLACKLIST_TAG_NAMES) {
    if (foundNames.has(name)) continue;
    const one = await getJson<ApiListResponse<RawLabel>>(
      "/api/v2/get-label-list",
      {
        project_id: config.salesmartly.projectId,
        page: 1,
        page_size: 50,
        label_name: name,
      },
    );
    assertOk(one, "get-label-list");
    const hit = (one.data?.list ?? []).find((x) => x.label_name === name);
    if (hit) {
      found.push({ id: hit.id, name: hit.label_name });
      foundNames.add(name);
    }
    await sleep(120);
  }

  onProgress?.(
    `黑名单标签匹配：${found.map((f) => `${f.name}(#${f.id})`).join("、") || "无"}`,
  );

  const missing = BLACKLIST_TAG_NAMES.filter((n) => !foundNames.has(n));
  if (missing.length) {
    onProgress?.(`警告：Sale 中未找到标签：${missing.join("、")}`);
  }
  if (found.length === 0) {
    throw new Error(
      `SaleSmartly 中未找到任何黑名单标签（${BLACKLIST_TAG_NAMES.join("、")}），请核对标签名是否完全一致`,
    );
  }

  return found;
}

type RawContact = {
  chat_user_id: string;
  name: string;
  channel: number;
  channel_id: number | string;
  channel_uid: string;
  labels?: string;
  msg_last_send_time?: number;
  user_last_reply_time?: number;
};

function mapContact(
  item: RawContact,
  mapped: MessengerPage,
): ContactRow | null {
  const name = (item.name || "").trim();
  if (!name) return null;
  const userLastReplyMs = Number(item.user_last_reply_time ?? 0);
  const userLastReplySec =
    userLastReplyMs > 1e12
      ? Math.floor(userLastReplyMs / 1000)
      : userLastReplyMs;

  return {
    chatUserId: item.chat_user_id,
    name,
    channel: item.channel,
    channelId: String(item.channel_id),
    channelUid: item.channel_uid || "",
    pageId: mapped.pageId,
    pageName: mapped.pageName,
    msgLastSendTime: Number(item.msg_last_send_time ?? 0),
    userLastReplyTime: userLastReplySec,
    labels: item.labels || "",
  };
}

async function fetchContactsPaged(options: {
  pages: MessengerPage[];
  updatedStart: number;
  updatedEnd: number;
  labelIds?: number[];
  channelId?: string;
  onProgress?: ProgressFn;
  progressLabel?: string;
}): Promise<ContactRow[]> {
  const pageMap = new Map(
    options.pages.map((p) => [p.channelId, p] as const),
  );
  // 也按 pageId 映射（部分环境 channel_id 等于 page_id）
  for (const p of options.pages) {
    pageMap.set(p.pageId, p);
  }

  const contacts: ContactRow[] = [];
  let page = 1;
  const pageSize = 100;
  const updatedTime = JSON.stringify({
    start: options.updatedStart,
    end: options.updatedEnd,
  });

  while (true) {
    const params: Record<string, string | number> = {
      project_id: config.salesmartly.projectId,
      updated_time: updatedTime,
      page,
      page_size: pageSize,
      channel: MESSENGER_CHANNEL,
    };
    if (options.labelIds && options.labelIds.length > 0) {
      params.labels = options.labelIds.join(",");
    }
    if (options.channelId) {
      params.channel_id = options.channelId;
    }

    const payload = await getJson<ApiListResponse<RawContact>>(
      "/api/v2/get-contact-list",
      params,
    );
    assertOk(payload, "get-contact-list");
    const list = payload.data?.list ?? [];
    const total = payload.data?.total ?? list.length;

    for (const item of list) {
      const channelId = String(item.channel_id);
      const mapped = pageMap.get(channelId);
      if (!mapped) continue;
      const row = mapContact(item, mapped);
      if (row) contacts.push(row);
    }

    options.onProgress?.(
      `${options.progressLabel ?? "拉取客户"}：第 ${page} 页，本页 ${list.length}，累计有效 ${contacts.length}/${total}`,
    );

    if (page * pageSize >= total || list.length === 0) break;
    page += 1;
    await sleep(120);
  }

  return contacts;
}

/**
 * 拉取指定主页的 Messenger 客户（可缓存为发送名单）。
 */
export async function fetchMessengerContacts(options: {
  pages: MessengerPage[];
  updatedStart: number;
  updatedEnd: number;
  onProgress?: ProgressFn;
}): Promise<ContactRow[]> {
  if (options.pages.length === 0) return [];

  const all: ContactRow[] = [];
  const seen = new Set<string>();

  for (const p of options.pages) {
    options.onProgress?.(`同步客户：${p.pageName}`);
    const rows = await fetchContactsPaged({
      pages: [p],
      updatedStart: options.updatedStart,
      updatedEnd: options.updatedEnd,
      channelId: p.channelId,
      onProgress: options.onProgress,
      progressLabel: p.pageName,
    });
    for (const row of rows) {
      const key = `${row.pageId}::${row.chatUserId || row.name}`;
      if (seen.has(key)) continue;
      seen.add(key);
      all.push(row);
    }
  }

  return all;
}

/**
 * 仅拉取勾选主页下、带黑名单标签的客户。
 */
export async function fetchBlacklistContacts(options: {
  pages: MessengerPage[];
  onProgress?: ProgressFn;
}): Promise<ContactRow[]> {
  if (options.pages.length === 0) {
    throw new Error("请先勾选至少一个主页");
  }

  const labels = await resolveBlacklistLabelIds(options.onProgress);
  const labelIds = labels.map((l) => l.id);
  const now = Math.floor(Date.now() / 1000);
  // 黑名单用足够长的时间窗，避免漏掉老客户
  const updatedStart = now - 10 * 365 * 24 * 3600;

  const all: ContactRow[] = [];
  const seen = new Set<string>();

  for (const p of options.pages) {
    options.onProgress?.(`更新黑名单：${p.pageName}`);
    const rows = await fetchContactsPaged({
      pages: [p],
      updatedStart,
      updatedEnd: now,
      labelIds,
      channelId: p.channelId,
      onProgress: options.onProgress,
      progressLabel: `黑名单/${p.pageName}`,
    });
    for (const row of rows) {
      const key = `${row.pageId}::${row.name}`;
      if (seen.has(key)) continue;
      seen.add(key);
      all.push(row);
    }
  }

  return all;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
