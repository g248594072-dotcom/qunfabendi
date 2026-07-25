export type MessengerPage = {
  id: number;
  pageId: string;
  pageName: string;
  channelId: string;
  status: number;
  accountStatus: number;
  /** SaleSmartly 主页备注；含「封」视为封号主页，发送时整页跳过 */
  remark?: string;
};

/** 备注里只要出现「封」就视为封号主页（如：封、封号、已封） */
export function isPageBannedByRemark(remark?: string | null): boolean {
  return Boolean(remark && String(remark).includes("封"));
}

export type ContactRow = {
  chatUserId: string;
  name: string;
  channel: number;
  channelId: string;
  channelUid: string;
  pageId: string;
  pageName: string;
  msgLastSendTime: number;
  userLastReplyTime: number;
  labels?: string;
};

export type BlacklistEntry = {
  pageId: string;
  pageName: string;
  customerName: string;
  chatUserId: string;
  matchedTags: string[];
  updatedAt: string;
};

export type ApiListResponse<T> = {
  code: number;
  msg: string;
  data?: {
    list?: T[];
    page?: number;
    page_size?: number;
    total?: number;
  };
};

/** 进入不发送黑名单的访客标签（须与 SaleSmartly 中完全一致） */
export const BLACKLIST_TAG_NAMES = [
  "黑粉（澳）",
  "定金客户（尾款补齐发货）",
  "全款客户",
  "分期客户",
  "删",
] as const;

export function blacklistKey(pageId: string, customerName: string): string {
  return `${pageId}::${customerName.trim()}`;
}
