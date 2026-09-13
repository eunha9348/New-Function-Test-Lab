/** RAGKOR 매처 — 사전 + 자모 유사도 + BM25를 하나로 묶는다. */
import { similarity } from "./jamo.js";
import { buildLexicon, type Cluster, type LexiconData } from "./lexicon.js";
import { normalizeToken, tokenize } from "./normalize.js";

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

  /** 표면형을 대표형으로. 사전에 없으면 정규화형을 그대로 돌려준다. */
  canonical(token: string): string {
    const t = normalizeToken(token);
    const hit = this.canon[t];
    if (hit) return hit;
    return this.canon[token.trim().toLowerCase()] ?? t;
  }

  /** 사전에 없는 오타를 자모 거리로 가장 가까운 표제어에 붙인다. */
  fuzzyCanonical(token: string, threshold = 0.86): { canon: string; score: number } {
    const t = normalizeToken(token);
    if (this.canon[t]) return { canon: this.canon[t]!, score: 1 };
    let best = t;
    let score = 0;
    for (const L of [t.length - 1, t.length, t.length + 1]) {
      for (const cand of this.byLen.get(L) ?? []) {
        const s = similarity(t, cand);
        if (s > score) {
          best = cand;
          score = s;
          if (s >= 0.99) break;
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
