import { EFFORT, MODELS, PIPELINE } from "../config.js";
import { allFieldsFor, extractionToolSchema, labelForPath, resolveLayout } from "../schema/index.js";
import type {
  ExperienceTypeSpec, ExtractedDoc, ExtractionResult, FieldSpec, FieldValue,
} from "../types.js";
import type { LlmSession } from "../llm/client.js";
import { buildEvidenceBundle } from "./evidence.js";
import { isEmptyValue, setByPath } from "../util/path.js";

const RULES = `당신은 ARC 경험 기록 서비스의 **2단계 배분 에이전트**다.
1단계에서 확정된 경험 유형의 입력 항목에, 원문 내용을 요약해서 나눠 담는 것이 임무다.

── 절대 규칙 ──
1. **원문에 없는 사실을 만들지 않는다.** 이름·숫자·날짜·기관명·성과는 원문에 있는 것만 쓴다.
   추정·보간·"아마도"는 금지. 근거를 댈 수 없으면 그 항목은 null로 비운다.
2. **비우는 것이 틀리게 채우는 것보다 낫다.** 빈 항목은 뒤에서 사용자에게 되물어 채운다.
3. 채운 값마다 evidence에 근거를 남긴다. quote는 원문에서 **그대로 복사**한 문장이어야 한다.
   요약한 문장을 quote에 넣지 말 것. 근거 없는 값은 애초에 채우지 말 것.
4. **'나'와 '팀'을 구분한다.** 팀 전체가 한 일을 '내 역할'에 쓰지 않는다.
   원문이 주어를 흐리면 확신 가능한 범위까지만 쓰고 신뢰도를 낮춘다.
5. **한 항목에 몰아넣지 않는다.** 반복 입력(repeater)이 있으면 원문의 건수만큼 항목을 만들어
   쪼개 담는다. 거꾸로 원문에 1건뿐인데 억지로 여러 건을 만들지 않는다.
6. 같은 내용을 여러 항목에 중복해서 넣지 않는다. 가장 적합한 한 곳에만 넣는다.
7. 형식을 지킨다. 날짜는 YYYY-MM-DD(모르면 YYYY-MM 또는 YYYY), 선택 항목은 주어진 보기 중에서만,
   보기에 맞는 게 없으면 null.
8. 서술형은 **원문의 표현과 사실을 유지하되 군더더기를 덜어낸 요약**으로 쓴다.
   과장하거나 미화하지 않는다. 한국어로 쓴다.
9. '한 줄 요약'은 80자 내외 한 문장. '핵심 성과'는 가능하면 수치를 포함하되 없는 수치를 지어내지 않는다.
10. 파일 항목(kind=file)에는 업로드된 파일명을 그대로 적는다. 없으면 null.
11. 텍스트 품질이 '낮음'인 문서에서만 나온 값은 confidence를 0.5 이하로 준다.
    OCR 결과의 «불명» 표시 주변 값은 신뢰하지 않는다.
12. unfilled에는 비워 둔 항목을 **왜** 비웠는지와 함께 모두 적는다. 이건 다음 단계에서
    사용자에게 "무엇을 더 주면 채울 수 있는지" 안내하는 재료가 된다.`;

function fieldOutline(type: ExperienceTypeSpec): string {
  const { layout } = resolveLayout(type);
  const render = (f: FieldSpec, depth: number): string => {
    const pad = "  ".repeat(depth);
    const opt = f.options ? ` 〔${f.options.join("·")}〕` : "";
    const req = f.required ? " (필수)" : "";
    const hint = f.hint ? `  ※ ${f.hint}` : "";
    const head = `${pad}- ${f.key} | ${f.label} — ${f.kind}${opt}${req}${hint}`;
    const kids = (f.fields ?? []).map((c) => render(c, depth + 2)).join("\n");
    return kids ? `${head}\n${kids}` : head;
  };
  return layout
    .map((sec) => `### ${sec.title}${sec.collapsedByDefault ? " (접힘)" : ""}\n${sec.fields.map((f) => render(f, 0)).join("\n")}`)
    .join("\n\n");
}

export async function extract(
  session: LlmSession,
  type: ExperienceTypeSpec,
  docs: ExtractedDoc[],
  opts: { userHint?: string; feedback?: string } = {},
): Promise<ExtractionResult> {
  const fields = allFieldsFor(type);
  const schema = extractionToolSchema(fields);

  const systemStable = [
    RULES,
    "",
    `── 이번 경험 유형: ${type.emoji} ${type.label} (${type.id}) ──`,
    "아래가 이 유형에서 채워야 할 전체 항목이다. 화면 배치 순서 그대로다.",
    "",
    fieldOutline(type),
    "",
    `업로드된 파일명 목록: ${docs.map((d) => d.name).join(", ")}`,
  ].join("\n");

  const raw = await session.structured<{
    values: Record<string, unknown>;
    evidence: { path: string; sourceId: string; quote: string; confidence: number }[];
    unfilled: { path: string; reason: string }[];
  }>({
    stage: "extract",
    model: MODELS.extractor,
    effort: EFFORT.extractor,
    systemStable,
    systemVolatile: [
      opts.userHint ? `사용자가 준 추가 맥락: ${opts.userHint}` : "",
      opts.feedback ? `\n── 감독 에이전트의 재작업 지시 ──\n${opts.feedback}` : "",
    ]
      .filter(Boolean)
      .join("\n") || undefined,
    toolName: "submit_experience",
    toolDescription: "정리한 경험 항목과 근거를 제출한다.",
    schema,
    content: [{ type: "text", text: buildEvidenceBundle(docs) }],
    maxTokens: 32000,
  });

  return normalize(raw, type, fields);
}

/** 근거·신뢰도를 정리하고, 신뢰도 미달 값은 비운다 */
function normalize(
  raw: {
    values: Record<string, unknown>;
    evidence: { path: string; sourceId: string; quote: string; confidence: number }[];
    unfilled: { path: string; reason: string }[];
  },
  type: ExperienceTypeSpec,
  fields: FieldSpec[],
): ExtractionResult {
  const byPath = new Map<string, FieldValue>();
  for (const e of raw.evidence ?? []) {
    const cur = byPath.get(e.path);
    if (cur) {
      cur.quotes.push({ sourceId: e.sourceId, text: e.quote });
      cur.confidence = Math.max(cur.confidence, e.confidence);
    } else {
      byPath.set(e.path, {
        path: e.path,
        value: undefined,
        confidence: e.confidence,
        quotes: [{ sourceId: e.sourceId, text: e.quote }],
      });
    }
  }

  const values = raw.values ?? {};
  const unfilled = [...(raw.unfilled ?? [])].map((u) => ({
    path: u.path,
    label: labelForPath(type, u.path),
    reason: u.reason,
  }));

  // 신뢰도 미달 값은 비우고 unfilled로 돌린다 — "틀리게 채우느니 비운다"
  for (const [path, fv] of byPath) {
    if (fv.confidence < PIPELINE.fieldConfidenceFloor) {
      setByPath(values, path, null);
      unfilled.push({
        path,
        label: labelForPath(type, path),
        reason: `근거가 약해 비웠습니다 (신뢰도 ${(fv.confidence * 100).toFixed(0)}%)`,
      });
      byPath.delete(path);
    }
  }

  // 스키마에 있으나 응답에 없는 키를 null로 채워 형태를 고정
  for (const f of fields) if (!(f.key in values)) values[f.key] = null;

  // 빈 repeater 항목 제거
  for (const f of fields) {
    if (f.kind === "repeater" && Array.isArray(values[f.key])) {
      const arr = (values[f.key] as unknown[]).filter((row) => !isEmptyValue(row));
      values[f.key] = arr.length ? arr : null;
    }
  }

  const provenance = [...byPath.values()].map((fv) => ({ ...fv, value: undefined }));
  return { values, provenance, unfilled: dedupeUnfilled(unfilled) };
}

function dedupeUnfilled<T extends { path: string }>(list: T[]): T[] {
  const seen = new Set<string>();
  return list.filter((u) => (seen.has(u.path) ? false : (seen.add(u.path), true)));
}
