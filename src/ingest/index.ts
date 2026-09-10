import type { ExtractedDoc, ExtractedPage, InputFile, ProgressHandler, SourceKind } from "../types.js";
import type { LlmSession } from "../llm/client.js";
import { ocrImage } from "../ocr/index.js";
import { detectKind, extensionOf, guessMime, looksLikeText, refineZip } from "./detect.js";
import { tryImport } from "./optional.js";
import {
  extractDocx, extractHwp, extractPdf, extractPptx, extractXlsx,
} from "./extractors/documents.js";
import { extractAudio, extractVideo } from "./extractors/media.js";
import {
  decodeText, htmlToText, normalizeDelimited, notebookToText, subtitlesToText,
} from "./extractors/text-like.js";

const MAX_ARCHIVE_ENTRIES = 40;
const MAX_ARCHIVE_DEPTH = 2;

/** JPEG/HEIC EXIF에서 촬영일시를 긁어온다 (기간 추정의 좋은 근거가 된다) */
function sniffExifDate(bytes: Uint8Array): string | null {
  const head = Buffer.from(bytes.subarray(0, Math.min(bytes.length, 131072))).toString("latin1");
  const m = /(19|20)\d{2}:[01]\d:[0-3]\d [0-2]\d:[0-5]\d:[0-5]\d/.exec(head);
  if (!m) return null;
  const [d, t] = m[0].split(" ");
  return `${d!.replace(/:/g, "-")} ${t}`;
}

async function imageDimensions(bytes: Uint8Array): Promise<{ w?: number; h?: number }> {
  const sharpMod = await tryImport<any>("sharp");
  if (!sharpMod) return {};
  try {
    const meta = await (sharpMod.default ?? sharpMod)(bytes).metadata();
    return { w: meta.width, h: meta.height };
  } catch {
    return {};
  }
}

function joinPages(pages: ExtractedPage[]): string {
  return pages
    .map((p) => p.text.trim())
    .filter(Boolean)
    .join("\n\n")
    .replace(/\n{4,}/g, "\n\n\n")
    .trim();
}

/** 파일 하나 → ExtractedDoc 하나(또는 압축 파일이면 여러 개) */
async function extractOne(
  session: LlmSession,
  file: InputFile,
  sourceId: string,
  depth: number,
  onProgress?: ProgressHandler,
): Promise<ExtractedDoc[]> {
  const bytes = file.bytes;
  const kindRaw = detectKind(file.name, file.mimeType, bytes);
  let kind: SourceKind = kindRaw;
  const warnings: string[] = [];
  const metadata: Record<string, string | number> = { fileName: file.name };
  const pages: ExtractedPage[] = [];
  let confidence = 1;

  const base = (): ExtractedDoc => ({
    sourceId,
    name: file.name,
    kind,
    mimeType: file.mimeType ?? guessMime(kind, file.name),
    bytesLength: bytes?.length ?? file.text?.length ?? 0,
    text: joinPages(pages),
    pages,
    metadata,
    warnings,
    confidence,
  });

  // 사용자가 텍스트를 직접 준 경우 (설명 입력창 등)
  if (!bytes && file.text) {
    pages.push({ index: 1, text: file.text, method: "native" });
    kind = "text";
    return [base()];
  }
  if (!bytes) return [{ ...base(), warnings: ["빈 파일"], confidence: 0 }];

  // ZIP 컨테이너 재판별 (docx/pptx/xlsx/hwpx가 archive로 잡힌 경우)
  if (kind === "archive") {
    const jszip = await tryImport<any>("jszip");
    if (jszip) {
      try {
        const zip = await (jszip.default ?? jszip).loadAsync(Buffer.from(bytes));
        const names = Object.keys(zip.files);
        const refined = refineZip(names);
        if (refined !== "archive") kind = refined;
        else if (depth < MAX_ARCHIVE_DEPTH) {
          // 진짜 압축 파일 → 안쪽 파일들을 각각 처리
          onProgress?.({ stage: "ingest", message: `압축 해제: ${file.name} (${names.length}개 항목)` });
          const inner: ExtractedDoc[] = [];
          let n = 0;
          for (const name of names) {
            const entry = zip.files[name];
            if (entry.dir) continue;
            if (/(^|\/)(__MACOSX|\.DS_Store|Thumbs\.db)/.test(name)) continue;
            if (++n > MAX_ARCHIVE_ENTRIES) {
              warnings.push(`압축 파일 항목이 많아 앞 ${MAX_ARCHIVE_ENTRIES}개만 읽었습니다.`);
              break;
            }
            const buf = new Uint8Array(await entry.async("uint8array"));
            const docs = await extractOne(
              session,
              { name: `${file.name}/${name}`, bytes: buf },
              `${sourceId}#${n}`,
              depth + 1,
              onProgress,
            );
            inner.push(...docs);
          }
          if (inner.length) return inner;
          warnings.push("압축 파일 안에서 읽을 수 있는 내용을 찾지 못했습니다.");
          return [base()];
        }
      } catch (e) {
        warnings.push(`압축 해제 실패: ${(e as Error).message}`);
      }
    } else {
      warnings.push("jszip 미설치 — 압축 파일을 열지 못했습니다.");
    }
  }

  switch (kind) {
    case "text":
    case "code": {
      const { text, encoding } = decodeText(bytes);
      metadata.encoding = encoding;
      const ext = extensionOf(file.name);
      let body = text;
      if (ext === "csv" || ext === "tsv") body = normalizeDelimited(text, file.name);
      else if (ext === "ipynb") body = notebookToText(text);
      else if (ext === "srt" || ext === "vtt") body = subtitlesToText(text);
      else if (ext === "rtf") body = text.replace(/\\[a-z]+-?\d*\s?/g, "").replace(/[{}]/g, "").trim();
      pages.push({ index: 1, text: body, method: "native" });
      break;
    }
    case "html": {
      const { text } = decodeText(bytes);
      pages.push({ index: 1, text: await htmlToText(text), method: "native" });
      break;
    }
    case "email": {
      const { text } = decodeText(bytes);
      const headerEnd = text.indexOf("\n\n");
      const head = headerEnd > 0 ? text.slice(0, headerEnd) : "";
      const bodyRaw = headerEnd > 0 ? text.slice(headerEnd) : text;
      for (const k of ["Subject", "From", "To", "Date"]) {
        const m = new RegExp(`^${k}:\\s*(.+)$`, "mi").exec(head);
        if (m) metadata[k.toLowerCase()] = m[1]!.trim();
      }
      pages.push({ index: 1, text: `${head}\n\n${await htmlToText(bodyRaw)}`, method: "native" });
      break;
    }
    case "pdf": {
      const r = await extractPdf(bytes);
      pages.push(...r.pages);
      Object.assign(metadata, r.metadata);
      warnings.push(...r.warnings);
      if (r.needsOcr.length) {
        onProgress?.({ stage: "ocr", message: `${file.name}: 스캔 페이지 ${r.needsOcr.length}장 OCR` });
        const confs: number[] = [];
        for (const page of r.needsOcr.slice(0, 25)) {
          const ocr = await ocrImage(session, page.image, { hint: `PDF ${file.name}의 ${page.index}쪽` });
          confs.push(ocr.confidence);
          warnings.push(...ocr.warnings.map((w) => `${page.index}쪽: ${w}`));
          const existing = pages.find((p) => p.index === page.index);
          if (existing && existing.text.replace(/\s/g, "").length < 40) {
            existing.text = ocr.text;
            existing.method = "ocr";
            existing.ocrConfidence = ocr.confidence;
          } else if (!existing) {
            pages.push({ index: page.index, text: ocr.text, method: "ocr", ocrConfidence: ocr.confidence });
          }
        }
        pages.sort((a, b) => a.index - b.index);
        if (confs.length) confidence = confs.reduce((a, b) => a + b, 0) / confs.length;
      }
      break;
    }
    case "docx": {
      const r = await extractDocx(bytes);
      pages.push(...r.pages); Object.assign(metadata, r.metadata); warnings.push(...r.warnings);
      break;
    }
    case "pptx": {
      const r = await extractPptx(bytes);
      pages.push(...r.pages); Object.assign(metadata, r.metadata); warnings.push(...r.warnings);
      break;
    }
    case "xlsx": {
      const r = await extractXlsx(bytes);
      pages.push(...r.pages); Object.assign(metadata, r.metadata); warnings.push(...r.warnings);
      break;
    }
    case "hwp": {
      const r = await extractHwp(bytes, file.name);
      pages.push(...r.pages); Object.assign(metadata, r.metadata); warnings.push(...r.warnings);
      break;
    }
    case "image": {
      const exif = sniffExifDate(bytes);
      if (exif) metadata.capturedAt = exif;
      const dim = await imageDimensions(bytes);
      if (dim.w) metadata.width = dim.w;
      if (dim.h) metadata.height = dim.h;
      onProgress?.({ stage: "ocr", message: `${file.name}: 이미지 OCR` });
      const ocr = await ocrImage(session, bytes, { hint: `파일명 ${file.name}` });
      pages.push({ index: 1, text: ocr.text, method: "ocr", ocrConfidence: ocr.confidence });
      warnings.push(...ocr.warnings);
      metadata.ocrEngines = ocr.engines.map((e) => `${e.engine}:${e.chars}`).join(", ");
      confidence = ocr.confidence;
      break;
    }
    case "audio": {
      const r = await extractAudio(bytes, file.name);
      pages.push(...r.pages); Object.assign(metadata, r.metadata); warnings.push(...r.warnings);
      confidence = r.pages.length ? 0.8 : 0.2;
      break;
    }
    case "video": {
      const r = await extractVideo(bytes, file.name);
      pages.push(...r.pages); Object.assign(metadata, r.metadata); warnings.push(...r.warnings);
      for (const [i, frame] of r.frames.entries()) {
        const ocr = await ocrImage(session, frame, { hint: `${file.name} 장면 ${i + 1}`, allowReread: false });
        if (ocr.text.trim()) {
          pages.push({
            index: 100 + i,
            text: `[장면 ${i + 1} 화면 텍스트]\n${ocr.text}`,
            method: "ocr",
            ocrConfidence: ocr.confidence,
          });
        }
      }
      confidence = pages.length ? 0.75 : 0.2;
      break;
    }
    default: {
      // 알 수 없는 형식 — 텍스트로 읽히면 텍스트로, 아니면 파일명만 근거로 남긴다
      if (looksLikeText(bytes)) {
        const { text } = decodeText(bytes);
        kind = "text";
        pages.push({ index: 1, text, method: "native" });
        warnings.push(`확장자를 알 수 없어 일반 텍스트로 읽었습니다: ${file.name}`);
      } else {
        kind = "unknown";
        confidence = 0.1;
        pages.push({
          index: 1,
          text: `[읽을 수 없는 파일] ${file.name} (${bytes.length.toLocaleString()} bytes)`,
          method: "metadata",
        });
        warnings.push(
          `지원하지 않는 형식입니다: ${file.name}. PDF·이미지·텍스트로 변환해 올리면 내용까지 반영됩니다.`,
        );
      }
    }
  }

  if (!joinPages(pages)) {
    warnings.push(`${file.name}에서 텍스트를 얻지 못했습니다.`);
    confidence = Math.min(confidence, 0.15);
  }
  return [base()];
}

/** 여러 파일을 병렬로 수집 */
export async function ingestFiles(
  session: LlmSession,
  files: InputFile[],
  onProgress?: ProgressHandler,
): Promise<ExtractedDoc[]> {
  onProgress?.({ stage: "ingest", message: `파일 ${files.length}개 수집 시작` });
  const results = await Promise.all(
    files.map((f, i) =>
      extractOne(session, f, `src${i + 1}`, 0, onProgress).catch((e): ExtractedDoc[] => [
        {
          sourceId: `src${i + 1}`,
          name: f.name,
          kind: "unknown",
          mimeType: f.mimeType ?? "application/octet-stream",
          bytesLength: f.bytes?.length ?? 0,
          text: "",
          pages: [],
          metadata: { fileName: f.name },
          warnings: [`처리 실패: ${(e as Error).message}`],
          confidence: 0,
        },
      ]),
    ),
  );
  const docs = results.flat();
  onProgress?.({
    stage: "ingest",
    message: `수집 완료: ${docs.length}개 문서, ${docs.reduce((a, d) => a + d.text.length, 0).toLocaleString()}자`,
    detail: docs.map((d) => ({ name: d.name, kind: d.kind, chars: d.text.length, confidence: d.confidence })),
  });
  return docs;
}

export * from "./detect.js";
