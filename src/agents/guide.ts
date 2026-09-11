import { PIPELINE } from "../config.js";
import { EXPERIENCE_TYPES, allFieldsFor, labelForPath } from "../schema/index.js";
import type {
  ClassificationResult, ExperienceTypeSpec, ExtractedDoc, ExtractionResult,
  FallbackGuide, FieldSpec, MissingGuide,
} from "../types.js";
import type { LlmSession } from "../llm/index.js";
import { getByPath, isEmptyValue } from "../util/path.js";

const SYSTEM = `당신은 ARC 경험 기록 서비스의 **Fallback 안내 에이전트**다.
자동 정리 후 **비어 있는 항목**을 보고, 사용자가 무엇을 더 주면 채울 수 있는지 안내한다.

── 원칙 ──
1. 사용자를 탓하지 않는다. "자료가 부족합니다"가 아니라 "○○을 알려주시면 △△칸이 채워집니다"로 쓴다.
2. 각 항목마다 **구체적으로 무엇을** 주면 되는지 적는다.
   나쁜 예: "성과를 입력해주세요"
   좋은 예: "이 캠페인으로 팔로워가 몇 명 늘었는지, 또는 참여자가 몇 명이었는지 숫자로 알려주세요.
             주최 측에서 받은 결과 리포트가 있으면 그 파일을 올려주셔도 됩니다."
3. question은 사용자에게 그대로 보여줄 **한 문장 질문**이다. 존댓말, 40자 내외.
4. exampleAnswer는 이 유형에서 흔한 답 예시 한 줄. 사용자의 실제 사실이 아님이 분명하게, 일반적인 예로 쓴다.
5. priority — 이 유형에서 그 항목이 얼마나 중요한지.
   필수 항목과 이 경험의 가치를 보여주는 항목(성과·내 역할·기간)은 high.
6. nextQuestions에는 **가장 효율적인 질문 3~5개**만 고른다.
   하나의 답으로 여러 칸이 동시에 채워지는 질문을 우선한다.
7. recommendedUploads에는 이 유형에서 흔히 빈칸을 메워주는 **파일 종류**를 적는다.
   예: "수료증 PDF", "발표 슬라이드", "성과 대시보드 캡처", "팀 회고 문서"
8. 모든 출력은 한국어.`;

const SCHEMA = {
  type: "object",
  properties: {
    missing: {
      type: "array",
      items: {
        type: "object",
        properties: {
          path: { type: "string" },
          why: { type: "string", description: "왜 못 채웠는지 (원문에 없음/판단 불가 등)" },
          whatToProvide: { type: "string", description: "무엇을 주면 채울 수 있는지 구체적으로" },
          question: { type: "string", description: "사용자에게 보여줄 한 문장 질문. 40자 내외." },
          exampleAnswer: { type: "string", description: "일반적인 답변 예시 한 줄" },
          priority: { type: "string", enum: ["high", "medium", "low"] },
        },
        required: ["path", "why", "whatToProvide", "question", "exampleAnswer", "priority"],
        additionalProperties: false,
      },
    },
    recommendedUploads: { type: "array", items: { type: "string" } },
    nextQuestions: { type: "array", items: { type: "string" } },
  },
  required: ["missing", "recommendedUploads", "nextQuestions"],
  additionalProperties: false,
} as const;

/** 실제로 비어 있는 항목을 기계적으로 수집 (repeater 하위까지) */
export function collectEmptyPaths(
  type: ExperienceTypeSpec,
  values: Record<string, unknown>,
): { path: string; label: string; required: boolean; kind: string }[] {
  const out: { path: string; label: string; required: boolean; kind: string }[] = [];
  const walk = (fields: readonly FieldSpec[], prefix: string) => {
    for (const f of fields) {
      const path = prefix ? `${prefix}.${f.key}` : f.key;
      const v = getByPath(values, path);
      if (f.kind === "repeater") {
        if (isEmptyValue(v)) {
          out.push({ path, label: labelForPath(type, path), required: !!f.required, kind: f.kind });
        } else if (Array.isArray(v)) {
          v.forEach((_, i) => walk(f.fields ?? [], `${path}[${i}]`));
        }
        continue;
      }
      if (isEmptyValue(v)) {
        out.push({ path, label: labelForPath(type, path), required: !!f.required, kind: f.kind });
      }
    }
  };
  walk(allFieldsFor(type), "");
  return out;
}

/** 채움률: 가중치 — 필수 3, 일반 1 */
export function completeness(type: ExperienceTypeSpec, values: Record<string, unknown>): number {
  const fields = allFieldsFor(type);
  let total = 0;
  let filled = 0;
  for (const f of fields) {
    const w = f.required ? 3 : 1;
    total += w;
    if (!isEmptyValue(getByPath(values, f.key))) filled += w;
  }
  return total ? Math.round((filled / total) * 100) : 0;
}

export async function buildFallbackGuide(
  session: LlmSession,
  type: ExperienceTypeSpec,
  draft: ExtractionResult,
  docs: ExtractedDoc[],
  classification: ClassificationResult,
): Promise<FallbackGuide> {
  const empties = collectEmptyPaths(type, draft.values);
  const score = completeness(type, draft.values);

  // 빈 항목이 없으면 LLM 호출 없이 종료
  if (empties.length === 0) {
    return {
      completeness: score,
      missing: [],
      recommendedUploads: [],
      nextQuestions: [],
      ...typeConfirmation(classification),
    };
  }

  const emptyList = empties
    .map(
      (e) =>
        `- ${e.path} | ${e.label} (${e.kind}${e.required ? ", 필수" : ""})` +
        (draft.unfilled.find((u) => u.path === e.path)
          ? ` ← 추출기 메모: ${draft.unfilled.find((u) => u.path === e.path)!.reason}`
          : ""),
    )
    .join("\n");

  const raw = await session.structured<{
    missing: Omit<MissingGuide, "label">[];
    recommendedUploads: string[];
    nextQuestions: string[];
  }>({
    stage: "guide",
    systemStable: `${SYSTEM}\n\n── 대상 유형: ${type.emoji} ${type.label} (${type.id}) ──`,
    toolName: "submit_guide",
    toolDescription: "빈 항목별 안내와 추가 질문을 제출한다.",
    schema: SCHEMA as unknown as Record<string, unknown>,
    maxTokens: 12000,
    content: [
      {
        type: "text",
        text: `## 사용자가 올린 자료\n${docs.map((d) => `- ${d.name} (${d.kind})`).join("\n")}`,
      },
      {
        type: "text",
        text: `## 지금까지 채워진 내용 (채움률 ${score}%)\n\`\`\`json\n${JSON.stringify(draft.values, null, 2)}\n\`\`\``,
      },
      { type: "text", text: `## 비어 있는 항목 (${empties.length}개)\n${emptyList}` },
    ],
  });

  const labelOf = new Map(empties.map((e) => [e.path, e.label]));
  return {
    completeness: score,
    missing: (raw.missing ?? [])
      .map((m) => ({ ...m, label: labelOf.get(m.path) ?? labelForPath(type, m.path) }))
      .sort((a, b) => rank(b.priority) - rank(a.priority)),
    recommendedUploads: raw.recommendedUploads ?? [],
    nextQuestions: (raw.nextQuestions ?? []).slice(0, 5),
    ...typeConfirmation(classification),
  };
}

function rank(p: MissingGuide["priority"]): number {
  return p === "high" ? 2 : p === "medium" ? 1 : 0;
}

/** 분류 신뢰도가 낮으면 유형 확인 질문을 붙인다 */
function typeConfirmation(c: ClassificationResult): Pick<FallbackGuide, "confirmTypeWith"> {
  if (c.confidence >= PIPELINE.classificationConfidenceFloor) return {};
  const candidates = [
    { typeId: c.typeId, label: labelOfType(c.typeId) },
    ...c.alternatives.slice(0, 2).map((a) => ({ typeId: a.typeId, label: labelOfType(a.typeId) })),
  ];
  return {
    confirmTypeWith: {
      candidates,
      question: `이 활동이 '${candidates[0]!.label}'이 맞나요? 아니라면 아래에서 골라주세요.`,
    },
  };
}

function labelOfType(id: string): string {
  return EXPERIENCE_TYPES.find((t) => t.id === id)?.label ?? id;
}
