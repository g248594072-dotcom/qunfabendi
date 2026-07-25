import { createHash } from "node:crypto";

/**
 * SaleSmartly external-sign:
 * Token 放最前，其余参数名按字典序排序后用 & 拼接，再 MD5 小写。
 * 文档：https://help.salesmartly.com/docs/API-Header
 */
export function buildExternalSign(
  token: string,
  params: Record<string, string | number | undefined | null>,
): string {
  const pairs = Object.entries(params)
    .filter(([, value]) => value !== undefined && value !== null && value !== "")
    .map(([key, value]) => [key, String(value)] as const)
    .sort(([a], [b]) => a.localeCompare(b));

  const raw = [token, ...pairs.map(([k, v]) => `${k}=${v}`)].join("&");
  return createHash("md5").update(raw, "utf8").digest("hex");
}
