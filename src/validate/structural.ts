import { allFieldsFor, labelForPath } from "../schema/index.js";
import type { ExperienceTypeSpec, FieldSpec, ReviewIssue } from "../types.js";
import { isEmptyValue } from "../util/path.js";

const DATE_RE = /^(19|20)\d{2}(-(0[1-9]|1[0-2])(-(0[1-9]|[12]\d|3[01]))?)?$/;
const URL_RE = /^(https?:\/\/|www\.)\S+$/i;

/**
 * 결정론적 형식 검증.
 * LLM 감독에게 넘기기 전에 기계가 잡을 수 있는 건 기계가 잡는다 —
 * 감독 에이전트는 '의미'에만 집중하게 만들어 정확도와 비용을 동시에 잡는다.
 */
export function validateStructure(
  type: ExperienceTypeSpec,
  values: Record<string, unknown>,
): ReviewIssue[] {
  const issues: ReviewIssue[] = [];
  const push = (
    severity: ReviewIssue["severity"],
    t: ReviewIssue["type"],
    path: string,
    detail: string,
    suggestedValue?: unknown,
  ) => issues.push({ severity, type: t, path, detail, suggestedValue, foundBy: "validator" });

  const walk = (fields: readonly FieldSpec[], obj: any, prefix: string) => {
    for (const f of fields) {
      const path = prefix ? `${prefix}.${f.key}` : f.key;
      const v = obj?.[f.key];
      const label = labelForPath(type, path);

      if (f.required && isEmptyValue(v)) {
        push("blocker", "missing_required", path, `필수 항목 '${label}'이 비어 있습니다.`);
        continue;
      }
      if (isEmptyValue(v)) continue;

      switch (f.kind) {
        case "date":
          if (typeof v !== "string" || !DATE_RE.test(v.trim())) {
            push("major", "format", path, `'${label}'의 날짜 형식이 올바르지 않습니다: ${JSON.stringify(v)} (YYYY-MM-DD / YYYY-MM / YYYY)`);
          }
          break;
        case "daterange": {
          const r = v as { start?: string | null; end?: string | null; ongoing?: boolean | null };
          for (const k of ["start", "end"] as const) {
            const dv = r?.[k];
            if (dv && !DATE_RE.test(String(dv).trim())) {
              push("major", "format", `${path}.${k}`, `'${label}'의 ${k === "start" ? "시작" : "종료"}일 형식 오류: ${dv}`);
            }
          }
          if (r?.start && r?.end && String(r.start) > String(r.end)) {
            push("major", "format", path, `'${label}'의 시작일이 종료일보다 뒤입니다 (${r.start} > ${r.end}).`);
          }
          if (r?.ongoing && r?.end) {
            push("minor", "format", path, `'${label}'이 진행 중인데 종료일이 있습니다.`);
          }
          break;
        }
        case "select":
          if (f.options && !f.options.includes(String(v))) {
            push("major", "format", path, `'${label}'의 값 "${v}"은(는) 보기에 없습니다. 보기: ${f.options.join(", ")}`, null);
          }
          break;
        case "checklist": {
          if (!Array.isArray(v)) {
            push("major", "format", path, `'${label}'은 복수 선택 배열이어야 합니다.`);
            break;
          }
          if (f.options && !f.freeOptions) {
            const bad = v.filter((x) => !f.options!.includes(String(x)));
            if (bad.length) {
              push("major", "format", path, `'${label}'에 보기에 없는 값: ${bad.join(", ")}. 보기: ${f.options.join(", ")}`);
            }
          }
          break;
        }
        case "tags":
          if (!Array.isArray(v)) push("major", "format", path, `'${label}'은 태그 배열이어야 합니다.`);
          else if (v.length > 20) push("minor", "format", path, `'${label}' 태그가 ${v.length}개로 과합니다. 핵심 위주로 줄이세요.`);
          break;
        case "link":
          if (typeof v === "string" && !URL_RE.test(v.trim())) {
            push("minor", "format", path, `'${label}'이 URL 형식이 아닙니다: ${v}`);
          }
          break;
        case "text":
          if (typeof v === "string" && v.includes("\n")) {
            push("minor", "format", path, `'${label}'은 한 줄 입력인데 줄바꿈이 있습니다.`, v.replace(/\s*\n\s*/g, " "));
          }
          if (f.key === "summary" || f.key === "oneLiner") {
            if (typeof v === "string" && v.length > 120) {
              push("minor", "format", path, `'${label}'이 ${v.length}자로 깁니다. 80자 내외 한 문장으로 줄이세요.`);
            }
          }
          break;
        case "repeater": {
          if (!Array.isArray(v)) {
            push("major", "format", path, `'${label}'은 반복 입력 배열이어야 합니다.`);
            break;
          }
          v.forEach((row, i) => walk(f.fields ?? [], row, `${path}[${i}]`));
          break;
        }
        case "longtext":
          if (typeof v === "string" && v.trim().length < 5) {
            push("minor", "format", path, `'${label}'의 내용이 너무 짧습니다. 비우거나 제대로 채우세요.`, null);
          }
          break;
        case "file":
          break;
      }
    }
  };

  walk(allFieldsFor(type), values, "");
  return issues;
}
