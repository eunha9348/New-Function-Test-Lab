import { execFile } from "node:child_process";
import { promisify } from "node:util";

const pExecFile = promisify(execFile);

/** 선택 의존성 동적 로드. 없으면 null — 파이프라인은 계속 돈다. */
export async function tryImport<T = any>(name: string): Promise<T | null> {
  try {
    return (await import(/* @vite-ignore */ name)) as T;
  } catch {
    return null;
  }
}

const binCache = new Map<string, boolean>();

/** 시스템 바이너리 존재 확인 (pdftoppm, ffmpeg 등) */
export async function hasBinary(bin: string): Promise<boolean> {
  const cached = binCache.get(bin);
  if (cached !== undefined) return cached;
  try {
    await pExecFile("which", [bin]);
    binCache.set(bin, true);
    return true;
  } catch {
    binCache.set(bin, false);
    return false;
  }
}

export async function run(bin: string, args: string[], timeoutMs = 120_000) {
  return pExecFile(bin, args, { timeout: timeoutMs, maxBuffer: 1024 * 1024 * 64 });
}
