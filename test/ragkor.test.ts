/**
 * RAGKOR TypeScript 포팅 검증.
 *
 * Python 구현(`ragkor/`)과 **같은 수치가 나오는지**를 확인한다.
 * 알고리즘이 갈라지면 여기서 바로 드러난다.
 *   npx tsx test/ragkor.test.ts
 */
import assert from "node:assert/strict";
import {
  Lexicon, SourceIndex, buildLexicon, decompose, defaultLexicon,
  fold, normalizeNumber, similarity, stem, stripParticle, tokenize, typoVariants,
} from "../src/ragkor/index.js";
import { EXPERIENCE_TYPES } from "../src/schema/index.js";
import { checkGrounding } from "../src/validate/grounding.js";
import { mergeDrafts } from "../src/agents/merge.js";
import { evidenceSpans } from "../src/agents/evidence.js";
import type { ExtractedDoc, ExtractionResult } from "../src/types.js";

let passed = 0;
function test(name: string, fn: () => void) {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    console.error(`  ✗ ${name}\n    ${(e as Error).message}`);
    process.exitCode = 1;
  }
}

const doc = (text: string, name = "d.pdf"): ExtractedDoc => ({
  sourceId: "src1", name, kind: "pdf", mimeType: "application/pdf",
  bytesLength: text.length, text, pages: [], metadata: {}, warnings: [], confidence: 1,
});

/* ── 자모 ─────────────────────────────────────────────────────── */

test("자모 분해가 Python과 일치한다", () => {
  assert.equal(decompose("개선했습니다"), "ㄱㅐㅅㅓㄴㅎㅐㅆㅅㅡㅂㄴㅣㄷㅏ");
});

test("오타와 다른 말이 갈린다 (0.95 vs 0.47)", () => {
  assert.equal(similarity("개선", "게선").toFixed(2), "0.95");
  assert.equal(similarity("개선", "향상").toFixed(2), "0.47");
});

test("오타 생성이 Python과 같은 목록을 낸다", () => {
  assert.deepEqual(typoVariants("개선"), ["게선", "깨선", "대선", "래선", "새선", "개션"]);
});

/* ── 정규화 ───────────────────────────────────────────────────── */

test("조사·어미 정규화", () => {
  assert.equal(stripParticle("프로젝트에서"), "프로젝트");
  assert.equal(stem("개선했습니다"), "개선");
  assert.equal(stem("구현하였으며"), "구현");
});

test("수치 정규화 — 쉼표·단위 흡수", () => {
  assert.equal(normalizeNumber("18,799"), "18799");
  assert.equal(normalizeNumber("1만"), "10000");
});

test("토큰화가 불용어와 한 글자를 걸러낸다", () => {
  const t = tokenize("저는 주문 API의 응답시간을 820ms에서 210ms로 개선했습니다");
  assert.ok(t.includes("주문") && t.includes("api") && t.includes("개선"), t.join(","));
});

/* ── 사전 ─────────────────────────────────────────────────────── */

test("사전이 정확히 1만 건이고 충돌이 없다", () => {
  const lex = buildLexicon();
  assert.equal(lex.entries, 10_000);
  assert.equal(Object.keys(lex.conflicts).length, 0, JSON.stringify(Object.entries(lex.conflicts).slice(0, 3)));
  assert.equal(lex.clusters.length, 72);
});

test("비문이 섞이지 않는다 (성과하다 류)", () => {
  const lex = buildLexicon();
  const bad = Object.keys(lex.canon).filter((k) => /^(성과|지표|매출|회사|문제|비용)하/.test(k));
  assert.deepEqual(bad, []);
});

test("유의어·신조어·오타를 같은 대표형으로 묶는다", () => {
  const lex = defaultLexicon();
  assert.equal(lex.canonical("향상"), lex.canonical("개선"));
  assert.equal(lex.canonical("캐리했다"), lex.canonical("주도했다"));
  assert.equal(lex.canonical("컨텐츠"), lex.canonical("콘텐츠"));
  assert.equal(lex.fuzzyCanonical("프로젝드").canon, lex.canonical("프로젝트"));
});

/* ── 근거 검증: 사용자가 실제로 겪은 실패들 ─────────────────────── */

const SRC = `2.1 이 도메인이 어려운 이유
연금 질의는 일반적인 문서 QA와 세 가지 지점에서 다르다.
1. 틀린 답이 금전적 손해로 직결된다
2. 코퍼스 자체가 불완전하다
3. 금융 규제상 단정적 추천이 금지된다

| 항목 | 값 |
| :--- | :--- |
| Python 모듈 | 62개 |
| 소스 코드 | 18,799행 |
| 회귀 테스트 | 1,476건 |

RAG 계층 개선으로 상품분류 근거 확보율이 32.9%에서 55.7%로 올랐다.`;
const idx = new SourceIndex([SRC]);

test("[회귀] 말줄임표 인용을 환각으로 찍지 않는다", () => {
  const r = idx.verifyQuote(
    "연금 질의는 일반적인 문서 QA와 세 가지 지점에서 다르다. 1. 틀린 답이 금전적 손해로 직결된다. 2…");
  assert.notEqual(r.verdict, "ungrounded", JSON.stringify(r));
  assert.equal(r.score.toFixed(2), "0.86", "Python과 같은 점수여야 한다");
});

test("[회귀] 표 재구성 인용이 통과한다", () => {
  const r = idx.verifyQuote("| 항목 | 값 | | :--- | :--- | | Python 모듈 | 62개 | | 소스 코드 | 18,799행 |");
  assert.equal(r.score, 1);
});

test("[회귀] 유의어로 바꿔 인용해도 근거로 인정한다", () => {
  const r = idx.verifyQuote("RAG 계층 향상으로 상품분류 근거 확보율이 32.9%에서 55.7%로 올랐다");
  assert.notEqual(r.verdict, "ungrounded");
});

test("진짜 환각은 여전히 잡는다", () => {
  assert.equal(idx.verifyQuote("전국 대회에서 대상을 수상하여 상금 5천만원을 받았다").verdict, "ungrounded");
});

test("조각을 긁어모은 문장은 통과하지 못한다", () => {
  const r = idx.verifyQuote("연금 질의는 회귀 테스트 금융 규제상 Python 모듈 불완전하다");
  assert.equal(r.verdict, "ungrounded", JSON.stringify(r));
});

test("[회귀] 파생 수치(55.7-32.9=22.8)를 환각으로 지우지 않는다", () => {
  assert.equal(idx.classifyNumber("22.8"), "derived");
  assert.equal(idx.classifyNumber("18,799"), "literal");
  assert.equal(idx.classifyNumber("777"), "unknown");
});

test("유의어·오타로 등장한 용어도 원문에 있다고 본다", () => {
  assert.equal(idx.checkTerm("개선"), true);
  assert.equal(idx.checkTerm("향상"), true);
  assert.equal(idx.checkTerm("프로젝트"), false);
});

test("[회귀] 파생 수치 성과가 blocker로 찍히지 않는다", () => {
  const award = EXPERIENCE_TYPES.find((t) => t.id === "career.award")!;
  const issues = checkGrounding(
    award,
    { keyAchievement: "근거 확보율을 22.8%p 높였다" },
    [{
      path: "keyAchievement", value: undefined, confidence: 0.9,
      quotes: [{ sourceId: "src1", text: "상품분류 근거 확보율이 32.9%에서 55.7%로 올랐다" }],
    }],
    [doc(SRC)],
    idx,
  );
  assert.ok(!issues.some((i) => i.severity === "blocker"), JSON.stringify(issues, null, 2));
});

/* ── 앙상블 병합 ──────────────────────────────────────────────── */

test("[앙상블] 더 구체적인 성과를 고르고 반복입력은 합친다", () => {
  const work = EXPERIENCE_TYPES.find((t) => t.id === "career.work")!;
  const si = new SourceIndex(["라온테크에서 주문 API 응답시간을 820ms에서 210ms로 줄였다. 배치 모니터링도 했다."]);
  const a: ExtractionResult = {
    values: { companyName: "라온테크", keyAchievement: "성능을 개선했다", tasks: [{ name: "주문 API 개선", role: "단독" }] },
    provenance: [{ path: "companyName", value: undefined, confidence: 0.9, quotes: [{ sourceId: "s", text: "라온테크" }] }],
    unfilled: [],
  };
  const b: ExtractionResult = {
    values: { companyName: "라온테크", keyAchievement: "응답시간을 820ms에서 210ms로 줄였다", tasks: [{ name: "배치 모니터링", role: "공동" }] },
    provenance: [{ path: "keyAchievement", value: undefined, confidence: 0.95, quotes: [{ sourceId: "s", text: "820ms" }] }],
    unfilled: [],
  };
  const { result } = mergeDrafts(work, [a, b], si);
  assert.ok(String(result.values.keyAchievement).includes("820ms"), String(result.values.keyAchievement));
  assert.equal((result.values.tasks as unknown[]).length, 2, "서로 다른 두 건이 합쳐져야 한다");
});

/* ── 비용: 근거 구간 압축 ─────────────────────────────────────── */

test("[비용] 감독 근거가 원문보다 크게 짧아지고 핵심은 남는다", () => {
  const big = "잡담. ".repeat(400) + "\n핵심 문장: 응답시간을 820ms에서 210ms로 줄였다.\n" + "잡담. ".repeat(400);
  const si = new SourceIndex([big]);
  const spans = evidenceSpans(
    [doc(big, "d.txt")],
    { keyAchievement: "응답시간을 820ms에서 210ms로 줄였다" },
    [{
      path: "keyAchievement", value: undefined, confidence: 0.9,
      quotes: [{ sourceId: "src1", text: "응답시간을 820ms에서 210ms로 줄였다" }],
    }],
    si,
    1200,
  );
  assert.ok(spans.length < big.length / 2, `압축 실패: ${spans.length} / ${big.length}`);
  assert.ok(spans.includes("820ms"), "핵심 문장이 사라졌다");
});

/* ── 벤치마크: Python과 같은 F1이 나오는가 ────────────────────── */

test("근거 검증 벤치마크 — 오탐 0건, 미탐 1건 이하 (Python과 같은 실패 양상)", () => {
  const DOCS: Record<string, string> = {
    기술문서: SRC,
    업무메모: `8/12 화
오늘 주문 API 손봄. N+1 때문에 응답이 820ms나 나왔는데
fetch join 걸고 레디스 캐시 붙여서 210ms로 줄임. 개꿀.
근데 캐시 무효화를 깜빡해서 재고 수량이 잠깐 틀어짐 -> 주문 이벤트에서 evict 하도록 픽스.`,
    활동기록: `제10회 미래에셋증권 AI Festival 참가 기록
팀명: ADC (3인)
저는 백엔드 파트를 맡아 다중 에이전트 오케스트레이션을 설계했습니다.
아쉬운 점은 동시성 테스트를 못 한 것입니다.`,
  };
  const variants = (s: string): string[] => [
    s,
    s.slice(0, Math.max(12, Math.floor(s.length * 0.7))) + "…",
    s.replace(/\n/g, " "),
    s.replace(/\./g, " ·").replace(/,/g, " "),
    s.replace(/\s+/g, ""),
    s.length > 12 ? s.slice(3, -3) : s,
  ];
  const fabricated = [
    "전국 대회에서 대상을 수상하여 상금 5천만원을 받았습니다",
    "누적 사용자 100만 명을 달성하여 업계 1위를 기록했습니다",
    "특허 3건을 출원하고 SCI 논문 2편을 게재했습니다",
  ];

  let tp = 0, fp = 0, fn = 0;
  for (const [name, text] of Object.entries(DOCS)) {
    const si = new SourceIndex([text]);
    // 표 구분선('| :--- |')처럼 정규화하면 내용이 남지 않는 줄은 문장이 아니므로 제외한다
    const isSentence = (l: string) => l.length >= 15 && fold(l).length >= 8;
    const lines = text.split("\n").map((l) => l.trim()).filter(isSentence);
    for (const line of lines) {
      for (const q of variants(line)) {
        if (si.verifyQuote(q).verdict !== "ungrounded") tp++;
        else fn++;
      }
    }
    for (const f of fabricated) {
      if (si.verifyQuote(f).verdict !== "ungrounded") fp++;
    }
    // 타 문서 문장 — Python 평가셋과 같은 난이도를 맞추기 위한 음성 케이스
    for (const [other, otherText] of Object.entries(DOCS)) {
      if (other === name) continue;
      for (const l of otherText.split("\n").map((x) => x.trim()).filter(isSentence)) {
        if (si.verifyQuote(l).verdict !== "ungrounded") fp++;
      }
    }
  }
  const precision = tp / (tp + fp);
  const recall = tp / (tp + fn);
  const f1 = (2 * precision * recall) / (precision + recall);
  console.log(`      정밀도 ${precision.toFixed(3)} · 재현율 ${recall.toFixed(3)} · F1 ${f1.toFixed(3)} `
    + `· 오탐 ${fn}건 / 미탐 ${fp}건 (총 ${tp + fn + fp})`);
  // F1 절대값은 평가셋 크기에 좌우된다(Python은 186건에서 0.997).
  // 알고리즘 동등성은 위의 개별 점수 일치(0.86/1.00)로 확인하고,
  // 여기서는 **실패 유형**으로 단언한다 — 이쪽이 회귀를 더 정확히 잡는다.
  assert.equal(fn, 0, "정상 인용을 환각으로 찍으면 안 된다 (기존 구현의 실패 모드)");
  assert.ok(fp <= 1, `환각을 너무 많이 통과시킨다: ${fp}건`);
  assert.ok(f1 >= 0.98, `F1이 낮다: ${f1}`);
});

console.log(`\n${passed}개 통과${process.exitCode ? " (실패 있음)" : ""}\n`);
