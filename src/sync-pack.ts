import { execFile } from "node:child_process";
import { access, mkdir, mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { loadAccounts, saveAccounts, resolveProfileDir } from "./accounts.js";
import { config } from "./config.js";
import { ensureDir } from "./utils/delay.js";

const execFileAsync = promisify(execFile);

/** 本机准备 → 服务器发送：需要同步的内容 */
const DATA_FILES = [
  "accounts.json",
  "pages.json",
  "contacts.json",
  "blacklist.json",
  "fb-session-pages.json",
  "settings.json",
] as const;

/** Chromium 缓存目录（体积大、登录不需要） */
const PROFILE_EXCLUDE_DIRS = new Set([
  "Cache",
  "Code Cache",
  "GPUCache",
  "GrShaderCache",
  "GraphiteDawnCache",
  "ShaderCache",
  "Media Cache",
  "Service Worker",
  "Crashpad",
  "BrowserMetrics",
  "optimization_guide_prediction_model_downloads",
  "Component Crx Cache",
  "DawnGraphiteCache",
  "DawnWebGPUCache",
  "VideoDecodeStats",
  "blob_storage",
]);

async function pathExists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

async function copyProfileSlim(src: string, dest: string): Promise<void> {
  const { cp } = await import("node:fs/promises");
  await cp(src, dest, {
    recursive: true,
    force: true,
    filter: (input) => {
      const name = path.basename(input);
      if (PROFILE_EXCLUDE_DIRS.has(name)) return false;
      // 跳过超大日志/临时
      if (name.endsWith(".log") || name === "LOCK") return true;
      return true;
    },
  });
}

/**
 * 打包：账号配置 + 登录资料夹 + 主页/客户/黑名单/设置
 * 用于本机做完准备后上传到服务器，服务器只负责发送。
 */
export async function packSyncBundle(): Promise<{
  fileName: string;
  buffer: Buffer;
}> {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "fb-sync-"));
  const stage = path.join(tmp, "bundle");
  const outFile = path.join(tmp, "sync-bundle.tar.gz");
  await mkdir(path.join(stage, "data"), { recursive: true });
  await mkdir(path.join(stage, "storage"), { recursive: true });

  try {
    const { copyFile } = await import("node:fs/promises");

    for (const name of DATA_FILES) {
      const src = path.join(config.paths.dataDir, name);
      if (await pathExists(src)) {
        await copyFile(src, path.join(stage, "data", name));
      }
    }

    const profilesSrc = path.join(config.rootDir, "storage", "profiles");
    if (await pathExists(profilesSrc)) {
      await copyProfileSlim(
        profilesSrc,
        path.join(stage, "storage", "profiles"),
      );
    }

    const browserSrc = path.join(config.rootDir, "storage", "browser-profile");
    if (await pathExists(browserSrc)) {
      await copyProfileSlim(
        browserSrc,
        path.join(stage, "storage", "browser-profile"),
      );
    }

    await writeFile(
      path.join(stage, "manifest.json"),
      JSON.stringify(
        {
          kind: "fb-page-broadcast-sync",
          version: 1,
          exportedAt: new Date().toISOString(),
          files: DATA_FILES,
          slimProfile: true,
        },
        null,
        2,
      ),
      "utf8",
    );

    await execFileAsync("tar", ["-czf", outFile, "-C", stage, "."], {
      windowsHide: true,
    });
    const buffer = await readFile(outFile);
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
    return {
      fileName: `fb-sync-${stamp}.tar.gz`,
      buffer,
    };
  } finally {
    await rm(tmp, { recursive: true, force: true }).catch(() => undefined);
  }
}

/**
 * 登录助手专用包：仅账号列表 + 登录资料夹（给别人填完回传给你）
 */
export async function packLoginBundle(): Promise<{
  fileName: string;
  buffer: Buffer;
}> {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "fb-login-"));
  const stage = path.join(tmp, "bundle");
  const outFile = path.join(tmp, "login-bundle.tar.gz");
  await mkdir(path.join(stage, "data"), { recursive: true });
  await mkdir(path.join(stage, "storage"), { recursive: true });

  try {
    const { copyFile } = await import("node:fs/promises");
    const accountsSrc = path.join(config.paths.dataDir, "accounts.json");
    if (await pathExists(accountsSrc)) {
      await copyFile(accountsSrc, path.join(stage, "data", "accounts.json"));
    }

    const profilesSrc = path.join(config.rootDir, "storage", "profiles");
    if (await pathExists(profilesSrc)) {
      await copyProfileSlim(
        profilesSrc,
        path.join(stage, "storage", "profiles"),
      );
    }
    const browserSrc = path.join(config.rootDir, "storage", "browser-profile");
    if (await pathExists(browserSrc)) {
      await copyProfileSlim(
        browserSrc,
        path.join(stage, "storage", "browser-profile"),
      );
    }

    await writeFile(
      path.join(stage, "manifest.json"),
      JSON.stringify(
        {
          kind: "fb-page-broadcast-login",
          version: 1,
          exportedAt: new Date().toISOString(),
        },
        null,
        2,
      ),
      "utf8",
    );

    await execFileAsync("tar", ["-czf", outFile, "-C", stage, "."], {
      windowsHide: true,
    });
    const buffer = await readFile(outFile);
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
    return {
      fileName: `fb-login-${stamp}.tar.gz`,
      buffer,
    };
  } finally {
    await rm(tmp, { recursive: true, force: true }).catch(() => undefined);
  }
}

/**
 * 批量导入登录助手回传的资料：合并账号 + 覆盖对应登录资料夹
 */
export async function unpackLoginBundle(archive: Buffer): Promise<{
  restored: string[];
  mergedAccounts: number;
}> {
  if (!archive.length) throw new Error("上传内容为空");
  if (archive.length > 800 * 1024 * 1024) {
    throw new Error("资料包过大（超过 800MB）");
  }

  const tmp = await mkdtemp(path.join(os.tmpdir(), "fb-login-in-"));
  const archivePath = path.join(tmp, "upload.tar.gz");
  const extractDir = path.join(tmp, "extract");
  await mkdir(extractDir, { recursive: true });

  try {
    await writeFile(archivePath, archive);
    await execFileAsync("tar", ["-xzf", archivePath, "-C", extractDir], {
      windowsHide: true,
    });

    let root = extractDir;
    if (!(await pathExists(path.join(extractDir, "data")))) {
      const { readdir } = await import("node:fs/promises");
      for (const e of await readdir(extractDir)) {
        if (await pathExists(path.join(extractDir, e, "data"))) {
          root = path.join(extractDir, e);
          break;
        }
      }
    }

    const incomingAccountsPath = path.join(root, "data", "accounts.json");
    if (!(await pathExists(incomingAccountsPath))) {
      throw new Error("不是登录资料包：缺少 accounts.json（请用登录助手的「导出给主控」）");
    }

    const incoming = JSON.parse(
      await readFile(incomingAccountsPath, "utf8"),
    ) as Awaited<ReturnType<typeof loadAccounts>>;
    const current = await loadAccounts();
    const byId = new Map(current.accounts.map((a) => [a.id, a]));
    let merged = 0;

    for (const acc of incoming.accounts || []) {
      byId.set(acc.id, {
        ...byId.get(acc.id),
        ...acc,
      });
      merged += 1;
    }
    current.accounts = [...byId.values()];
    if (
      incoming.activeAccountId &&
      current.accounts.some((a) => a.id === incoming.activeAccountId)
    ) {
      current.activeAccountId = incoming.activeAccountId;
    }
    await saveAccounts(current);

    const { cp } = await import("node:fs/promises");
    const restored: string[] = [`accounts.json（合并 ${merged} 个账号）`];

    for (const acc of incoming.accounts || []) {
      const srcProfile = path.join(root, acc.profileDir);
      // 包内路径相对 bundle 根：storage/profiles/xxx
      const altSrc = path.join(root, "storage", "profiles", acc.id);
      const fromPack = (await pathExists(srcProfile))
        ? srcProfile
        : (await pathExists(altSrc))
          ? altSrc
          : "";
      if (!fromPack) continue;
      const dest = resolveProfileDir(acc);
      await rm(dest, { recursive: true, force: true }).catch(() => undefined);
      await ensureDir(path.dirname(dest));
      await cp(fromPack, dest, { recursive: true, force: true });
      restored.push(acc.profileDir || acc.id);
    }

    const browserSrc = path.join(root, "storage", "browser-profile");
    if (await pathExists(browserSrc)) {
      const dest = path.join(config.rootDir, "storage", "browser-profile");
      await rm(dest, { recursive: true, force: true }).catch(() => undefined);
      await cp(browserSrc, dest, { recursive: true, force: true });
      restored.push("storage/browser-profile");
    }

    return { restored, mergedAccounts: merged };
  } finally {
    await rm(tmp, { recursive: true, force: true }).catch(() => undefined);
  }
}

/**
 * 导入同步包：覆盖 data 指定文件与 storage 登录资料（不删发送日志）
 */
export async function unpackSyncBundle(archive: Buffer): Promise<{
  restored: string[];
}> {
  if (!archive.length) throw new Error("上传内容为空");
  if (archive.length > 800 * 1024 * 1024) {
    throw new Error("资料包过大（超过 800MB）");
  }

  const tmp = await mkdtemp(path.join(os.tmpdir(), "fb-sync-in-"));
  const archivePath = path.join(tmp, "upload.tar.gz");
  const extractDir = path.join(tmp, "extract");
  await mkdir(extractDir, { recursive: true });
  const restored: string[] = [];

  try {
    await writeFile(archivePath, archive);
    await execFileAsync("tar", ["-xzf", archivePath, "-C", extractDir], {
      windowsHide: true,
    });

    let root = extractDir;
    const directData = path.join(extractDir, "data");
    if (!(await pathExists(directData))) {
      const { readdir } = await import("node:fs/promises");
      const entries = await readdir(extractDir);
      for (const e of entries) {
        const candidate = path.join(extractDir, e, "data");
        if (await pathExists(candidate)) {
          root = path.join(extractDir, e);
          break;
        }
      }
    }

    await ensureDir(config.paths.dataDir);
    await ensureDir(path.join(config.rootDir, "storage"));

    const { copyFile, cp } = await import("node:fs/promises");

    for (const name of DATA_FILES) {
      const src = path.join(root, "data", name);
      if (await pathExists(src)) {
        await copyFile(src, path.join(config.paths.dataDir, name));
        restored.push(`data/${name}`);
      }
    }

    const profilesSrc = path.join(root, "storage", "profiles");
    if (await pathExists(profilesSrc)) {
      const dest = path.join(config.rootDir, "storage", "profiles");
      await rm(dest, { recursive: true, force: true }).catch(() => undefined);
      await cp(profilesSrc, dest, { recursive: true, force: true });
      restored.push("storage/profiles");
    }

    const browserSrc = path.join(root, "storage", "browser-profile");
    if (await pathExists(browserSrc)) {
      const dest = path.join(config.rootDir, "storage", "browser-profile");
      await rm(dest, { recursive: true, force: true }).catch(() => undefined);
      await cp(browserSrc, dest, { recursive: true, force: true });
      restored.push("storage/browser-profile");
    }

    if (!restored.length) {
      throw new Error("资料包无效：未找到可导入的账号/数据文件");
    }
    return { restored };
  } finally {
    await rm(tmp, { recursive: true, force: true }).catch(() => undefined);
  }
}
