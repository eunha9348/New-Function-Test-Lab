import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ExtractedPage } from "../../types.js";
import { hasBinary, run, tryImport } from "../optional.js";
import { decodeText } from "./text-like.js";

export interface DocExtraction {
  pages: ExtractedPage[];
  metadata: Record<string, string | number>;
  warnings: string[];
  /** OCR이 필요한 페이지 이미지 (PDF 스캔본 등) */
  needsOcr: { index: number; image: Uint8Array }[];
}

const empty = (): DocExtraction => ({ pages: [], metadata: {}, warnings: [], needsOcr: [] });

async function tmpWrite(bytes: Uint8Array, ext: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "arc-ingest-"));
  const file = path.join(dir, `input.${ext}`);
  await fs.writeFile(file, bytes);
  return file;
}

/* ─────────────────────────── PDF ─────────────────────────── */

/**
 * PDF는 두 갈래다.
 *  ① 텍스트 레이어가 있는 PDF → 그대로 뽑는다 (OCR보다 항상 정확)
 *  ② 스캔·사진 PDF          → 페이지를 300DPI 이미지로 렌더해 OCR로 넘긴다
 * 페이지별 텍스트 밀도를 재서 ②에 해당하는 페이지만 골라 OCR한다.
 */
export async function extractPdf(bytes: Uint8Array): Promise<DocExtraction> {
  const out = empty();
  const pdfjs = await tryImport<any>("pdfjs-dist/legacy/build/pdf.mjs");
  const lowTextPages: number[] = [];

  if (pdfjs) {
    try {
      const doc = await pdfjs.getDocument({
        data: bytes,
        useSystemFonts: true,
        isEvalSupported: false,
      }).promise;
      const meta = await doc.getMetadata().catch(() => null);
      if (meta?.info?.Title) out.metadata.title = String(meta.info.Title);
      if (meta?.info?.Author) out.metadata.author = String(meta.info.Author);
      if (meta?.info?.CreationDate) out.metadata.createdAt = String(meta.info.CreationDate);
      out.metadata.pageCount = doc.numPages;

      for (let i = 1; i <= doc.numPages; i++) {
        const page = await doc.getPage(i);
        const content = await page.getTextContent();
        const text = content.items
          .map((it: any) => (typeof it.str === "string" ? it.str : ""))
          .join(" ")
          .replace(/\s{2,}/g, " ")
          .trim();
        out.pages.push({ index: i, text, method: "native" });
        if (text.replace(/\s/g, "").length < 40) lowTextPages.push(i);
      }
    } catch (e) {
      out.warnings.push(`PDF 텍스트 추출 실패: ${(e as Error).message}`);
    }
  } else {
    out.warnings.push("pdfjs-dist 미설치 — PDF 전체를 OCR로 처리합니다.");
  }

  const needOcrPages =
    out.pages.length === 0
      ? null // 전체 페이지 OCR
      : lowTextPages;

  if (needOcrPages === null || needOcrPages.length > 0) {
    const rendered = await renderPdfPages(bytes, needOcrPages ?? undefined);
    out.warnings.push(...rendered.warnings);
    for (const r of rendered.images) {
      out.needsOcr.push({ index: r.index, image: r.image });
    }
    if (rendered.images.length === 0 && (needOcrPages === null || needOcrPages.length > 0)) {
      out.warnings.push(
        "스캔 PDF로 보이지만 페이지를 이미지로 변환하지 못했습니다. poppler(pdftoppm) 설치 시 자동 OCR됩니다.",
      );
    }
  }
  return out;
}

/** poppler(pdftoppm) → ImageMagick 순으로 시도해 페이지를 PNG로 렌더 */
async function renderPdfPages(
  bytes: Uint8Array,
  onlyPages?: number[],
): Promise<{ images: { index: number; image: Uint8Array }[]; warnings: string[] }> {
  const warnings: string[] = [];
  const images: { index: number; image: Uint8Array }[] = [];
  const usePoppler = await hasBinary("pdftoppm");
  if (!usePoppler) {
    const magick = (await hasBinary("magick")) || (await hasBinary("convert"));
    if (!magick) return { images, warnings };
  }
  let file = "";
  try {
    file = await tmpWrite(bytes, "pdf");
    const dir = path.dirname(file);
    const prefix = path.join(dir, "page");
    const targets = onlyPages && onlyPages.length <= 40 ? onlyPages : undefined;

    if (usePoppler) {
      if (targets) {
        for (const p of targets) {
          await run("pdftoppm", ["-r", "300", "-png", "-f", String(p), "-l", String(p), file, `${prefix}-${p}`]);
        }
      } else {
        await run("pdftoppm", ["-r", "300", "-png", "-l", "40", file, prefix], 300_000);
      }
    } else {
      const bin = (await hasBinary("magick")) ? "magick" : "convert";
      await run(bin, ["-density", "300", file, `${prefix}.png`], 300_000);
    }

    const files = (await fs.readdir(dir)).filter((f) => f.endsWith(".png")).sort();
    for (const f of files) {
      const m = /(\d+)\.png$/.exec(f);
      images.push({
        index: m ? Number(m[1]) : images.length + 1,
        image: new Uint8Array(await fs.readFile(path.join(dir, f))),
      });
    }
  } catch (e) {
    warnings.push(`PDF 페이지 렌더 실패: ${(e as Error).message}`);
  } finally {
    if (file) await fs.rm(path.dirname(file), { recursive: true, force: true }).catch(() => {});
  }
  return { images, warnings };
}

/* ─────────────────────── DOCX / ODT ─────────────────────── */

export async function extractDocx(bytes: Uint8Array): Promise<DocExtraction> {
  const out = empty();
  const mammoth = await tryImport<any>("mammoth");
  if (mammoth) {
    try {
      const r = await (mammoth.default ?? mammoth).extractRawText({ buffer: Buffer.from(bytes) });
      out.pages.push({ index: 1, text: String(r.value ?? "").trim(), method: "native" });
      for (const m of r.messages ?? []) if (m.type === "warning") out.warnings.push(String(m.message));
      return out;
    } catch (e) {
      out.warnings.push(`mammoth 실패: ${(e as Error).message}`);
    }
  }
  // 폴백: zip에서 word/document.xml 직접 파싱
  const xml = await readZipEntry(bytes, "word/document.xml");
  if (xml) {
    out.pages.push({ index: 1, text: ooxmlToText(xml), method: "native" });
  } else {
    out.warnings.push("DOCX 본문을 읽지 못했습니다. `npm i mammoth`를 설치하면 표·목록까지 복원됩니다.");
  }
  return out;
}

/* ────────────────────────── PPTX ────────────────────────── */

export async function extractPptx(bytes: Uint8Array): Promise<DocExtraction> {
  const out = empty();
  const jszip = await tryImport<any>("jszip");
  if (!jszip) {
    out.warnings.push("jszip 미설치 — PPTX 본문을 읽지 못했습니다.");
    return out;
  }
  try {
    const zip = await (jszip.default ?? jszip).loadAsync(Buffer.from(bytes));
    const slideNames = Object.keys(zip.files)
      .filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n))
      .sort((a, b) => Number(/(\d+)/.exec(a)![1]) - Number(/(\d+)/.exec(b)![1]));
    for (const [i, name] of slideNames.entries()) {
      const xml = await zip.files[name].async("string");
      const body = ooxmlToText(xml);
      // 발표자 노트도 중요한 근거가 된다
      const noteName = `ppt/notesSlides/notesSlide${i + 1}.xml`;
      let note = "";
      if (zip.files[noteName]) note = ooxmlToText(await zip.files[noteName].async("string"));
      out.pages.push({
        index: i + 1,
        text: `[슬라이드 ${i + 1}]\n${body}${note ? `\n[발표자 노트]\n${note}` : ""}`,
        method: "native",
      });
    }
    out.metadata.slideCount = slideNames.length;
  } catch (e) {
    out.warnings.push(`PPTX 파싱 실패: ${(e as Error).message}`);
  }
  return out;
}

/* ────────────────────────── XLSX ────────────────────────── */

export async function extractXlsx(bytes: Uint8Array): Promise<DocExtraction> {
  const out = empty();
  const xlsxMod = await tryImport<any>("xlsx");
  if (!xlsxMod) {
    out.warnings.push("xlsx 미설치 — 스프레드시트 본문을 읽지 못했습니다.");
    return out;
  }
  try {
    const XLSX = xlsxMod.default ?? xlsxMod;
    const wb = XLSX.read(bytes, { type: "array", cellDates: true });
    for (const [i, sheetName] of (wb.SheetNames as string[]).entries()) {
      const sheet = wb.Sheets[sheetName];
      const rows: any[][] = XLSX.utils.sheet_to_json(sheet, { header: 1, blankrows: false, raw: false });
      const lines = rows.slice(0, 500).map((r) => r.map((c) => (c ?? "").toString().trim()).join(" | "));
      out.pages.push({
        index: i + 1,
        text: `[시트: ${sheetName}]\n${lines.join("\n")}${rows.length > 500 ? `\n… (총 ${rows.length}행)` : ""}`,
        method: "native",
      });
    }
    out.metadata.sheetCount = wb.SheetNames.length;
  } catch (e) {
    out.warnings.push(`스프레드시트 파싱 실패: ${(e as Error).message}`);
  }
  return out;
}

/* ─────────────────────── HWP / HWPX ─────────────────────── */

export async function extractHwp(bytes: Uint8Array, name: string): Promise<DocExtraction> {
  const out = empty();
  const isHwpx = name.toLowerCase().endsWith(".hwpx") || bytes[0] === 0x50;

  if (isHwpx) {
    // HWPX는 ZIP + XML — 표준 파서 없이도 텍스트를 건질 수 있다
    const jszip = await tryImport<any>("jszip");
    if (jszip) {
      try {
        const zip = await (jszip.default ?? jszip).loadAsync(Buffer.from(bytes));
        const sections = Object.keys(zip.files)
          .filter((n) => /Contents\/section\d+\.xml$/.test(n))
          .sort();
        for (const [i, n] of sections.entries()) {
          const xml = await zip.files[n].async("string");
          out.pages.push({ index: i + 1, text: hwpxToText(xml), method: "native" });
        }
        if (out.pages.length) return out;
      } catch (e) {
        out.warnings.push(`HWPX 파싱 실패: ${(e as Error).message}`);
      }
    }
  }

  // 구형 HWP(OLE2): hwp.js가 있으면 사용, 없으면 외부 변환기 시도
  const hwpjs = await tryImport<any>("hwp.js");
  if (hwpjs) {
    try {
      const parse = (hwpjs.default ?? hwpjs).parse ?? hwpjs.parse;
      const doc = parse(Buffer.from(bytes));
      const text = JSON.stringify(doc)
        .match(/"text":"(.*?)"/g)
        ?.map((s) => s.slice(8, -1))
        .join("\n");
      if (text) {
        out.pages.push({ index: 1, text, method: "native" });
        return out;
      }
    } catch (e) {
      out.warnings.push(`hwp.js 파싱 실패: ${(e as Error).message}`);
    }
  }
  if (await hasBinary("hwp5txt")) {
    let file = "";
    try {
      file = await tmpWrite(bytes, "hwp");
      const { stdout } = await run("hwp5txt", [file]);
      out.pages.push({ index: 1, text: stdout.trim(), method: "native" });
      return out;
    } catch (e) {
      out.warnings.push(`hwp5txt 실패: ${(e as Error).message}`);
    } finally {
      if (file) await fs.rm(path.dirname(file), { recursive: true, force: true }).catch(() => {});
    }
  }
  out.warnings.push(
    "HWP 본문을 읽지 못했습니다. PDF로 저장해 다시 올리면 정확히 인식됩니다. (또는 `pip install pyhwp` 설치)",
  );
  return out;
}

/* ────────────────────────── 유틸 ────────────────────────── */

async function readZipEntry(bytes: Uint8Array, entry: string): Promise<string | null> {
  const jszip = await tryImport<any>("jszip");
  if (!jszip) return null;
  try {
    const zip = await (jszip.default ?? jszip).loadAsync(Buffer.from(bytes));
    if (!zip.files[entry]) return null;
    return await zip.files[entry].async("string");
  } catch {
    return null;
  }
}

/** OOXML 조각 → 문단 단위 텍스트 (표는 셀 구분자 유지) */
export function ooxmlToText(xml: string): string {
  return xml
    .replace(/<w:tab\/>|<a:tab\/>/g, "\t")
    .replace(/<\/a:p>|<\/w:p>/g, "\n")
    .replace(/<\/a:tc>|<\/w:tc>/g, " | ")
    .replace(/<\/a:tr>|<\/w:tr>/g, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function hwpxToText(xml: string): string {
  return xml
    .replace(/<hp:tab[^>]*\/>/g, "\t")
    .replace(/<\/hp:p>/g, "\n")
    .replace(/<\/hp:tc>/g, " | ")
    .replace(/<\/hp:tr>/g, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export { decodeText };
