/**
 * 최종 필드 감사관 검증 — API 키 없이 돈다.
 *   npx tsx test/auditor.test.ts
 *
 * 1) 오류 주입 평가: 정답 정리 결과에 '틀린 칸에 넣기' 오류를 일부러 넣고,
 *    기계 검증(사전 감사)이 몇 개를 잡는지, 멀쩡한 칸을 몇 개 잘못 찍는지 잰다.
 * 2) 패치 관문: 감사관(LLM)이 낸 수정 중 원문 정렬을 통과한 것만 적용되는가.
 * 3) 전체 파이프라인: 가짜 LLM 세션으로 끝까지 돌려 감사 보고서가 붙는가, LLM 호출이 늘지 않는가.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { auditFields, applyAuditPatches, preAudit, type AuditPatch } from "../src/agents/auditor.js";
import { organizeExperience } from "../src/pipeline.js";
import { SourceIndex } from "../src/ragkor/index.js";
import { TYPE_BY_ID } from "../src/schema/index.js";
import { checkContext } from "../src/validate/context.js";
import { checkGrounding } from "../src/validate/grounding.js";
import { locateQuotes } from "../src/validate/locate.js";
import { validateStructure } from "../src/validate/structural.js";
import type { LlmSession, StructuredRequest } from "../src/llm/index.js";
import type { ExtractedDoc, ExtractionResult, FieldValue, ReviewIssue } from "../src/types.js";

let passed = 0;
async function test(name: string, fn: () => void | Promise<void>) {
  try {
    await fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    console.error(`  ✗ ${name}\n    ${(e as Error).message}`);
    process.exitCode = 1;
  }
}

const TEXT = readFileSync(new URL("../examples/sample-intern-report.md", import.meta.url), "utf-8");
const doc: ExtractedDoc = {
  sourceId: "src1", name: "sample-intern-report.md", kind: "text", mimeType: "text/markdown",
  bytesLength: TEXT.length, text: TEXT, pages: [], metadata: {}, warnings: [], confidence: 1,
};
const docs = [doc];
const type = TYPE_BY_ID.get("career.work")!;
const index = new SourceIndex([TEXT]);

const q = (text: string) => ({ sourceId: "src1", text });
const prov = (path: string, ...texts: string[]): FieldValue => ({ path, value: undefined, confidence: 0.9, quotes: texts.map(q) });

/* ── 정답 정리 결과 ─────────────────────────────────────────── */
function gold(): ExtractionResult {
  return {
    values: {
      companyName: "주식회사 라온테크",
      position: "백엔드 엔지니어링 인턴",
      jobFunction: "백엔드 엔지니어링",
      team: "플랫폼개발팀",
      motivation: "대규모 트래픽을 다루는 서비스의 백엔드 구조를 실제로 보고 싶어 지원했습니다.",
      learned: "성능 문제는 추측이 아니라 측정에서 시작해야 한다는 걸 체감했습니다.",
      resignReason: "인턴 기간 만료로 8월 30일자 종료",
      tasks: [
        {
          name: "주문 조회 API 응답 개선", role: "단독 담당",
          detail: "N+1 쿼리 문제를 JPA fetch join과 Redis 캐시로 해결",
          tools: "Spring Boot, JPA, Redis, Grafana",
          metrics: "평균 응답 820ms → 210ms",
          risks: "캐시 무효화 시점을 놓쳐 재고 수량이 어긋난 문제를 주문 이벤트 발행 시 evict 하도록 바꿔 해결",
        },
        {
          name: "사내 배치 모니터링 대시보드", role: "백엔드 집계 API",
          detail: "백엔드 집계 API와 슬랙 실패 알림 기능 개발",
          metrics: "배치 실패 인지 시간 평균 40분 → 5분 이내",
        },
      ],
    },
    provenance: [
      prov("companyName", "회사: 주식회사 라온테크"),
      prov("position", "직무: 백엔드 엔지니어링 인턴"),
      prov("jobFunction", "직무: 백엔드 엔지니어링 인턴"),
      prov("team", "소속: 플랫폼개발팀"),
      prov("motivation", "대규모 트래픽을 다루는 서비스의 백엔드 구조를 실제로 보고 싶어 지원했습니다."),
      prov("learned", "성능 문제는 추측이 아니라 측정에서 시작해야 한다는 걸 체감했습니다."),
      prov("resignReason", "인턴 기간 만료로 8월 30일자 종료되었습니다."),
      prov("tasks[0].name", "주문 조회 API 응답 개선"),
      prov("tasks[0].role", "역할: 단독 담당 (멘토 코드리뷰)"),
      prov("tasks[0].detail", "JPA fetch join과 Redis 캐시를 적용해 평균 210ms로 줄였습니다."),
      prov("tasks[0].tools", "활용 툴: Spring Boot, JPA, Redis, Grafana"),
      prov("tasks[0].metrics", "JPA fetch join과 Redis 캐시를 적용해 평균 210ms로 줄였습니다."),
      prov("tasks[0].risks", "주문 이벤트 발행 시점에 캐시를 evict 하도록 바꿔 해결했습니다."),
      prov("tasks[1].name", "사내 배치 모니터링 대시보드"),
      prov("tasks[1].role", "저는 백엔드 집계 API를 맡았습니다."),
      prov("tasks[1].detail", "실패한 배치 잡을 슬랙으로 알림 보내는 기능까지 붙였습니다."),
      prov("tasks[1].metrics", "도입 후 배치 실패 인지 시간이 평균 40분에서 5분 이내로 줄었습니다."),
    ],
    unfilled: [],
  };
}

async function issuesOf(d: ExtractionResult): Promise<ReviewIssue[]> {
  return [
    ...validateStructure(type, d.values),
    ...checkGrounding(type, d.values, d.provenance, docs, index),
    ...(await checkContext(type, d.values, d.provenance, docs)),
  ];
}

async function prepared(d: ExtractionResult) {
  const located = { ...d, provenance: locateQuotes(d.provenance, docs) };
  return { draft: located, issues: await issuesOf(located) };
}

/* ── 1) 오류 주입 평가 ─────────────────────────────────────── */

interface Injection {
  name: string;
  path: string;
  /** 기계 검증으로 잡혀야 하는가 (false = 의미 판단이 필요해 LLM 감사관 몫) */
  machine: boolean;
  apply: (d: ExtractionResult) => void;
}

const set = (d: ExtractionResult, path: string, value: unknown, ...quotes: string[]) => {
  const [k, rest] = path.split(/\.(.+)/);
  const m = /^(\w+)\[(\d+)\]$/.exec(k!);
  if (m) (d.values[m[1]!] as Record<string, unknown>[])[Number(m[2])]![rest!] = value;
  else d.values[path] = value;
  d.provenance = d.provenance.filter((p) => p.path !== path);
  if (quotes.length) d.provenance.push(prov(path, ...quotes));
};

const INJECTIONS: Injection[] = [
  { name: "이슈(문제) 문장을 성과 칸에", path: "keyAchievement", machine: true,
    apply: (d) => set(d, "keyAchievement", "캐시 무효화 시점을 놓쳐 재고 수량이 잠깐 어긋남",
      "이슈: 캐시 무효화 시점을 놓쳐 재고 수량이 잠깐 어긋난 적이 있었고") },
  { name: "결과 없이 행동만 성과 칸에", path: "outcome", machine: true,
    apply: (d) => set(d, "outcome", "Redis 캐시를 적용했습니다") },
  { name: "팀이 한 일을 내 업무 칸에", path: "tasks[1].detail", machine: true,
    apply: (d) => set(d, "tasks[1].detail", "팀원들이 슬랙 알림 기능을 붙였다") },
  { name: "원문에 없는 수치", path: "tasks[0].metrics", machine: true,
    apply: (d) => set(d, "tasks[0].metrics", "평균 응답 820ms → 150ms",
      "JPA fetch join과 Redis 캐시를 적용해 평균 210ms로 줄였습니다.") },
  { name: "지어낸 성과와 지어낸 근거", path: "keyAchievement", machine: true,
    apply: (d) => set(d, "keyAchievement", "사내 우수 인턴으로 선정", "인턴 평가에서 사내 우수 인턴으로 선정되었습니다.") },
  { name: "같은 성과를 두 칸에 중복", path: "outcome", machine: true,
    apply: (d) => set(d, "outcome", "배치 실패 인지 시간 40분 → 5분",
      "도입 후 배치 실패 인지 시간이 평균 40분에서 5분 이내로 줄었습니다.") },
  { name: "퇴사 사유를 배운 점 칸에", path: "learned", machine: false,
    apply: (d) => set(d, "learned", "인턴 기간 만료로 종료", "인턴 기간 만료로 8월 30일자 종료되었습니다.") },
  { name: "참여를 주도로 과장", path: "tasks[1].role", machine: false,
    apply: (d) => set(d, "tasks[1].role", "대시보드 개발 주도", "저는 백엔드 집계 API를 맡았습니다.") },
];

await test("정답 결과에서는 칸을 잘못 찍지 않는다 (오탐 0)", async () => {
  const { draft, issues } = await prepared(gold());
  const pre = preAudit(type, draft, docs, issues);
  const flagged = [...pre.audits.values()].filter((a) => a.status === "flagged");
  assert.equal(flagged.length, 0, flagged.map((a) => `${a.path}: ${a.notes.join(" / ")}`).join("\n    "));
});

const caught: string[] = [];
const missed: string[] = [];
for (const inj of INJECTIONS) {
  await test(`[${inj.machine ? "기계" : "LLM 몫"}] ${inj.name} → ${inj.path}`, async () => {
    const d = gold();
    inj.apply(d);
    const { draft, issues } = await prepared(d);
    const pre = preAudit(type, draft, docs, issues);
    const a = pre.audits.get(inj.path)!;
    const hit = a.status === "flagged";
    (hit ? caught : missed).push(inj.name);
    if (inj.machine) assert.ok(hit, `잡히지 않음: ${a.notes.join(" / ") || "(메모 없음)"}`);
    // 다른 칸은 멀쩡해야 한다
    const others = [...pre.audits.values()].filter((x) => x.status === "flagged" && x.path !== inj.path
      && !(inj.name.includes("중복") && x.path === "tasks[1].metrics"));
    assert.equal(others.length, 0, `다른 칸 오탐: ${others.map((x) => x.path).join(", ")}`);
  });
}

await test("오류 주입 요약", () => {
  const machine = INJECTIONS.filter((i) => i.machine).length;
  console.log(`    기계 검증 ${caught.length}/${INJECTIONS.length} 적발 (기계 대상 ${machine}건 전부 + 의미 판단 ${caught.length - machine}건)`);
  console.log(`    LLM 감사관 몫으로 남음: ${missed.join(", ") || "없음"}`);
});

await test("임베딩: 단서어가 없는 한계 문장도 성과 칸에서 잡는다 (가짜 임베더)", async () => {
  // 단서어가 하나도 없는 문장 — 규칙만으로는 못 잡고 임베딩이 있어야 잡힌다
  const SENT = "동시 접속 상황은 다뤄 보지 않았다";
  const text = `## 정리\n${SENT}.\n`;
  const d2: ExtractedDoc = { ...doc, text };
  const lim = [0, 1, 0], out = [1, 0, 0], plan = [0, 0, 1];
  const fake = {
    name: "fake",
    async embed(texts: string[]) {
      return texts.map((t) => (t.includes("한계") || t.includes("못") || t.includes("포기") || t.includes(SENT)) ? lim
        : (t.includes("예정") || t.includes("하려") || t.includes("목표")) ? plan : out);
    },
  };
  const pv = locateQuotes([prov("keyAchievement", SENT)], [d2]);
  const withEmb = await checkContext(type, { keyAchievement: SENT }, pv, [d2], { embedder: fake });
  const without = await checkContext(type, { keyAchievement: SENT }, pv, [d2]);
  assert.ok(withEmb.some((i) => i.type === "context_mismatch" && /임베딩/.test(i.detail)), JSON.stringify(withEmb));
  assert.equal(without.filter((i) => i.type === "context_mismatch").length, 0);
});

/* ── 2) 패치 관문 ─────────────────────────────────────────── */

async function gate(d: ExtractionResult, patches: AuditPatch[]) {
  const { draft, issues } = await prepared(d);
  const pre = preAudit(type, draft, docs, issues);
  return applyAuditPatches(draft, patches, { type, docs, index, pre });
}

await test("wrong_field — 빈 칸으로 옮긴다", async () => {
  const d = gold();
  set(d, "learned", "인턴 기간 만료로 종료", "인턴 기간 만료로 8월 30일자 종료되었습니다.");
  d.values.resignReason = null;
  d.provenance = d.provenance.filter((p) => p.path !== "resignReason");
  const r = await gate(d, [{ path: "learned", verdict: "wrong_field", moveTo: "resignReason", reason: "퇴사 사유다" }]);
  assert.equal(r.applied.length, 1);
  assert.equal(r.draft.values.learned, null);
  assert.equal(r.draft.values.resignReason, "인턴 기간 만료로 종료");
  assert.ok(r.draft.provenance.some((p) => p.path === "resignReason"));
});

await test("wrong_field — 채워진 칸이나 없는 칸으로는 옮기지 않는다", async () => {
  const r = await gate(gold(), [
    { path: "learned", verdict: "wrong_field", moveTo: "resignReason", reason: "" },
    { path: "learned", verdict: "wrong_field", moveTo: "noSuchField", reason: "" },
  ]);
  assert.equal(r.applied.length, 0);
  assert.equal(r.rejected.length, 2);
});

await test("distorted — 원문 그대로의 근거가 있으면 고친다", async () => {
  const d = gold();
  set(d, "tasks[1].role", "대시보드 개발 주도", "저는 백엔드 집계 API를 맡았습니다.");
  const r = await gate(d, [{
    path: "tasks[1].role", verdict: "distorted", value: "백엔드 집계 API 담당",
    quote: "저는 백엔드 집계 API를 맡았습니다.", reason: "주도가 아니라 담당",
  }]);
  assert.equal(r.applied.length, 1);
  assert.equal((r.draft.values.tasks as Record<string, unknown>[])[1]!.role, "백엔드 집계 API 담당");
  const pv = r.draft.provenance.find((p) => p.path === "tasks[1].role")!;
  assert.ok(pv.quotes[0]!.start !== undefined && pv.quotes[0]!.alignScore! >= 0.85);
});

await test("지어낸 근거로 고치려 하면 버린다", async () => {
  const r = await gate(gold(), [{
    path: "companyName", verdict: "distorted", value: "라온테크 글로벌",
    quote: "회사: 라온테크 글로벌 주식회사 본사", reason: "",
  }]);
  assert.equal(r.applied.length, 0);
  assert.match(r.rejected[0]!.why, /원문과 맞지 않습니다/);
});

await test("원문에 없는 수치로 고치려 하면 버린다", async () => {
  const r = await gate(gold(), [{
    path: "tasks[0].metrics", verdict: "incomplete", value: "평균 응답 820ms → 210ms, 처리량 1,200건",
    quote: "JPA fetch join과 Redis 캐시를 적용해 평균 210ms로 줄였습니다.", reason: "",
  }]);
  assert.equal(r.applied.length, 0);
  assert.match(r.rejected[0]!.why, /수치/);
});

await test("근거가 단단한 칸은 감사관이 '근거 없음'이라 해도 지우지 않는다", async () => {
  const r = await gate(gold(), [{ path: "companyName", verdict: "unsupported", reason: "" }]);
  assert.equal(r.applied.length, 0);
  assert.equal(r.draft.values.companyName, "주식회사 라온테크");
});

await test("근거가 없는 칸은 '근거 없음' 판정으로 비운다", async () => {
  const d = gold();
  set(d, "keyAchievement", "사내 우수 인턴으로 선정", "인턴 평가에서 사내 우수 인턴으로 선정되었습니다.");
  const r = await gate(d, [{ path: "keyAchievement", verdict: "unsupported", reason: "원문에 없음" }]);
  assert.equal(r.applied.length, 1);
  assert.equal(r.draft.values.keyAchievement, null);
});

/* ── 3) 감사관 진입점: 되돌림 + 호출 1회 ─────────────────────── */

function stubSession(handler: (req: StructuredRequest) => unknown): LlmSession & { calls: string[] } {
  const calls: string[] = [];
  return {
    providerName: "stub",
    calls,
    usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, estimatedCostUsd: 0, calls: [] },
    async resolveModel() { return "stub"; },
    async structured<T>(req: StructuredRequest) { calls.push(req.toolName); return handler(req) as T; },
    async text() { return ""; },
    async verify() { return { ok: true, detail: "stub" }; },
  };
}

await test("감사관은 LLM을 정확히 1번 부르고, 새 문제를 만드는 수정은 되돌린다", async () => {
  const d = gold();
  set(d, "tasks[1].role", "대시보드 개발 주도", "저는 백엔드 집계 API를 맡았습니다.");
  const { draft, issues } = await prepared(d);
  const session = stubSession(() => ({
    fields: [
      { path: "tasks[1].role", verdict: "distorted", moveTo: null, valueJson: "\"백엔드 집계 API 담당\"",
        quote: "저는 백엔드 집계 API를 맡았습니다.", reason: "과장" },
      // 날짜 형식을 깨뜨리는 수정 — 근거는 맞지만 형식 검증에서 새 major가 생긴다
      { path: "motivation", verdict: "wrong_field", moveTo: "employmentPeriod", valueJson: null, quote: null, reason: "" },
      { path: "companyName", verdict: "correct", moveTo: null, valueJson: null, quote: null, reason: "" },
    ],
    comment: "역할 과장 1건 수정",
  }));
  const r = await auditFields(session, type, draft, docs, index, {
    issues, evidenceText: TEXT, useLlm: true,
    revalidate: async (x) => issuesOf(x),
  });
  assert.deepEqual(session.calls, ["submit_field_audit"]);
  assert.equal(r.report.applied.length, 1, JSON.stringify(r.report.rejected));
  assert.equal(r.report.fields.find((f) => f.path === "tasks[1].role")!.status, "fixed");
  assert.equal(r.draft.values.motivation, gold().values.motivation);
  assert.ok(r.report.summary.fieldAccuracy > 0);
});

await test("LLM 없이(fast)도 사전 감사 보고서가 나온다", async () => {
  const { draft, issues } = await prepared(gold());
  const session = stubSession(() => { throw new Error("불리면 안 됨"); });
  const r = await auditFields(session, type, draft, docs, index, {
    issues, evidenceText: TEXT, useLlm: false, revalidate: async (x) => issuesOf(x),
  });
  assert.equal(session.calls.length, 0);
  assert.equal(r.report.llm, false);
  assert.equal(r.report.summary.flagged, 0);
});

/* ── 4) 전체 파이프라인 (가짜 LLM) ─────────────────────────── */

await test("전체 파이프라인: 감사 보고서가 붙고, 감사관 호출은 1번뿐이다", async () => {
  const g = gold();
  const session = stubSession((req) => {
    switch (req.toolName) {
      case "submit_factsheet":
        return { docType: "보고서", register: "격식체", title: "하계 인턴십", outline: [], entities: { people: [], orgs: ["라온테크"], products: [], tools: [] },
          numbers: [], dates: [], myActions: [], teamActions: [], unclear: [], achievements: [], problems: [], learnings: [], links: [], normalized: [] };
      case "submit_classification":
        return { categoryId: "career", typeId: "career.work", confidence: 0.95, rationale: "인턴 보고서", alternatives: [], multipleExperiences: false, splitSuggestions: [] };
      case "submit_experience":
        return {
          values: { ...g.values, keyAchievement: "재고 수량이 잠깐 어긋남" },
          evidence: [
            ...g.provenance.map((p) => ({ path: p.path, sourceId: "src1", quote: p.quotes[0]!.text, confidence: 0.9 })),
            { path: "keyAchievement", sourceId: "src1", quote: "이슈: 캐시 무효화 시점을 놓쳐 재고 수량이 잠깐 어긋난 적이 있었고", confidence: 0.9 },
          ],
          unfilled: [],
        };
      case "submit_arbitration": return { decisions: [] };
      case "submit_review":
        return { verdict: "approve", scores: { classification: 95, coverage: 80, faithfulness: 90, formatting: 100 }, issues: [], reclassifyTo: null, patch: [], comment: "" };
      case "submit_field_audit":
        return { fields: [{ path: "keyAchievement", verdict: "wrong_field", moveTo: "tasks[0].risks", valueJson: null, quote: null, reason: "문제 상황이다" }], comment: "" };
      case "submit_guide":
        return { missing: [], recommendedUploads: [], nextQuestions: [] };
      default:
        throw new Error(`예상하지 못한 호출: ${req.toolName}`);
    }
  });
  const result = await organizeExperience([{ name: "sample-intern-report.md", text: TEXT }], { session, quality: "balanced" });
  assert.ok(result.audit, "감사 보고서 없음");
  assert.equal(session.calls.filter((c) => c === "submit_field_audit").length, 1);
  const ka = result.audit!.fields.find((f) => f.path === "keyAchievement")!;
  // tasks[0].risks가 이미 채워져 있어 옮기지 못하고 '확인 필요'로 남는다 — 지우거나 덮어쓰지 않는다
  assert.equal(ka.status, "flagged");
  assert.ok(result.provenance.some((p) => p.quotes.some((x) => x.start !== undefined)), "근거 위치가 없다");
  assert.ok(result.review.final.issues.some((i) => i.type === "context_mismatch" && i.path === "keyAchievement"));
});

console.log(`\n필드 감사관 ${passed}건 통과`);
