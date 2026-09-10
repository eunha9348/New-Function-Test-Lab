import { tryImport } from "../optional.js";

/** EUC-KR/CP949까지 감안한 디코딩. UTF-8이 깨지면 cp949로 재시도. */
export function decodeText(bytes: Uint8Array): { text: string; encoding: string } {
  const utf8 = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  const replacementRatio = (utf8.match(/�/g)?.length ?? 0) / Math.max(1, utf8.length);
  if (replacementRatio < 0.005) return { text: utf8, encoding: "utf-8" };
  for (const enc of ["euc-kr", "windows-949", "utf-16le"]) {
    try {
      const alt = new TextDecoder(enc as any, { fatal: false }).decode(bytes);
      const r = (alt.match(/�/g)?.length ?? 0) / Math.max(1, alt.length);
      if (r < replacementRatio) return { text: alt, encoding: enc };
    } catch {
      /* 지원 안 하는 인코딩은 건너뜀 */
    }
  }
  return { text: utf8, encoding: "utf-8(손실)" };
}

/** CSV/TSV를 표 형태로 정리 — 모델이 열 의미를 잡기 쉬워진다 */
export function normalizeDelimited(text: string, name: string): string {
  const delim = name.toLowerCase().endsWith(".tsv") ? "\t" : ",";
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  if (lines.length < 2) return text;
  const rows = lines.slice(0, 400).map((l) => l.split(delim));
  const header = rows[0]!;
  const body = rows.slice(1);
  const out = body.map((r) =>
    header.map((h, i) => `${h.trim()}: ${(r[i] ?? "").trim()}`).filter((s) => !s.endsWith(": ")).join(" | "),
  );
  const more = lines.length > 400 ? `\n… (총 ${lines.length - 1}행 중 앞 399행)` : "";
  return `[표: ${name}]\n열: ${header.join(" | ")}\n${out.join("\n")}${more}`;
}

/** .ipynb → 마크다운 셀 + 코드 셀 + 출력 */
export function notebookToText(raw: string): string {
  try {
    const nb = JSON.parse(raw);
    const parts: string[] = [];
    for (const cell of nb.cells ?? []) {
      const src = Array.isArray(cell.source) ? cell.source.join("") : String(cell.source ?? "");
      if (cell.cell_type === "markdown") parts.push(src);
      else if (cell.cell_type === "code") {
        parts.push("```\n" + src + "\n```");
        for (const o of cell.outputs ?? []) {
          const t = o.text ?? o.data?.["text/plain"];
          if (t) parts.push("출력: " + (Array.isArray(t) ? t.join("") : String(t)).slice(0, 800));
        }
      }
    }
    return parts.join("\n\n");
  } catch {
    return raw;
  }
}

/** HTML → 본문 텍스트 (스크립트/스타일 제거, 링크는 보존) */
export async function htmlToText(raw: string): Promise<string> {
  const mod = await tryImport<any>("node-html-parser");
  if (mod) {
    const root = mod.parse(raw, { blockTextElements: { script: false, style: false } });
    root.querySelectorAll("script,style,noscript,svg").forEach((n: any) => n.remove());
    const links = root
      .querySelectorAll("a[href]")
      .slice(0, 60)
      .map((a: any) => `${a.text.trim()} → ${a.getAttribute("href")}`)
      .filter((s: string) => !s.startsWith("→"));
    const body = root.textContent.replace(/\n{3,}/g, "\n\n").trim();
    return links.length ? `${body}\n\n[링크]\n${links.join("\n")}` : body;
  }
  // 폴백: 태그 제거
  return raw
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|tr|h[1-6])>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** 자막(SRT/VTT) → 타임코드 제거한 대사 */
export function subtitlesToText(raw: string): string {
  return raw
    .split(/\r?\n/)
    .filter((l) => !/^\d+$/.test(l.trim()))
    .filter((l) => !/-->/.test(l))
    .filter((l) => !/^WEBVTT/.test(l.trim()))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
