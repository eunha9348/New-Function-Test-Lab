
import { CATEGORIES, EXPERIENCE_TYPES } from "../schema/index.js";
import type { ClassificationResult, ExtractedDoc } from "../types.js";
import type { LlmSession } from "../llm/index.js";
import { buildClassificationDigest } from "./evidence.js";

/** 캐시되는 안정 프리픽스 — 18종 카탈로그. 요청마다 동일해야 캐시가 산다. */
const TYPE_CATALOG = (() => {
  const byCat = CATEGORIES.map((c) => {
    const types = EXPERIENCE_TYPES.filter((t) => t.category === c.id)
      .map(
        (t) =>
          `  · ${t.id} — ${t.label}\n      동의어: ${t.aliases.join(", ")}\n      신호: ${t.signals.join(", ")}\n      전용 항목: ${t.fields.map((f) => f.label).join(", ")}`,
      )
      .join("\n");
    return `[${c.id}] ${c.emoji} ${c.label}\n  대분류 신호: ${c.signals.join(", ")}\n${types}`;
  }).join("\n\n");
  return byCat;
})();

const SYSTEM = `당신은 ARC 경험 기록 서비스의 **1단계 분류 에이전트**다.
사용자가 올린 산출물(파일)을 읽고, 그것이 어떤 경험인지 판별한다.

작업 순서는 반드시 이 순서다.
  1) 먼저 **대분류**(학업 / 커리어 / 프로젝트 / 개인성장) 4개 중 하나를 고른다.
  2) 그 대분류 안의 **세부 유형**을 고른다.

── 판별 원칙 ──
1. **산출물의 형식이 아니라 활동의 성격**으로 판단한다.
   PDF라서 논문이 아니고, 코드라서 개인 프로젝트가 아니다. 누가·어디서·왜 한 일인지를 본다.
2. 헷갈리는 경계는 다음 기준으로 자른다.
   · 회사에서 급여를 받고 한 일 → career.work (팀 프로젝트처럼 보여도)
   · 학교 수업의 일부로 한 팀 과제 → academic.major_course (수업 기록 안에 담는다)
   · 수업/회사와 무관하게 스스로 만든 것 → project.personal / project.team
   · 대회에서 상을 받은 게 핵심이면 → career.award (만든 결과물이 있어도)
   · 상을 못 받았거나 참가가 핵심이면 → career.external 또는 project.*
   · 학회·동아리는 소속 단체가 주체, 대외활동은 외부 기관이 주최
   · 결과물의 '완성도·작품성'이 핵심이면 project.creative
   · 배운 것/느낀 것이 핵심이고 산출물이 부차적이면 growth.*
3. 근거가 약하면 confidence를 정직하게 낮춘다. 억지로 확신하지 않는다.
4. 한 파일에 서로 다른 경험이 여러 개 섞여 있으면(예: 포트폴리오 전체, 이력서)
   multipleExperiences=true 로 두고 splitSuggestions에 나눠 담는다.
5. rationale은 한국어 2~3문장. "무엇을 보고" 그렇게 판단했는지 원문 표현을 인용한다.

── 경험 유형 카탈로그 (18종) ──
${TYPE_CATALOG}`;

const SCHEMA = {
  type: "object",
  properties: {
    categoryId: { type: "string", enum: CATEGORIES.map((c) => c.id) },
    typeId: { type: "string", enum: EXPERIENCE_TYPES.map((t) => t.id) },
    confidence: { type: "number", description: "0~1. 근거가 약하면 정직하게 낮출 것." },
    rationale: { type: "string", description: "한국어 2~3문장. 원문 표현을 인용." },
    alternatives: {
      type: "array",
      description: "차점 후보 최대 2개. 없으면 빈 배열.",
      items: {
        type: "object",
        properties: {
          typeId: { type: "string", enum: EXPERIENCE_TYPES.map((t) => t.id) },
          confidence: { type: "number" },
          reason: { type: "string" },
        },
        required: ["typeId", "confidence", "reason"],
        additionalProperties: false,
      },
    },
    multipleExperiences: { type: "boolean" },
    splitSuggestions: {
      type: "array",
      description: "여러 경험이 섞여 있을 때만 채운다. 아니면 빈 배열.",
      items: {
        type: "object",
        properties: {
          title: { type: "string" },
          typeId: { type: "string", enum: EXPERIENCE_TYPES.map((t) => t.id) },
          hint: { type: "string", description: "원문 어느 부분이 이 경험인지" },
        },
        required: ["title", "typeId", "hint"],
        additionalProperties: false,
      },
    },
  },
  required: ["categoryId", "typeId", "confidence", "rationale", "alternatives", "multipleExperiences", "splitSuggestions"],
  additionalProperties: false,
} as const;

export async function classify(
  session: LlmSession,
  docs: ExtractedDoc[],
  userHint?: string,
): Promise<ClassificationResult> {
  const digest = buildClassificationDigest(docs);
  const result = await session.structured<ClassificationResult>({
    stage: "classify",
    systemStable: SYSTEM,
    systemVolatile: userHint ? `사용자가 준 추가 맥락: ${userHint}` : undefined,
    toolName: "submit_classification",
    toolDescription: "판별한 대분류와 세부 유형을 제출한다.",
    schema: SCHEMA as unknown as Record<string, unknown>,
    content: [{ type: "text", text: digest }],
    maxTokens: 8000,
  });

  // 유형과 대분류가 어긋나면 유형 쪽을 신뢰한다
  const spec = EXPERIENCE_TYPES.find((t) => t.id === result.typeId);
  if (spec && spec.category !== result.categoryId) result.categoryId = spec.category;
  return result;
}
