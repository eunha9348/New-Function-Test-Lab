/**
 * 이 저장소의 JSON Schema → Gemini `responseSchema` 형식 변환.
 *
 * Gemini는 OpenAPI 3.0 스키마의 부분집합만 받는다. 차이가 셋 있다.
 *   1. type이 대문자 문자열 하나다. `["string","null"]` 같은 유니온을 못 받으므로
 *      → type은 대표 타입 하나로 하고 `nullable: true`를 붙인다.
 *   2. `additionalProperties`를 모르는 키로 보고 거부한다 → 제거.
 *   3. 키 순서가 보장되지 않으므로 `propertyOrdering`으로 순서를 고정한다
 *      (순서를 고정하면 모델 출력이 눈에 띄게 안정된다).
 *
 * select 항목의 보기는 enum으로 넣지 않고 description으로 안내한다.
 * nullable + enum 조합이 공급자/버전에 따라 거부되기 때문이다. 대신
 * `src/validate/structural.ts`가 보기 위반을 결정론적으로 잡고,
 * `coerceToSchema()`가 값을 보기 안으로 되돌린다.
 */

type Json = Record<string, any>;

const TYPE_MAP: Record<string, string> = {
  string: "STRING",
  number: "NUMBER",
  integer: "INTEGER",
  boolean: "BOOLEAN",
  array: "ARRAY",
  object: "OBJECT",
};

export function toGeminiSchema(node: Json): Json {
  const types: string[] = Array.isArray(node.type) ? node.type : node.type ? [node.type] : [];
  const nullable = types.includes("null");
  const primary = types.find((t) => t !== "null") ?? "string";

  const out: Json = { type: TYPE_MAP[primary] ?? "STRING" };
  if (nullable) out.nullable = true;

  const desc = buildDescription(node);
  if (desc) out.description = desc;

  if (out.type === "OBJECT") {
    const props = node.properties ?? {};
    const keys = Object.keys(props);
    out.properties = Object.fromEntries(keys.map((k) => [k, toGeminiSchema(props[k])]));
    if (keys.length) out.propertyOrdering = keys;
    // nullable 필드는 required에서 뺀다 — 비울 수 있어야 하기 때문
    const required = (node.required ?? []).filter((k: string) => {
      const t = props[k]?.type;
      return !(Array.isArray(t) ? t.includes("null") : false);
    });
    if (required.length) out.required = required;
  }

  if (out.type === "ARRAY") {
    out.items = toGeminiSchema(node.items ?? { type: "string" });
  }

  return out;
}

function buildDescription(node: Json): string {
  const bits: string[] = [];
  if (node.description) bits.push(String(node.description));
  if (Array.isArray(node.enum)) {
    const options = node.enum.filter((v: unknown) => v !== null);
    if (options.length) {
      bits.push(`반드시 다음 중 하나여야 함: ${options.join(" | ")}. 해당 없으면 null.`);
    }
  }
  return bits.join(" ");
}

/**
 * 모델 응답을 원래 JSON Schema에 맞게 되돌린다.
 *  · enum 밖 값 → 정규화 매칭 시도 후 실패하면 null
 *  · 빠진 키 → null 로 채워 폼 형태를 고정
 *  · "null" / "없음" / "N/A" 같은 가짜 값 → 진짜 null
 */
export function coerceToSchema(value: unknown, node: Json): unknown {
  const types: string[] = Array.isArray(node.type) ? node.type : node.type ? [node.type] : [];
  const primary = types.find((t) => t !== "null") ?? "string";

  if (isBlank(value)) return types.includes("null") ? null : defaultFor(primary);

  if (primary === "object") {
    const props = node.properties ?? {};
    const src = (typeof value === "object" && value !== null ? value : {}) as Json;
    const out: Json = {};
    for (const k of Object.keys(props)) out[k] = coerceToSchema(src[k], props[k]);
    return out;
  }

  if (primary === "array") {
    const arr = Array.isArray(value) ? value : [value];
    const items = node.items ?? { type: "string" };
    const mapped = arr.map((v) => coerceToSchema(v, items)).filter((v) => !isBlank(v));
    return mapped.length ? mapped : types.includes("null") ? null : [];
  }

  if (Array.isArray(node.enum)) {
    const options = node.enum.filter((v: unknown) => typeof v === "string") as string[];
    if (options.length) {
      const hit = matchEnum(String(value), options);
      return hit ?? (types.includes("null") ? null : options[0]);
    }
  }

  if (primary === "boolean") return typeof value === "boolean" ? value : /^(true|예|yes|y|1)$/i.test(String(value));
  if (primary === "number" || primary === "integer") {
    const n = Number(String(value).replace(/[^\d.\-]/g, ""));
    return Number.isFinite(n) ? n : types.includes("null") ? null : 0;
  }
  return String(value).trim();
}

const BLANK_WORDS = new Set([
  "", "null", "undefined", "none", "n/a", "na", "-", "없음", "미상", "해당없음",
  "해당 없음", "알 수 없음", "미기재", "정보 없음", "확인 불가",
]);

function isBlank(v: unknown): boolean {
  if (v === null || v === undefined) return true;
  if (typeof v === "string") return BLANK_WORDS.has(v.trim().toLowerCase());
  if (Array.isArray(v)) return v.length === 0;
  if (typeof v === "object") return Object.keys(v).length === 0;
  return false;
}

function defaultFor(type: string): unknown {
  return type === "array" ? [] : type === "object" ? {} : null;
}

function norm(s: string): string {
  return s.replace(/[\s·.\-_/]/g, "").toLowerCase();
}

function matchEnum(raw: string, options: string[]): string | null {
  const n = norm(raw);
  const exact = options.find((o) => norm(o) === n);
  if (exact) return exact;
  const partial = options.find((o) => n.includes(norm(o)) || norm(o).includes(n));
  return partial ?? null;
}
