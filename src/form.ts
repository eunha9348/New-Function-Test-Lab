import { TYPE_BY_ID, allFieldsFor } from "./schema/index.js";
import type {
  FieldKind, FieldSpec, MissingGuide, OrganizeResult,
} from "./types.js";
import { getByPath, isEmptyValue } from "./util/path.js";

/**
 * 프론트엔드 바인딩용 평탄화 결과.
 *
 * 프론트는 ARC 스키마 내부를 몰라도 된다. 이 배열을 그대로 map 해서 그리면
 * 유형에 맞는 폼이 **자동으로 만들어지고 값까지 채워진 상태**가 된다.
 */
export interface FormFieldState {
  /** 폼 상태 객체의 키 (= values[key]) */
  key: string;
  label: string;
  kind: FieldKind;
  /** 화면 섹션 제목 */
  section: string;
  zone: "header" | "specialized" | "extended" | "evidence";
  /** 기본 접힘 섹션인지 */
  collapsed: boolean;
  required: boolean;
  options?: string[];
  /** select/checklist에서 보기 외 자유 입력 허용 */
  freeOptions?: boolean;
  /** 그대로 input/textarea에 바인딩하면 되는 값 (못 채웠으면 null) */
  value: unknown;
  /** 자동으로 채워졌는지 */
  filled: boolean;
  /** 값 신뢰도 0~1 (근거가 없으면 null) */
  confidence: number | null;
  /** 어느 파일 어느 문장에서 왔는지 — "출처 보기" UI용 */
  evidence: { sourceId: string; fileName: string; text: string }[];
  /** 비어 있을 때 보여줄 안내 (placeholder·도움말로 바로 쓸 수 있음) */
  guide?: {
    question: string;
    whatToProvide: string;
    priority: "high" | "medium" | "low";
  };
  /** kind === 'repeater'일 때 한 행의 칸 구성 */
  itemFields?: FormFieldState[];
}

export interface FormState {
  categoryId: string;
  categoryLabel: string;
  typeId: string;
  typeLabel: string;
  /** 유형 판별 신뢰도 0~1 */
  typeConfidence: number;
  /** 판별 근거 — "왜 이 유형인가요?" 툴팁용 */
  typeRationale: string;
  /** 신뢰도가 낮을 때만 채워짐. 사용자에게 유형 확인을 받아야 한다. */
  confirmType?: {
    question: string;
    candidates: { typeId: string; label: string }[];
  };
  /** 폼 상태 초기값. `setValues(formState.values)` 한 줄이면 끝 */
  values: Record<string, unknown>;
  /** 렌더링용 필드 목록 (순서 그대로 그리면 됨) */
  fields: FormFieldState[];
  /** 섹션 단위로 묶은 뷰 (섹션별 카드 UI에 쓰기 편함) */
  sections: { title: string; zone: FormFieldState["zone"]; collapsed: boolean; fields: FormFieldState[] }[];
  /** 0~100 채움률 — 진행바에 바로 표시 */
  completeness: number;
  /** 사용자에게 물어볼 질문 3~5개 */
  questions: string[];
  /** 추가로 올리면 좋은 자료 */
  recommendedUploads: string[];
  /** 사용자에게 보여줄 경고 (OCR 품질 낮음, 형식 미지원 등) */
  warnings: string[];
  /** 검수 결과 요약 — 배지로 표시하기 좋음 */
  review: {
    verdict: "approve" | "revise" | "reclassify";
    faithfulness: number;
    /** 사용자가 확인해 볼 만한 항목 (minor 제외) */
    attentionFields: { key: string; label: string; detail: string }[];
  };
  /** 전용 항목과 겹쳐 화면에서 숨긴 공통 항목 */
  hiddenCommonKeys: string[];
  meta: {
    files: { name: string; kind: string; chars: number; confidence: number }[];
    estimatedCostUsd: number;
    elapsedMs: number;
  };
}

/**
 * 파이프라인 결과 → 프론트엔드가 바로 쓰는 폼 상태.
 *
 *   const form = toFormState(result);
 *   setValues(form.values);          // 값이 이미 채워져 있음
 *   form.sections.map(renderSection) // 유형에 맞는 폼이 자동 생성됨
 */
export function toFormState(result: OrganizeResult): FormState {
  const type = TYPE_BY_ID.get(result.typeId);
  const specs = new Map<string, FieldSpec>(
    (type ? allFieldsFor(type) : []).map((f) => [f.key, f]),
  );

  const provByPath = new Map(result.provenance.map((p) => [p.path, p]));
  const guideByPath = new Map<string, MissingGuide>(
    result.fallback.missing.map((m) => [m.path, m]),
  );
  const fileNameById = new Map(result.ingest.docs.map((d) => [d.sourceId, d.name]));

  const buildField = (
    spec: FieldSpec,
    path: string,
    section: string,
    zone: FormFieldState["zone"],
    collapsed: boolean,
  ): FormFieldState => {
    const value = getByPath(result.form.values, path) ?? null;
    const prov = provByPath.get(path);
    const guide = guideByPath.get(path);
    const field: FormFieldState = {
      key: spec.key,
      label: spec.label,
      kind: spec.kind,
      section,
      zone,
      collapsed,
      required: !!spec.required,
      value,
      filled: !isEmptyValue(value),
      confidence: prov?.confidence ?? null,
      evidence: (prov?.quotes ?? []).map((q) => ({
        sourceId: q.sourceId,
        fileName: fileNameById.get(q.sourceId) ?? q.sourceId,
        text: q.text,
      })),
    };
    if (spec.options) field.options = [...spec.options];
    if (spec.freeOptions) field.freeOptions = true;
    if (guide) {
      field.guide = {
        question: guide.question,
        whatToProvide: guide.whatToProvide,
        priority: guide.priority,
      };
    }
    if (spec.kind === "repeater" && spec.fields) {
      field.itemFields = spec.fields.map((sub) =>
        buildField(sub, `${path}[0].${sub.key}`, section, zone, collapsed),
      );
      // 행 템플릿이므로 값·근거는 비워 둔다
      field.itemFields.forEach((f) => {
        f.value = null;
        f.filled = false;
        f.confidence = null;
        f.evidence = [];
      });
    }
    return field;
  };

  const sections = result.form.layout.map((sec) => ({
    title: sec.title,
    zone: sec.zone,
    collapsed: !!sec.collapsedByDefault,
    fields: sec.fields.map((f) =>
      buildField(specs.get(f.key) ?? f, f.key, sec.title, sec.zone, !!sec.collapsedByDefault),
    ),
  }));

  const fields = sections.flatMap((s) => s.fields);

  const attentionFields = result.review.final.issues
    .filter((i) => i.severity !== "minor")
    .map((i) => {
      const rootKey = i.path.split(".")[0]!.replace(/\[\d+\]$/, "");
      return {
        key: rootKey,
        label: specs.get(rootKey)?.label ?? rootKey,
        detail: i.detail,
      };
    })
    .filter((v, i, arr) => arr.findIndex((x) => x.key === v.key && x.detail === v.detail) === i);

  return {
    categoryId: result.categoryId,
    categoryLabel: result.categoryLabel,
    typeId: result.typeId,
    typeLabel: result.typeLabel,
    typeConfidence: result.classification.confidence,
    typeRationale: result.classification.rationale,
    confirmType: result.fallback.confirmTypeWith
      ? {
          question: result.fallback.confirmTypeWith.question,
          candidates: result.fallback.confirmTypeWith.candidates,
        }
      : undefined,
    values: result.form.values,
    fields,
    sections,
    completeness: result.fallback.completeness,
    questions: result.fallback.nextQuestions,
    recommendedUploads: result.fallback.recommendedUploads,
    warnings: result.ingest.docs.flatMap((d) => d.warnings.map((w) => `${d.name}: ${w}`)),
    review: {
      verdict: result.review.final.verdict,
      faithfulness: result.review.final.scores.faithfulness,
      attentionFields,
    },
    hiddenCommonKeys: result.form.hiddenCommonKeys,
    meta: {
      files: result.ingest.docs.map((d) => ({
        name: d.name,
        kind: d.kind,
        chars: d.chars,
        confidence: d.confidence,
      })),
      estimatedCostUsd: result.usage.estimatedCostUsd,
      elapsedMs: result.usage.calls.reduce((a, c) => a + c.ms, 0),
    },
  };
}
