import { PIPELINE } from "../config.js";
import type { ExtractedDoc } from "../types.js";

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
