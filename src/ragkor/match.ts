/** RAGKOR 매처 — 사전 + 자모 유사도 + BM25를 하나로 묶는다. */
import { similarity } from "./jamo.js";
import { buildLexicon, type Cluster, type LexiconData } from "./lexicon.js";
import { getMorph, type MorphAnalyzer } from "./morph.js";
import { normalizeToken, ruleNormalize, tokenize } from "./normalize.js";

/** 사람이 직접 쓴 표제어 규칙 — 생성 규칙(굴절·오타)보다 먼저 믿는다 */
const HUMAN_RULES = new Set(["seed", "variant", "collo", "abbr", "affix-stem", "affix"]);

/** 표면형 → 대표형 사전. 규칙으로 생성하므로 외부 파일이 필요 없다. */
export class Lexicon {
  readonly canon: Record<string, string>;
  readonly origin: Record<string, string>;
  readonly clusters: Cluster[];
  readonly entries: number;
  private readonly members = new Map<string, Set<string>>();
  private readonly byLen = new Map<number, string[]>();

  constructor(data: LexiconData = buildLexicon()) {
    this.canon = data.canon;
    this.origin = data.origin;
    this.clusters = data.clusters;
    this.entries = Object.keys(this.canon).length;

    for (const c of this.clusters) {
      for (const m of c.members) this.addMember(c.canon, m);
    }
    for (const [surface, canonical] of Object.entries(this.canon)) {
      this.addMember(canonical, surface);
      // 자모 유사도 폴백용 — 사전에 없는 오타를 잡을 때 후보를 좁힌다
      const bucket = this.byLen.get(surface.length);
      if (bucket) bucket.push(surface);
      else this.byLen.set(surface.length, [surface]);
    }
  }

  private addMember(canonical: string, surface: string) {
    const set = this.members.get(canonical);
    if (set) set.add(surface);
    else this.members.set(canonical, new Set([surface]));
  }

  /**
   * 표면형을 대표형으로. 사전에 없으면 정규화형을 그대로 돌려준다.
   *
   * 규칙 모드(기본)는 예전과 똑같다: 정규화형 → 표면형 → 정규화형.
   *
   * Kiwi 모드는 두 가지를 더 한다.
   *   · 사람이 쓴 표제어(시드·표기 변형·신조어·줄임말·접사)에 그대로 있는 표면형을 먼저 본다.
   *     '갈아넣다'를 Kiwi가 '갈'로 쪼개 엉뚱한 말에 붙이지 않게 하려는 것이다.
   *   · 결과를 대표형의 Kiwi 원형 색인으로 한 번 더 모은다.
   *     사전 대표형에는 '주도'와 '주도했다', '집중투입하다'처럼 활용형이 섞여 있어서,
   *     Kiwi 원형('주도', '집중투입')과 어긋나지 않게 하나로 맞춘다.
   */
  canonical(token: string): string {
    const raw = token.trim().toLowerCase();
    const morph = getMorph();
    if (!morph) {
      const t = normalizeToken(token);
      return this.canon[t] ?? this.canon[raw] ?? t;
    }
    const t = normalizeToken(token);
    const found = (this.canon[raw] && HUMAN_RULES.has(this.origin[raw] ?? "") ? this.canon[raw] : undefined)
      ?? this.canon[t] ?? this.canon[raw]
      ?? (/^[가-힣]+$/.test(raw) ? this.canon[ruleNormalize(raw)] : undefined)
      ?? t;
    return /^[가-힣]+$/.test(found) ? this.lemmaIndex(morph).get(morph.lemma(found)) ?? found : found;
  }

  private lemmaIdx: { morph: MorphAnalyzer; map: Map<string, string> } | null = null;

  /**
   * 대표형을 Kiwi 원형으로 다시 색인한다 (Kiwi가 켜졌을 때만, 한 번).
   * 같은 원형에 대표형이 여럿이면 의미 클러스터의 머리말 → 사람이 쓴 표제어 → 나머지 순으로 이긴다.
   */
  private lemmaIndex(morph: MorphAnalyzer): Map<string, string> {
    if (this.lemmaIdx?.morph === morph) return this.lemmaIdx.map;
    const map = new Map<string, string>();
    const put = (surface: string, canonical: string) => {
      if (!/^[가-힣]+$/.test(surface)) return;
      const l = morph.lemma(surface);
      if (l && !map.has(l)) map.set(l, canonical);
    };
    for (const c of this.clusters) put(c.canon, c.canon);
    for (const [surface, canonical] of Object.entries(this.canon)) {
      if (HUMAN_RULES.has(this.origin[surface] ?? "")) put(surface, canonical);
    }
    for (const c of new Set(Object.values(this.canon))) put(c, c);
    this.lemmaIdx = { morph, map };
    return map;
  }

  /** 사전에 없는 오타를 자모 거리로 가장 가까운 표제어에 붙인다. */
  fuzzyCanonical(token: string, threshold = 0.86): { canon: string; score: number } {
    const t = normalizeToken(token);
    if (this.canon[t]) return { canon: this.canon[t]!, score: 1 };
    const raw = token.trim().toLowerCase();
    // 오타가 섞인 말은 형태소 분석이 엉뚱하게 쪼갤 수 있다('포트폴리도'→'포트폴리') — 표면형으로도 재 본다
    const queries = [...new Set([t, raw, /^[가-힣]+$/.test(raw) ? ruleNormalize(raw) : raw])].filter(Boolean);
    let best = t;
    let score = 0;
    for (const q of queries) {
      for (const L of [q.length - 1, q.length, q.length + 1]) {
        for (const cand of this.byLen.get(L) ?? []) {
          const s = similarity(q, cand);
          if (s > score) {
            best = cand;
            score = s;
            if (s >= 0.99) break;
          }
        }
      }
    }
    return score >= threshold ? { canon: this.canon[best] ?? best, score } : { canon: t, score: 0 };
  }

  /** 검색 확장용 — 같은 뜻으로 쓰이는 표면형을 전부 돌려준다. */
  expand(token: string): Set<string> {
    const c = this.canonical(token);
    const out = new Set<string>([c, normalizeToken(token)]);
    for (const m of this.members.get(c) ?? []) out.add(m);
    out.delete("");
    return out;
  }

  /** 텍스트 → 대표형 토큰 열. 비교·검색은 전부 이 형태에서 한다. */
  analyze(text: string): string[] {
    return tokenize(text).map((t) => this.canonical(t));
  }
}

let cached: Lexicon | null = null;

/** 프로세스 하나당 한 번만 만든다 (생성 ~100ms). */
export function defaultLexicon(): Lexicon {
  if (!cached) cached = new Lexicon();
  return cached;
}

/** 청크 검색용. 유의어 확장을 질의 쪽에 적용해 재현율을 올린다. */
export class BM25 {
  private readonly docs: Map<string, number>[];
  private readonly lens: number[];
  private readonly avg: number;
  private readonly df = new Map<string, number>();
  private readonly N: number;

  constructor(
    readonly chunks: string[],
    private readonly lex: Lexicon = defaultLexicon(),
    private readonly k1 = 1.4,
    private readonly b = 0.72,
  ) {
    this.docs = chunks.map((c) => {
      const m = new Map<string, number>();
      for (const t of this.lex.analyze(c)) m.set(t, (m.get(t) ?? 0) + 1);
      return m;
    });
    this.lens = this.docs.map((d) => [...d.values()].reduce((a, x) => a + x, 0) || 1);
    this.avg = this.lens.reduce((a, x) => a + x, 0) / Math.max(1, this.lens.length);
    for (const d of this.docs) {
      for (const k of d.keys()) this.df.set(k, (this.df.get(k) ?? 0) + 1);
    }
    this.N = Math.max(1, this.docs.length);
  }

  private idf(term: string): number {
    const n = this.df.get(term) ?? 0;
    return Math.log(1 + (this.N - n + 0.5) / (n + 0.5));
  }

  search(query: string, top = 5): { index: number; score: number }[] {
    const terms = new Set<string>();
    for (const t of tokenize(query)) {
      for (const x of this.lex.expand(t)) terms.add(this.lex.canonical(x));
    }
    const scores: { index: number; score: number }[] = [];
    this.docs.forEach((d, i) => {
      let s = 0;
      for (const term of terms) {
        const f = d.get(term) ?? 0;
        if (!f) continue;
        s += this.idf(term) * (f * (this.k1 + 1)) /
          (f + this.k1 * (1 - this.b + this.b * this.lens[i]! / this.avg));
      }
      if (s > 0) scores.push({ index: i, score: s });
    });
    scores.sort((a, b) => b.score - a.score);
    return scores.slice(0, top);
  }
}
