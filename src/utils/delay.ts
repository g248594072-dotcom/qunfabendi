export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function randomDelayMs(minSec: number, maxSec: number): number {
  const min = Math.min(minSec, maxSec) * 1000;
  const max = Math.max(minSec, maxSec) * 1000;
  return Math.floor(min + Math.random() * (max - min + 1));
}

export async function ensureDir(dir: string): Promise<void> {
  const { mkdir } = await import("node:fs/promises");
  await mkdir(dir, { recursive: true });
}
