import { PIPELINE } from "../config.js";
import { SourceIndex, fold, ngrams } from "../ragkor/index.js";
import type { ExtractedDoc, FieldValue } from "../types.js";
import { getByPath, leafPaths } from "../util/path.js";

/**
 * 모델에 넘길 근거 묶음.
 * 파일마다 sourceId를 붙여 두면 추출 결과에 "어느 파일 몇 줄" 근거를 달 수 있고,
 * 감독 에이전트가 그 근거를 원문과 대조할 수 있다.
 */
export function buildEvidenceBundle(docs: ExtractedDoc[]): string {
  const budget = PIPELINE.maxEvidenceChars;
  const totalChars = docs.reduce((a, d) => a + d.text.length, 0);
  // 문서별 예산을 길이 비례로 배분하되, 짧은 문서는 통째로 살린다
  const parts: string[] = [];

  for (const d of docs) {
    const share =
      totalChars <= budget
        ? d.text.length
        : Math.max(2000, Math.floor((d.text.length / totalChars) * budget));
    const body = d.text.length <= share ? d.text : clip(d.text, share);
    const meta = Object.entries(d.metadata)
      .filter(([k]) => k !== "fileName")
      .map(([k, v]) => `${k}=${v}`)
      .join(", ");
    const quality =
      d.confidence >= 0.85
        ? "높음"
        : d.confidence >= 0.6
          ? "보통 (OCR 오독 가능)"
          : "낮음 (오독 주의 — 이 문서만 근거인 값은 신뢰도를 낮게 줄 것)";

    parts.push(
      [
        `<<<파일 sourceId=${d.sourceId} 이름="${d.name}" 형식=${d.kind} 텍스트품질=${quality}>>>`,
        meta ? `[메타데이터] ${meta}` : "",
        d.warnings.length ? `[경고] ${d.warnings.join(" / ")}` : "",
        body || "(텍스트 없음)",
        `<<<파일 끝 sourceId=${d.sourceId}>>>`,
      ]
        .filter(Boolean)
        .join("\n"),
    );
  }
  return parts.join("\n\n");
}

/** 앞·뒤를 살리고 가운데를 접는다 — 문서는 보통 앞뒤에 핵심이 있다 */
function clip(text: string, budget: number): string {
  const head = Math.floor(budget * 0.62);
  const tail = budget - head - 60;
  return `${text.slice(0, head)}\n\n…(중략: ${(text.length - head - tail).toLocaleString()}자 생략)…\n\n${text.slice(-tail)}`;
}

/** 분류 단계용 축약본 — 전체를 다 볼 필요 없이 앞부분과 파일 목록이면 충분하다 */
export function buildClassificationDigest(docs: ExtractedDoc[]): string {
  const list = docs
    .map(
      (d) =>
        `- ${d.name} (${d.kind}, ${d.text.length.toLocaleString()}자, 품질 ${(d.confidence * 100).toFixed(0)}%)`,
    )
    .join("\n");
  const snippets = docs
    .map((d) => `[${d.sourceId} ${d.name}]\n${d.text.slice(0, 6000)}`)
    .join("\n\n");
  return `[업로드된 파일 목록]\n${list}\n\n[본문 발췌]\n${snippets}`;
}


/**
 * 감독용 근거 압축 — 전체 문서 대신 '관련 구간'만 보낸다.
 *
 * 채워진 값의 근거 주변만 잘라 모은다. 실제 문서에서 감독 입력이 31k → 3k자로 줄었고,
 * 그만큼 상위 모델 토큰이 빠진다. 비용 절감의 가장 큰 항목이다.
 */
export function evidenceSpans(
  docs: ExtractedDoc[],
  values: Record<string, unknown>,
  provenance: FieldValue[],
  idx: SourceIndex,
  budget: number = PIPELINE.supervisorEvidenceChars,
): string {
  const raw = docs.map((d) => d.text).join("\n");
  const picked: [number, number][] = [];
  const ratio = raw.length / Math.max(1, idx.folded.length);

  const mark = (needle: string, pad = 260) => {
    const f = fold(needle);
    if (f.length < 6) return;
    let pos = idx.folded.indexOf(f.slice(0, 60));
    if (pos < 0) {
      for (const g of ngrams(needle, 4).slice(0, 12)) {
        const hit = idx.postings.get(g);
        if (hit?.length) { pos = hit[0]!; break; }
      }
    }
    if (pos < 0) return;
    const c = Math.floor(pos * ratio);
    picked.push([Math.max(0, c - pad), Math.min(raw.length, c + needle.length + pad)]);
  };

  for (const p of provenance) for (const q of p.quotes) mark(q.text);
  for (const path of leafPaths(values).slice(0, 120)) {
    const v = getByPath(values, path);
    if (typeof v === "string" && v.length > 12) mark(v, 180);
  }

  if (!picked.length) return raw.slice(0, budget);
  picked.sort((a, b) => a[0] - b[0]);
  const merged: [number, number][] = [];
  for (const [a, b] of picked) {
    const last = merged[merged.length - 1];
    if (last && a <= last[1] + 120) last[1] = Math.max(last[1], b);
    else merged.push([a, b]);
  }

  const out: string[] = [];
  let total = 0;
  for (const [a, b] of merged) {
    let chunk = raw.slice(a, b);
    if (total + chunk.length > budget) chunk = chunk.slice(0, Math.max(0, budget - total));
    if (chunk) { out.push(chunk); total += chunk.length; }
    if (total >= budget) break;
  }
  return out.join("…\n");
}
