import type { BrowserContext, Page, Locator } from "playwright";
import { access } from "node:fs/promises";
import { getRuntimeConfig } from "../config.js";
import { randomDelayMs, sleep } from "../utils/delay.js";
import { appendSendResult, addBlacklistEntry } from "../storage/files.js";

export type SendTarget = {
  pageId: string;
  pageName: string;
  customerName: string;
  chatUserId?: string;
};

export type SendOptions = {
  dryRun?: boolean;
  text?: string;
  imagePath?: string;
  delayMinSec?: number;
  delayMaxSec?: number;
  maxPerPage?: number;
  onLog?: (line: string) => void;
};

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** 关掉干扰弹层：Instagram 绑定、创建订单等 */
async function dismissPopups(page: Page): Promise<void> {
  const later = [
    page.getByRole("button", {
      name: /^以后再说$|^现在不要$|^Not now$|^Maybe later$|^Later$/i,
    }),
    page.getByText(/^以后再说$/).first(),
  ];
  for (const loc of later) {
    try {
      if (await loc.first().isVisible({ timeout: 400 })) {
        await loc
          .first()
          .click({ force: true, timeout: 800 })
          .catch(() => undefined);
        await page.waitForTimeout(300);
      }
    } catch {
      // ignore
    }
  }
}

/**
 * 只找「所有消息」下方、挨着「管理」的收件箱搜索框。
 * 绝不用最左侧导航栏的全局搜索。
 * 注意：必须用字符串脚本，避免 tsx 注入 __name 导致 page.evaluate 报错。
 */
/** 页面上搜索相关 UI 的诊断快照（写进报错，方便对照截图） */
async function diagnoseSearchUi(page: Page): Promise<string> {
  const info = await page.evaluate(`(() => {
    const vw = window.innerWidth || 0;
    const vh = window.innerHeight || 0;
    const url = location.href.slice(0, 120);
    const manages = [];
    for (const el of Array.from(document.querySelectorAll("div, span, button, a"))) {
      const t = (el.textContent || "").replace(/\\s+/g, " ").trim();
      if (t !== "管理" && t !== "Manage") continue;
      const r = el.getBoundingClientRect();
      if (r.width < 4 || r.height < 4) continue;
      manages.push({
        x: Math.round(r.left),
        y: Math.round(r.top),
        w: Math.round(r.width),
        text: t,
      });
      if (manages.length >= 6) break;
    }
    const inputs = [];
    for (const el of Array.from(
      document.querySelectorAll(
        "input, textarea, [role='combobox'], [role='searchbox'], [contenteditable='true']",
      ),
    )) {
      const r = el.getBoundingClientRect();
      const ph = (
        (el.placeholder || "") +
        "|" +
        (el.getAttribute("aria-label") || "") +
        "|" +
        (el.getAttribute("role") || "")
      ).slice(0, 60);
      inputs.push({
        tag: el.tagName,
        x: Math.round(r.left),
        y: Math.round(r.top),
        w: Math.round(r.width),
        h: Math.round(r.height),
        val: String(el.value || "").slice(0, 24),
        ph,
        type: el.type || "",
      });
      if (inputs.length >= 12) break;
    }
    const hasAllMsg = /所有消息/.test(document.body ? document.body.innerText.slice(0, 5000) : "");
    const hasUnread = /未读/.test(document.body ? document.body.innerText.slice(0, 5000) : "");
    const cannotSend = /你无法再向这位用户发送消息/.test(
      document.body ? document.body.innerText : "",
    );
    return { vw, vh, url, manages, inputs, hasAllMsg, hasUnread, cannotSend };
  })()`);

  const i = info as {
    vw: number;
    vh: number;
    url: string;
    manages: Array<{ x: number; y: number; w: number; text: string }>;
    inputs: Array<{
      tag: string;
      x: number;
      y: number;
      w: number;
      h: number;
      val: string;
      ph: string;
      type: string;
    }>;
    hasAllMsg: boolean;
    hasUnread: boolean;
    cannotSend: boolean;
  };

  const manageStr =
    i.manages.length === 0
      ? "无"
      : i.manages.map((m) => `${m.text}@(${m.x},${m.y})`).join("; ");
  const inputStr =
    i.inputs.length === 0
      ? "无"
      : i.inputs
          .map(
            (el) =>
              `  - ${el.tag}[${el.type}]@(${el.x},${el.y},${el.w}x${el.h}) val="${el.val}" ph="${el.ph}"`,
          )
          .join("\n");

  // 多行，配合前端 pre-wrap / server pushLog 换行显示
  return [
    `窗口 ${i.vw}x${i.vh}`,
    `页签所有消息=${i.hasAllMsg} 未读=${i.hasUnread} 无法发送条=${i.cannotSend}`,
    `「管理」按钮: ${manageStr}`,
    `可见输入候选:`,
    inputStr,
    `url: ${i.url}`,
  ].join("\n");
}

/** 左栏「管理」按钮位置（搜索框在它左边） */
async function locateLeftManageButton(page: Page): Promise<{
  x: number;
  y: number;
  left: number;
  right: number;
  top: number;
  bottom: number;
} | null> {
  const m = await page.evaluate(`(() => {
    const vw = window.innerWidth || 1400;
    const leftColMax = Math.min(900, vw * 0.55);
    let best = null;
    let bestTop = Infinity;
    for (const el of Array.from(document.querySelectorAll("div, span, button, a"))) {
      const t = (el.textContent || "").replace(/\\s+/g, " ").trim();
      if (t !== "管理" && t !== "Manage") continue;
      const r = el.getBoundingClientRect();
      if (r.width < 8 || r.height < 8) continue;
      if (r.left < 40 || r.left > leftColMax + 80) continue;
      if (r.top < 40 || r.top > 420) continue;
      if (r.top < bestTop) {
        bestTop = r.top;
        best = {
          x: r.left + r.width / 2,
          y: r.top + r.height / 2,
          left: r.left,
          right: r.right,
          top: r.top,
          bottom: r.bottom,
        };
      }
    }
    return best;
  })()`);
  return m as {
    x: number;
    y: number;
    left: number;
    right: number;
    top: number;
    bottom: number;
  } | null;
}

/** 点「管理」左边的搜索区域（DOM 里经常不是 input，只能靠坐标） */
async function clickInboxSearchArea(page: Page): Promise<boolean> {
  const m = await locateLeftManageButton(page);
  if (!m) return false;
  // 先 Escape，避免焦点停在右侧「添加标签」
  await page.keyboard.press("Escape").catch(() => undefined);
  await page.waitForTimeout(80);
  // 搜索框在「管理」左侧，点偏左一点进入输入（不要点太靠右以免点到 X/管理）
  const x = Math.max(80, m.left - 120);
  await page.mouse.click(x, m.y);
  await page.waitForTimeout(150);

  // 若焦点仍在右半屏（标签区），再点一次更靠左
  const inRight = await page.evaluate(`(() => {
    const a = document.activeElement;
    if (!a) return false;
    const r = a.getBoundingClientRect();
    return r.left > window.innerWidth * 0.55;
  })()`);
  if (inRight) {
    await page.mouse.click(Math.max(70, m.left - 180), m.y);
    await page.waitForTimeout(150);
  }
  return true;
}

/** 点搜索框与「管理」之间的 X 清空 */
async function clickSearchClearXByManage(page: Page): Promise<boolean> {
  const m = await locateLeftManageButton(page);
  if (!m) return false;
  // X 紧贴管理左侧
  const x = Math.max(60, m.left - 18);
  await page.mouse.click(x, m.y);
  await page.waitForTimeout(350);
  return true;
}

/**
 * 按截图定位左栏搜索：「所有消息」下方、与「管理」同一行、紧挨其左侧。
 * Meta 有时把真正的 input 做成 0 尺寸藏在可见容器里，所以用 elementFromPoint 扫。
 */
async function markInboxConversationSearch(page: Page): Promise<boolean> {
  return page.evaluate(`(() => {
    document
      .querySelectorAll("[data-inbox-search]")
      .forEach((e) => e.removeAttribute("data-inbox-search"));

    const vw = window.innerWidth || 1400;
    // 左栏放宽：对话列表经常占到一半左右
    const leftColMax = Math.min(900, Math.max(520, vw * 0.55));

    function visible(el) {
      const r = el.getBoundingClientRect();
      return r.width > 8 && r.height > 8 && r.bottom > 0 && r.right > 0;
    }

    function useRect(el) {
      const r = el.getBoundingClientRect();
      if (r.width >= 8 && r.height >= 8) return r;
      let p = el.parentElement;
      for (let i = 0; i < 5 && p; i++) {
        const pr = p.getBoundingClientRect();
        if (pr.width >= 40 && pr.height >= 12) return pr;
        p = p.parentElement;
      }
      return r;
    }

    function findInputNear(node) {
      let p = node;
      for (let i = 0; i < 10 && p; i++) {
        if (
          p.matches &&
          p.matches(
            "input, textarea, [role='combobox'], [role='searchbox'], [contenteditable='true']",
          )
        ) {
          if (p.getAttribute("role") === "textbox" && p.closest("[data-msg-composer]"))
            return null;
          return p;
        }
        const inner =
          p.querySelector &&
          p.querySelector(
            "input:not([type='hidden']), textarea, [role='combobox'], [role='searchbox']",
          );
        if (inner) return inner;
        p = p.parentElement;
      }
      return null;
    }

    // 「管理」：允许 textContent 稍长（图标+文字）
    const manageList = Array.from(
      document.querySelectorAll("div, span, button, a"),
    ).filter((el) => {
      const t = (el.textContent || "").replace(/\\s+/g, " ").trim();
      if (!(t === "管理" || t === "Manage" || /^管理$/.test(t))) return false;
      if (!visible(el)) return false;
      const r = el.getBoundingClientRect();
      return r.left >= 40 && r.left <= leftColMax + 120 && r.top > 40 && r.top < 480;
    });

    let bestInput = null;
    let bestScore = -1;

    const consider = (el, base) => {
      if (!el || el.disabled || el.type === "hidden") return;
      // 排除底部消息输入
      const r = useRect(el);
      if (r.left < 40 || r.left > leftColMax) return;
      if (r.top < 50 || r.top > 480) return;
      if (r.bottom > window.innerHeight - 100) return; // 太靠底=消息框

      const ph = (
        (el.placeholder || "") +
        " " +
        (el.getAttribute("aria-label") || "") +
        " " +
        (el.getAttribute("aria-placeholder") || "")
      ).trim();
      if (/通过 Messenger|Write a message/i.test(ph)) return;

      const role = el.getAttribute("role") || "";
      let score = base;
      if (/搜索|Search|对话|Conversation|客户|People/i.test(ph)) score += 20;
      if (role === "combobox" || role === "searchbox") score += 12;
      if ((el.value || "").length > 0) score += 8;
      if (r.width >= 60) score += 4;
      if (r.top < 260) score += 6;
      if (score > bestScore) {
        bestScore = score;
        bestInput = el;
      }
    };

    // 1) 从「管理」往左 elementFromPoint
    for (const manage of manageList) {
      const mr = manage.getBoundingClientRect();
      const cy = mr.top + mr.height / 2;
      for (let x = mr.left - 8; x > 45; x -= 10) {
        const hit = document.elementFromPoint(x, cy);
        if (!hit) continue;
        const input = findInputNear(hit);
        if (input) consider(input, 50);
      }
      for (const el of Array.from(
        document.querySelectorAll(
          "input, textarea, [role='combobox'], [role='searchbox']",
        ),
      )) {
        const use = useRect(el);
        if (Math.abs(use.top + use.height / 2 - cy) > 50) continue;
        if (use.right > mr.left + 20) continue;
        consider(el, 45);
      }
    }

    // 2) 「未读」筛选条上方 = 搜索行
    const unread = Array.from(document.querySelectorAll("div, span, button")).find(
      (el) => {
        const t = (el.textContent || "").replace(/\\s+/g, " ").trim();
        if (t !== "未读" && t !== "Unread") return false;
        const r = el.getBoundingClientRect();
        return r.left >= 40 && r.left < leftColMax && visible(el);
      },
    );
    if (unread) {
      const ur = unread.getBoundingClientRect();
      for (const el of Array.from(
        document.querySelectorAll(
          "input, textarea, [role='combobox'], [role='searchbox']",
        ),
      )) {
        const use = useRect(el);
        if (use.left < 40 || use.left > leftColMax) continue;
        if (use.bottom > ur.top + 8) continue;
        if (use.top < ur.top - 100) continue;
        consider(el, 42);
      }
    }

    // 3) 左栏所有 input 兜底（含 0 尺寸）
    for (const el of Array.from(
      document.querySelectorAll(
        "input, textarea, [role='combobox'], [role='searchbox']",
      ),
    )) {
      consider(el, 18);
    }

    if (!bestInput || bestScore < 16) return false;
    bestInput.setAttribute("data-inbox-search", "1");
    // 若自身不可点，给可点父级也打标，供点击用
    let clickable = bestInput;
    if (useRect(bestInput).width < 40) {
      let p = bestInput.parentElement;
      for (let i = 0; i < 5 && p; i++) {
        if (useRect(p).width >= 60) {
          clickable = p;
          break;
        }
        p = p.parentElement;
      }
    }
    clickable.setAttribute("data-inbox-search-hit", "1");
    return true;
  })()`);
}

/** 关掉「回复建议」浮层 —— 它长得像对话框正文，最容易被误点成输入框 */
async function dismissReplySuggestions(page: Page): Promise<void> {
  for (let round = 0; round < 2; round += 1) {
    const closed = await page.evaluate(`(() => {
      // 标题含「回复建议」的卡片，点右上角小 X
      const nodes = Array.from(document.querySelectorAll("div, span, h2, h3"));
      for (const el of nodes) {
        const t = (el.textContent || "").replace(/\\s+/g, " ").trim();
        if (!/^回复建议|^Reply suggestion/i.test(t) && !t.includes("回复建议 ·")) continue;
        const r = el.getBoundingClientRect();
        if (r.width < 40 || r.top < 150) continue;
        let root = el;
        for (let i = 0; i < 8 && root; i++) {
          const brRoot = root.getBoundingClientRect();
          if (brRoot.height > 420) {
            root = root.parentElement;
            continue;
          }
          const btns = Array.from(
            root.querySelectorAll(
              '[aria-label], div[role="button"], button, span[role="button"]',
            ),
          );
          for (const b of btns) {
            const label = (
              (b.getAttribute("aria-label") || "") +
              " " +
              (b.getAttribute("title") || "")
            ).trim();
            const br = b.getBoundingClientRect();
            if (br.width < 8 || br.height < 8 || br.width > 36 || br.height > 36) continue;
            const nearTopRight =
              br.top >= brRoot.top - 4 &&
              br.top <= brRoot.top + 48 &&
              br.left >= brRoot.left + brRoot.width * 0.7;
            if (
              /关闭|Close|Dismiss|移除/i.test(label) ||
              nearTopRight
            ) {
              b.click();
              return true;
            }
          }
          root = root.parentElement;
        }
      }
      return false;
    })()`);
    if (!closed) break;
    await page.waitForTimeout(350);
  }
}

/** 找不到搜索框时，轻量恢复：关浮层 + Escape，不再乱点坐标 */
async function recoverInboxSearchView(page: Page): Promise<void> {
  await dismissPopups(page);
  await dismissReplySuggestions(page);
  await page.keyboard.press("Escape").catch(() => undefined);
  await page.waitForTimeout(250);

  // 只点「所有消息」页签（精确一点），不要点 elementFromPoint
  const allMsg = page.locator("div, span, a").filter({ hasText: /^所有消息/ }).first();
  if (await allMsg.isVisible({ timeout: 600 }).catch(() => false)) {
    await allMsg.click({ force: true }).catch(() => undefined);
    await page.waitForTimeout(700);
  }

  await dismissPopups(page);
}

/** 整页空白 + 转圈（截图那种）：没有「管理/所有消息」，正文极短 */
async function isInboxBlankOrLoading(page: Page): Promise<boolean> {
  const blank = await page
    .evaluate(`(() => {
      const txt = ((document.body && document.body.innerText) || "").replace(/\\s+/g, "");
      const hasManage = /管理|Manage/.test(txt);
      const hasTabs = /所有消息|未读|Messenger|无法发送/.test(txt);
      if (hasManage || hasTabs) return false;
      if (txt.length < 100) return true;
      const loaders = document.querySelectorAll(
        '[role="progressbar"], [aria-busy="true"], svg[aria-label*="Loading"], svg[aria-label*="加载"]',
      );
      return loaders.length > 0 && txt.length < 240;
    })()`)
    .catch(() => false);
  return Boolean(blank);
}

function inboxUrlForPage(pageId: string): string {
  return (
    `https://business.facebook.com/latest/inbox/all/` +
    `?asset_id=${encodeURIComponent(pageId)}` +
    `&page_id=${encodeURIComponent(pageId)}` +
    `&mailbox_id=${encodeURIComponent(pageId)}`
  );
}

/** 空白/卡死时强制重开收件箱（比 Escape 有用） */
async function hardRecoverInbox(
  page: Page,
  pageId: string,
  pageName: string,
  log: (line: string) => void,
): Promise<void> {
  log(`  收件箱空白/转圈，强制重新打开「${pageName}」…`);
  const url = inboxUrlForPage(pageId);
  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 90_000 });
  } catch {
    await page
      .reload({ waitUntil: "domcontentloaded", timeout: 60_000 })
      .catch(() => undefined);
  }
  await page.waitForTimeout(1500);
  await dismissPopups(page);
  await waitForInboxReady(page, pageName, log);
}

/**
 * 确保能点到左栏搜索区。
 * 诊断已证明：搜索经常不是 DOM 里的 input，只能靠「管理」左侧坐标点进去。
 * 若整页空白转圈，会用 pageId 强制重开收件箱。
 */
async function ensureSearchAreaReady(
  page: Page,
  log?: (line: string) => void,
  recover?: { pageId: string; pageName: string },
): Promise<void> {
  const say = log ?? (() => undefined);
  await dismissPopups(page);
  for (let round = 0; round < 8; round += 1) {
    if (await clickInboxSearchArea(page)) return;

    const blank = await isInboxBlankOrLoading(page);
    if (blank && recover) {
      say(`  未找到「管理」且页面空白转圈，强制刷新收件箱…`);
      await hardRecoverInbox(page, recover.pageId, recover.pageName, say);
      continue;
    }

    if (round === 2 || round === 4) {
      say(`  未找到「管理」按钮，尝试恢复收件箱…`);
      await recoverInboxSearchView(page);
    } else if (round === 6 && recover) {
      say(`  轻量恢复无效，强制重新打开收件箱…`);
      await hardRecoverInbox(page, recover.pageId, recover.pageName, say);
    } else {
      await page.waitForTimeout(500);
    }
  }
  const detail = await diagnoseSearchUi(page).catch(() => "诊断失败");
  throw new Error(
    `找不到左栏搜索区（「管理」左边）。诊断：\n${detail}`,
  );
}

function normalizeSearchText(s: string): string {
  return (s || "").replace(/\s+/g, " ").trim().toLowerCase();
}

/** 若误把名字打进右侧「标签」，清掉，避免污染客户资料 */
async function clearAccidentalLabelInput(
  page: Page,
  customerName: string,
): Promise<boolean> {
  return page.evaluate(`((name) => {
    const vw = window.innerWidth || 1400;
    const leftMax = Math.min(720, vw * 0.48);
    const want = (name || "").replace(/\\s+/g, " ").trim().toLowerCase();
    let cleared = false;
    for (const el of Array.from(document.querySelectorAll("input, textarea"))) {
      const r = el.getBoundingClientRect();
      if (r.left <= leftMax) continue;
      const v = (el.value || "").replace(/\\s+/g, " ").trim();
      if (!v) continue;
      const vl = v.toLowerCase();
      if (vl !== want && !vl.includes(want) && !want.includes(vl)) continue;
      el.focus();
      el.value = "";
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
      el.blur();
      cleared = true;
    }
    return cleared;
  })(${JSON.stringify(customerName)})`);
}

/** 确认焦点在左栏搜索框上，避免打字打进右侧标签 */
async function ensureInboxSearchFocused(
  page: Page,
  search: Locator,
): Promise<boolean> {
  // Escape 打断右侧标签焦点；不要盲点固定坐标（容易点飞左栏）
  await page.keyboard.press("Escape").catch(() => undefined);
  await page.waitForTimeout(80);
  await markInboxConversationSearch(page).catch(() => false);

  try {
    await search.click({ timeout: 2500 });
  } catch {
    await search.click({ force: true, timeout: 2000 }).catch(() => undefined);
  }
  await page.waitForTimeout(100);

  const ok = await page.evaluate(`(() => {
    const input = document.querySelector("[data-inbox-search='1']");
    if (!input) return false;
    const active = document.activeElement;
    if (active === input) return true;
    if (input.contains && input.contains(active)) return true;
    input.focus();
    return document.activeElement === input;
  })()`);
  return Boolean(ok);
}

/** 只往左栏搜索框里写字，绝不使用全局 keyboard.type（会打进右侧标签） */
async function typeIntoInboxSearch(
  page: Page,
  search: Locator,
  customerName: string,
): Promise<void> {
  await markInboxConversationSearch(page).catch(() => false);
  await ensureInboxSearchFocused(page, search);

  // 优先 fill（绑定到 locator），再 pressSequentially；禁止 page.keyboard.type
  try {
    await search.fill("");
    await search.fill(customerName, { force: true, timeout: 4000 });
  } catch {
    await ensureInboxSearchFocused(page, search);
    await search.pressSequentially(customerName, { delay: 35 }).catch(async () => {
      // 最后：在已标记的 input 上直接设 value + 派发 input（仍不碰全局键盘）
      await page.evaluate(`((name) => {
        const input = document.querySelector("[data-inbox-search='1']");
        if (!input) return;
        input.focus();
        const proto = Object.getPrototypeOf(input);
        const desc = Object.getOwnPropertyDescriptor(proto, "value");
        if (desc && desc.set) desc.set.call(input, name);
        else input.value = name;
        input.dispatchEvent(new Event("input", { bubbles: true }));
        input.dispatchEvent(new Event("change", { bubbles: true }));
      })(${JSON.stringify(customerName)})`);
    });
  }
}

/** 尽量清空左栏搜索（点 X + 全选删除），避免叠字成「Marty Marty」 */
async function hardClearInboxSearch(page: Page): Promise<void> {
  await clickSearchClearXByManage(page);
  await clickInboxSearchArea(page);
  await page.keyboard.press("Control+A").catch(() => undefined);
  await page.keyboard.press("Backspace").catch(() => undefined);
  await page.keyboard.press("Delete").catch(() => undefined);
  await page.waitForTimeout(150);
  // 再点一次 X：Meta 有时第一次清不掉
  await clickSearchClearXByManage(page);
  await page.waitForTimeout(100);
}

/** 点「管理」左边搜索区 → 清旧字 → 键盘输入客户名（只打一遍） */
async function focusAndFillSearch(
  page: Page,
  customerName: string,
  log: (line: string) => void = () => undefined,
  recover?: { pageId: string; pageName: string },
): Promise<void> {
  await dismissPopups(page);
  await ensureSearchAreaReady(page, log, recover);

  await hardClearInboxSearch(page);
  await clickInboxSearchArea(page);
  await page.waitForTimeout(100);

  // 确认焦点不在右栏标签，再打字
  const inRight = await page.evaluate(`(() => {
    const a = document.activeElement;
    if (!a) return false;
    const r = a.getBoundingClientRect();
    return r.left > window.innerWidth * 0.55;
  })()`);
  if (inRight) {
    await page.keyboard.press("Escape").catch(() => undefined);
    await clickInboxSearchArea(page);
  }

  // 只打一遍；禁止「清不干净又 type」叠成双名
  await page.keyboard.type(customerName, { delay: 35 });
  await page.waitForTimeout(400);

  // 若误入右侧标签：只清标签，左栏若已有正确名字则不再重打
  const leaked = await clearAccidentalLabelInput(page, customerName);
  if (leaked) {
    log(`  ⚠ 名字误入右侧标签，已清除`);
    const leftVal = await currentSearchValue(page);
    if (normalizeSearchText(leftVal) !== normalizeSearchText(customerName)) {
      log(`  左栏搜索不完整，清空后重输一次…`);
      await hardClearInboxSearch(page);
      await clickInboxSearchArea(page);
      await page.keyboard.type(customerName, { delay: 40 });
      await page.waitForTimeout(400);
    }
  }
}

/** 等待左侧出现该客户搜索结果 */
async function waitForSearchResultVisible(
  page: Page,
  customerName: string,
  timeoutMs = 7000,
): Promise<boolean> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const byEval = await page.evaluate(`((name) => {
      const nodes = Array.from(document.querySelectorAll("div, span, a, li, [role='option'], [role='row']"));
      for (const el of nodes) {
        const r = el.getBoundingClientRect();
        if (r.left < 100 || r.left > 720) continue;
        if (r.width < 24 || r.height < 12) continue;
        const lines = (el.innerText || "")
          .split("\\n")
          .map((s) => s.trim())
          .filter(Boolean);
        if (lines[0] === name) return true;
        const t = (el.textContent || "").replace(/\\s+/g, " ").trim();
        if (t === name) return true;
      }
      return false;
    })(${JSON.stringify(customerName)})`);
    if (byEval) return true;

    const exact = page.getByText(customerName, { exact: true });
    const n = await exact.count().catch(() => 0);
    for (let i = 0; i < Math.min(n, 10); i += 1) {
      const box = await exact.nth(i).boundingBox().catch(() => null);
      if (box && box.x >= 100 && box.x < 720 && box.y > 80) return true;
    }
    await page.waitForTimeout(400);
  }
  return false;
}

/** 发完/跳过一位后：点搜索旁 X，准备下一位 */
async function prepareSearchForNext(
  page: Page,
  log: (line: string) => void,
  recover?: { pageId: string; pageName: string },
): Promise<void> {
  await dismissPopups(page);
  await clearSearchWithX(page, log);
  // 确认还能点到「管理」左边；点不到再恢复；空白转圈则强制重开
  if (!(await locateLeftManageButton(page))) {
    if (recover && (await isInboxBlankOrLoading(page))) {
      log(`  未看到「管理」且页面空白，强制重开收件箱…`);
      await hardRecoverInbox(page, recover.pageId, recover.pageName, log);
    } else {
      log(`  未看到「管理」，恢复收件箱视图…`);
      await recoverInboxSearchView(page);
      if (
        recover &&
        !(await locateLeftManageButton(page)) &&
        (await isInboxBlankOrLoading(page))
      ) {
        await hardRecoverInbox(page, recover.pageId, recover.pageName, log);
      }
    }
  }
  await page.waitForTimeout(300);
}

/** 读取中间栏会话标题（必须全名相等，避免点了搜索结果但右边还是老客户） */
async function readOpenConversationName(page: Page): Promise<string> {
  return page.evaluate(`(() => {
    const nodes = Array.from(document.querySelectorAll("h1, h2, span, a, div"));
    let best = "";
    let bestScore = -1;
    for (const el of nodes) {
      const r = el.getBoundingClientRect();
      if (r.width < 30 || r.height < 12 || r.height > 48) continue;
      // 中间栏顶部标题区（避开左侧列表、右侧资料）
      if (r.left < 380 || r.left > 920) continue;
      if (r.top < 48 || r.top > 140) continue;
      const t = (el.textContent || "").replace(/\\s+/g, " ").trim();
      if (!t || t.length < 2 || t.length > 60) continue;
      // 排除角标「新」、筛选条、功能文案、日期、气泡/建议误读
      if (/^新+$/.test(t)) continue;
      if (/^\\d{4}年|上午|下午|\\d{1,2}:\\d{2}/.test(t)) continue;
      if (/^(hi|hello|ok|yes|no)[.!]?$/i.test(t)) continue;
      if (/Please confirm|reviewing patient|回复建议|点击即可|Reply HOLD|RELEASE to cancel|Pending records|follow-up|Honey u there|keep it active/i.test(t)) continue;
      if (t.length > 40 && !/^[A-Z][a-z]+(?: [A-Z][a-zA-Z'’-]+)+$/.test(t)) continue;
      if (/分配这个对话|Assign|收件箱|Messenger|回复|搜索|未读|管理|优先级|广告|跟进|WhatsApp|Instagram|所有消息|Facebook/.test(t)) continue;
      if (el.children.length > 2) continue;
      let score = 0;
      if (r.top >= 56 && r.top <= 110) score += 12;
      if (el.tagName === "H1" || el.tagName === "H2" || el.tagName === "SPAN") score += 6;
      if (/\\s/.test(t)) score += 8; // 英文名通常有空格
      score += Math.min(t.length, 20);
      if (score > bestScore) {
        bestScore = score;
        best = t;
      }
    }
    return best;
  })()`);
}

async function waitUntilConversationIs(
  page: Page,
  customerName: string,
  timeoutMs = 9000,
): Promise<boolean> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    // 优先右侧资料栏名字（中间标题常误读成气泡文案）
    const right = await page.evaluate(`((name) => {
      const nodes = Array.from(document.querySelectorAll("span, div, a, h2"));
      for (const el of nodes) {
        const r = el.getBoundingClientRect();
        if (r.left < 900) continue;
        if (r.top > 280) continue;
        const t = (el.textContent || "").replace(/\\s+/g, " ").trim();
        if (t === name) return true;
      }
      return false;
    })(${JSON.stringify(customerName)})`);
    if (right) return true;

    const title = await readOpenConversationName(page);
    if (title === customerName) return true;
    await page.waitForTimeout(350);
  }
  return false;
}

/**
 * 点击左侧搜索结果中的客户（第一行全名精确匹配，多个取最上）。
 * 用 Playwright 真实点击，避免 DOM click 不切换会话。
 */
async function clickCustomerName(
  page: Page,
  customerName: string,
  prefer: "user" | "messenger",
): Promise<boolean> {
  await dismissPopups(page);

  const marked = await page.evaluate(`((name, prefer) => {
    document.querySelectorAll("[data-cust-hit]").forEach((e) => e.removeAttribute("data-cust-hit"));
    const bad = /对话内搜索|Search in Messenger|以后再说|绑定 Instagram|创建订单/i;
    const nodes = Array.from(
      document.querySelectorAll(
        '[role="option"], [role="listitem"], [role="row"], [role="button"], a, div, li',
      ),
    );
    const matches = [];
    for (const el of nodes) {
      const r = el.getBoundingClientRect();
      if (r.width < 40 || r.height < 18) continue;
      if (r.left < 100 || r.left > 700) continue;
      if (r.height > 180) continue;
      const raw = (el.innerText || "").trim();
      if (!raw || bad.test(raw)) continue;
      const lines = raw.split("\\n").map((s) => s.trim()).filter(Boolean);
      if ((lines[0] || "") !== name) continue;
      const isMessengerRow = /你:|You:|ad_id/i.test(raw) || lines.length >= 2;
      matches.push({ el, top: r.top, h: r.height, isMessengerRow });
    }
    if (!matches.length) return false;
    matches.sort((a, b) => {
      if (prefer === "messenger") {
        if (a.isMessengerRow !== b.isMessengerRow) return a.isMessengerRow ? -1 : 1;
      } else {
        if (a.isMessengerRow !== b.isMessengerRow) return a.isMessengerRow ? 1 : -1;
      }
      if (Math.abs(a.top - b.top) > 8) return a.top - b.top;
      return a.h - b.h;
    });
    matches[0].el.setAttribute("data-cust-hit", "1");
    matches[0].el.scrollIntoView({ block: "center", inline: "nearest" });
    return true;
  })(${JSON.stringify(customerName)}, ${JSON.stringify(prefer)})`);

  if (!marked) {
    // Playwright 精确文本兜底（左侧栏）
    const exact = page.getByText(customerName, { exact: true });
    const n = await exact.count().catch(() => 0);
    for (let i = 0; i < Math.min(n, 8); i += 1) {
      const hit = exact.nth(i);
      const box = await hit.boundingBox().catch(() => null);
      if (!box || box.x < 100 || box.x > 700) continue;
      await hit.scrollIntoViewIfNeeded().catch(() => undefined);
      await hit.click({ force: true, timeout: 3000 }).catch(() => undefined);
      return true;
    }
    return false;
  }

  const hit = page.locator("[data-cust-hit='1']").first();
  await hit.click({ force: true, timeout: 4000 }).catch(async () => {
    await hit.click({ timeout: 4000 });
  });
  return true;
}

/**
 * 那个「X」在 搜索输入框 与 「管理」按钮 之间的空档里。
 * 不同布局下，X 可能压在输入框右端内侧，也可能在输入框右边缘外。
 * 这里返回若干候选点坐标（从最可能到次可能），逐个真实鼠标点击尝试。
 */
async function locateClearXPoints(
  page: Page,
): Promise<Array<{ x: number; y: number }>> {
  await markInboxConversationSearch(page).catch(() => false);
  const points = await page.evaluate(`(() => {
    const input =
      document.querySelector("[data-inbox-search='1']") ||
      document.querySelector('input[placeholder*="搜索"]') ||
      document.querySelector('input[placeholder*="Search"]') ||
      document.querySelector('input[role="combobox"]');
    if (!input) return [];
    const ir = input.getBoundingClientRect();
    const cy = ir.top + ir.height / 2;

    // 找同一行、在输入框右侧的「管理 / Manage」，作为 X 的右边界
    let manageLeft = ir.right + 120;
    const all = Array.from(document.querySelectorAll("div, span, button, a"));
    for (const el of all) {
      const t = (el.textContent || "").replace(/\\s+/g, " ").trim();
      if (t !== "管理" && t !== "Manage") continue;
      const r = el.getBoundingClientRect();
      if (Math.abs(r.top + r.height / 2 - cy) > 40) continue;
      if (r.left < ir.right - 10) continue;
      manageLeft = Math.min(manageLeft, r.left);
    }

    const out = [];
    const push = (x, y, prio) => out.push({ x, y, prio });

    // 1) 带清除语义 aria-label 的按钮（最可靠）
    const labeled = Array.from(
      document.querySelectorAll('[aria-label], [role="button"], button'),
    );
    for (const b of labeled) {
      const label = (
        (b.getAttribute("aria-label") || "") + " " + (b.getAttribute("title") || "")
      ).trim();
      if (!/清除|清空|Clear|移除|Remove/i.test(label)) continue;
      const r = b.getBoundingClientRect();
      if (r.width < 6 || r.height < 6 || r.width > 48 || r.height > 48) continue;
      if (Math.abs(r.top + r.height / 2 - cy) > 30) continue;
      const bx = r.left + r.width / 2;
      if (bx < ir.left) continue;
      push(bx, r.top + r.height / 2, 100);
    }

    // 2) 输入框右端与管理之间的小图标/按钮
    const cands = Array.from(
      document.querySelectorAll(
        'div[role="button"], button, span[role="button"], svg, i[data-visualcompletion="css-img"], [aria-label]',
      ),
    );
    for (const b of cands) {
      const r = b.getBoundingClientRect();
      if (r.width < 6 || r.height < 6 || r.width > 44 || r.height > 44) continue;
      if (Math.abs(r.top + r.height / 2 - cy) > 24) continue;
      const bx = r.left + r.width / 2;
      // 在输入框右半区 ~ 管理左边缘之间
      if (bx < ir.left + ir.width * 0.5) continue;
      if (bx > manageLeft - 2) continue;
      push(bx, cy, 60);
    }

    // 3) 几何兜底点：空档中心、输入框右内侧、右外侧
    const gap = manageLeft - ir.right;
    if (gap > 18) push(ir.right + gap / 2, cy, 40);
    push(ir.right - 16, cy, 30);
    push(ir.right + 12, cy, 20);

    // 去重 + 按优先级
    out.sort((a, b) => b.prio - a.prio);
    const dedup = [];
    for (const p of out) {
      if (dedup.some((q) => Math.abs(q.x - p.x) < 8 && Math.abs(q.y - p.y) < 8)) continue;
      dedup.push(p);
      if (dedup.length >= 6) break;
    }
    return dedup.map((p) => ({ x: p.x, y: p.y }));
  })()`);
  return (points as Array<{ x: number; y: number }>) || [];
}

/** 搜索框边上的 X：优先按「管理」左侧坐标点（截图上的那个灰 X） */
async function clearSearchWithX(page: Page, log: (line: string) => void): Promise<void> {
  // 1) 坐标点 X（最可靠）
  if (await clickSearchClearXByManage(page)) {
    log(`  已点搜索框旁 X 清空`);
    await dismissPopups(page);
    return;
  }

  // 2) 旧逻辑：按 input 找 X
  const points = await locateClearXPoints(page);
  for (const p of points) {
    await page.mouse.click(p.x, p.y).catch(() => undefined);
    await page.waitForTimeout(300);
  }

  // 3) 键盘兜底
  if (await clickInboxSearchArea(page)) {
    await page.keyboard.press("Control+A").catch(() => undefined);
    await page.keyboard.press("Backspace").catch(() => undefined);
    log(`  已清空搜索（键盘兜底）`);
  } else {
    log(`  ⚠ 未能定位搜索清空按钮`);
  }
  await page.waitForTimeout(200);
  await dismissPopups(page);
}

/** 只读左栏收件箱搜索框文字（绝不读右侧标签） */
async function currentSearchValue(page: Page): Promise<string> {
  await markInboxConversationSearch(page).catch(() => false);
  const v = await page.evaluate(`(() => {
    const marked = document.querySelector("[data-inbox-search='1']");
    if (marked && "value" in marked) return (marked.value || "").trim();

    // 标记失败时的几何兜底：左栏、偏上的 combobox/搜索 input
    const vw = window.innerWidth || 1400;
    const leftColMax = Math.min(700, Math.max(420, vw * 0.42));
    let best = null;
    let bestScore = -1;
    for (const el of Array.from(
      document.querySelectorAll(
        "input, textarea, [role='combobox'], [role='searchbox']",
      ),
    )) {
      if (el.type === "hidden" || el.disabled) continue;
      const r = el.getBoundingClientRect();
      if (r.left < 56 || r.left > leftColMax) continue;
      if (r.top < 70 || r.top > 360) continue;
      if (r.width < 40) continue;
      const ph = (el.placeholder || el.getAttribute("aria-label") || "").trim();
      let score = r.width;
      if (/搜索|Search/i.test(ph)) score += 200;
      if ((el.value || "").length) score += 50;
      if (score > bestScore) {
        bestScore = score;
        best = el;
      }
    }
    return best ? (best.value || "").trim() : "";
  })()`);
  return (v as string) || "";
}

/**
 * 人工流程：搜索 → 点名字 → 再点 → 直到右侧标题变成该客户
 */
async function openConversationByName(
  page: Page,
  customerName: string,
  log: (line: string) => void,
  recover?: { pageId: string; pageName: string },
): Promise<void> {
  await dismissPopups(page);

  let foundInSearch = false;
  for (let trySearch = 0; trySearch < 5; trySearch += 1) {
    await focusAndFillSearch(page, customerName, log, recover);
    foundInSearch = await waitForSearchResultVisible(
      page,
      customerName,
      2500 + trySearch * 800,
    );
    if (foundInSearch) break;

    log(`  搜索结果未出现，重试输入（${trySearch + 1}）…`);
    await clearSearchWithX(page, () => undefined);
    await page.waitForTimeout(400);
  }

  if (!foundInSearch) {
    throw new Error(`搜索未找到客户：${customerName}`);
  }

  for (let round = 1; round <= 5; round += 1) {
    const prefer = round <= 2 ? (round === 1 ? "user" : "messenger") : "messenger";
    const clicked = await clickCustomerName(page, customerName, prefer);
    if (!clicked && round === 1) {
      throw new Error(`搜索未找到可点击结果：${customerName}`);
    }
    if (clicked) {
      log(`  第${round}次点击客户名${prefer === "messenger" ? "（会话）" : ""}`);
    }
    await page.waitForTimeout(1400);
    await dismissPopups(page);

    if (await waitUntilConversationIs(page, customerName, 4000)) {
      log(`  已打开会话：${customerName}`);
      await page.waitForTimeout(1000);
      return;
    }

    const now = await readOpenConversationName(page);
    log(`  右侧仍是「${now || "未知"}」，继续点击…`);
  }

  const now = await readOpenConversationName(page);
  throw new Error(
    `未能切换到客户「${customerName}」（右侧仍是「${now || "未知"}」）`,
  );
}

/** 每个主页只调用一次：打开该主页收件箱 */
async function openInbox(
  page: Page,
  pageId: string,
  pageName: string,
  log: (line: string) => void,
): Promise<void> {
  const url = inboxUrlForPage(pageId);

  log(`  打开主页收件箱：${pageName} (${pageId})`);

  // 多标签并发加载时容易卡在转圈：goto 失败/超时就重试几次
  let loaded = false;
  for (let attempt = 1; attempt <= 3 && !loaded; attempt += 1) {
    try {
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 90_000 });
      loaded = true;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log(`  收件箱加载超时（第${attempt}次）：${msg.slice(0, 60)}，重试…`);
      await page.waitForTimeout(2000);
      await page.reload({ waitUntil: "domcontentloaded", timeout: 60_000 }).catch(
        () => undefined,
      );
    }
  }

  await dismissPopups(page);

  // 等收件箱 UI 真正就绪（能看到「管理/所有消息」），卡住则刷新
  await waitForInboxReady(page, pageName, log);

  let finalUrl = page.url();
  if (!finalUrl.includes(pageId)) {
    log(`  URL 未带上 page_id，尝试资产列表切换…`);
    await switchPageByUi(page, pageName, pageId, log);
    await page.waitForTimeout(3000);
    finalUrl = page.url();
  }

  if (!finalUrl.includes(pageId)) {
    throw new Error(
      `未能打开主页「${pageName}」收件箱。当前 URL: ${finalUrl.slice(0, 120)}`,
    );
  }
  log(`  已进入收件箱（本页后续只搜索客户，不再切主页）`);
}

/** 收件箱是否已渲染出可用 UI（有「管理」或「所有消息」页签、且非空白转圈页） */
async function isInboxUiReady(page: Page): Promise<boolean> {
  const ready = await page
    .evaluate(`(() => {
      const txt = (document.body && document.body.innerText) || "";
      const hasTabs = /所有消息|Messenger/.test(txt);
      const hasManage = /管理|Manage/.test(txt);
      // 页面几乎空白（只有骨架/转圈）时 innerText 很短
      const enough = txt.replace(/\\s+/g, "").length > 40;
      return (hasTabs || hasManage) && enough;
    })()`)
    .catch(() => false);
  return Boolean(ready);
}

/** 等收件箱 UI 就绪；久了没出来就刷新，最多几轮 */
async function waitForInboxReady(
  page: Page,
  pageName: string,
  log: (line: string) => void,
): Promise<void> {
  const perTryMs = 18_000;
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    const end = Date.now() + perTryMs;
    while (Date.now() < end) {
      if (await isInboxUiReady(page)) {
        if (attempt > 1) log(`  收件箱已恢复正常显示`);
        return;
      }
      await page.waitForTimeout(800);
    }
    log(`  「${pageName}」疑似卡在空白转圈（第${attempt}次），刷新页面…`);
    await page
      .reload({ waitUntil: "domcontentloaded", timeout: 90_000 })
      .catch(() => undefined);
    await page.waitForTimeout(2500);
    await dismissPopups(page);
  }
  // 兜底：即便未确认就绪，也继续走后续（可能只是文案匹配不到）
  log(`  ⚠「${pageName}」多次刷新仍未确认加载完成，继续尝试后续步骤`);
}

async function switchPageByUi(
  page: Page,
  pageName: string,
  pageId: string,
  log: (line: string) => void,
): Promise<void> {
  try {
    const top = page.locator('[role="banner"] div[role="button"]').first();
    if (await top.isVisible({ timeout: 2000 }).catch(() => false)) {
      await top.click();
      await page.waitForTimeout(1500);
    }

    const other = page
      .getByText(/其他资产|Other assets|สินทรัพย์อื่นๆ|企业资产|业务资产/i)
      .first();
    if (await other.isVisible({ timeout: 2000 }).catch(() => false)) {
      await other.click();
      await page.waitForTimeout(1500);
    }

    const radio = page
      .locator('[role="radio"]')
      .filter({ hasText: new RegExp(escapeRegExp(pageName), "i") })
      .first();
    if (await radio.isVisible({ timeout: 3000 }).catch(() => false)) {
      await radio.click();
      await page.waitForTimeout(2500);
      log(`  已点选资产「${pageName}」`);
      return;
    }

    await page.goto(
      `https://business.facebook.com/latest/inbox/all/?asset_id=${pageId}&page_id=${pageId}`,
      { waitUntil: "domcontentloaded", timeout: 120_000 },
    );
  } catch (err) {
    log(`  界面切换失败: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** FB 提示无法再发送时抛出，上层跳过并写入黑名单 */
export class CannotSendToUserError extends Error {
  readonly code = "CANNOT_SEND" as const;
  constructor(customerName: string) {
    super(`无法再向该用户发送消息：${customerName}`);
    this.name = "CannotSendToUserError";
  }
}

async function isCannotSendBannerVisible(page: Page): Promise<boolean> {
  return page.evaluate(`(() => {
    const re = /你无法再向这位用户发送消息|无法再向这位用户发送消息|can't send messages to this user|You can no longer send messages/i;
    const els = Array.from(document.querySelectorAll("div, span, p"));
    for (const el of els) {
      const t = (el.textContent || "").replace(/\\s+/g, " ").trim();
      if (!re.test(t)) continue;
      // 只要含关键句即可；整段可能带「详细了解」
      if (t.length > 160) continue;
      const r = el.getBoundingClientRect();
      if (r.width < 40 || r.height < 8) continue;
      if (r.left < 280) continue;
      // 一般在会话底部输入区位置
      if (r.top < 200) continue;
      return true;
    }
    return false;
  })()`);
}

async function assertConversationOpen(
  page: Page,
  customerName: string,
): Promise<void> {
  await dismissPopups(page);
  await page.waitForTimeout(500);

  if (!(await waitUntilConversationIs(page, customerName, 5000))) {
    const now = await readOpenConversationName(page);
    throw new Error(
      `会话未切换成功：目标「${customerName}」，右侧仍是「${now || "未知"}」`,
    );
  }

  // 先看是否「无法再发送」——有就直接黑名单，不必找输入框
  if (await isCannotSendBannerVisible(page)) {
    throw new CannotSendToUserError(customerName);
  }
}

/**
 * 直接点底部「通过 Messenger 回复…」。
 * 能点到就输入；点不到再看是不是无法发送。不关回复建议。
 */
async function findComposer(page: Page, customerName = "") {
  await dismissPopups(page);

  // 1) 直接点占位文案
  const hint = page.getByText(/通过 Messenger 回复/i).first();
  if (await hint.isVisible({ timeout: 1500 }).catch(() => false)) {
    const box = await hint.boundingBox().catch(() => null);
    if (box && box.x >= 300 && box.y > 200) {
      await page.mouse.click(box.x + Math.min(box.width * 0.4, 120), box.y + box.height / 2);
      await page.waitForTimeout(200);
    }
  }

  // 2) 标记底部 textbox / contenteditable
  const marked = await page.evaluate(`(() => {
    document
      .querySelectorAll("[data-msg-composer]")
      .forEach((e) => e.removeAttribute("data-msg-composer"));
    const vh = window.innerHeight || 900;
    let best = null;
    let bestScore = -1;
    for (const el of Array.from(
      document.querySelectorAll(
        '[contenteditable="true"], [role="textbox"], textarea, div[role="textbox"]',
      ),
    )) {
      const r = el.getBoundingClientRect();
      if (r.width < 80 || r.height < 14) continue;
      if (r.left < 300 || r.left > 1100) continue;
      if (r.bottom < vh - 220) continue;
      const ph = (
        (el.getAttribute("aria-label") || "") +
        " " +
        (el.getAttribute("aria-placeholder") || "") +
        " " +
        (el.getAttribute("data-placeholder") || "") +
        " " +
        (el.getAttribute("placeholder") || "")
      );
      let score = 10 + Math.min(r.width / 40, 10);
      if (/Messenger|回复/i.test(ph)) score += 50;
      if (r.bottom > vh - 80) score += 20;
      if (score > bestScore) {
        bestScore = score;
        best = el;
      }
    }
    // 占位文字节点
    if (!best || bestScore < 20) {
      for (const el of Array.from(document.querySelectorAll("div, span, p"))) {
        const t = (el.textContent || "").replace(/\\s+/g, " ").trim();
        if (!/^通过 Messenger 回复/.test(t)) continue;
        const r = el.getBoundingClientRect();
        if (r.left < 300 || r.bottom < vh - 220) continue;
        let p = el;
        for (let i = 0; i < 8 && p; i++) {
          if (
            p.getAttribute("contenteditable") === "true" ||
            p.getAttribute("role") === "textbox"
          ) {
            best = p;
            bestScore = 80;
            break;
          }
          p = p.parentElement;
        }
        if (bestScore >= 80) break;
      }
    }
    if (!best) return false;
    best.setAttribute("data-msg-composer", "1");
    return true;
  })()`);

  if (marked) {
    const el = page.locator("[data-msg-composer='1']").first();
    if ((await el.count()) > 0) return el;
  }

  if (await isCannotSendBannerVisible(page)) {
    throw new CannotSendToUserError(customerName || "未知客户");
  }
  throw new Error("找不到底部「通过 Messenger 回复」");
}

async function readComposerText(page: Page, composer: Locator): Promise<string> {
  const fromLoc =
    ((await composer.innerText().catch(() => "")) || "").trim() ||
    ((await composer.inputValue().catch(() => "")) || "").trim();
  if (fromLoc) return fromLoc;
  return page.evaluate(`(() => {
    const el =
      document.querySelector("[data-msg-composer='1']") ||
      document.activeElement;
    if (!el) return "";
    if ("value" in el && el.value) return String(el.value).trim();
    return ((el.innerText || el.textContent) || "").trim();
  })()`);
}

async function typeMessage(
  page: Page,
  text: string,
  customerName = "",
): Promise<void> {
  await dismissPopups(page);

  // 无法发送 → 交给上层进黑名单
  if (await isCannotSendBannerVisible(page)) {
    throw new CannotSendToUserError(customerName || "未知客户");
  }

  const composer = await findComposer(page, customerName);
  const box = await composer.boundingBox().catch(() => null);
  if (box) {
    await page.mouse.click(
      box.x + Math.min(box.width * 0.35, 100),
      box.y + box.height / 2,
    );
  } else {
    await composer.click({ timeout: 3000 }).catch(() => undefined);
  }
  await page.waitForTimeout(200);

  try {
    await composer.fill(text, { timeout: 4000 });
  } catch {
    await page.keyboard.press("Control+A").catch(() => undefined);
    await page.keyboard.press("Backspace").catch(() => undefined);
    await page.keyboard.type(text, { delay: 30 });
  }
  await page.waitForTimeout(350);

  let written = await readComposerText(page, composer);
  if (
    !written ||
    (!written.includes(text) &&
      written.replace(/\s+/g, "") !== text.replace(/\s+/g, ""))
  ) {
    // 再试一次点「通过 Messenger 回复」
    const hint = page.getByText(/通过 Messenger 回复/i).first();
    if (await hint.isVisible({ timeout: 800 }).catch(() => false)) {
      await hint.click({ force: true }).catch(() => undefined);
      await page.keyboard.type(text, { delay: 35 });
      await page.waitForTimeout(300);
      written = await readComposerText(page, composer);
    }
  }

  // 输入失败时再确认是不是无法发送
  if (
    !written ||
    (!written.includes(text) &&
      written.replace(/\s+/g, "") !== text.replace(/\s+/g, ""))
  ) {
    if (await isCannotSendBannerVisible(page)) {
      throw new CannotSendToUserError(customerName || "未知客户");
    }
    throw new Error(
      `未能写入「通过 Messenger 回复」（当前: ${JSON.stringify((written || "").slice(0, 40))}）`,
    );
  }
}

/** 统计会话区中文案出现次数（尽量只计气泡叶子节点） */
async function countMessageBubbles(page: Page, text: string): Promise<number> {
  return page.evaluate(`((msg) => {
    let count = 0;
    const nodes = Array.from(document.querySelectorAll("div, span"));
    for (const el of nodes) {
      const t = (el.textContent || "").trim();
      if (t !== msg) continue;
      if (el.closest("[data-msg-composer='1']")) continue;
      if (el.isContentEditable) continue;
      const childSame = Array.from(el.children).some(
        (c) => ((c.textContent || "").trim() === msg),
      );
      if (childSame) continue;
      const r = el.getBoundingClientRect();
      if (r.left < 380 || r.left > 1300) continue;
      if (r.top < 120 || r.top > window.innerHeight - 60) continue;
      if (r.width < 12 || r.width > 560) continue;
      if (r.height < 10 || r.height > 160) continue;
      count += 1;
    }
    return count;
  })(${JSON.stringify(text)})`);
}

async function clickSend(page: Page, composer?: Locator): Promise<void> {
  if (composer) {
    const left = await readComposerText(page, composer);
    if (!left) {
      throw new Error("发送前输入框已空");
    }
    await composer.click({ force: true }).catch(() => undefined);
    await composer.focus().catch(() => undefined);
    await page.waitForTimeout(200);
  } else {
    const fallback = page.locator("[data-msg-composer='1']").first();
    if ((await fallback.count().catch(() => 0)) > 0) {
      await fallback.click({ force: true }).catch(() => undefined);
      await page.waitForTimeout(150);
    }
  }

  // 回车发送（你已确认可用）
  await page.keyboard.press("Enter");
  await page.waitForTimeout(800);

  const still = await page.evaluate(`(() => {
    const el = document.querySelector("[data-msg-composer='1']");
    if (!el) return false;
    return ((el.innerText || el.textContent) || "").trim().length > 0;
  })()`);

  if (still) {
    await page.keyboard.press("Enter");
    await page.waitForTimeout(600);
  }

  const still2 = await page.evaluate(`(() => {
    const el = document.querySelector("[data-msg-composer='1']");
    if (!el) return false;
    return ((el.innerText || el.textContent) || "").trim().length > 0;
  })()`);

  if (still2) {
    const btn = page.getByRole("button", { name: /^发送$/ }).first();
    if (await btn.isVisible({ timeout: 1000 }).catch(() => false)) {
      await btn.click({ force: true }).catch(() => undefined);
      await page.waitForTimeout(600);
    }
  }
}

/**
 * 必须看到「比发送前多一条」同样文案的气泡，才算成功。
 * 避免把聊天里旧的 hello（例如 5:08 那条）误判成刚发出。
 */
async function verifySent(
  page: Page,
  text: string,
  countBefore: number,
): Promise<void> {
  for (let attempt = 0; attempt < 12; attempt += 1) {
    await page.waitForTimeout(700);
    const countAfter = await countMessageBubbles(page, text);
    if (countAfter > countBefore) return;

    const stillInBox = await page.evaluate(`((msg) => {
      const el = document.querySelector("[data-msg-composer='1']");
      if (!el) return false;
      const left = ((el.innerText || el.textContent) || "").trim();
      return left === msg || left.indexOf(msg) >= 0;
    })(${JSON.stringify(text)})`);

    if (stillInBox && attempt === 4) {
      await page.keyboard.press("Enter").catch(() => undefined);
    }
  }

  const countAfter = await countMessageBubbles(page, text);
  throw new Error(
    `发送未确认：发送前气泡 ${countBefore} 条，发送后仍是 ${countAfter} 条（可能点到旧消息）`,
  );
}

async function attachImage(page: Page, imagePath: string): Promise<void> {
  await access(imagePath);

  const fileInputs = page.locator('input[type="file"]');
  const count = await fileInputs.count();
  if (count > 0) {
    await fileInputs.last().setInputFiles(imagePath);
    await page.waitForTimeout(1500);
    return;
  }

  const attachBtn = page
    .locator('[aria-label*="附加"], [aria-label*="Attach"], [aria-label*="添加文件"]')
    .first();
  if (await attachBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
    const [fileChooser] = await Promise.all([
      page.waitForEvent("filechooser", { timeout: 10_000 }),
      attachBtn.click(),
    ]);
    await fileChooser.setFiles(imagePath);
    await page.waitForTimeout(1500);
    return;
  }

  throw new Error("找不到图片上传入口");
}

/** 已在该主页收件箱内时，只搜客户并发送（或只定位） */
export async function sendOneMessage(
  page: Page,
  target: SendTarget,
  options: SendOptions = {},
): Promise<{ ok: boolean; error?: string; skippedBlacklist?: boolean }> {
  const runtime = await getRuntimeConfig();
  const text = options.text ?? runtime.messageText;
  const imagePath = options.imagePath ?? runtime.messageImagePath;
  const log = options.onLog ?? (() => undefined);

  const recover = { pageId: target.pageId, pageName: target.pageName };

  try {
    await openConversationByName(page, target.customerName, log, recover);
    await assertConversationOpen(page, target.customerName);

    if (options.dryRun) {
      await prepareSearchForNext(page, log, recover);
      return { ok: true };
    }

    if (!text && !imagePath) {
      throw new Error("未设置发送文案或图片");
    }

    if (text) {
      log(`  正在输入文案…`);
      await typeMessage(page, text, target.customerName);
      log(`  文案已写入输入框`);
    }
    if (imagePath) {
      log(`  正在附加图片…`);
      await attachImage(page, imagePath);
    }

    // 输入后再确认一次：有的会话打开时还没有「无法发送」条
    if (await isCannotSendBannerVisible(page)) {
      throw new CannotSendToUserError(target.customerName);
    }

    const composer = await findComposer(page, target.customerName).catch(
      () => undefined,
    );
    const bubblesBefore = text ? await countMessageBubbles(page, text) : 0;
    if (text) {
      log(`  发送前同文案气泡 ${bubblesBefore} 条`);
    }
    log(`  按回车发送…`);
    await clickSend(page, composer ?? undefined);
    if (text) {
      try {
        await verifySent(page, text, bubblesBefore);
      } catch (sendErr) {
        // 回车没出去 + 底部是无法发送 → 按黑名单处理（Wellbeing 常见）
        if (await isCannotSendBannerVisible(page)) {
          throw new CannotSendToUserError(target.customerName);
        }
        throw sendErr;
      }
      const after = await countMessageBubbles(page, text);
      log(`  已确认新消息（气泡 ${bubblesBefore} → ${after}）`);
    } else {
      await page.waitForTimeout(1200);
    }

    await prepareSearchForNext(page, log, recover);
    return { ok: true };
  } catch (err) {
    if (err instanceof CannotSendToUserError) {
      await addBlacklistEntry({
        pageId: target.pageId,
        pageName: target.pageName,
        customerName: target.customerName,
        chatUserId: target.chatUserId,
        reason: "FB无法发送",
      });
      await prepareSearchForNext(page, log, recover).catch(() => undefined);
      return {
        ok: false,
        error: err.message,
        skippedBlacklist: true,
      };
    }
    // 注意：搜不到/打不开会话时，页面上可能还留着上一位的「无法发送」条，
    // 不能据此把当前客户误加黑名单；只有 CannotSendToUserError（已确认打开该会话）才进黑名单。
    const message = err instanceof Error ? err.message : String(err);
    await prepareSearchForNext(page, log, recover).catch(() => undefined);
    return { ok: false, error: message };
  }
}

/**
 * 一个浏览器标签页 = 一个主页：
 * 只打开一次收件箱，之后全部用左侧「搜索」找客户。
 */
export async function sendForPage(
  context: BrowserContext,
  pageId: string,
  pageName: string,
  customers: SendTarget[],
  options: SendOptions = {},
): Promise<void> {
  const runtime = await getRuntimeConfig();
  const maxPerPage = options.maxPerPage ?? runtime.maxPerPage;
  const delayMin = options.delayMinSec ?? runtime.delayMinSec;
  const delayMax = options.delayMaxSec ?? runtime.delayMaxSec;
  const rawLog = options.onLog ?? console.log;
  // 并行跑两个主页时，每行都带主页名，避免日志串在一起难读
  const log = (line: string) => {
    if (line.includes(`[${pageName}]`)) {
      rawLog(line);
      return;
    }
    rawLog(`[${pageName}] ${line.replace(/^\s+/, "")}`);
  };

  const page = await context.newPage();
  const limit =
    maxPerPage > 0 ? customers.slice(0, maxPerPage) : customers;

  log(
    `开始，共 ${limit.length} 条` +
      (maxPerPage > 0 ? `（每页上限 ${maxPerPage}）` : ""),
  );

  try {
    // 只进一次该主页收件箱
    await openInbox(page, pageId, pageName, log);

    for (let i = 0; i < limit.length; i += 1) {
      const target = limit[i];
      log(`(${i + 1}/${limit.length}) → ${target.customerName}`);

      // 发到一半若整页空白转圈，先恢复再搜
      if (await isInboxBlankOrLoading(page)) {
        await hardRecoverInbox(page, pageId, pageName, log);
      }

      let result = await sendOneMessage(page, target, {
        ...options,
        onLog: log,
      });

      // 搜索区找不到（常见于空白转圈）：强制重开后对该客户再试一次
      if (
        !result.ok &&
        !result.skippedBlacklist &&
        /找不到左栏搜索区|未找到「管理」/.test(result.error || "")
      ) {
        log(`  搜索区失败，强制重开收件箱后重试该客户…`);
        await hardRecoverInbox(page, pageId, pageName, log);
        result = await sendOneMessage(page, target, {
          ...options,
          onLog: log,
        });
      }

      await appendSendResult({
        pageId,
        pageName,
        customerName: target.customerName,
        chatUserId: target.chatUserId,
        ok: result.ok,
        error: result.error ?? null,
        skippedBlacklist: Boolean(result.skippedBlacklist),
        dryRun: Boolean(options.dryRun),
      });

      if (result.skippedBlacklist) {
        log(`  跳过并加入黑名单：${target.customerName}（无法再发送）`);
      } else if (!result.ok) {
        log(`  失败: ${result.error}`);
        await dismissPopups(page);
        if (await isInboxBlankOrLoading(page)) {
          await hardRecoverInbox(page, pageId, pageName, log);
        }
      } else {
        log(
          options.dryRun
            ? `  定位成功（未发送）：${target.customerName}`
            : `  已发送：${target.customerName}`,
        );
      }

      if (i < limit.length - 1) {
        const waitMs = randomDelayMs(delayMin, delayMax);
        await sleep(waitMs);
      }
    }
  } finally {
    await page.close();
  }
}
