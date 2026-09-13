/**
 * 데모/개발용 서버 — 의존성 0개.
 *
 *   npm run serve        → http://localhost:5174
 *
 * 엔드포인트
 *   GET  /api/health     엔진 상태 (키 유효성, 실제로 선택된 모델)
 *   GET  /api/types      경험 유형 18종 목록
 *   POST /api/organize   파일 업로드 → 자동 정리된 폼 상태(FormState) 반환
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { promises as fs } from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { API_KEYS, PIPELINE, PROVIDER } from "../src/config.js";
import { toFormState } from "../src/form.js";
import { createSession } from "../src/llm/index.js";
import { organizeExperience } from "../src/pipeline.js";
import { EXPERIENCE_TYPES } from "../src/schema/index.js";
import type { InputFile } from "../src/types.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.resolve(here, "../public");
const PORT = Number(process.env.PORT ?? 5174);

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
};

function json(res: ServerResponse, status: number, body: unknown) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
    "access-control-allow-origin": "*",
  });
  res.end(payload);
}

/** node:http 요청을 표준 Request로 바꿔 multipart를 그대로 파싱한다 (추가 라이브러리 불필요) */
async function readUpload(req: IncomingMessage): Promise<{
  files: InputFile[]; hint: string; typeId: string; quality: string;
}> {
  const request = new Request("http://localhost/api/organize", {
    method: "POST",
    headers: req.headers as Record<string, string>,
    body: Readable.toWeb(req) as unknown as BodyInit,
    duplex: "half",
  } as RequestInit & { duplex: "half" });
  const form = await request.formData();

  const files: InputFile[] = [];
  let total = 0;
  for (const entry of form.getAll("file").concat(form.getAll("files"))) {
    if (typeof entry === "string") {
      files.push({ name: "입력.txt", text: entry });
      continue;
    }
    const bytes = new Uint8Array(await entry.arrayBuffer());
    total += bytes.length;
    if (total > PIPELINE.maxUploadBytes) {
      throw new Error(`업로드 용량이 ${PIPELINE.maxUploadBytes / 1024 / 1024}MB를 넘었습니다.`);
    }
    files.push({ name: entry.name, mimeType: entry.type || undefined, bytes });
  }
  return {
    files,
    hint: String(form.get("hint") ?? ""),
    typeId: String(form.get("typeId") ?? ""),
    quality: String(form.get("quality") ?? ""),
  };
}

async function serveStatic(res: ServerResponse, urlPath: string) {
  const rel = urlPath === "/" ? "index.html" : urlPath.replace(/^\/+/, "");
  const file = path.resolve(PUBLIC_DIR, rel);
  if (!file.startsWith(PUBLIC_DIR)) {
    res.writeHead(403).end("forbidden");
    return;
  }
  try {
    const body = await fs.readFile(file);
    res.writeHead(200, { "content-type": MIME[path.extname(file)] ?? "application/octet-stream" });
    res.end(body);
  } catch {
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" }).end("없는 경로입니다");
  }
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");

  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "POST, GET, OPTIONS",
      "access-control-allow-headers": "content-type",
    });
    res.end();
    return;
  }

  if (url.pathname === "/api/health") {
    if (!API_KEYS.google && PROVIDER === "gemini") {
      json(res, 200, {
        ok: false,
        provider: PROVIDER,
        message: "Google API 키가 없습니다. .env의 GOOGLE_API_KEY 또는 src/config.ts의 API_KEYS.google을 채워주세요.",
      });
      return;
    }
    try {
      const session = await createSession();
      const check = await session.verify();
      json(res, 200, {
        ok: check.ok,
        provider: session.providerName,
        model: await session.resolveModel("extract"),
        lightModel: await session.resolveModel("guide"),
        message: check.detail,
      });
    } catch (e) {
      json(res, 200, { ok: false, provider: PROVIDER, message: (e as Error).message });
    }
    return;
  }

  if (url.pathname === "/api/types") {
    json(res, 200, {
      types: EXPERIENCE_TYPES.map((t) => ({
        id: t.id, category: t.category, label: t.label, emoji: t.emoji,
      })),
    });
    return;
  }

  if (url.pathname === "/api/organize" && req.method === "POST") {
    try {
      const { files, hint, typeId, quality } = await readUpload(req);
      if (!files.length) {
        json(res, 400, { error: "파일이 없습니다. form-data의 'file' 필드로 보내주세요." });
        return;
      }
      const result = await organizeExperience(files, {
        userHint: hint || undefined,
        forceTypeId: typeId || undefined,
        quality: (quality || undefined) as "fast" | "balanced" | "best" | undefined,
        onProgress: (e) => console.log(`  [${e.stage}] ${e.message}`),
      });
      json(res, 200, { form: toFormState(result), raw: result });
    } catch (e) {
      console.error(e);
      json(res, 500, { error: (e as Error).message });
    }
    return;
  }

  await serveStatic(res, url.pathname);
});

server.listen(PORT, () => {
  console.log(`\n  ARC 자동 정리 데모 서버`);
  console.log(`  → http://localhost:${PORT}`);
  console.log(
    API_KEYS.google
      ? `  → Google API 키 감지됨 (${API_KEYS.google.slice(0, 6)}…)\n`
      : `  ⚠ Google API 키가 없습니다. .env에 GOOGLE_API_KEY=... 를 넣어주세요.\n`,
  );
});
