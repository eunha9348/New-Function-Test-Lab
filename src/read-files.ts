import { promises as fs } from "node:fs";
import path from "node:path";
import type { InputFile } from "./types.js";

/** 로컬 경로 목록 → InputFile[] (디렉터리는 한 단계 펼침) */
export async function readInputFiles(paths: string[]): Promise<InputFile[]> {
  const out: InputFile[] = [];
  for (const p of paths) {
    const stat = await fs.stat(p);
    if (stat.isDirectory()) {
      for (const name of await fs.readdir(p)) {
        const full = path.join(p, name);
        if ((await fs.stat(full)).isFile()) {
          out.push({ name, path: full, bytes: new Uint8Array(await fs.readFile(full)) });
        }
      }
    } else {
      out.push({
        name: path.basename(p),
        path: p,
        bytes: new Uint8Array(await fs.readFile(p)),
      });
    }
  }
  return out;
}
