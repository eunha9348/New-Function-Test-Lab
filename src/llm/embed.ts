import { googleKey } from "../config.js";
import type { UsageStat } from "../types.js";

/**
 * 문장 임베딩 — 맥락 검사(이 인용이 성과 이야기인가, 한계 이야기인가)에 쓴다.
 *
 * 기본은 Gemini `gemini-embedding-001` (100만 토큰당 $0.15). 생성 모델 호출이 아니므로
 * 단가가 생성 모델의 1/5 수준이고, 문서 하나에 수천 토큰이면 충분하다.
 */
export interface Embedder {
  readonly name: string;
  embed(texts: string[]): Promise<number[][]>;
}

const BASE = "https://generativelanguage.googleapis.com/v1beta";
const MODEL = "gemini-embedding-001";
const PRICE_PER_MTOK = 0.15;
const CHARS_PER_TOKEN = 1.7;

export class GeminiEmbedder implements Embedder {
  readonly name = MODEL;
  private readonly cache = new Map<string, number[]>();

  constructor(
    private readonly apiKey: string = googleKey(),
    private readonly usage?: UsageStat,
    private readonly dims = 768,
  ) {}

  async embed(texts: string[]): Promise<number[][]> {
    const todo = [...new Set(texts.filter((t) => !this.cache.has(t)))];
    for (let i = 0; i < todo.length; i += 100) {
      const batch = todo.slice(i, i + 100);
      const started = Date.now();
      const res = await fetch(`${BASE}/models/${MODEL}:batchEmbedContents?key=${this.apiKey}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          requests: batch.map((text) => ({
            model: `models/${MODEL}`,
            content: { parts: [{ text: text.slice(0, 2000) }] },
            taskType: "SEMANTIC_SIMILARITY",
            outputDimensionality: this.dims,
          })),
        }),
      });
      if (!res.ok) throw new Error(`임베딩 실패 (${res.status}): ${(await res.text()).slice(0, 200)}`);
      const json = (await res.json()) as { embeddings?: { values: number[] }[] };
      (json.embeddings ?? []).forEach((e, k) => this.cache.set(batch[k]!, normalize(e.values)));
      if (this.usage) {
        const tokens = batch.reduce((a, t) => a + Math.min(t.length, 2000), 0) / CHARS_PER_TOKEN;
        this.usage.inputTokens += Math.round(tokens);
        this.usage.estimatedCostUsd += (tokens / 1e6) * PRICE_PER_MTOK;
        this.usage.calls.push({ stage: "embed", ms: Date.now() - started });
      }
    }
    return texts.map((t) => this.cache.get(t) ?? []);
  }
}

export function normalize(v: number[]): number[] {
  const n = Math.sqrt(v.reduce((a, x) => a + x * x, 0)) || 1;
  return v.map((x) => x / n);
}

export function cosine(a: number[], b: number[]): number {
  let s = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i++) s += a[i]! * b[i]!;
  return s;
}

/** Google 키가 있으면 Gemini 임베더, 없으면 null (맥락 검사는 단서어 규칙만으로 돈다) */
export function defaultEmbedder(usage?: UsageStat): Embedder | null {
  try {
    return new GeminiEmbedder(googleKey(), usage);
  } catch {
    return null;
  }
}
