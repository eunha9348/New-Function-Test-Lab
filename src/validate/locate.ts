import { alignQuote, foldWithMap, type FoldedText } from "../ragkor/align.js";
import type { ExtractedDoc, FieldValue } from "../types.js";

/** 이 점수 미만이면 위치를 믿지 않는다 — 하이라이트가 엉뚱한 곳을 가리키는 것보다 없는 편이 낫다 */
export const LOCATE_FLOOR = 0.6;

/**
 * 근거 인용마다 원문 위치(start/end)를 붙인다. LLM 호출 없음.
 *
 * 모델이 적어 준 sourceId 문서에서 먼저 찾고, 거기서 못 찾으면 다른 문서도 본다
 * (모델이 sourceId를 틀리게 적는 일이 실제로 있다). 찾은 문서로 sourceId를 바로잡는다.
 */
export function locateQuotes(provenance: FieldValue[], docs: ExtractedDoc[]): FieldValue[] {
  const folded = new Map<string, FoldedText>();
  const foldOf = (d: ExtractedDoc) => {
    let f = folded.get(d.sourceId);
    if (!f) folded.set(d.sourceId, (f = foldWithMap(d.text)));
    return f;
  };

  return provenance.map((p) => ({
    ...p,
    quotes: p.quotes.map((q) => {
      const own = docs.find((d) => d.sourceId === q.sourceId);
      let best = own ? { doc: own, r: alignQuote(q.text, foldOf(own)) } : null;
      if (!best?.r || best.r.score < 0.9) {
        for (const d of docs) {
          if (d === own) continue;
          const r = alignQuote(q.text, foldOf(d));
          if (r && (!best?.r || r.score > best.r.score)) best = { doc: d, r };
        }
      }
      if (!best?.r || best.r.score < LOCATE_FLOOR) {
        const { start: _s, end: _e, ...rest } = q;
        return { ...rest, alignScore: best?.r?.score ?? 0 };
      }
      return {
        ...q,
        sourceId: best.doc.sourceId,
        start: best.r.start,
        end: best.r.end,
        alignScore: best.r.score,
      };
    }),
  }));
}

/** 여러 문서를 '\n'으로 이어 붙인 원문(SourceIndex.raw)에서의 위치로 바꾼다 */
export function globalOffset(docs: ExtractedDoc[], sourceId: string, pos: number): number {
  let base = 0;
  for (const d of docs) {
    if (d.sourceId === sourceId) return base + pos;
    base += d.text.length + 1;
  }
  return -1;
}
