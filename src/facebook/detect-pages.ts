import type { Page } from "playwright";
import type { ProxyConfig } from "../proxy.js";
import { launchPersistentContext, openBusinessSuite } from "./browser.js";

export type FbPageRef = {
  pageId: string;
  pageName: string;
};

export type DetectResult = {
  fbPages: FbPageRef[];
  matched: FbPageRef[];
  fbOnly: FbPageRef[];
  saleOnly: FbPageRef[];
};

type LogFn = (line: string) => void;

const DETECT_VERSION = "v9-radio";

function normalizeName(s: string): string {
  return s
    .replace(/\s+/g, " ")
    .replace(/[’']/g, "'")
    .trim()
    .toLowerCase();
}

function compact(s: string): string {
  return normalizeName(s).replace(/[^a-z0-9\u4e00-\u9fff]+/g, "");
}

function namesLooselyEqual(a: string, b: string): boolean {
  const na = compact(a);
  const nb = compact(b);
  if (!na || !nb) return false;
  if (na === nb) return true;
  if (na.length < 5 || nb.length < 5) return false;
  return na.includes(nb) || nb.includes(na);
}

/** 专门读取企业资产面板里的 radio 行（主页名），忽略收件箱菜单 */
async function scrapeRadioPageNames(page: Page): Promise<string[]> {
  try {
    return (await page.evaluate(`(() => {
      const junk = /automations|messaging|insights|availability|settings|to-dos|unread|priority|follow up|not now|connect|manage|more|open|create |search|portfolio|business assets|other assets|พอร์ต|สินทรัพย์|เลือก|รายการ|通知|寻找|搜索/i;
      const names = [];
      const seen = Object.create(null);

      document.querySelectorAll('[role="radio"]').forEach((el) => {
        let t = (el.innerText || el.getAttribute("aria-label") || "")
          .replace(/\\s+/g, " ")
          .trim();
        // 去掉尾部通知数字
        t = t.replace(/\\s*\\d+\\+?\\s*$/g, "").trim();
        // 有的行是「名字\\nFacebook」
        const firstLine = t.split(/\\n/)[0].trim();
        if (!firstLine || firstLine.length < 2 || firstLine.length > 90) return;
        if (junk.test(firstLine)) return;
        if (/^\\d+$/.test(firstLine)) return;
        const key = firstLine.toLowerCase();
        if (seen[key]) return;
        seen[key] = 1;
        names.push(firstLine);
      });

      return names;
    })()`)) as string[];
  } catch {
    return [];
  }
}

async function scrapePageIds(page: Page): Promise<string[]> {
  const html = await page.content();
  const ids = new Set<string>();
  const patterns = [
    /page_id(?:=|%3D|\\u003d|":"|':\s*|\\":\\")(\d{8,20})/gi,
    /asset_id(?:=|%3D|\\u003d|":")(\d{8,20})/gi,
    /"pageID":"(\d{8,20})"/g,
    /"page_id":"(\d{8,20})"/g,
  ];
  for (const re of patterns) {
    let m: RegExpExecArray | null;
    while ((m = re.exec(html))) ids.add(m[1]);
  }
  return [...ids];
}

async function tryOpenSwitcher(page: Page, log: LogFn): Promise<void> {
  const candidates = [
    page.locator('[role="banner"] div[role="button"]').first(),
    page.getByRole("button", { name: /切换|资产|Profiles|pages|พอร์ต|สินทรัพย์/i }),
  ];
  for (const loc of candidates) {
    try {
      if (await loc.isVisible({ timeout: 1000 }).catch(() => false)) {
        await loc.click({ timeout: 2000 });
        await page.waitForTimeout(1000);
        log("已尝试点击顶部切换入口");
        return;
      }
    } catch {
      // continue
    }
  }
}

/** 打开业务套件并尝试点顶部切换（多账号并行时每个浏览器各调一次） */
export async function prepareDetectBrowser(
  page: Page,
  log: LogFn = console.log,
): Promise<void> {
  log(`探测引擎 ${DETECT_VERSION}`);
  log("步骤1：打开 Meta 业务套件…");
  await openBusinessSuite(page);
  await page.waitForTimeout(2500);
  await tryOpenSwitcher(page, log);
}

export function detectManualStepsLog(log: LogFn, accountLabel?: string): void {
  const who = accountLabel ? `账号「${accountLabel}」` : "浏览器";
  log(`请手动操作${who}（必须看到右侧主页 radio 列表）：`);
  log("  1) 点左上角切换");
  log("  2) 点 Other assets / 其他资产 / สินทรัพย์อื่นๆ");
  log("  3) 右侧出现主页列表（带圆点单选）");
  log("  4) 回到控制台，点「确认已打开企业资产列表」");
}

/** 在已打开的页面上读取 radio 列表并对照 Sale（不关闭浏览器） */
export async function matchSalePagesFromPage(
  page: Page,
  salePages: { pageId: string; pageName: string }[],
  log: LogFn = console.log,
): Promise<DetectResult> {
  log("步骤2：读取企业资产 radio 列表，并对照 Sale…");
  for (let i = 0; i < 10; i += 1) {
    await page.mouse.wheel(0, 800);
    await page.waitForTimeout(200);
  }

  const radioNames = await scrapeRadioPageNames(page);
  const pageIds = await scrapePageIds(page);
  log(
    `radio 主页名 ${radioNames.length} 个：${radioNames.slice(0, 12).join("、") || "（空）"}`,
  );
  log(`源码 page_id/asset_id ${pageIds.length} 个`);

  if (radioNames.length === 0) {
    log(
      "未读到任何 radio 主页名。请确认右侧列表已展开且每行有圆点单选，然后重新探测。",
    );
  }

  const matchedMap = new Map<string, FbPageRef>();
  const saleById = new Map(salePages.map((p) => [p.pageId, p] as const));

  for (const fbName of radioNames) {
    const sale = salePages.find((p) => namesLooselyEqual(p.pageName, fbName));
    if (sale) {
      matchedMap.set(sale.pageId, {
        pageId: sale.pageId,
        pageName: sale.pageName,
      });
      log(`  ✓ 「${fbName}」→ Sale「${sale.pageName}」`);
    } else {
      log(`  · FB「${fbName}」未在 Sale 中找到同名`);
    }
  }

  for (const id of pageIds) {
    const sale = saleById.get(id);
    if (sale && !matchedMap.has(sale.pageId)) {
      matchedMap.set(sale.pageId, {
        pageId: sale.pageId,
        pageName: sale.pageName,
      });
      log(`  ✓ ID ${id} →「${sale.pageName}」`);
    }
  }

  const matched = [...matchedMap.values()];
  const matchedIds = new Set(matched.map((m) => m.pageId));
  const saleOnly = salePages
    .filter((p) => !matchedIds.has(p.pageId))
    .map((p) => ({ pageId: p.pageId, pageName: p.pageName }));
  const matchedFb = new Set(
    [...matchedMap.values()].map((m) => compact(m.pageName)),
  );
  const fbOnly = radioNames
    .filter((n) => !matchedFb.has(compact(n)))
    .filter((n) => !salePages.some((p) => namesLooselyEqual(p.pageName, n)))
    .map((n) => ({ pageId: "", pageName: n }));

  log(
    `对照完成：FB∩Sale=${matched.length}；FB有Sale无=${fbOnly.length}；Sale有当前FB无=${saleOnly.length}`,
  );

  return {
    fbPages: radioNames.map((n) => ({ pageId: "", pageName: n })),
    matched,
    fbOnly,
    saleOnly,
  };
}

export async function detectAccessiblePages(options: {
  salePages: { pageId: string; pageName: string }[];
  headless?: boolean;
  /** 指定浏览器资料夹（多账号时每号一个） */
  profileDir?: string;
  proxy?: ProxyConfig | null;
  accountLabel?: string;
  onLog?: LogFn;
  waitUntilListReady?: () => Promise<void>;
  /** 若传入已有 context，则探测后不关闭（多开保留浏览器时用） */
  existingContext?: Awaited<ReturnType<typeof launchPersistentContext>>;
}): Promise<DetectResult> {
  const log = options.onLog ?? console.log;
  const ownsContext = !options.existingContext;
  const context =
    options.existingContext ??
    (await launchPersistentContext(
      options.headless ?? false,
      options.profileDir,
      options.proxy,
    ));
  const page = context.pages()[0] ?? (await context.newPage());

  for (const p of context.pages()) {
    if (p !== page) await p.close().catch(() => undefined);
  }

  try {
    await prepareDetectBrowser(page, log);
    detectManualStepsLog(log, options.accountLabel);

    if (options.waitUntilListReady) {
      await options.waitUntilListReady();
    } else {
      log("（命令行）等待 45 秒…");
      await page.waitForTimeout(45_000);
    }

    return await matchSalePagesFromPage(page, options.salePages, log);
  } finally {
    if (ownsContext) await context.close();
  }
}
