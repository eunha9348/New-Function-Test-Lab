import type { FieldSpec } from "../types.js";

/**
 * FieldSpec → JSON Schema 변환.
 *
 * strict tool use(`strict: true`)를 쓰기 때문에 모든 키가 required에 들어가야 하고
 * additionalProperties는 false여야 한다. "못 채우는 항목은 비운다"는 요구는
 * 모든 타입을 nullable로 만들어 충족한다 — 모델이 값을 지어내는 대신 null을 낸다.
 */

type JsonSchema = Record<string, unknown>;

function describe(f: FieldSpec): string {
  const bits = [f.label];
  if (f.required) bits.push("(필수)");
  if (f.hint) bits.push(`— ${f.hint}`);
  return bits.join(" ");
}

function fieldSchema(f: FieldSpec): JsonSchema {
  const description = describe(f);
  switch (f.kind) {
    case "text":
      return { type: ["string", "null"], description: `${description} [한 줄]` };
    case "longtext":
      return { type: ["string", "null"], description: `${description} [서술형]` };
    case "link":
      return { type: ["string", "null"], description: `${description} [URL. 원문에 있는 URL만]` };
    case "file":
      return {
        type: ["string", "null"],
        description: `${description} [업로드된 파일명 그대로. 없으면 null]`,
      };
    case "date":
      return {
        type: ["string", "null"],
        description: `${description} [YYYY-MM-DD. 연·월만 알면 YYYY-MM, 연도만 알면 YYYY]`,
      };
    case "daterange":
      return {
        type: ["object", "null"],
        description: `${description} [기간]`,
        properties: {
          start: { type: ["string", "null"], description: "시작일 YYYY-MM-DD / YYYY-MM / YYYY" },
          end: { type: ["string", "null"], description: "종료일. 진행 중이면 null" },
          ongoing: { type: ["boolean", "null"], description: "진행 중 여부" },
        },
        required: ["start", "end", "ongoing"],
        additionalProperties: false,
      };
    case "select":
      return {
        type: ["string", "null"],
        enum: [...(f.options ?? []), null],
        description: `${description} [보기 중 1개. 확실하지 않으면 null]`,
      };
    case "checklist":
      return {
        type: ["array", "null"],
        description: `${description} [복수 선택]`,
        items: f.freeOptions
          ? { type: "string" }
          : { type: "string", enum: [...(f.options ?? [])] },
      };
    case "tags":
      return {
        type: ["array", "null"],
        description: `${description} [자유 태그. 원문에 근거한 것만]`,
        items: { type: "string" },
      };
    case "repeater":
      return {
        type: ["array", "null"],
        description: `${description} [반복 입력. 원문에 있는 건수만큼 항목 생성. 억지로 채우지 말 것]`,
        items: objectSchema(f.fields ?? []),
      };
  }
}

export function objectSchema(fields: readonly FieldSpec[]): JsonSchema {
  const properties: Record<string, JsonSchema> = {};
  for (const f of fields) properties[f.key] = fieldSchema(f);
  return {
    type: "object",
    properties,
    required: fields.map((f) => f.key),
    additionalProperties: false,
  };
}

/** 추출 에이전트가 호출할 tool의 input_schema */
export function extractionToolSchema(fields: readonly FieldSpec[]): JsonSchema {
  return {
    type: "object",
    properties: {
      values: objectSchema(fields),
      evidence: {
        type: "array",
        description:
          "채운 값마다 원문 근거 1개 이상. 근거를 댈 수 없는 값은 채우지 말고 null로 둘 것.",
        items: {
          type: "object",
          properties: {
            path: { type: "string", description: "필드 경로. 예: courses[0].courseName" },
            sourceId: { type: "string", description: "근거가 있는 파일의 sourceId" },
            quote: { type: "string", description: "원문에서 그대로 복사한 문장(최대 200자)" },
            confidence: { type: "number", description: "0~1" },
          },
          required: ["path", "sourceId", "quote", "confidence"],
          additionalProperties: false,
        },
      },
      unfilled: {
        type: "array",
        description: "비워 둔 항목과 그 이유.",
        items: {
          type: "object",
          properties: {
            path: { type: "string" },
            reason: { type: "string", description: "원문에 없음 / 판단 불가 / 다른 유형의 정보 등" },
          },
          required: ["path", "reason"],
          additionalProperties: false,
        },
      },
    },
    required: ["values", "evidence", "unfilled"],
    additionalProperties: false,
  };
}
