/**
 * 인용 정렬기 검증 — RapidFuzz와 같은 점수를 내는가, 위치가 맞는가.
 *   npx tsx test/align.test.ts
 * 기준값: python tools/gen_align_fixture.py (실제 rapidfuzz로 생성)
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { alignQuote, foldWithMap, partialRatioAlignment } from "../src/ragkor/align.js";

interface Case {
  doc: string; kind: string; quote: string; truth: boolean; score: number;
  lineStart?: number; lineEnd?: number; start?: number; end?: number;
}
const fx = JSON.parse(readFileSync(new URL("./fixtures/align-rapidfuzz.json", import.meta.url), "utf-8")) as {
  rapidfuzz: string; docs: Record<string, string>; cases: Case[];
};

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

/*
 * 판정에 쓰이는 구간(0.5 이상)에서는 rapidfuzz와 같은 점수를 내야 한다.
 * 그 아래(공유하는 3-gram이 거의 없는 환각)는 후보 탐색을 건너뛰므로 점수가 더 낮게 나올 수 있다.
 * 그때도 rapidfuzz보다 높게 나오면 안 된다 — 환각을 근거로 올려 주는 쪽의 오차는 허용하지 않는다.
 */
test(`점수가 rapidfuzz ${fx.rapidfuzz}와 일치한다 (${fx.cases.length}건, 0.5 이상 구간 오차 0.02 이내)`, () => {
  const folded = Object.fromEntries(Object.entries(fx.docs).map(([k, v]) => [k, foldWithMap(v).chars]));
  const off: string[] = [];
  for (const c of fx.cases) {
    const q = foldWithMap(c.quote).chars;
    const r = partialRatioAlignment(q, folded[c.doc]!);
    const bad = c.score >= 0.5 ? Math.abs(r.score - c.score) > 0.02 : r.score > c.score + 0.02 || r.score >= 0.5;
    if (bad) off.push(`[${c.kind}] ${c.quote.slice(0, 20)} ts=${r.score.toFixed(3)} rf=${c.score}`);
  }
  assert.equal(off.length, 0, off.slice(0, 5).join("\n    "));
});

test("근거 있는 인용은 원래 문장 위치를 가리킨다", () => {
  const miss: string[] = [];
  for (const c of fx.cases.filter((x) => x.truth)) {
    const r = alignQuote(c.quote, fx.docs[c.doc]!)!;
    const overlap = Math.min(r.end, c.lineEnd!) - Math.max(r.start, c.lineStart!);
    if (overlap <= 0) miss.push(`[${c.kind}] ${c.quote.slice(0, 20)}`);
  }
  assert.equal(miss.length, 0, miss.slice(0, 5).join(", "));
});

test("하이라이트가 원문 문장 밖으로 크게 번지지 않는다", () => {
  for (const c of fx.cases.filter((x) => x.truth && x.kind === "원문 그대로")) {
    const r = alignQuote(c.quote, fx.docs[c.doc]!)!;
    assert.ok(r.start >= c.lineStart! - 2 && r.end <= c.lineEnd! + 2,
      `${c.quote.slice(0, 20)}: ${r.start}-${r.end} vs ${c.lineStart}-${c.lineEnd}`);
  }
});

test("원문 좌표를 그대로 잘라 보면 인용과 같은 글이다", () => {
  const doc = fx.docs["기술문서"]!;
  const q = "RAG 계층을 개선하여 상품분류 근거 확보율이 32.9%에서 55.7%로 올랐다.";
  const r = alignQuote(q, doc)!;
  assert.equal(doc.slice(r.start, r.end), q.slice(0, -1));
  assert.equal(r.score, 1);
});

test("환각 인용과 근거 있는 인용의 점수가 갈린다", () => {
  const t = fx.cases.filter((c) => c.truth).map((c) => c.score);
  const f = fx.cases.filter((c) => !c.truth).map((c) => c.score);
  assert.ok(Math.min(...t) > Math.max(...f) + 0.3, `true min ${Math.min(...t)} / false max ${Math.max(...f)}`);
});

test("4글자 미만 인용은 위치를 주지 않는다", () => {
  assert.equal(alignQuote("| :- |", "아무 문서"), null);
});

test("긴 문서에서도 빠르다 (3만 자 · 인용 30건 < 2초)", () => {
  const doc = Object.values(fx.docs).join("\n").repeat(40).slice(0, 30_000);
  const fs = foldWithMap(doc);
  const quotes = fx.cases.filter((c) => c.truth).slice(0, 30).map((c) => c.quote);
  const t0 = Date.now();
  for (const q of quotes) alignQuote(q, fs);
  const ms = Date.now() - t0;
  assert.ok(ms < 2000, `${ms}ms`);
  console.log(`    (${ms}ms)`);
});

console.log(`\n정렬기 ${passed}건 통과`);
