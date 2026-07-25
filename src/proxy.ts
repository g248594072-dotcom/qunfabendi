/** Playwright / Chromium 代理配置（http / https / socks5） */
export type ProxyConfig = {
  /** 如 http://1.2.3.4:8080 或 socks5://1.2.3.4:1080 */
  server: string;
  username?: string;
  password?: string;
};

export function normalizeProxy(
  p?: ProxyConfig | null,
): ProxyConfig | undefined {
  const server = String(p?.server || "").trim();
  if (!server) return undefined;
  return {
    server,
    username: String(p?.username || "").trim() || undefined,
    password: String(p?.password || "").trim() || undefined,
  };
}

/** 分组用指纹（含密码，仅进程内比较） */
export function proxyKey(p?: ProxyConfig | null): string {
  const n = normalizeProxy(p);
  if (!n) return "direct";
  return `${n.server}\0${n.username || ""}\0${n.password || ""}`;
}

export function proxyLabel(p?: ProxyConfig | null): string {
  const n = normalizeProxy(p);
  if (!n) return "直连";
  const auth = n.username ? `（${n.username}）` : "";
  return `${n.server}${auth}`;
}

export function toPlaywrightProxy(
  p?: ProxyConfig | null,
): { server: string; username?: string; password?: string } | undefined {
  return normalizeProxy(p);
}
