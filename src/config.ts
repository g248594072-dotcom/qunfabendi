import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import { z } from "zod";
import { loadSettings, type AppSettings } from "./settings.js";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
dotenv.config({ path: path.join(rootDir, ".env") });

const envSchema = z.object({
  SALESMARTLY_PROJECT_ID: z.string().optional().default(""),
  SALESMARTLY_API_TOKEN: z.string().optional().default(""),
  SALESMARTLY_BASE_URL: z
    .string()
    .optional()
    .default("https://developer.salesmartly.com"),
  UI_PORT: z.coerce.number().default(3789),
});

const parsed = envSchema.safeParse(process.env);
if (!parsed.success) {
  throw new Error("环境变量无效，请检查 .env");
}

const env = parsed.data;

export function requireSaleSmartly(): {
  projectId: string;
  apiToken: string;
  baseUrl: string;
} {
  if (!env.SALESMARTLY_PROJECT_ID || !env.SALESMARTLY_API_TOKEN) {
    throw new Error(
      "请先在 .env 填写 SALESMARTLY_PROJECT_ID 和 SALESMARTLY_API_TOKEN（可参考 .env.example）",
    );
  }
  return {
    projectId: env.SALESMARTLY_PROJECT_ID,
    apiToken: env.SALESMARTLY_API_TOKEN,
    baseUrl: env.SALESMARTLY_BASE_URL.replace(/\/$/, ""),
  };
}

export const config = {
  rootDir,
  uiPort: env.UI_PORT,
  salesmartly: {
    get projectId() {
      return requireSaleSmartly().projectId;
    },
    get apiToken() {
      return requireSaleSmartly().apiToken;
    },
    get baseUrl() {
      return requireSaleSmartly().baseUrl;
    },
  },
  paths: {
    dataDir: path.join(rootDir, "data"),
    pagesFile: path.join(rootDir, "data", "pages.json"),
    contactsFile: path.join(rootDir, "data", "contacts.json"),
    blacklistFile: path.join(rootDir, "data", "blacklist.json"),
    fbSessionPagesFile: path.join(rootDir, "data", "fb-session-pages.json"),
    resultsFile: path.join(rootDir, "data", "send-results.jsonl"),
    settingsFile: path.join(rootDir, "data", "settings.json"),
    logsDir: path.join(rootDir, "storage", "logs"),
    publicDir: path.join(rootDir, "public"),
  },
  browser: {
    profileDir: path.join(rootDir, "storage", "browser-profile"),
  },
};

export type RuntimeConfig = {
  messageText: string;
  messageImagePath: string;
  delayMinSec: number;
  delayMaxSec: number;
  maxPerPage: number;
  headless: boolean;
  contactDays: number;
  selectedPageIds: string[];
  maxPageConcurrency: number;
};

export async function getRuntimeConfig(
  override?: Partial<AppSettings>,
): Promise<RuntimeConfig> {
  const s = { ...(await loadSettings(rootDir)), ...override };
  const image = (s.messageImage || "").trim();
  return {
    messageText: s.messageText,
    messageImagePath: image
      ? path.isAbsolute(image)
        ? image
        : path.join(rootDir, image)
      : "",
    delayMinSec: s.delayMinSec,
    delayMaxSec: s.delayMaxSec,
    maxPerPage: s.maxSendPerPage,
    headless: s.headless,
    contactDays: s.contactDays,
    selectedPageIds: s.selectedPageIds,
    maxPageConcurrency: s.maxPageConcurrency ?? 6,
  };
}
