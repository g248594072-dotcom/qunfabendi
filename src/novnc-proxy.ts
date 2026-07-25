import http from "node:http";
import type { Duplex } from "node:stream";

const NOVNC_HOST = "127.0.0.1";
const NOVNC_PORT = Number(process.env.NOVNC_PORT || 6080);

/** /novnc/xxx → 本机 noVNC；/websockify → WebSocket */
export function isNovncPath(pathname: string): boolean {
  return pathname === "/websockify" || pathname.startsWith("/novnc/");
}

function targetPath(pathname: string, search: string): string {
  if (pathname === "/websockify" || pathname.startsWith("/websockify?")) {
    return `/websockify${search}`;
  }
  const stripped = pathname.replace(/^\/novnc/, "") || "/";
  return `${stripped}${search}`;
}

export function proxyNovncHttp(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  pathname: string,
  search: string,
): void {
  const pathWithQuery = targetPath(pathname, search);
  const headers = { ...req.headers, host: `${NOVNC_HOST}:${NOVNC_PORT}` };
  delete headers["accept-encoding"];

  const upstream = http.request(
    {
      hostname: NOVNC_HOST,
      port: NOVNC_PORT,
      path: pathWithQuery,
      method: req.method,
      headers,
    },
    (pres) => {
      res.writeHead(pres.statusCode || 502, pres.headers);
      pres.pipe(res);
    },
  );
  upstream.on("error", () => {
    if (!res.headersSent) {
      res.writeHead(502, { "Content-Type": "text/plain; charset=utf-8" });
    }
    res.end("noVNC unavailable (is websockify running?)");
  });
  req.pipe(upstream);
}

export function proxyNovncUpgrade(
  req: http.IncomingMessage,
  socket: Duplex,
  head: Buffer,
): void {
  const url = new URL(req.url || "/", "http://localhost");
  if (!isNovncPath(url.pathname)) {
    socket.destroy();
    return;
  }
  const pathWithQuery = targetPath(url.pathname, url.search);
  const headers = { ...req.headers, host: `${NOVNC_HOST}:${NOVNC_PORT}` };

  const upstream = http.request({
    hostname: NOVNC_HOST,
    port: NOVNC_PORT,
    path: pathWithQuery,
    method: "GET",
    headers,
  });

  upstream.on("upgrade", (ures, usocket, uhead) => {
    const lines = [`HTTP/1.1 ${ures.statusCode} ${ures.statusMessage || "OK"}`];
    for (const [k, v] of Object.entries(ures.headers)) {
      if (v === undefined) continue;
      if (Array.isArray(v)) {
        for (const item of v) lines.push(`${k}: ${item}`);
      } else {
        lines.push(`${k}: ${v}`);
      }
    }
    socket.write(lines.join("\r\n") + "\r\n\r\n");
    if (uhead.length) socket.write(uhead);
    usocket.pipe(socket);
    socket.pipe(usocket);
  });

  upstream.on("error", () => {
    socket.destroy();
  });

  upstream.end(head);
}
