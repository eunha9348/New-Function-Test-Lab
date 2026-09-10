import { labelForPath } from "../schema/index.js";
import type { ExperienceTypeSpec, ExtractedDoc, FieldValue, ReviewIssue } from "../types.js";
import { getByPath, leafPaths } from "../util/path.js";

/** 비교용 정규화 — 공백·구두점을 지우고 소문자화 */
function norm(s: string): string {
  return s.replace(/[\s​]+/g, "").replace(/[.,·:;'"“”‘’()[\]{}\-—_/\\|]/g, "").toLowerCase();
}

/**
 * 환각 탐지 — 값 안의 '검증 가능한 토큰'이 원문에 실제로 있는지 대조한다.
 * 서술형 요약은 표현이 바뀌므로 문장 전체를 대조하지 않고
 *   · 숫자(수치·연도·퍼센트·금액)
 *   · 영문 고유명사 후보
 *   · 한글 3자 이상 기관/제품명 후보
 * 만 골라서 확인한다. 이게 실제로 지어낸 값이 새어나가는 주 경로다.
 */
export function checkGrounding(
  type: ExperienceTypeSpec,
  values: Record<string, unknown>,
  provenance: FieldValue[],
  docs: ExtractedDoc[],
): ReviewIssue[] {
  const issues: ReviewIssue[] = [];
  const sourceNorm = norm(docs.map((d) => d.text).join("\n"));
  const fileNames = docs.map((d) => d.name);
  const provByPath = new Map(provenance.map((p) => [p.path, p]));

  // 1) 근거 문장(quote)이 실제 원문에 존재하는가
  for (const p of provenance) {
    for (const q of p.quotes) {
      const nq = norm(q.text);
      if (nq.length >= 8 && !sourceNorm.includes(nq)) {
        issues.push({
          severity: "blocker",
          type: "hallucination",
          path: p.path,
          detail: `'${labelForPath(type, p.path)}'의 근거로 제시된 문장이 원문에 없습니다: "${q.text.slice(0, 60)}…"`,
          foundBy: "validator",
        });
      }
    }
  }

  // 2) 값 안의 숫자·고유명사가 원문에 있는가
  for (const path of leafPaths(values)) {
    const v = getByPath(values, path);
    if (typeof v !== "string" || !v.trim()) continue;

    const fieldKey = path.split(".").pop()!.replace(/\[\d+\]$/, "");
    // 파일 항목은 업로드 파일명과 대조
    if (/evidence|certificate|file|transcript|screenshots?|submission|artifacts|attachment/i.test(fieldKey)) {
      if (!fileNames.some((n) => n.includes(v.trim()) || v.includes(n))) {
        issues.push({
          severity: "major",
          type: "hallucination",
          path,
          detail: `'${labelForPath(type, path)}'에 적힌 파일명 "${v}"이 업로드된 파일 목록에 없습니다. 업로드: ${fileNames.join(", ")}`,
          suggestedValue: null,
          foundBy: "validator",
        });
      }
      continue;
    }

    const numbers = v.match(/\d[\d,.]*%?/g) ?? [];
    for (const raw of numbers) {
      const n = norm(raw);
      if (n.length < 2) continue; // 한 자리 숫자는 오탐이 많다
      if (!sourceNorm.includes(n)) {
        issues.push({
          severity: "major",
          type: "hallucination",
          path,
          detail: `'${labelForPath(type, path)}'의 수치 "${raw}"가 원문에서 확인되지 않습니다. 원문에 없는 숫자는 빼야 합니다.`,
          foundBy: "validator",
        });
      }
    }

    const latin = v.match(/[A-Za-z][A-Za-z0-9+#.]{2,}/g) ?? [];
    for (const token of latin) {
      if (COMMON_LATIN.has(token.toLowerCase())) continue;
      if (!sourceNorm.includes(norm(token))) {
        issues.push({
          severity: "minor",
          type: "hallucination",
          path,
          detail: `'${labelForPath(type, path)}'의 "${token}"이 원문에서 확인되지 않습니다.`,
          foundBy: "validator",
        });
      }
    }

    // 근거가 아예 없는 값 (repeater 하위는 부모 경로 근거도 인정)
    const hasProv =
      provByPath.has(path) ||
      [...provByPath.keys()].some((k) => path.startsWith(k) || k.startsWith(path));
    if (!hasProv && v.trim().length > 25) {
      issues.push({
        severity: "minor",
        type: "hallucination",
        path,
        detail: `'${labelForPath(type, path)}'에 근거(quote)가 붙어 있지 않습니다. 원문 근거를 확인하거나 비워야 합니다.`,
        foundBy: "validator",
      });
    }
  }

  return dedupe(issues);
}

/** 요약·설명에 흔히 등장해 오탐을 부르는 일반 영단어 */
const COMMON_LATIN = new Set([
  "and", "the", "for", "with", "from", "team", "project", "data", "web", "app",
  "api", "ui", "ux", "pm", "qa", "ai", "ml", "it", "hr", "ceo", "cto", "kpi", "roi",
  "pdf", "png", "jpg", "url", "http", "https", "www", "com", "net", "org",
]);

function dedupe(issues: ReviewIssue[]): ReviewIssue[] {
  const seen = new Set<string>();
  return issues.filter((i) => {
    const k = `${i.path}|${i.type}|${i.detail}`;
    return seen.has(k) ? false : (seen.add(k), true);
  });
}
