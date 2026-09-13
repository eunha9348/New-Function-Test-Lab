import { labelForPath } from "../schema/index.js";
import { SourceIndex } from "../ragkor/index.js";
import type { ExperienceTypeSpec, ExtractedDoc, FieldValue, ReviewIssue } from "../types.js";
import { getByPath, leafPaths } from "../util/path.js";

/**
 * 환각 탐지 — RAGKOR 기반.
 *
 * 예전에는 `정규화(quote) in 정규화(원문)` 이었다. 모델이 인용을 조금만 다듬어도
 * (말줄임표, 표 재구성, 페이지 머리말) 전부 환각으로 튀었고, 그 오탐이 감독에게
 * 흘러가 재작업을 유발했다. 실제 실행에서 검증기 지적이 8 → 10 → 13건으로
 * **늘어나며** 충실도가 50 → 30 → 50으로 떨어졌다.
 *
 * 지금은 n-gram 국소 밀도로 '원문 어딘가에 이어진 형태로 존재하는가'를 재고,
 * 수치는 원문값/파생값/근거없음 3단으로 가른다.
 */
export function checkGrounding(
  type: ExperienceTypeSpec,
  values: Record<string, unknown>,
  provenance: FieldValue[],
  docs: ExtractedDoc[],
  index?: SourceIndex,
): ReviewIssue[] {
  const idx = index ?? new SourceIndex(docs.map((d) => d.text));
  const issues: ReviewIssue[] = [];
  const seen = new Set<string>();
  const fileNames = docs.map((d) => d.name);

  const add = (
    severity: ReviewIssue["severity"],
    path: string,
    detail: string,
    kind: ReviewIssue["type"] = "hallucination",
  ) => {
    const key = `${path}|${detail}`;
    if (seen.has(key)) return;
    seen.add(key);
    issues.push({ severity, type: kind, path, detail, foundBy: "validator" });
  };

  // 1) 근거 문장이 원문에 실제로 있는가
  for (const p of provenance) {
    for (const q of p.quotes) {
      const r = idx.verifyQuote(q.text);
      if (r.verdict === "ungrounded") {
        add("blocker", p.path,
          `'${labelForPath(type, p.path)}'의 근거 문장이 원문에서 확인되지 않습니다` +
          `(일치도 ${Math.round(r.score * 100)}%): "${q.text.slice(0, 60)}"`);
      } else if (r.where === "내용 없음") {
        add("minor", p.path,
          `'${labelForPath(type, p.path)}'의 근거로 제시된 문장에 내용이 없습니다` +
          `("${q.text.slice(0, 30)}"). 실제 원문 문장을 근거로 달아야 합니다.`);
      } else if (r.verdict === "weak") {
        add("minor", p.path,
          `'${labelForPath(type, p.path)}'의 근거가 원문과 부분적으로만 일치합니다` +
          `(일치도 ${Math.round(r.score * 100)}%). 표현이 바뀌었는지 확인하세요.`);
      }
    }
  }

  const provPaths = provenance.map((p) => p.path);

  for (const path of leafPaths(values)) {
    const v = getByPath(values, path);
    if (typeof v !== "string" || !v.trim()) continue;
    const fieldKey = path.split(".").pop()!.replace(/\[\d+\]$/, "");

    // 2) 파일 항목은 업로드 목록과 대조
    if (/evidence|certificate|file|transcript|screenshots?|submission|artifacts|attachment/i.test(fieldKey)) {
      if (!fileNames.some((n) => n.includes(v.trim()) || v.includes(n))) {
        add("major", path,
          `'${labelForPath(type, path)}'에 적힌 파일명 "${v}"이 업로드된 파일 목록에 없습니다. ` +
          `업로드: ${fileNames.join(", ")}`);
      }
      continue;
    }

    // 3) 수치 — 원문값 / 파생값 / 근거없음
    for (const raw of v.match(/\d[\d,]*(?:\.\d+)?/g) ?? []) {
      if (raw.replace(/,/g, "").length < 2) continue;
      const kind = idx.classifyNumber(raw);
      if (kind === "unknown") {
        add("major", path,
          `'${labelForPath(type, path)}'의 수치 "${raw}"가 원문에서 확인되지 않습니다. ` +
          "원문에 없는 숫자는 빼야 합니다.");
      }
      // derived(원문 수치에서 계산된 값)는 통과시킨다 — 예전엔 이것까지 환각으로 지웠다
    }

    // 4) 고유명사·용어 — 유의어와 오타를 허용하고도 못 찾을 때만 지적
    for (const token of v.match(/[A-Za-z][A-Za-z0-9+#.]{2,}|[가-힣]{3,}/g) ?? []) {
      if (COMMON_LATIN.has(token.toLowerCase())) continue;
      if (!idx.checkTerm(token)) {
        add("minor", path, `'${labelForPath(type, path)}'의 "${token}"이 원문에서 확인되지 않습니다.`);
      }
    }

    // 5) 근거가 아예 없는 긴 값
    const hasProv = provPaths.some((k) => path.startsWith(k) || k.startsWith(path));
    if (!hasProv && v.trim().length > 25) {
      add("minor", path, `'${labelForPath(type, path)}'에 근거(quote)가 붙어 있지 않습니다.`);
    }
  }

  return issues;
}

/** 요약·설명에 흔히 등장해 오탐을 부르는 일반 영단어 */
const COMMON_LATIN = new Set([
  "and", "the", "for", "with", "from", "team", "project", "data", "web", "app",
  "api", "ui", "ux", "pm", "qa", "ai", "ml", "it", "hr", "ceo", "cto", "kpi", "roi",
  "pdf", "png", "jpg", "url", "http", "https", "www", "com", "net", "org",
]);

export { SourceIndex };
