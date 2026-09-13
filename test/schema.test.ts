/**
 * API 키 없이 도는 오프라인 검증.
 *   npm test
 */
import assert from "node:assert/strict";
import {
  BASE_FIELDS, EXTENDED_FIELDS, EXPERIENCE_TYPES, CATEGORIES,
  allFieldsFor, extractionToolSchema, labelForPath, resolveLayout, supersededCommonKeys,
} from "../src/schema/index.js";
import { collectEmptyPaths, completeness } from "../src/agents/guide.js";
import { validateStructure } from "../src/validate/structural.js";
import { checkGrounding } from "../src/validate/grounding.js";
import { getByPath, leafPaths, setByPath } from "../src/util/path.js";
import { detectKind } from "../src/ingest/detect.js";
import { ingestFiles } from "../src/ingest/index.js";
import type { ExtractedDoc, FieldSpec } from "../src/types.js";

let passed = 0;
function test(name: string, fn: () => void | Promise<void>) {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      passed++;
      console.log(`  ✓ ${name}`);
    })
    .catch((e) => {
      console.error(`  ✗ ${name}\n    ${(e as Error).message}`);
      process.exitCode = 1;
    });
}

const commonKeys = new Set([...BASE_FIELDS, ...EXTENDED_FIELDS].map((f) => f.key));

await test("경험 유형은 18종이다", () => {
  assert.equal(EXPERIENCE_TYPES.length, 18);
});

await test("대분류는 4종이고 모든 유형이 실재하는 대분류에 속한다", () => {
  assert.equal(CATEGORIES.length, 4);
  const ids = new Set(CATEGORIES.map((c) => c.id));
  for (const t of EXPERIENCE_TYPES) assert.ok(ids.has(t.category), `${t.id}: ${t.category}`);
});

await test("유형 id는 중복되지 않고 category 접두사와 일치한다", () => {
  const seen = new Set<string>();
  for (const t of EXPERIENCE_TYPES) {
    assert.ok(!seen.has(t.id), `중복 id: ${t.id}`);
    seen.add(t.id);
    assert.equal(t.id.split(".")[0], t.category, t.id);
  }
});

await test("한 유형 안에서 필드 key가 중복되지 않는다", () => {
  for (const t of EXPERIENCE_TYPES) {
    const keys = t.fields.map((f) => f.key);
    assert.equal(new Set(keys).size, keys.length, `${t.id}: ${keys.join(",")}`);
    for (const f of t.fields) {
      if (!f.fields) continue;
      const sub = f.fields.map((x) => x.key);
      assert.equal(new Set(sub).size, sub.length, `${t.id}.${f.key}`);
    }
  }
});

await test("supersedes는 실재하는 공통 항목만 가리킨다", () => {
  for (const t of EXPERIENCE_TYPES) {
    for (const k of supersededCommonKeys(t)) {
      assert.ok(commonKeys.has(k), `${t.id} → 알 수 없는 공통 key: ${k}`);
    }
  }
});

await test("select/checklist에는 보기가 있고, 그 외 kind에는 보기가 없다", () => {
  const walk = (fields: readonly FieldSpec[], where: string) => {
    for (const f of fields) {
      if (f.kind === "select") assert.ok(f.options?.length, `${where}.${f.key} 보기 없음`);
      if (f.options && !["select", "checklist"].includes(f.kind)) {
        assert.fail(`${where}.${f.key} (${f.kind})에 보기가 붙어 있음`);
      }
      if (f.kind === "repeater") {
        assert.ok(f.fields?.length, `${where}.${f.key} 하위 칸 없음`);
        walk(f.fields!, `${where}.${f.key}`);
      }
    }
  };
  for (const t of EXPERIENCE_TYPES) walk(t.fields, t.id);
});

await test("모든 유형이 레이아웃으로 전개된다 (헤더/전용/확장 존재)", () => {
  for (const t of EXPERIENCE_TYPES) {
    const { layout, hiddenCommonKeys } = resolveLayout(t);
    assert.ok(layout.some((s) => s.zone === "header"), t.id);
    assert.ok(layout.some((s) => s.zone === "specialized"), t.id);
    assert.ok(layout.some((s) => s.zone === "extended"), t.id);
    // 숨겨진 공통 항목은 확장 입력에 다시 나타나면 안 된다
    const ext = layout.find((s) => s.zone === "extended")!;
    for (const f of ext.fields) {
      assert.ok(!hiddenCommonKeys.includes(f.key), `${t.id}: ${f.key}가 중복 노출됨`);
    }
  }
});

await test("추출 tool 스키마가 strict 규격을 만족한다", () => {
  const checkObj = (node: any, where: string) => {
    if (!node || typeof node !== "object") return;
    if (node.type === "object" || (Array.isArray(node.type) && node.type.includes("object"))) {
      assert.equal(node.additionalProperties, false, `${where}: additionalProperties`);
      const props = Object.keys(node.properties ?? {});
      assert.deepEqual(
        [...(node.required ?? [])].sort(),
        props.sort(),
        `${where}: required가 모든 키를 덮지 않음`,
      );
      for (const [k, v] of Object.entries(node.properties ?? {})) checkObj(v, `${where}.${k}`);
    }
    if (node.items) checkObj(node.items, `${where}[]`);
  };
  for (const t of EXPERIENCE_TYPES) {
    checkObj(extractionToolSchema(allFieldsFor(t)), t.id);
  }
});

await test("labelForPath가 중첩 경로를 라벨로 바꾼다", () => {
  const work = EXPERIENCE_TYPES.find((t) => t.id === "career.work")!;
  assert.equal(labelForPath(work, "tasks[0].metrics"), "업무내용 > 성과 지표");
  assert.equal(labelForPath(work, "companyName"), "회사명");
});

await test("경로 유틸이 중첩 배열을 읽고 쓴다", () => {
  const o: Record<string, unknown> = {};
  setByPath(o, "tasks[1].name", "리팩터링");
  setByPath(o, "period.start", "2024-03-01");
  assert.equal(getByPath(o, "tasks[1].name"), "리팩터링");
  assert.equal(getByPath(o, "period.start"), "2024-03-01");
  assert.deepEqual(leafPaths(o).sort(), ["period.start", "tasks[1].name"]);
});

await test("형식 검증기가 필수 누락·보기 위반·날짜 역전을 잡는다", () => {
  const work = EXPERIENCE_TYPES.find((t) => t.id === "career.work")!;
  const issues = validateStructure(work, {
    companyName: null, // 필수 누락
    employmentPeriod: { start: "2024-08-01", end: "2024-03-01", ongoing: false }, // 역전
    employmentType: "알바", // 보기에 없음
    position: "인턴",
    jobFunction: "백엔드",
  });
  const types = issues.map((i) => `${i.type}:${i.path}`);
  assert.ok(types.includes("missing_required:companyName"), JSON.stringify(types));
  assert.ok(types.includes("format:employmentPeriod"), JSON.stringify(types));
  assert.ok(types.includes("format:employmentType"), JSON.stringify(types));
});

await test("환각 검증기가 원문에 없는 수치를 잡는다", () => {
  const award = EXPERIENCE_TYPES.find((t) => t.id === "career.award")!;
  const docs: ExtractedDoc[] = [
    {
      sourceId: "src1", name: "상장.png", kind: "image", mimeType: "image/png",
      bytesLength: 10, text: "제12회 교내 창업 경진대회 최우수상 수상. 주최: 창업지원단",
      pages: [], metadata: {}, warnings: [], confidence: 0.9,
    },
  ];
  const issues = checkGrounding(
    award,
    { awardName: "최우수상", keyAchievement: "참가팀 250팀 중 1위" },
    [{ path: "awardName", value: undefined, confidence: 0.9, quotes: [{ sourceId: "src1", text: "최우수상 수상" }] }],
    docs,
  );
  assert.ok(
    issues.some((i) => i.type === "hallucination" && i.detail.includes("250")),
    JSON.stringify(issues, null, 2),
  );
});

await test("환각 검증기가 근거 문장 위조를 잡는다", () => {
  const award = EXPERIENCE_TYPES.find((t) => t.id === "career.award")!;
  const docs: ExtractedDoc[] = [
    {
      sourceId: "src1", name: "상장.png", kind: "image", mimeType: "image/png",
      bytesLength: 10, text: "제12회 교내 창업 경진대회 최우수상 수상",
      pages: [], metadata: {}, warnings: [], confidence: 0.9,
    },
  ];
  const issues = checkGrounding(
    award,
    { awardName: "최우수상" },
    [{ path: "awardName", value: undefined, confidence: 0.9, quotes: [{ sourceId: "src1", text: "전국 대회에서 대상을 받았습니다" }] }],
    docs,
  );
  assert.ok(issues.some((i) => i.severity === "blocker" && i.type === "hallucination"));
});

await test("빈 항목 수집과 채움률 계산", () => {
  const reading = EXPERIENCE_TYPES.find((t) => t.id === "growth.reading")!;
  const empties = collectEmptyPaths(reading, { bookTitle: "사피엔스", author: null });
  const paths = empties.map((e) => e.path);
  assert.ok(!paths.includes("bookTitle"));
  assert.ok(paths.includes("author"));
  assert.ok(paths.includes("summary3"));
  const c = completeness(reading, { bookTitle: "사피엔스" });
  assert.ok(c > 0 && c < 100, String(c));
});

await test("파일 형식 판별 — 확장자·매직넘버·충돌", () => {
  assert.equal(detectKind("보고서.pdf"), "pdf");
  assert.equal(detectKind("상장.JPG"), "image");
  assert.equal(detectKind("발표.pptx"), "pptx");
  assert.equal(detectKind("과제.hwp"), "hwp");
  assert.equal(detectKind("notes"), "unknown");
  // 확장자는 txt인데 실제로는 PNG
  assert.equal(detectKind("fake.txt", undefined, new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0])), "image");
  // 확장자 없고 텍스트 바이트
  assert.equal(detectKind("readme", undefined, new TextEncoder().encode("안녕하세요 텍스트입니다")), "text");
});

await test("텍스트·CSV·HTML 수집이 API 호출 없이 동작한다", async () => {
  const enc = new TextEncoder();
  const docs = await ingestFiles({} as never, [
    { name: "회고.md", bytes: enc.encode("# 회고\n오늘 배포를 했다.") },
    { name: "성과.csv", bytes: enc.encode("항목,수치\n전환율,12%\n방문자,3000") },
    { name: "소개.html", bytes: enc.encode("<html><body><h1>팀 소개</h1><p>백엔드 담당</p><script>x=1</script></body></html>") },
  ]);
  assert.equal(docs.length, 3);
  assert.ok(docs[0]!.text.includes("배포"));
  assert.ok(docs[1]!.text.includes("항목: 전환율 | 수치: 12%"), docs[1]!.text);
  assert.ok(docs[2]!.text.includes("백엔드 담당"));
  assert.ok(!docs[2]!.text.includes("x=1"));
});


/* ───────── Gemini 스키마 변환 / 프론트 바인딩 ───────── */

const { toGeminiSchema, coerceToSchema } = await import("../src/llm/gemini-schema.js");
const { pickModel, pickTier } = await import("../src/llm/gemini.js");
const { toFormState } = await import("../src/form.js");

await test("JSON Schema → Gemini 스키마: 유니온 타입이 nullable로 바뀐다", () => {
  const g: any = toGeminiSchema({
    type: "object",
    properties: {
      name: { type: ["string", "null"], description: "이름" },
      count: { type: "integer" },
      tags: { type: ["array", "null"], items: { type: "string" } },
    },
    required: ["name", "count", "tags"],
    additionalProperties: false,
  });
  assert.equal(g.type, "OBJECT");
  assert.equal(g.properties.name.type, "STRING");
  assert.equal(g.properties.name.nullable, true);
  assert.equal(g.properties.count.nullable, undefined);
  assert.equal(g.properties.tags.type, "ARRAY");
  assert.equal(g.properties.tags.items.type, "STRING");
  // nullable 필드는 required에서 빠지고, additionalProperties는 제거된다
  assert.deepEqual(g.required, ["count"]);
  assert.equal("additionalProperties" in g, false);
  assert.deepEqual(g.propertyOrdering, ["name", "count", "tags"]);
});

await test("Gemini 스키마 변환이 18종 전체에서 깨지지 않는다", () => {
  const walk = (n: any, where: string) => {
    assert.ok(typeof n.type === "string", `${where}: type이 문자열이 아님`);
    assert.ok(
      ["STRING", "NUMBER", "INTEGER", "BOOLEAN", "ARRAY", "OBJECT"].includes(n.type),
      `${where}: 알 수 없는 type ${n.type}`,
    );
    assert.equal("additionalProperties" in n, false, `${where}`);
    if (n.properties) for (const [k, v] of Object.entries(n.properties)) walk(v, `${where}.${k}`);
    if (n.items) walk(n.items, `${where}[]`);
  };
  for (const t of EXPERIENCE_TYPES) {
    walk(toGeminiSchema(extractionToolSchema(allFieldsFor(t))), t.id);
  }
});

await test("coerce: 보기 밖 값·가짜 null 문자열을 정리한다", () => {
  const schema = {
    type: "object",
    properties: {
      employmentType: { type: ["string", "null"], enum: ["인턴", "계약직", "정규직", "프리랜서", null] },
      companyName: { type: ["string", "null"] },
      salary: { type: ["string", "null"] },
      tags: { type: ["array", "null"], items: { type: "string" } },
    },
    required: ["employmentType", "companyName", "salary", "tags"],
    additionalProperties: false,
  };
  const out: any = coerceToSchema(
    { employmentType: "인턴십", companyName: "라온테크", salary: "해당 없음", tags: [] },
    schema,
  );
  assert.equal(out.employmentType, "인턴", "보기 안으로 정규화");
  assert.equal(out.companyName, "라온테크");
  assert.equal(out.salary, null, "'해당 없음'은 null로");
  assert.equal(out.tags, null, "빈 배열은 null로");
});

await test("coerce: 응답에 빠진 키를 null로 채워 폼 형태를 고정한다", () => {
  const schema = {
    type: "object",
    properties: { a: { type: ["string", "null"] }, b: { type: ["string", "null"] } },
    required: ["a", "b"],
    additionalProperties: false,
  };
  assert.deepEqual(coerceToSchema({ a: "값" }, schema), { a: "값", b: null });
});

await test("모델 자동 선택은 세대를 tier보다 먼저 본다", () => {
  const models = ["gemini-2.5-flash", "gemini-2.5-pro", "gemini-3-pro", "gemini-1.5-pro", "embedding-001"];
  assert.equal(pickModel(models), "gemini-3-pro");
  assert.equal(pickModel(["gemini-2.5-flash", "embedding-001"]), "gemini-2.5-flash");
  assert.equal(pickModel(["embedding-001"]), null);
  // 실제 사용자 계정에서 나온 목록 — 3.8세대 flash가 2.5세대 pro보다 낫다
  assert.equal(
    pickModel(["gemini-2.5-pro", "gemini-2.5-flash", "gemini-3.8-flash", "embedding-001"]),
    "gemini-3.8-flash",
    "세대를 먼저 보지 않으면 gemini-2.5-pro 가 선택된다",
  );
  assert.equal(pickTier(["gemini-2.5-pro", "gemini-3.8-flash"], "flash"), "gemini-3.8-flash");
});

await test("toFormState가 프론트에 바로 꽂히는 형태를 만든다", () => {
  const work = EXPERIENCE_TYPES.find((t) => t.id === "career.work")!;
  const { layout, hiddenCommonKeys } = resolveLayout(work);
  const values = {
    title: "라온테크 하계 인턴",
    companyName: "주식회사 라온테크",
    position: "백엔드 인턴",
    tasks: [{ name: "주문 API 개선", role: "단독 담당", detail: "N+1 제거" }],
    salary: null,
  };
  const form = toFormState({
    categoryId: "career", categoryLabel: "커리어",
    typeId: work.id, typeLabel: work.label,
    classification: {
      categoryId: "career", typeId: work.id, confidence: 0.92,
      rationale: "재직증명 문구가 있음", alternatives: [],
      multipleExperiences: false, splitSuggestions: [],
    },
    form: { values, layout, hiddenCommonKeys },
    provenance: [
      { path: "companyName", value: undefined, confidence: 0.95,
        quotes: [{ sourceId: "src1", text: "회사: 주식회사 라온테크" }] },
    ],
    review: {
      rounds: 1,
      final: {
        verdict: "approve",
        scores: { classification: 95, coverage: 70, faithfulness: 92, formatting: 100 },
        issues: [{ severity: "major", type: "format", path: "salary", detail: "급여가 비어 있음", foundBy: "validator" }],
        patch: {}, comment: "",
      },
      history: [],
    },
    fallback: {
      completeness: 64,
      missing: [{ path: "salary", label: "급여", why: "원문에 없음", whatToProvide: "월 급여를 알려주세요",
                  question: "급여는 얼마였나요?", exampleAnswer: "월 220만원", priority: "low" }],
      recommendedUploads: ["경력증명서"],
      nextQuestions: ["담당 업무의 성과를 숫자로 알려주실 수 있나요?"],
    },
    ingest: { docs: [{ sourceId: "src1", name: "보고서.pdf", kind: "pdf", chars: 1200, confidence: 1, warnings: [] }] },
    usage: { inputTokens: 100, outputTokens: 50, cacheReadTokens: 0, estimatedCostUsd: 0.01, calls: [{ stage: "extract", ms: 900 }] },
  });

  assert.equal(form.typeLabel, "인턴 및 업무 경력");
  assert.equal(form.values, values, "values는 그대로 바인딩된다");

  const company = form.fields.find((f) => f.key === "companyName")!;
  assert.equal(company.filled, true);
  assert.equal(company.value, "주식회사 라온테크");
  assert.equal(company.evidence[0]!.fileName, "보고서.pdf", "근거에 파일명이 붙는다");

  const salary = form.fields.find((f) => f.key === "salary")!;
  assert.equal(salary.filled, false);
  assert.equal(salary.guide?.question, "급여는 얼마였나요?", "빈 칸에는 안내 질문이 붙는다");

  const tasks = form.fields.find((f) => f.key === "tasks")!;
  assert.equal(tasks.kind, "repeater");
  assert.ok(tasks.itemFields?.some((f) => f.key === "metrics"), "행 템플릿이 들어 있다");

  // 전용 항목이 대체한 공통 항목은 확장 입력에서 빠진다
  const ext = form.sections.find((s) => s.zone === "extended")!;
  assert.ok(!ext.fields.some((f) => f.key === "period"), "재직기간이 기간을 대체");
  assert.ok(form.sections.some((s) => s.title === "근무 정보"));
  assert.equal(form.review.attentionFields[0]!.label, "급여");
});

console.log(`\n${passed}개 통과${process.exitCode ? " (실패 있음)" : ""}\n`);
