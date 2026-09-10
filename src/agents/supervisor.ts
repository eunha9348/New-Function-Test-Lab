import { EFFORT, MODELS } from "../config.js";
import { EXPERIENCE_TYPES, allFieldsFor, labelForPath } from "../schema/index.js";
import type {
  ExperienceTypeSpec, ExtractedDoc, ExtractionResult, ReviewIssue, ReviewResult,
} from "../types.js";
import type { LlmSession } from "../llm/client.js";
import { buildEvidenceBundle } from "./evidence.js";

const SYSTEM = `당신은 ARC 경험 기록 서비스의 **3단계 감독(Supervisor) 에이전트**다.
앞 단계가 만든 정리 결과를 **원문과 대조해 검수**한다. 당신은 작성자가 아니라 심사자다.
좋게 봐주지 말고, 틀린 것을 찾아내는 것이 임무다.

── 검수 항목 (이 순서로 본다) ──
1. **유형 판별이 맞나** — 이 산출물이 정말 이 경험 유형인가.
   명백히 다른 유형이면 verdict="reclassify", reclassifyTo에 올바른 유형 id를 넣는다.
   애매한 정도로는 재분류하지 않는다. 확실할 때만.
2. **환각(hallucination)** — 원문에 근거가 없는 이름·숫자·날짜·기관·성과가 들어갔는가.
   ※ 가장 중요한 항목이다. 하나라도 있으면 verdict는 최소 "revise"다.
   patch로 해당 항목을 null 또는 근거 있는 값으로 고친다.
3. **주어 왜곡** — 팀이 한 일을 '내 역할/기여'에 쓰지 않았는가. 원문이 뒷받침하는 만큼만 남긴다.
4. **오배치(misplaced)** — 다른 항목에 들어가야 할 내용이 엉뚱한 칸에 있는가.
   예: 회사 소개가 '내가 한 일'에, 팀 성과가 '핵심 성과'에.
5. **요약 왜곡(summary_drift)** — 요약이 원문의 의미·강도·인과를 바꿨는가.
   "참여했다"를 "주도했다"로, "시도했다"를 "달성했다"로 바꾼 것은 왜곡이다.
6. **중복(duplication)** — 같은 내용이 두 항목 이상에 들어갔는가. 한 곳만 남긴다.
7. **분해 누락** — 반복 입력에 담아야 할 여러 건이 한 칸에 뭉쳐 있는가. 쪼갠다.
8. **과소 추출** — 원문에 분명히 있는데 비워 둔 항목이 있는가. 있으면 patch로 채운다.
   단, 근거 없이 채우는 것보다는 비워 두는 편이 낫다. 근거가 있을 때만 채운다.
9. **형식** — 날짜·보기·배열 형식. (기계 검증기가 이미 찾은 것은 아래에 목록으로 준다.)

── 판정 기준 ──
· blocker(환각·필수 누락·유형 오류)가 하나라도 있으면 verdict = "revise" 또는 "reclassify"
· major만 있으면 patch로 고칠 수 있으면 "revise", 이미 patch에 다 담았으면 "approve"
· minor만 남으면 "approve"
· 점수는 0~100. 후하게 주지 말 것. faithfulness는 환각이 하나라도 있으면 60점 이하.

── patch 작성법 ──
· path는 값의 경로. 예: "myRole", "tasks[0].metrics", "period.start"
· valueJson은 넣을 값을 **JSON으로 인코딩한 문자열**. 예: "\\"백엔드 API 설계\\"", "null", "[\\"Python\\"]"
· 비워야 하는 항목은 valueJson을 "null"로.
· 고칠 게 없으면 patch는 빈 배열.
· comment는 한국어 3~5문장으로 무엇이 문제였고 무엇을 고쳤는지 요약한다.`;

const SCHEMA = {
  type: "object",
  properties: {
    verdict: { type: "string", enum: ["approve", "revise", "reclassify"] },
    scores: {
      type: "object",
      properties: {
        classification: { type: "number" },
        coverage: { type: "number" },
        faithfulness: { type: "number" },
        formatting: { type: "number" },
      },
      required: ["classification", "coverage", "faithfulness", "formatting"],
      additionalProperties: false,
    },
    issues: {
      type: "array",
      items: {
        type: "object",
        properties: {
          severity: { type: "string", enum: ["blocker", "major", "minor"] },
          type: {
            type: "string",
            enum: ["hallucination", "misplaced", "format", "summary_drift", "duplication", "missing_required", "wrong_type"],
          },
          path: { type: "string" },
          detail: { type: "string", description: "한국어. 무엇이 왜 문제인지 원문을 인용해 설명." },
        },
        required: ["severity", "type", "path", "detail"],
        additionalProperties: false,
      },
    },
    reclassifyTo: {
      type: ["string", "null"],
      enum: [...EXPERIENCE_TYPES.map((t) => t.id), null],
    },
    patch: {
      type: "array",
      items: {
        type: "object",
        properties: {
          path: { type: "string" },
          valueJson: { type: "string", description: "넣을 값의 JSON 인코딩 문자열" },
          note: { type: "string" },
        },
        required: ["path", "valueJson", "note"],
        additionalProperties: false,
      },
    },
    comment: { type: "string" },
  },
  required: ["verdict", "scores", "issues", "reclassifyTo", "patch", "comment"],
  additionalProperties: false,
} as const;

export async function supervise(
  session: LlmSession,
  type: ExperienceTypeSpec,
  draft: ExtractionResult,
  docs: ExtractedDoc[],
  validatorIssues: ReviewIssue[],
): Promise<ReviewResult> {
  const fieldList = allFieldsFor(type)
    .map((f) => `- ${f.key} | ${f.label} — ${f.kind}${f.options ? ` 〔${f.options.join("·")}〕` : ""}${f.required ? " (필수)" : ""}`)
    .join("\n");

  const systemStable = [
    SYSTEM,
    "",
    `── 검수 대상 유형: ${type.emoji} ${type.label} (${type.id}) ──`,
    fieldList,
  ].join("\n");

  const validatorReport = validatorIssues.length
    ? validatorIssues
        .map((i) => `[${i.severity}/${i.type}] ${i.path} — ${i.detail}`)
        .join("\n")
    : "(기계 검증기가 찾은 문제 없음)";

  const provenanceReport = draft.provenance.length
    ? draft.provenance
        .map(
          (p) =>
            `· ${p.path} (신뢰도 ${(p.confidence * 100).toFixed(0)}%) ← ${p.quotes
              .map((q) => `[${q.sourceId}] "${q.text.slice(0, 120)}"`)
              .join(" / ")}`,
        )
        .join("\n")
    : "(근거 없음 — 이 자체가 문제다)";

  const raw = await session.structured<{
    verdict: ReviewResult["verdict"];
    scores: ReviewResult["scores"];
    issues: Omit<ReviewIssue, "foundBy" | "suggestedValue">[];
    reclassifyTo: string | null;
    patch: { path: string; valueJson: string; note: string }[];
    comment: string;
  }>({
    stage: "supervise",
    model: MODELS.supervisor,
    effort: EFFORT.supervisor,
    systemStable,
    toolName: "submit_review",
    toolDescription: "검수 결과와 수정 패치를 제출한다.",
    schema: SCHEMA as unknown as Record<string, unknown>,
    maxTokens: 24000,
    content: [
      { type: "text", text: `## 원문 (근거)\n${buildEvidenceBundle(docs)}` },
      { type: "text", text: `## 정리 결과 (검수 대상)\n\`\`\`json\n${JSON.stringify(draft.values, null, 2)}\n\`\`\`` },
      { type: "text", text: `## 값별 근거\n${provenanceReport}` },
      { type: "text", text: `## 비워 둔 항목\n${draft.unfilled.map((u) => `· ${u.label} (${u.path}) — ${u.reason}`).join("\n") || "(없음)"}` },
      { type: "text", text: `## 기계 검증기 결과\n${validatorReport}` },
    ],
  });

  const patch: Record<string, unknown> = {};
  for (const p of raw.patch ?? []) {
    try {
      patch[p.path] = JSON.parse(p.valueJson);
    } catch {
      // JSON이 아니면 문자열 그대로 취급
      patch[p.path] = p.valueJson;
    }
  }

  return {
    verdict: raw.verdict,
    scores: raw.scores,
    issues: [
      ...validatorIssues,
      ...(raw.issues ?? []).map((i) => ({ ...i, foundBy: "supervisor" as const })),
    ],
    reclassifyTo: raw.reclassifyTo ?? undefined,
    patch,
    comment: raw.comment,
  };
}

export { labelForPath };
