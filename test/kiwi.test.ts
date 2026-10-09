/**
 * Kiwi 형태소 정규화 검증 — 규칙 기반보다 활용형을 잘 묶는가, Python과 같은 원형을 내는가.
 *   npx tsx test/kiwi.test.ts
 * Kiwi 모델이 없으면(tools/fetch_kiwi_model.sh 미실행) 건너뛴다.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { SourceIndex, defaultLexicon, findKiwiModelDir, loadKiwi, normalizeToken, setMorph } from "../src/ragkor/index.js";

const fx = JSON.parse(readFileSync(new URL("./fixtures/inflection-pairs.json", import.meta.url), "utf-8")) as {
  pairs: [string, string][]; distinct: [string, string][];
};

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

const agree = () => fx.pairs.filter(([a, b]) => normalizeToken(a) === normalizeToken(b)).length;
const apart = () => fx.distinct.filter(([a, b]) => normalizeToken(a) !== normalizeToken(b)).length;

setMorph(null);
const ruleAgree = agree();

if (!findKiwiModelDir()) {
  console.log("  - Kiwi 모델 없음 — 건너뜀 (bash tools/fetch_kiwi_model.sh)");
} else {
  const kiwi = await loadKiwi({ quiet: true });

  await test("Kiwi가 로드된다", () => {
    assert.ok(kiwi, "loadKiwi() 실패");
  });

  await test(`활용형 ${fx.pairs.length}쌍 — Kiwi가 규칙보다 많이 묶는다 (규칙 ${ruleAgree}쌍)`, () => {
    const k = agree();
    console.log(`    규칙 ${ruleAgree}/${fx.pairs.length} → Kiwi ${k}/${fx.pairs.length}`);
    assert.ok(k >= 38, `Kiwi ${k}쌍`);
  });

  await test("다른 말은 여전히 갈린다", () => {
    assert.equal(apart(), fx.distinct.length);
  });

  await test("Python(kiwipiepy)과 같은 원형 — 대표 사례", () => {
    assert.equal(normalizeToken("개선했습니다"), "개선");
    assert.equal(normalizeToken("줄였다"), "줄이");
    assert.equal(normalizeToken("응답시간을"), "응답시간");
    assert.equal(normalizeToken("맡았습니다"), "맡");
  });

  await test("사전 유의어 클러스터는 Kiwi를 켜도 그대로 동작한다", () => {
    const lex = defaultLexicon();
    assert.equal(lex.canonical("개선했습니다"), lex.canonical("향상"));
    assert.equal(lex.canonical("캐리했다"), lex.canonical("주도"));
  });

  await test("근거 검증: 사전에 없는 활용형도 같은 용어로 인정한다", () => {
    const idx = new SourceIndex(["fetch join 걸고 레디스 캐시 붙여서 210ms로 줄임"]);
    assert.ok(idx.checkTerm("줄였다"));
    assert.ok(idx.checkTerm("붙였다"));
  });
  setMorph(null);
}

console.log(`\nKiwi ${passed}건 통과`);
