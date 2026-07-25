import { config, getRuntimeConfig } from "./config.js";
import {
  fetchBlacklistContacts,
  fetchMessengerContacts,
  fetchMessengerPages,
} from "./salesmartly/client.js";
import {
  BLACKLIST_TAG_NAMES,
  blacklistKey,
  isPageBannedByRemark,
} from "./salesmartly/types.js";
import {
  getAccount,
  getActiveAccount,
  loadAccounts,
  resolveProfileDir,
  type FbAccount,
} from "./accounts.js";
import {
  interactiveLogin,
  launchPersistentContext,
  openBusinessSuite,
} from "./facebook/browser.js";
import { normalizeProxy, proxyLabel } from "./proxy.js";
import {
  detectAccessiblePages,
  detectManualStepsLog,
  matchSalePagesFromPage,
  prepareDetectBrowser,
} from "./facebook/detect-pages.js";
import { sendForPage, type SendTarget } from "./facebook/sender.js";
import {
  buildBlacklistSet,
  loadBlacklist,
  loadContacts,
  loadFbSessionPages,
  loadPages,
  mergeContacts,
  readRecentResults,
  saveFbSessionPagesForAccount,
  savePages,
  updateBlacklistForPages,
} from "./storage/files.js";
import { loadSettings } from "./settings.js";
import { sleep } from "./utils/delay.js";

export type LogFn = (line: string) => void;

const noop: LogFn = () => undefined;

async function resolveSelectedPages(log: LogFn) {
  let pages;
  try {
    pages = await loadPages();
  } catch {
    log("本地还没有主页，先同步主页…");
    pages = await fetchMessengerPages();
    await savePages(pages);
  }

  const settings = await loadSettings(config.rootDir);
  const selected = settings.selectedPageIds;
  if (!selected.length) {
    throw new Error("请先在控制台勾选至少一个主页，并点「保存设置」");
  }

  const filtered = pages.filter((p) => selected.includes(p.pageId));
  if (!filtered.length) {
    throw new Error("勾选的主页在本地列表中找不到，请先「同步主页」");
  }

  const session = await loadFbSessionPages();
  if (session?.pageIds?.length) {
    const allowed = new Set(session.pageIds);
    const blocked = filtered.filter((p) => !allowed.has(p.pageId));
    if (blocked.length) {
      throw new Error(
        `以下勾选主页不在已探测账号的可管理列表中，请用对应账号「探测」或「探测全部」：${blocked
          .map((p) => p.pageName)
          .join("、")}`,
      );
    }
  }

  return filtered;
}

export async function jobLogin(
  log: LogFn = noop,
  waitUntilDone?: () => Promise<void>,
  accountId?: string,
): Promise<void> {
  const account = accountId
    ? await getAccount(accountId)
    : await getActiveAccount();
  const profileDir = resolveProfileDir(account);
  const proxy = normalizeProxy(account.proxy);
  log(
    `正在打开账号「${account.name}」的浏览器（${proxyLabel(proxy)}），请手动登录…`,
  );
  await interactiveLogin(waitUntilDone, profileDir, proxy);
  log(`账号「${account.name}」登录态已保存。建议接着探测该号可管理主页。`);
}

/** 多开：每个账号各开一个浏览器（类似 Chrome 个人资料），确认后一并关闭（资料夹保留） */
export async function jobLoginAllAccounts(
  log: LogFn = noop,
  waitUntilDone?: () => Promise<void>,
): Promise<void> {
  const file = await loadAccounts();
  const accounts = file.accounts;
  log(`将打开 ${accounts.length} 个浏览器（每账号一个资料夹）…`);

  const contexts: Awaited<ReturnType<typeof launchPersistentContext>>[] = [];
  try {
    for (const account of accounts) {
      const proxy = normalizeProxy(account.proxy);
      const ctx = await launchPersistentContext(
        false,
        resolveProfileDir(account),
        proxy,
      );
      const page = ctx.pages()[0] ?? (await ctx.newPage());
      await openBusinessSuite(page);
      contexts.push(ctx);
      log(`已打开「${account.name}」· ${proxyLabel(proxy)}`);
    }
    log("请在各浏览器中分别登录对应 Facebook 号，全部完成后点「确认已登录」。");
    if (waitUntilDone) await waitUntilDone();
    else await sleep(60_000);
  } finally {
    for (const ctx of contexts) await ctx.close().catch(() => undefined);
  }
  log("全部登录窗口已关闭，登录态已按账号分别保存。可接着「探测全部账号」。");
}

export async function jobSyncPages(log: LogFn = noop) {
  log("正在从 SaleSmartly 拉取 Messenger 主页…");
  const pages = await fetchMessengerPages();
  await savePages(pages);
  const banned = pages.filter((p) => isPageBannedByRemark(p.remark));
  log(`已保存 ${pages.length} 个主页（Sale 全量）。请再探测当前 Facebook 能管哪些。`);
  if (banned.length) {
    log(
      `其中封号主页 ${banned.length} 个（备注含「封」，发送时自动跳过）：` +
        banned.map((p) => `${p.pageName}「${String(p.remark || "").slice(0, 30)}」`).join("；"),
    );
  }
  return pages;
}

async function loadSalePagesOrSync(log: LogFn) {
  try {
    return await loadPages();
  } catch {
    log("本地还没有 Sale 主页，先同步…");
    const pages = await fetchMessengerPages();
    await savePages(pages);
    return pages;
  }
}

/** 探测单个账号（默认当前 active） */
export async function jobDetectFbPages(
  log: LogFn = noop,
  waitUntilListReady?: () => Promise<void>,
  accountId?: string,
) {
  const pages = await loadSalePagesOrSync(log);
  if (!pages.length) throw new Error("Sale 主页列表为空，请先同步主页");

  const account = accountId
    ? await getAccount(accountId)
    : await getActiveAccount();
  log(`探测账号「${account.name}」…`);

  const result = await detectAccessiblePages({
    salePages: pages.map((p) => ({ pageId: p.pageId, pageName: p.pageName })),
    headless: false,
    profileDir: resolveProfileDir(account),
    proxy: normalizeProxy(account.proxy),
    accountLabel: account.name,
    onLog: log,
    waitUntilListReady,
  });

  const session = await saveFbSessionPagesForAccount({
    accountId: account.id,
    accountName: account.name,
    pages: result.matched,
  });

  log(
    `账号「${account.name}」可发（FB∩Sale）：${result.matched.length}；汇总可管理主页：${session.pages.length}`,
  );
  return result;
}

/**
 * 多账号并行探测：同时打开多个浏览器（各用各的资料夹），
 * 你在各窗口打开企业资产列表后点一次确认，再逐个读取并汇总。
 */
export async function jobDetectAllAccounts(
  log: LogFn = noop,
  waitUntilListReady?: () => Promise<void>,
) {
  const pages = await loadSalePagesOrSync(log);
  if (!pages.length) throw new Error("Sale 主页列表为空，请先同步主页");

  const saleRefs = pages.map((p) => ({
    pageId: p.pageId,
    pageName: p.pageName,
  }));
  const file = await loadAccounts();
  const accounts = file.accounts;
  log(`多账号探测：将打开 ${accounts.length} 个浏览器…`);

  type Sess = {
    account: FbAccount;
    context: Awaited<ReturnType<typeof launchPersistentContext>>;
    page: Awaited<
      ReturnType<Awaited<ReturnType<typeof launchPersistentContext>>["newPage"]>
    >;
  };
  const sessions: Sess[] = [];

  try {
    for (const account of accounts) {
      const proxy = normalizeProxy(account.proxy);
      const context = await launchPersistentContext(
        false,
        resolveProfileDir(account),
        proxy,
      );
      const page = context.pages()[0] ?? (await context.newPage());
      for (const p of context.pages()) {
        if (p !== page) await p.close().catch(() => undefined);
      }
      await prepareDetectBrowser(page, (line) =>
        log(`[${account.name}] ${line}`),
      );
      sessions.push({ account, context, page });
      log(`已打开「${account.name}」· ${proxyLabel(proxy)}`);
    }

    detectManualStepsLog(log, "每一个窗口");
    log("全部窗口开好后，点一次「确认已打开企业资产列表」，将按窗口依次读取并汇总。");

    if (waitUntilListReady) await waitUntilListReady();
    else await sleep(60_000);

    let totalMatched = 0;
    for (const { account, page } of sessions) {
      log(`—— 读取账号「${account.name}」——`);
      const result = await matchSalePagesFromPage(
        page,
        saleRefs,
        (line) => log(`[${account.name}] ${line}`),
      );
      await saveFbSessionPagesForAccount({
        accountId: account.id,
        accountName: account.name,
        pages: result.matched,
      });
      totalMatched += result.matched.length;
      log(
        `账号「${account.name}」匹配 ${result.matched.length} 个主页：${result.matched
          .map((p) => p.pageName)
          .join("、") || "（无）"}`,
      );
    }

    const session = await loadFbSessionPages();
    const allNames = (session?.pages || [])
      .map((p) => `${p.pageName}←${p.accountName || "?"}`)
      .join("、");
    log(
      `汇总完成：各账号合计匹配 ${totalMatched}；去重可管理 ${session?.pages.length ?? 0}：${allNames || "（无）"}`,
    );
    return session;
  } finally {
    for (const s of sessions) {
      await s.context.close().catch(() => undefined);
    }
  }
}

/** 只同步勾选主页的发送客户，并合并进本地缓存（不覆盖其它主页） */
export async function jobSyncContacts(log: LogFn = noop) {
  const runtime = await getRuntimeConfig();
  const pages = await resolveSelectedPages(log);
  const now = Math.floor(Date.now() / 1000);
  const updatedStart = now - Math.max(1, runtime.contactDays) * 24 * 3600;

  log(
    `同步发送客户：${pages.length} 个勾选主页，近 ${runtime.contactDays} 天有更新`,
  );

  const contacts = await fetchMessengerContacts({
    pages,
    updatedStart,
    updatedEnd: now,
    onProgress: log,
  });
  const merged = await mergeContacts(contacts);

  const byPage = new Map<string, number>();
  for (const c of contacts) {
    byPage.set(c.pageName, (byPage.get(c.pageName) ?? 0) + 1);
  }
  for (const [name, count] of byPage) {
    log(`  本次 ${name}: ${count}`);
  }
  log(`本次写入 ${contacts.length}，本地客户库合计 ${merged.length}`);
  return merged;
}

/** 只拉勾选主页下带黑名单标签的客户，更新本地黑名单 */
export async function jobSyncBlacklist(log: LogFn = noop) {
  const pages = await resolveSelectedPages(log);
  log(
    `更新黑名单标签：${BLACKLIST_TAG_NAMES.join("、")}；主页 ${pages.length} 个`,
  );

  const contacts = await fetchBlacklistContacts({
    pages,
    onProgress: log,
  });

  const file = await updateBlacklistForPages(
    pages.map((p) => p.pageId),
    contacts,
  );

  log(
    `本批命中 ${contacts.length} 人；黑名单总计 ${file.entries.length} 条（其它主页保留）`,
  );
  return file;
}

export async function jobSend(
  options: { dryRun?: boolean; pageIds?: string[] } = {},
  log: LogFn = noop,
) {
  const runtime = await getRuntimeConfig();
  const contacts = await loadContacts();
  if (contacts.length === 0) {
    throw new Error("还没有客户数据，请先「同步客户」");
  }

  const settings = await loadSettings(config.rootDir);
  const pageFilter =
    options.pageIds && options.pageIds.length > 0
      ? options.pageIds
      : settings.selectedPageIds;

  if (!pageFilter.length) {
    throw new Error("请先勾选要发送的主页");
  }

  // Sale 主页备注含「封」→ 整页跳过（不开标签、不发）
  const pageNameById = new Map<string, string>();
  const bannedPageIds = new Set<string>();
  const bannedPageLogs: string[] = [];
  try {
    const pages = await loadPages();
    for (const p of pages) {
      pageNameById.set(p.pageId, p.pageName);
      if (isPageBannedByRemark(p.remark)) {
        bannedPageIds.add(p.pageId);
        bannedPageLogs.push(
          `${p.pageName}（备注：${String(p.remark || "").slice(0, 40)}）`,
        );
      }
    }
  } catch {
    /* ignore */
  }
  for (const c of contacts) {
    if (c.pageName) pageNameById.set(c.pageId, c.pageName);
  }

  if (bannedPageLogs.length) {
    log(`跳过封号主页 ${bannedPageLogs.length} 个（备注含「封」）：${bannedPageLogs.join("；")}`);
  }

  const blacklist = await loadBlacklist();
  const blocked = buildBlacklistSet(blacklist.entries);
  let skipped = 0;

  const grouped = new Map<string, SendTarget[]>();
  for (const c of contacts) {
    if (!pageFilter.includes(c.pageId)) continue;
    if (bannedPageIds.has(c.pageId)) continue;
    if (blocked.has(blacklistKey(c.pageId, c.name))) {
      skipped += 1;
      continue;
    }
    const list = grouped.get(c.pageId) ?? [];
    list.push({
      pageId: c.pageId,
      pageName: c.pageName,
      customerName: c.name,
      chatUserId: c.chatUserId,
    });
    grouped.set(c.pageId, list);
  }

  if (grouped.size === 0) {
    throw new Error(
      "没有可发送的客户。请同步客户，或检查黑名单/封号备注是否把人都过滤掉了。",
    );
  }

  // 说明：浏览器标签 =「有待发客户的主页」，不是「勾选了就开空页」
  const openedIds = new Set(grouped.keys());
  const skippedPages: string[] = [];
  for (const pid of pageFilter) {
    if (openedIds.has(pid)) continue;
    if (bannedPageIds.has(pid)) continue; // 已在封号日志里说过
    const name = pageNameById.get(pid) || pid;
    const rawCount = contacts.filter((c) => c.pageId === pid).length;
    skippedPages.push(
      rawCount === 0
        ? `${name}（本地客户 0，请先同步）`
        : `${name}（${rawCount} 人全在黑名单）`,
    );
  }

  const sendTotal = [...grouped.values()].reduce((n, a) => n + a.length, 0);
  const openNames = [...grouped.entries()]
    .map(([id, list]) => `${list[0]?.pageName ?? id}(${list.length}人)`)
    .join("、");
  log(
    `${options.dryRun ? "[只定位不发送] " : ""}勾选 ${pageFilter.length} 个主页 → 实际打开 ${grouped.size} 个标签：${openNames}`,
  );
  log(
    `待发 ${sendTotal}，黑名单跳过 ${skipped}；间隔 ${runtime.delayMinSec}-${runtime.delayMaxSec}s；每页上限 ${runtime.maxPerPage || "不限制"}`,
  );
  if (skippedPages.length) {
    log(`未打开（无待发）：${skippedPages.join("；")}`);
  }

  // 账号资料夹 + 代理出口：同账号同代理可多标签并发；同账号不同代理须串行（资料夹独占）
  const session = await loadFbSessionPages();
  const accountsFile = await loadAccounts();
  const pageToAccount = session?.pageToAccount || {};
  const byAccount = new Map<string, [string, SendTarget[]][]>();
  for (const entry of grouped.entries()) {
    const [pageId] = entry;
    const accId =
      pageToAccount[pageId] ||
      accountsFile.activeAccountId ||
      accountsFile.accounts[0]?.id ||
      "default";
    const list = byAccount.get(accId) ?? [];
    list.push(entry);
    byAccount.set(accId, list);
  }

  const accountSummary = [...byAccount.entries()]
    .map(([accId, entries]) => {
      const acc = accountsFile.accounts.find((a) => a.id === accId);
      const name = acc?.name || accId;
      return `${name}/${proxyLabel(acc?.proxy)}(${entries.length}页)`;
    })
    .join("、");
  log(`按账号分浏览器：${accountSummary}`);

  const staggerMs = 1500;
  const runAccount = async (
    accountId: string,
    entries: [string, SendTarget[]][],
    accountIndex: number,
  ): Promise<void> => {
    await sleep(accountIndex * 800);
    let account: FbAccount;
    try {
      account = await getAccount(accountId);
    } catch {
      account = await getActiveAccount();
      log(`主页映射账号 ${accountId} 不存在，改用「${account.name}」`);
    }
    const proxy = normalizeProxy(account.proxy);
    const profileDir = resolveProfileDir(account);
    const concurrency = Math.max(
      1,
      Math.min(runtime.maxPageConcurrency ?? 6, 12, entries.length),
    );
    log(
      `账号「${account.name}」· ${proxyLabel(proxy)}：最多 ${concurrency} 标签 / ${entries.length} 主页`,
    );

    const context = await launchPersistentContext(
      runtime.headless,
      profileDir,
      proxy,
    );
    try {
      let cursor = 0;
      const runNext = async (workerIndex: number): Promise<void> => {
        await sleep(workerIndex * staggerMs);
        while (cursor < entries.length) {
          const idx = cursor;
          cursor += 1;
          const [pageId, targets] = entries[idx];
          await sendForPage(
            context,
            pageId,
            targets[0]?.pageName ?? pageId,
            targets,
            {
              dryRun: options.dryRun,
              text: runtime.messageText,
              imagePath: runtime.messageImagePath,
              delayMinSec: runtime.delayMinSec,
              delayMaxSec: runtime.delayMaxSec,
              maxPerPage: runtime.maxPerPage,
              onLog: (line) => log(`[${account.name}] ${line}`),
            },
          ).catch((err) => {
            const msg = err instanceof Error ? err.message : String(err);
            log(
              `[${account.name}][${targets[0]?.pageName ?? pageId}] 出错：${msg}`,
            );
          });
        }
      };
      await Promise.all(
        Array.from({ length: concurrency }, (_u, i) => runNext(i)),
      );
    } finally {
      await context.close();
    }
  };

  await Promise.all(
    [...byAccount.entries()].map(([accId, entries], i) =>
      runAccount(accId, entries, i),
    ),
  );

  log("任务结束，结果已写入 data/send-results.jsonl");
}

export async function getDashboardState() {
  const settings = await loadSettings(config.rootDir);
  let pages: Awaited<ReturnType<typeof loadPages>> = [];
  let contacts: Awaited<ReturnType<typeof loadContacts>> = [];
  let blacklist = await loadBlacklist();

  try {
    pages = await loadPages();
  } catch {
    pages = [];
  }
  try {
    contacts = await loadContacts();
  } catch {
    contacts = [];
  }

  const contactCountByPage: Record<string, number> = {};
  for (const c of contacts) {
    contactCountByPage[c.pageId] =
      (contactCountByPage[c.pageId] ?? 0) + 1;
  }

  const blocked = buildBlacklistSet(blacklist.entries);
  const bannedPageIds = new Set(
    pages.filter((p) => isPageBannedByRemark(p.remark)).map((p) => p.pageId),
  );
  let sendable = 0;
  for (const c of contacts) {
    if (
      settings.selectedPageIds.length > 0 &&
      !settings.selectedPageIds.includes(c.pageId)
    ) {
      continue;
    }
    if (bannedPageIds.has(c.pageId)) continue;
    if (blocked.has(blacklistKey(c.pageId, c.name))) continue;
    sendable += 1;
  }

  const session = await loadFbSessionPages();
  const accessSet = session?.pageIds?.length
    ? new Set(session.pageIds)
    : null;
  const pageMeta = new Map(
    (session?.pages || []).map((p) => [p.pageId, p] as const),
  );
  const accountsFile = await loadAccounts();

  const enriched = pages.map((p) => {
    const meta = pageMeta.get(p.pageId);
    return {
      ...p,
      contactCount: contactCountByPage[p.pageId] ?? 0,
      fbAccessible: accessSet ? accessSet.has(p.pageId) : (null as boolean | null),
      bannedByRemark: isPageBannedByRemark(p.remark),
      accountId: meta?.accountId || "",
      accountName: meta?.accountName || "",
    };
  });

  const results = await readRecentResults(80);

  return {
    settings,
    pages: enriched,
    pagesAccessible: enriched.filter((p) => p.fbAccessible === true),
    pagesUnavailable: enriched.filter((p) => p.fbAccessible === false),
    pagesUnknown: enriched.filter((p) => p.fbAccessible === null),
    fbDetectedAt: session?.detectedAt ?? "",
    fbSessionAccounts: session?.accounts || [],
    accounts: accountsFile,
    contactTotal: contacts.length,
    sendableTotal: sendable,
    blacklistCount: blacklist.entries.length,
    blacklistUpdatedAt: blacklist.updatedAt,
    blacklistTags: [...BLACKLIST_TAG_NAMES],
    results,
    hasSaleSmartly: Boolean(
      process.env.SALESMARTLY_PROJECT_ID && process.env.SALESMARTLY_API_TOKEN,
    ),
  };
}
