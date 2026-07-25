import { execFile } from "node:child_process";
import { access, mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { getAccount, resolveProfileDir } from "./accounts.js";
import { ensureDir } from "./utils/delay.js";

const execFileAsync = promisify(execFile);

async function pathExists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * 打包账号浏览器资料夹为 .tar.gz（登录态交接：本机登录后上传到服务器）
 */
export async function packAccountProfile(accountId: string): Promise<{
  fileName: string;
  buffer: Buffer;
}> {
  const account = await getAccount(accountId);
  const profileDir = resolveProfileDir(account);
  if (!(await pathExists(profileDir))) {
    throw new Error("资料夹还不存在，请先完成一次登录");
  }
  const tmp = await mkdtemp(path.join(os.tmpdir(), "fb-prof-"));
  const outFile = path.join(tmp, `${account.id}-profile.tar.gz`);
  try {
    await execFileAsync(
      "tar",
      ["-czf", outFile, "-C", profileDir, "."],
      { windowsHide: true },
    );
    const { readFile } = await import("node:fs/promises");
    const buffer = await readFile(outFile);
    return {
      fileName: `${account.id}-${account.name.replace(/[^\w\u4e00-\u9fa5-]+/g, "_")}-profile.tar.gz`,
      buffer,
    };
  } finally {
    await rm(tmp, { recursive: true, force: true }).catch(() => undefined);
  }
}

/**
 * 将上传的 .tar.gz 解压覆盖到账号资料夹
 */
export async function unpackAccountProfile(
  accountId: string,
  archive: Buffer,
): Promise<string> {
  const account = await getAccount(accountId);
  const profileDir = resolveProfileDir(account);
  await ensureDir(profileDir);

  const tmp = await mkdtemp(path.join(os.tmpdir(), "fb-prof-in-"));
  const archivePath = path.join(tmp, "upload.tar.gz");
  const extractDir = path.join(tmp, "extract");
  await mkdir(extractDir, { recursive: true });
  try {
    const { writeFile } = await import("node:fs/promises");
    await writeFile(archivePath, archive);
    await execFileAsync("tar", ["-xzf", archivePath, "-C", extractDir], {
      windowsHide: true,
    });

    // 清空目标后拷入（用 tar 直接解到目标更干净）
    await rm(profileDir, { recursive: true, force: true });
    await mkdir(profileDir, { recursive: true });
    await execFileAsync("tar", ["-xzf", archivePath, "-C", profileDir], {
      windowsHide: true,
    });
    return profileDir;
  } finally {
    await rm(tmp, { recursive: true, force: true }).catch(() => undefined);
  }
}
