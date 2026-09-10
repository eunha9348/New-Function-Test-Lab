import { PIPELINE } from "../config.js";
import type { LlmSession } from "../llm/client.js";
import { prepareImage, tileVertically } from "./preprocess.js";
import {
  claudeVisionOcr,
  clovaOcr,
  googleVisionOcr,
  tesseractOcr,
  type OcrProviderResult,
} from "./providers.js";

export interface OcrResult {
  text: string;
  confidence: number;
  engines: { engine: string; chars: number; error?: string }[];
  warnings: string[];
  /** 엔진 간 불일치가 큰 구간이 있었는지 */
  reread: boolean;
}

/** 공백·구두점을 지우고 비교용으로 정규화 */
function norm(s: string): string {
  return s
    .replace(/«불명»/g, "")
    .replace(/[\s​]+/g, "")
    .replace(/[.,·:;'"“”‘’()[\]{}\-—_/\\|]/g, "")
    .toLowerCase();
}

/** 문자 바이그램 Dice 계수 — 두 OCR 결과의 일치율 */
export function similarity(a: string, b: string): number {
  const x = norm(a);
  const y = norm(b);
  if (!x.length || !y.length) return 0;
  if (x === y) return 1;
  const grams = (s: string) => {
    const m = new Map<string, number>();
    for (let i = 0; i < s.length - 1; i++) {
      const g = s.slice(i, i + 2);
      m.set(g, (m.get(g) ?? 0) + 1);
    }
    return m;
  };
  const ga = grams(x);
  const gb = grams(y);
  let inter = 0;
  for (const [g, n] of ga) inter += Math.min(n, gb.get(g) ?? 0);
  const total = (x.length - 1) + (y.length - 1);
  return total > 0 ? (2 * inter) / total : 0;
}

/** 결과에 남은 «불명» 비율 → 신뢰도 감점 */
function unknownRatio(text: string): number {
  const marks = (text.match(/«불명»/g) ?? []).length;
  const tokens = Math.max(1, text.replace(/\s+/g, "").length / 4);
  return Math.min(1, marks / tokens);
}

/**
 * 다중 엔진 앙상블 OCR.
 *
 *  1. 전처리(회전·대비·업스케일·샤픈)
 *  2. Claude Vision(주) + Google Vision / CLOVA / tesseract(보조)를 병렬 실행
 *  3. 주 엔진 결과와 보조 엔진들의 일치율을 계산
 *  4. 일치율이 낮거나 이미지가 세로로 길면 → 겹침 타일로 잘라 재판독
 *  5. 최종 텍스트 + 신뢰도 반환. 신뢰도는 아래 추출 단계에서 근거 가중치로 쓰인다.
 */
export async function ocrImage(
  session: LlmSession,
  bytes: Uint8Array,
  opts: { hint?: string; allowReread?: boolean } = {},
): Promise<OcrResult> {
  const prep = await prepareImage(bytes);
  const warnings = [...prep.warnings];

  const [primary, ...secondaries] = await Promise.all([
    claudeVisionOcr(session, [prep.enhanced], "image/png", opts.hint),
    googleVisionOcr(prep.enhanced),
    clovaOcr(prep.enhanced),
    tesseractOcr(prep.binary),
  ]);

  let best: OcrProviderResult = primary!;
  const usable = secondaries.filter((s) => s.text.length > 20);

  // 주 엔진이 실패했으면 보조 중 가장 긴 결과로 대체
  if (!best.text || best.text === "[[NO_TEXT]]") {
    const alt = usable.sort((a, b) => b.text.length - a.text.length)[0];
    if (alt) {
      best = alt;
      warnings.push(`Claude Vision 실패(${primary!.error ?? "빈 결과"}) → ${alt.engine} 결과 사용`);
    }
  }

  const agreements = usable.map((s) => similarity(best.text, s.text));
  const agreement = agreements.length ? Math.max(...agreements) : 0;

  let reread = false;
  const tall = prep.height > PIPELINE.ocrTileThresholdPx;
  const disagrees = usable.length > 0 && agreement < PIPELINE.ocrAgreementFloor;

  if ((opts.allowReread ?? true) && (tall || disagrees)) {
    const tiles = await tileVertically(prep.enhanced, prep.height);
    if (tiles.length > 1) {
      const retry = await claudeVisionOcr(session, tiles, "image/png", opts.hint);
      if (retry.text && retry.text !== "[[NO_TEXT]]") {
        // 타일 판독이 더 많은 글자를 건졌으면 채택
        if (norm(retry.text).length >= norm(best.text).length * 0.9) {
          best = retry;
          reread = true;
          warnings.push(
            tall
              ? `세로 ${prep.height}px — ${tiles.length}개 타일로 나눠 재판독`
              : `엔진 간 일치율 ${(agreement * 100).toFixed(0)}% — 타일 재판독`,
          );
        }
      }
    }
  }

  const text = best.text === "[[NO_TEXT]]" ? "" : best.text;

  // 신뢰도 = 기본 0.62 + 앙상블 합의 보너스 − 불명 표시 패널티
  let confidence = 0.62;
  if (usable.length) confidence = 0.55 + agreement * 0.4;
  if (reread) confidence += 0.05;
  const reported = [best.reported, ...usable.map((u) => u.reported)].filter(
    (v): v is number => typeof v === "number",
  );
  if (reported.length) confidence = (confidence + Math.max(...reported)) / 2;
  confidence -= unknownRatio(text) * 0.5;
  if (!text) confidence = 0;
  confidence = Math.max(0, Math.min(1, confidence));

  if (confidence < 0.5 && text) {
    warnings.push(
      "OCR 신뢰도가 낮습니다. 더 밝고 정면에서 찍은 사진이나 원본 PDF를 올리면 정확도가 올라갑니다.",
    );
  }

  return {
    text,
    confidence,
    reread,
    warnings,
    engines: [best, ...secondaries].map((r) => ({
      engine: r.engine,
      chars: r.text.length,
      error: r.error,
    })),
  };
}

export { similarity as ocrSimilarity };
