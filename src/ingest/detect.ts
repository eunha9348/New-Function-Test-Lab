import type { SourceKind } from "../types.js";

const EXT_MAP: Record<string, SourceKind> = {
  txt: "text", md: "text", markdown: "text", rst: "text", log: "text",
  csv: "text", tsv: "text", json: "text", jsonl: "text", yaml: "text", yml: "text",
  srt: "text", vtt: "text", ics: "text", rtf: "text", tex: "text",
  ts: "code", tsx: "code", js: "code", jsx: "code", py: "code", java: "code",
  go: "code", rb: "code", c: "code", h: "code", cpp: "code", cs: "code",
  php: "code", swift: "code", kt: "code", rs: "code", sql: "code", sh: "code",
  css: "code", scss: "code", vue: "code", svelte: "code", ipynb: "code",
  pdf: "pdf",
  docx: "docx", doc: "docx", odt: "docx",
  pptx: "pptx", ppt: "pptx", odp: "pptx", key: "pptx",
  xlsx: "xlsx", xls: "xlsx", ods: "xlsx", numbers: "xlsx",
  hwp: "hwp", hwpx: "hwp",
  png: "image", jpg: "image", jpeg: "image", webp: "image", gif: "image",
  bmp: "image", tif: "image", tiff: "image", heic: "image", heif: "image", avif: "image",
  mp3: "audio", m4a: "audio", wav: "audio", flac: "audio", ogg: "audio", aac: "audio", wma: "audio",
  mp4: "video", mov: "video", avi: "video", mkv: "video", webm: "video", m4v: "video",
  zip: "archive", tar: "archive", gz: "archive", tgz: "archive", "7z": "archive", rar: "archive",
  html: "html", htm: "html", mhtml: "html", xml: "html",
  eml: "email", msg: "email",
};

const MIME_MAP: [RegExp, SourceKind][] = [
  [/^application\/pdf/, "pdf"],
  [/wordprocessingml|msword|opendocument\.text/, "docx"],
  [/presentationml|ms-powerpoint|opendocument\.presentation/, "pptx"],
  [/spreadsheetml|ms-excel|opendocument\.spreadsheet/, "xlsx"],
  [/^image\//, "image"],
  [/^audio\//, "audio"],
  [/^video\//, "video"],
  [/zip|x-tar|gzip|x-7z|rar/, "archive"],
  [/^text\/html|xml/, "html"],
  [/^message\/rfc822/, "email"],
  [/^text\//, "text"],
];

/** 매직 넘버 (확장자가 없거나 틀린 경우 대비) */
function sniff(bytes?: Uint8Array): SourceKind | null {
  if (!bytes || bytes.length < 8) return null;
  const b = bytes;
  const startsWith = (...sig: number[]) => sig.every((v, i) => b[i] === v);
  if (startsWith(0x25, 0x50, 0x44, 0x46)) return "pdf"; // %PDF
  if (startsWith(0x89, 0x50, 0x4e, 0x47)) return "image"; // PNG
  if (startsWith(0xff, 0xd8, 0xff)) return "image"; // JPEG
  if (startsWith(0x47, 0x49, 0x46, 0x38)) return "image"; // GIF
  if (startsWith(0x42, 0x4d)) return "image"; // BMP
  if (startsWith(0x49, 0x49, 0x2a, 0x00) || startsWith(0x4d, 0x4d, 0x00, 0x2a)) return "image"; // TIFF
  if (startsWith(0x1f, 0x8b)) return "archive"; // gzip
  if (startsWith(0xd0, 0xcf, 0x11, 0xe0)) return "hwp"; // OLE2 (구 hwp/doc/xls)
  if (startsWith(0x50, 0x4b, 0x03, 0x04)) return "archive"; // zip 계열 (docx/xlsx/pptx/hwpx 포함)
  if (startsWith(0x52, 0x49, 0x46, 0x46)) return "audio"; // RIFF/WAV
  return null;
}

/** ZIP 컨테이너 내부를 보고 OOXML 계열을 구분 */
export function refineZip(names: string[]): SourceKind {
  if (names.some((n) => n.startsWith("word/"))) return "docx";
  if (names.some((n) => n.startsWith("ppt/"))) return "pptx";
  if (names.some((n) => n.startsWith("xl/"))) return "xlsx";
  if (names.some((n) => n.includes("Contents/section") || n === "version.xml")) return "hwp";
  if (names.some((n) => n === "mimetype" || n.startsWith("META-INF/"))) return "docx";
  return "archive";
}

export function extensionOf(name: string): string {
  const m = /\.([A-Za-z0-9]+)$/.exec(name.trim());
  return m ? m[1]!.toLowerCase() : "";
}

export function detectKind(name: string, mimeType?: string, bytes?: Uint8Array): SourceKind {
  const ext = extensionOf(name);
  const byExt = EXT_MAP[ext];
  const sniffed = sniff(bytes);

  // 확장자와 매직넘버가 충돌하면 매직넘버를 신뢰하되, zip은 확장자 쪽이 더 구체적이다.
  if (sniffed && sniffed !== "archive" && byExt && sniffed !== byExt) {
    if (sniffed === "hwp" && (byExt === "docx" || byExt === "xlsx")) return byExt;
    return sniffed;
  }
  if (byExt) return byExt;
  if (sniffed) return sniffed;

  if (mimeType) {
    for (const [re, kind] of MIME_MAP) if (re.test(mimeType)) return kind;
  }
  // 확장자 없음 + 시그니처 없음 → 텍스트인지 바이트로 판단
  if (bytes && looksLikeText(bytes)) return "text";
  return "unknown";
}

/** 앞 4KB에 제어문자가 거의 없으면 텍스트로 본다 (UTF-8/EUC-KR 모두 통과) */
export function looksLikeText(bytes: Uint8Array): boolean {
  const n = Math.min(bytes.length, 4096);
  if (n === 0) return false;
  let ctrl = 0;
  for (let i = 0; i < n; i++) {
    const c = bytes[i]!;
    if (c === 0) return false;
    if (c < 9 || (c > 13 && c < 32)) ctrl++;
  }
  return ctrl / n < 0.02;
}

export function guessMime(kind: SourceKind, name: string): string {
  const ext = extensionOf(name);
  const table: Record<string, string> = {
    png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp",
    gif: "image/gif", pdf: "application/pdf",
  };
  return table[ext] ?? (kind === "image" ? "image/png" : "application/octet-stream");
}
