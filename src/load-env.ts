import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * 의존성 없는 .env 로더.
 * 프로젝트 루트의 .env.local / .env 를 읽어 process.env 에 채운다.
 * 이미 설정된 환경변수는 덮어쓰지 않으므로, Next.js처럼 프레임워크가 먼저
 * .env를 읽어주는 환경에서도 충돌하지 않는다.
 */
let loaded = false;

export function loadEnv(): void {
  if (loaded) return;
  loaded = true;
  if (typeof process === "undefined" || !process.versions?.node) return;

  for (const name of [".env.local", ".env"]) {
    let file: string;
    try {
      file = resolve(process.cwd(), name);
      if (!existsSync(file)) continue;
    } catch {
      continue;
    }
    try {
      for (const raw of readFileSync(file, "utf-8").split(/\r?\n/)) {
        const line = raw.trim();
        if (!line || line.startsWith("#")) continue;
        const m = /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
        if (!m) continue;
        const key = m[1]!;
        if (process.env[key]) continue;
        let value = m[2]!.trim();
        const quoted =
          (value.startsWith('"') && value.endsWith('"')) ||
          (value.startsWith("'") && value.endsWith("'"));
        if (quoted && value.length >= 2) value = value.slice(1, -1);
        process.env[key] = value;
      }
    } catch {
      /* 읽기 실패는 무시 — 환경변수를 직접 넣었을 수 있다 */
    }
  }
}
