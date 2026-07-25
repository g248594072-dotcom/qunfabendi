import { chromium, type BrowserContext, type Page } from "playwright";
import { config } from "../config.js";
import {
  normalizeProxy,
  proxyLabel,
  toPlaywrightProxy,
  type ProxyConfig,
} from "../proxy.js";
import { ensureDir } from "../utils/delay.js";

export async function launchPersistentContext(
  headless = false,
  profileDir?: string,
  proxy?: ProxyConfig | null,
): Promise<BrowserContext> {
  const dir = profileDir || config.browser.profileDir;
  await ensureDir(dir);
  const pwProxy = toPlaywrightProxy(proxy);
  const common = {
    headless,
    viewport: { width: 1440, height: 900 } as const,
    locale: "zh-CN",
    args: ["--disable-blink-features=AutomationControlled"],
    ...(pwProxy ? { proxy: pwProxy } : {}),
  };

  try {
    return await chromium.launchPersistentContext(dir, {
      ...common,
      channel: "chrome",
    });
  } catch {
    return chromium.launchPersistentContext(dir, common);
  }
}

export async function openBusinessSuite(page: Page): Promise<void> {
  await page.goto("https://business.facebook.com/latest/inbox/all", {
    waitUntil: "domcontentloaded",
    timeout: 120_000,
  });
}

/**
 * 打开指定资料夹的浏览器让用户登录。
 * waitUntilDone：CLI 用回车；UI 用「确认已登录」按钮 resolve。
 */
export async function interactiveLogin(
  waitUntilDone?: () => Promise<void>,
  profileDir?: string,
  proxy?: ProxyConfig | null,
): Promise<void> {
  const normalized = normalizeProxy(proxy);
  if (normalized) {
    console.log(`使用代理：${proxyLabel(normalized)}`);
  }
  const context = await launchPersistentContext(false, profileDir, normalized);
  const page = context.pages()[0] ?? (await context.newPage());

  await openBusinessSuite(page);

  if (waitUntilDone) {
    await waitUntilDone();
  } else {
    console.log("正在打开 Meta 业务套件…");
    console.log("请在弹出的浏览器中完成 Facebook 登录，并确认能进入「消息框」。");
    console.log("完成后回到终端按 Enter 继续。");
    await new Promise<void>((resolve) => {
      process.stdin.resume();
      process.stdin.once("data", () => resolve());
    });
  }

  await context.close();
}
