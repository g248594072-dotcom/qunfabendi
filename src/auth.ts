import type http from "node:http";
import { config } from "./config.js";

/** 若配置了 UI_PASSWORD，则要求 HTTP Basic 认证 */
export function checkBasicAuth(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): boolean {
  const password = config.uiPassword;
  if (!password) return true;

  const header = String(req.headers.authorization || "");
  if (!header.startsWith("Basic ")) {
    challenge(res);
    return false;
  }
  try {
    const decoded = Buffer.from(header.slice(6), "base64").toString("utf8");
    const i = decoded.indexOf(":");
    const user = i >= 0 ? decoded.slice(0, i) : decoded;
    const pass = i >= 0 ? decoded.slice(i + 1) : "";
    if (user === config.uiUser && pass === password) return true;
  } catch {
    /* fall through */
  }
  challenge(res);
  return false;
}

function challenge(res: http.ServerResponse): void {
  res.writeHead(401, {
    "WWW-Authenticate": 'Basic realm="FB Broadcast"',
    "Content-Type": "text/plain; charset=utf-8",
  });
  res.end("需要登录：请输入控制台账号密码（.env 中 UI_USER / UI_PASSWORD）");
}
