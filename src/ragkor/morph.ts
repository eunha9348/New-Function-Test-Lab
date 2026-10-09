/**
 * 형태소 분석 — Kiwi(지능형 한국어 형태소 분석기, bab2min/Kiwi)를 붙이는 자리.
 *
 * RAGKOR의 조사·어미 떼기는 사람이 쓴 접미 목록(PARTICLES·ENDINGS)과
 * 굴절형을 미리 만들어 둔 사전 4,200건(`infl`)으로 돌아갔다. 목록에 없는 활용형
 * ('줄였다', '붙여서', '맡았고')은 원형으로 돌아오지 못했다.
 * Kiwi는 활용형을 형태소로 쪼개 원형을 돌려주므로 목록에 없는 말도 처리한다.
 *
 * Kiwi는 선택 사항이다. 모델 파일이 없으면 기존 규칙으로 그대로 동작한다.
 *   모델 받기: bash tools/fetch_kiwi_model.sh   (models/kiwi/ 에 풀린다)
 *   다른 위치: KIWI_MODEL_DIR=/path/to/model
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";

/** 어절 하나를 비교용 원형으로 바꾸는 분석기 */
export interface MorphAnalyzer {
  readonly name: string;
  /** '개선했습니다' → '개선', '줄였다' → '줄이', '응답시간을' → '응답시간' */
  lemma(word: string): string;
}

let active: MorphAnalyzer | null = null;

export function setMorph(m: MorphAnalyzer | null): void {
  active = m;
}

export function getMorph(): MorphAnalyzer | null {
  return active;
}

/** Kiwi 품사 중 '뜻'을 담는 것 — 이것만 이어 붙여 원형을 만든다 */
const NOUNISH = new Set(["NNG", "NNP", "NR", "XR", "SL", "SH", "SN", "XPN"]);
const VERBISH = new Set(["VV", "VA", "VX", "VCN"]);

interface KiwiToken { str: string; tag: string }
interface KiwiLike { tokenize(s: string): KiwiToken[] }

/**
 * 형태소 열 → 원형.
 *   · 명사·어근이 있으면 그것들을 이어 붙인다 (개선+하+었+습니다 → 개선, 응답+시간+을 → 응답시간)
 *   · 없으면 첫 용언 어간 (줄이+었+다 → 줄이)
 *   · 둘 다 없으면 원래 어절
 */
export function lemmaFromMorphs(word: string, morphs: KiwiToken[]): string {
  const noun: string[] = [];
  for (const m of morphs) {
    if (NOUNISH.has(m.tag)) noun.push(m.str);
    else if (noun.length && !m.tag.startsWith("XSN")) break;   // 명사 덩어리가 끝났다
  }
  if (noun.length) return noun.join("").toLowerCase();
  const verb = morphs.find((m) => VERBISH.has(m.tag.replace(/-[RI]$/, "")));
  return (verb?.str ?? word).toLowerCase();
}

export function kiwiAnalyzer(kiwi: KiwiLike): MorphAnalyzer {
  const cache = new Map<string, string>();
  return {
    name: "kiwi",
    lemma(word: string) {
      let hit = cache.get(word);
      if (hit === undefined) {
        try {
          hit = lemmaFromMorphs(word, kiwi.tokenize(word));
        } catch {
          hit = word.toLowerCase();
        }
        if (cache.size > 50_000) cache.clear();
        cache.set(word, hit);
      }
      return hit;
    },
  };
}

/** 모델 디렉터리 찾기 — 환경 변수 → 저장소 models/kiwi → (Python) kiwipiepy_model */
export function findKiwiModelDir(): string | null {
  const candidates = [
    process.env.KIWI_MODEL_DIR,
    resolve(process.cwd(), "models/kiwi"),
    resolve(process.cwd(), "models/kiwi/models/cong/base"),
  ].filter(Boolean) as string[];
  for (const dir of candidates) {
    if (existsSync(join(dir, "sj.morph")) && existsSync(join(dir, "default.dict"))) return dir;
  }
  return null;
}

/**
 * Kiwi를 읽어 활성화한다. 실패하면 null을 돌려주고 기존 규칙이 계속 쓰인다.
 * WASM 빌드에 7초 안팎 걸리므로 프로세스당 한 번만 부른다.
 */
let loading: Promise<MorphAnalyzer | null> | null = null;
export function loadKiwi(opts: { modelDir?: string; quiet?: boolean } = {}): Promise<MorphAnalyzer | null> {
  if (active?.name === "kiwi") return Promise.resolve(active);
  if (loading) return loading;
  loading = (async () => {
    const dir = opts.modelDir ?? findKiwiModelDir();
    if (!dir) {
      if (!opts.quiet) console.warn("[ragkor] Kiwi 모델이 없어 규칙 기반 정규화를 씁니다 (tools/fetch_kiwi_model.sh)");
      return null;
    }
    try {
      const require = createRequire(import.meta.url);
      const entry = require.resolve("kiwi-nlp");
      const wasm = join(dirname(entry), "kiwi-wasm.wasm");
      const spec = "kiwi-nlp";   // 선택 의존성 — 없으면 catch로 빠져 규칙 기반으로 돈다
      const { KiwiBuilder } = (await import(spec)) as {
        KiwiBuilder: { create(p: string): Promise<{ build(a: unknown): Promise<KiwiLike> }> };
      };
      const modelFiles: Record<string, Uint8Array> = {};
      for (const f of readdirSync(dir)) {
        const p = join(dir, f);
        if (statSync(p).isFile() && !f.endsWith(".py")) modelFiles[f] = new Uint8Array(readFileSync(p));
      }
      const builder = await KiwiBuilder.create(wasm);
      const kiwi = await builder.build({ modelFiles, modelType: "cong" });
      const m = kiwiAnalyzer(kiwi);
      setMorph(m);
      return m;
    } catch (e) {
      if (!opts.quiet) console.warn(`[ragkor] Kiwi를 불러오지 못해 규칙 기반 정규화를 씁니다: ${(e as Error).message}`);
      return null;
    }
  })();
  return loading;
}
