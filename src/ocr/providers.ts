import { API_KEYS, visionKey } from "../config.js";
import { tryImport } from "../ingest/optional.js";
import type { LlmContent, LlmSession } from "../llm/index.js";

export interface OcrProviderResult {
  engine: string;
  text: string;
  /** 엔진이 자체 보고한 신뢰도 (없으면 undefined) */
  reported?: number;
  error?: string;
}

const VISION_OCR_SYSTEM = `당신은 한국어/영어 혼용 문서 전용 OCR 엔진이다. 다음 규칙을 반드시 지킨다.

1. 이미지에 보이는 모든 글자를 **있는 그대로** 옮겨 적는다. 요약·의역·맞춤법 교정 금지.
2. 읽기 순서를 지킨다. 다단 레이아웃이면 왼쪽 단을 끝까지 읽고 오른쪽 단으로 넘어간다.
3. 표는 마크다운 표로 옮긴다. 셀이 비었으면 빈 칸으로 둔다.
4. 체크박스/토글은 [x] 또는 [ ] 로 표기한다.
5. 글자가 잘리거나 흐려 확신이 없으면 그 부분만 «불명» 으로 감싼다. 추측해서 채우지 않는다.
   예: 2024년 «불명»월 3일
6. 손글씨, 도장, 워터마크, 로고 안의 글자도 읽는다. 읽었다면 [손글씨] 같은 표시를 앞에 붙인다.
7. 숫자와 단위는 특히 정확하게. 0/O, 1/l/I, 5/S, 8/B, 6/b 혼동에 주의한다.
8. 한국어 조사·어미가 깨져 보이면 획을 다시 확인한다. 그래도 불확실하면 «불명».
9. 이미지에 글자가 하나도 없으면 정확히 "[[NO_TEXT]]" 만 출력한다.
10. 설명·인사·머리말을 붙이지 말고 추출된 텍스트만 출력한다.`;

/**
 * 주 엔진: LLM Vision (Gemini).
 * 레이아웃 이해력이 높아 다단·표·손글씨가 섞인 한국어 문서에서 가장 잘 읽는다.
 */
export async function visionLlmOcr(
  session: LlmSession,
  images: Uint8Array[],
  mediaType = "image/png",
  hint?: string,
): Promise<OcrProviderResult> {
  const engine = `${session.providerName}-vision`;
  try {
    const content: LlmContent[] = [];
    images.forEach((img, i) => {
      if (images.length > 1) {
        content.push({ type: "text", text: `--- 조각 ${i + 1}/${images.length} ---` });
      }
      content.push({ type: "image", mediaType, dataBase64: Buffer.from(img).toString("base64") });
    });
    content.push({
      type: "text",
      text:
        (hint ? `문서 맥락 힌트: ${hint}\n` : "") +
        (images.length > 1
          ? "위 조각들은 하나의 세로로 긴 이미지를 겹치게 자른 것이다. 겹친 부분은 한 번만 적어 하나의 연속된 텍스트로 합쳐라."
          : "이 이미지의 텍스트를 규칙대로 추출하라."),
    });

    const text = await session.text("ocr", VISION_OCR_SYSTEM, content);
    return { engine, text: text.trim() };
  } catch (e) {
    return { engine, text: "", error: (e as Error).message };
  }
}

/**
 * 보조 엔진: Google Cloud Vision DOCUMENT_TEXT_DETECTION.
 * 같은 Google API 키를 쓴다 — GCP 프로젝트에서 Cloud Vision API를 켜 두면 자동으로 붙는다.
 * 안 켜져 있으면 403이 나고 조용히 건너뛴다.
 */
export async function googleVisionOcr(image: Uint8Array): Promise<OcrProviderResult> {
  const key = visionKey();
  if (!key) return { engine: "google-vision", text: "", error: "키 없음" };
  try {
    const res = await fetch(`https://vision.googleapis.com/v1/images:annotate?key=${key}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        requests: [
          {
            image: { content: Buffer.from(image).toString("base64") },
            features: [{ type: "DOCUMENT_TEXT_DETECTION" }],
            imageContext: { languageHints: ["ko", "en"] },
          },
        ],
      }),
    });
    if (!res.ok) {
      const hint =
        res.status === 403
          ? "Cloud Vision API가 꺼져 있습니다(선택 기능이라 건너뜁니다)."
          : `HTTP ${res.status}`;
      return { engine: "google-vision", text: "", error: hint };
    }
    const json: any = await res.json();
    const ann = json?.responses?.[0]?.fullTextAnnotation;
    return { engine: "google-vision", text: (ann?.text ?? "").trim() };
  } catch (e) {
    return { engine: "google-vision", text: "", error: (e as Error).message };
  }
}

/** 보조 엔진: NAVER CLOVA OCR — 한국어 인쇄체/증명서에 강하다 (선택) */
export async function clovaOcr(image: Uint8Array): Promise<OcrProviderResult> {
  const { invokeUrl, secret } = API_KEYS.clova;
  if (!invokeUrl || !secret) return { engine: "clova", text: "", error: "키 없음" };
  try {
    const res = await fetch(invokeUrl, {
      method: "POST",
      headers: { "content-type": "application/json", "X-OCR-SECRET": secret },
      body: JSON.stringify({
        version: "V2",
        requestId: `arc-${Date.now()}`,
        timestamp: Date.now(),
        lang: "ko",
        images: [{ format: "png", name: "page", data: Buffer.from(image).toString("base64") }],
      }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json: any = await res.json();
    const fields = json?.images?.[0]?.fields ?? [];
    const text = fields
      .map((f: any) => (f.inferText ?? "") + (f.lineBreak ? "\n" : " "))
      .join("")
      .trim();
    const scores: number[] = fields.map((f: any) => f.inferConfidence ?? 0).filter(Boolean);
    const reported = scores.length ? scores.reduce((a, b) => a + b, 0) / scores.length : undefined;
    return { engine: "clova", text, reported };
  } catch (e) {
    return { engine: "clova", text: "", error: (e as Error).message };
  }
}

/** 오프라인 폴백: tesseract.js (kor+eng). 키·네트워크 없이 동작 */
export async function tesseractOcr(image: Uint8Array): Promise<OcrProviderResult> {
  const mod = await tryImport<any>("tesseract.js");
  if (!mod) return { engine: "tesseract", text: "", error: "tesseract.js 미설치" };
  try {
    const Tesseract = mod.default ?? mod;
    const { data } = await Tesseract.recognize(Buffer.from(image), "kor+eng");
    return {
      engine: "tesseract",
      text: (data?.text ?? "").trim(),
      reported: typeof data?.confidence === "number" ? data.confidence / 100 : undefined,
    };
  } catch (e) {
    return { engine: "tesseract", text: "", error: (e as Error).message };
  }
}
