/**
 * 근거 검증 — RAGKOR의 존재 이유.
 *
 * 기존 검증기는 `normalize(quote) in normalize(source)` 였다.
 * 모델이 인용을 조금만 다듬으면(말줄임표, 표 재구성, 페이지 머리말 삽입)
 * 전부 '환각'으로 튀었고, 그 오탐이 감독에게 흘러가 재작업을 유발했다.
 * 여기서는 **n-gram 국소 밀도**로 "원문 어딘가에 이 말이 실제로 있는가"를 잰다.
 */
import { similarity } from "./jamo.js";
import { defaultLexicon, type Lexicon } from "./match.js";
import { STOPWORDS, fold, ngrams, normalizeNumber, numbersIn, tokenize } from "./normalize.js";

const GRAM = 4;

export type QuoteVerdict = "grounded" | "weak" | "ungrounded";
export type NumberKind = "literal" | "derived" | "unknown";

export interface QuoteCheck {
  score: number;
  verdict: QuoteVerdict;
  where: string;
}

/** 원문 한 벌을 여러 관점으로 색인해 둔다 — 질의마다 다시 훑지 않는다. */
export class SourceIndex {
  readonly raw: string;
  readonly folded: string;
  readonly postings = new Map<string, number[]>();
  readonly numbers: Set<string>;
  readonly tokens: Set<string>;
  readonly canonTokens: Set<string>;
  readonly latin: Set<string>;
  private readonly numericValues: number[];

  constructor(texts: string[], readonly lex: Lexicon = defaultLexicon()) {
    this.raw = texts.join("\n");
    this.folded = fold(this.raw);
    for (let i = 0; i + GRAM <= this.folded.length; i++) {
      const g = this.folded.slice(i, i + GRAM);
      const arr = this.postings.get(g);
      if (arr) arr.push(i);
      else this.postings.set(g, [i]);
    }
    this.numbers = numbersIn(this.raw);
    this.tokens = new Set(tokenize(this.raw));
    this.canonTokens = new Set([...this.tokens].map((t) => this.lex.canonical(t)));
    this.latin = new Set(
      [...this.tokens].filter((t) => /^[A-Za-z]/.test(t)).map((t) => t.toLowerCase()),
    );
    this.numericValues = [...new Set(
      [...this.numbers].map(Number).filter((v) => Number.isFinite(v)),
    )].sort((a, b) => a - b).slice(0, 200);
  }

  /* ── 인용문 검증 ────────────────────────────────────────────── */

  /**
   * 0~1. '원문에 이 말이 이어진 형태로 존재하는 정도'.
   *
   * 전역 포함률이 아니라 **한 구간에 몰려 있는 정도**를 본다.
   * 문서 여기저기서 조각을 긁어모아 만든 문장은 점수가 낮게 나온다.
   */
  quoteScore(quote: string): { score: number; where: string } {
    const grams = ngrams(quote, GRAM);
    const foldedQuote = fold(quote);
    // 표 구분선('| :--- |')처럼 정규화하면 아무것도 남지 않는 인용은
    // 환각은 아니지만 근거로도 쓸 수 없다. 통과시키면 빈 근거가 진짜 근거 행세를 한다.
    if (foldedQuote.length < 4) return { score: 0, where: "내용 없음" };
    if (grams.length === 0) return { score: 0, where: "너무 짧음" };
    if (grams.length < 3) {
      const hit = this.folded.includes(foldedQuote);
      return { score: hit ? 1 : 0, where: hit ? "직접 포함" : "원문에 없음" };
    }

    const hits: [number, number][] = [];            // [원문 위치, 인용 내 gram 번호]
    grams.forEach((g, idx) => {
      for (const pos of this.postings.get(g) ?? []) hits.push([pos, idx]);
    });
    if (hits.length === 0) return { score: 0, where: "일치 구간 없음" };

    hits.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    const width = Math.floor(foldedQuote.length * 1.8) + 40; // 원문이 좀 더 길어도 허용
    const window = new Map<number, number>();
    let best = 0;
    let left = 0;
    for (let right = 0; right < hits.length; right++) {
      const idx = hits[right]![1];
      window.set(idx, (window.get(idx) ?? 0) + 1);
      while (hits[right]![0] - hits[left]![0] > width) {
        const lidx = hits[left]![1];
        const n = (window.get(lidx) ?? 0) - 1;
        if (n <= 0) window.delete(lidx);
        else window.set(lidx, n);
        left++;
      }
      if (window.size > best) best = window.size;
    }
    const score = best / grams.length;
    const where = score >= 0.85 ? "국소 일치" : score >= 0.55 ? "부분 일치" : "산발 일치";
    return { score, where };
  }

  verifyQuote(quote: string): QuoteCheck {
    const { score, where } = this.quoteScore(quote);
    // '내용 없음'은 지어낸 것이 아니므로 환각(blocker)으로 올리지 않고 약한 근거로 둔다
    const verdict: QuoteVerdict = where === "내용 없음"
      ? "weak"
      : score >= 0.85 ? "grounded" : score >= 0.55 ? "weak" : "ungrounded";
    return { score: Math.round(score * 1000) / 1000, verdict, where };
  }

  /* ── 값 검증 ───────────────────────────────────────────────── */

  checkNumber(raw: string): boolean {
    const n = normalizeNumber(raw);
    if (this.numbers.has(n)) return true;
    const v = Number(n);
    if (!Number.isFinite(v)) return false;
    return this.numericValues.some((m) => Math.abs(m - v) < 1e-9);
  }

  /**
   * '원문 그대로' / '원문에서 계산됨' / '근거 없음' 을 가른다.
   *
   * '32.9%→55.7%' 가 원문에 있으면 '22.8%p 향상'은 환각이 아니라 **파생값**이다.
   * 이걸 구분하지 못하면 모델이 옳게 계산한 성과까지 환각으로 지워진다.
   */
  classifyNumber(raw: string): NumberKind {
    const n = normalizeNumber(raw);
    if (this.checkNumber(n)) return "literal";
    const v = Number(n);
    if (!Number.isFinite(v)) return "unknown";
    const eps = Math.max(0.05, Math.abs(v) * 1e-6);
    const nums = this.numericValues;
    for (let i = 0; i < nums.length; i++) {
      const a = nums[i]!;
      for (let j = i + 1; j < nums.length; j++) {
        const b = nums[j]!;
        if (Math.abs(Math.abs(a - b) - v) < eps || Math.abs(a + b - v) < eps
          || (b !== 0 && Math.abs((a / b) * 100 - v) < 0.05)
          || (a !== 0 && Math.abs((b / a) * 100 - v) < 0.05)
          || (a !== 0 && Math.abs(((b - a) / a) * 100 - v) < 0.05)) {
          return "derived";
        }
      }
    }
    return "unknown";
  }

  /** 고유명사·용어가 원문에 있는가. 유의어와 오타를 모두 허용한다. */
  checkTerm(term: string, fuzzy = 0.88): boolean {
    const t = term.trim();
    if (!t || STOPWORDS.has(t.toLowerCase())) return true;
    if (this.latin.has(t.toLowerCase()) || this.tokens.has(t)) return true;
    const f = fold(t);
    if (f && this.folded.includes(f)) return true;
    if (this.canonTokens.has(this.lex.canonical(t))) return true;
    for (const alt of this.lex.expand(t)) {          // 유의어로 등장했을 수 있다
      if (this.tokens.has(alt) || this.canonTokens.has(alt)) return true;
    }
    for (const src of this.tokens) {                 // 오타로 등장했을 수 있다
      if (Math.abs(src.length - t.length) <= 2 && similarity(t, src) >= fuzzy) return true;
    }
    return false;
  }
}
