/** Playwright / Chromium 代理配置（http / https / socks5） */
export type ProxyConfig = {
  /** 如 http://1.2.3.4:8080 或 socks5://1.2.3.4:1080 */
  server: string;
  username?: string;
  password?: string;
};

/** 与代理面板一致的结构化字段（如 kookeey：协议/域名/端口/账号/密码） */
export type StructuredProxy = {
  protocol: "socks5" | "http" | "https";
  host: string;
  port: number;
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

/** 将结构化字段拼成 Playwright 可用的 ProxyConfig */
export function buildProxyFromStructured(
  s: Partial<StructuredProxy> | null | undefined,
): ProxyConfig | undefined {
  const host = String(s?.host || "").trim();
  const port = Number(s?.port);
  if (!host || !Number.isFinite(port) || port <= 0 || port > 65535) {
    return undefined;
  }
  let protocol = String(s?.protocol || "socks5").toLowerCase();
  if (protocol !== "socks5" && protocol !== "http" && protocol !== "https") {
    protocol = "socks5";
  }
  return normalizeProxy({
    server: `${protocol}://${host}:${Math.floor(port)}`,
    username: s?.username,
    password: s?.password,
  });
}

/** 从 server URL 拆回结构化字段（供表单回填） */
export function parseProxyToStructured(
  p?: ProxyConfig | null,
): StructuredProxy | null {
  const n = normalizeProxy(p);
  if (!n) return null;
  try {
    const raw = n.server.includes("://") ? n.server : `http://${n.server}`;
    const u = new URL(raw);
    const protocol = (u.protocol.replace(":", "") || "socks5").toLowerCase();
    const host = u.hostname;
    const port = Number(u.port);
    if (!host || !Number.isFinite(port) || port <= 0) return null;
    const proto =
      protocol === "http" || protocol === "https" || protocol === "socks5"
        ? protocol
        : "socks5";
    return {
      protocol: proto,
      host,
      port,
      username: n.username,
      password: n.password,
    };
  } catch {
    return null;
  }
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
  const s = parseProxyToStructured(n);
  if (s) {
    const auth = s.username ? ` · ${s.username}` : "";
    return `${s.protocol}://${s.host}:${s.port}${auth}`;
  }
  const auth = n.username ? `（${n.username}）` : "";
  return `${n.server}${auth}`;
}

export function toPlaywrightProxy(
  p?: ProxyConfig | null,
): { server: string; username?: string; password?: string } | undefined {
  return normalizeProxy(p);
}
