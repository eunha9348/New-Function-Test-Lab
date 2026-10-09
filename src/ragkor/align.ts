/**
 * 인용 정렬 — "이 인용이 원문의 **몇 번째 글자부터 몇 번째 글자까지**인가".
 *
 * RAGKOR의 quoteScore()는 '있다/없다'만 말해 준다. 화면 하이라이트, 감독용 근거 구간,
 * 필드 감사관의 맥락 검사는 모두 **원문 위치**가 있어야 한다.
 *
 * 알고리즘은 RapidFuzz `fuzz.partial_ratio_alignment` 와 같은 정의를 따른다.
 *   · 짧은 쪽(인용) 길이 m 의 창을 원문 위로 밀며
 *   · 창마다 Indel 유사도 ratio = 2·LCS / (m + 창 길이) 를 재고
 *   · 가장 높은 창의 위치를 돌려준다.
 * 다만 원문 전체를 밀면 느리므로, 인용의 4-gram이 원문에 처음 닿는 지점들로
 * 후보 시작점을 투표해 상위 몇 곳 주변만 정밀하게 잰다.
 * Python 쪽은 `rapidfuzz` 를 직접 쓰고(`ragkor/align.py`), 두 구현이 같은 점수를
 * 내는지는 `test/fixtures/align-rapidfuzz.json` 으로 검증한다.
 */

/** 비교용으로 접은 글자열 + 각 글자가 원문 몇 번째 글자에서 왔는지 */
export interface FoldedText {
  chars: string;
  map: number[];
}

const KEEP = /[\p{L}\p{N}]/u;

/**
 * 글자·숫자만 남기고 소문자로 접는다. normalize.fold()와 같은 '뼈대'를 만들되
 * 원문 위치를 잃지 않도록 글자 단위로 처리한다.
 */
export function foldWithMap(text: string): FoldedText {
  let chars = "";
  const map: number[] = [];
  let i = 0;
  for (const ch of text ?? "") {
    const n = ch.normalize("NFKC").toLowerCase();
    for (const c of n) {
      if (KEEP.test(c)) {
        chars += c;
        map.push(i);
      }
    }
    i += ch.length;
  }
  return { chars, map };
}

export interface Alignment {
  /** 원문 기준 시작 위치 (포함) */
  start: number;
  /** 원문 기준 끝 위치 (미포함) */
  end: number;
  /** 0~1. RapidFuzz partial_ratio / 100 과 같은 척도 */
  score: number;
}

/** 두 문자열의 최장 공통 부분수열 길이 — 한 줄짜리 DP */
function lcs(a: string, b: string, row: Uint16Array): number {
  row.fill(0, 0, b.length + 1);
  for (let i = 0; i < a.length; i++) {
    let prevDiag = 0;
    const ai = a.charCodeAt(i);
    for (let j = 1; j <= b.length; j++) {
      const tmp = row[j]!;
      row[j] = ai === b.charCodeAt(j - 1) ? prevDiag + 1 : Math.max(row[j]!, row[j - 1]!);
      prevDiag = tmp;
    }
  }
  return row[b.length]!;
}

/** RapidFuzz `fuzz.ratio` 와 같은 Indel 정규화 유사도 (0~1) */
export function indelRatio(a: string, b: string): number {
  if (!a.length && !b.length) return 1;
  const row = new Uint16Array(b.length + 1);
  return (2 * lcs(a, b, row)) / (a.length + b.length);
}

const GRAM = 3;
const MAX_CANDIDATES = 4;

/**
 * 접힌 인용 q를 접힌 원문 s 위에 정렬한다. 반환 위치는 접힌 좌표.
 * RapidFuzz와 같이 창 길이는 m(인용 길이)이고, 원문 앞뒤 가장자리에서는 짧은 창도 본다.
 */
export function partialRatioAlignment(
  q: string,
  s: string,
): { start: number; end: number; score: number } {
  const m = q.length;
  if (!m || !s.length) return { start: 0, end: 0, score: 0 };
  if (m >= s.length) {
    return { start: 0, end: s.length, score: indelRatio(q, s) };
  }

  // 1) 후보 시작점 투표 — 인용 i번째 gram이 원문 p에 있으면 시작점은 p - i 근처
  const grams = new Map<string, number[]>();
  for (let i = 0; i + GRAM <= m; i++) {
    const g = q.slice(i, i + GRAM);
    const arr = grams.get(g);
    if (arr) arr.push(i);
    else grams.set(g, [i]);
  }
  const votes = new Map<number, number>();
  const bucket = Math.max(4, Math.floor(m / 8));
  for (let p = 0; p + GRAM <= s.length; p++) {
    const hits = grams.get(s.slice(p, p + GRAM));
    if (!hits) continue;
    for (const i of hits) {
      const b = Math.floor((p - i) / bucket);
      votes.set(b, (votes.get(b) ?? 0) + 1);
    }
  }

  let candidates: number[];
  if (votes.size) {
    candidates = [...votes.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, MAX_CANDIDATES)
      .map(([b]) => b * bucket);
  } else {
    // 3-gram 하나도 안 겹치면 근거로 볼 수 없다. 그래도 위치는 대략 돌려준다.
    candidates = [0];
  }

  // 2) 후보 주변의 길이 m 창을 전부 잰다
  const row = new Uint16Array(m + 1);
  let best = { start: 0, end: Math.min(m, s.length), score: -1 };
  const tried = new Set<number>();
  const consider = (start: number) => {
    const a = Math.max(0, start);
    const b = Math.min(s.length, start + m);
    if (b <= a || tried.has(start)) return;
    tried.add(start);
    const window = s.slice(a, b);
    const score = (2 * lcs(window, q, row)) / (m + window.length);
    if (score > best.score + 1e-12) best = { start: a, end: b, score };
  };
  for (const c of candidates) {
    for (let st = c - bucket - Math.ceil(m / 4); st <= c + 2 * bucket + Math.ceil(m / 4); st++) {
      if (st < -m + 1 || st > s.length - 1) continue;
      consider(st);
    }
  }

  // 3) 창 끝의 남는 글자는 잘라 낸다 — 하이라이트가 인용보다 넓어지지 않게
  if (best.score > 0) {
    let { start, end } = best;
    while (start < end && !q.includes(s[start]!)) start++;
    while (end > start && !q.includes(s[end - 1]!)) end--;
    best = { start, end, score: best.score };
  }
  return best;
}

/**
 * 인용을 원문에 정렬해 **원문 좌표**로 돌려준다.
 * 접힌 인용이 4글자 미만이면 위치를 믿을 수 없어 null.
 */
export function alignQuote(quote: string, source: string | FoldedText): Alignment | null {
  const fq = foldWithMap(quote).chars;
  if (fq.length < 4) return null;
  const fs = typeof source === "string" ? foldWithMap(source) : source;
  if (!fs.chars.length) return null;

  const r = partialRatioAlignment(fq, fs.chars);
  if (r.end <= r.start) return { start: 0, end: 0, score: 0 };
  const start = fs.map[r.start]!;
  const lastRaw = fs.map[r.end - 1]!;
  return { start, end: lastRaw + 1, score: Math.round(r.score * 1000) / 1000 };
}
