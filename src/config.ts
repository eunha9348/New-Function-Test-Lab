/**
 * ARC 자동 정리 엔진 — 설정 / API 키
 *
 * ┌──────────────────────────────────────────────────────────────┐
 * │  ★ 여기가 API 키를 넣는 유일한 곳입니다.                      │
 * │    환경변수(.env)를 쓰면 아래 값을 그대로 두면 되고,          │
 * │    바로 하드코딩하려면 `?? ""` 뒤의 빈 문자열 자리에          │
 * │    키를 직접 적으세요.                                        │
 * └──────────────────────────────────────────────────────────────┘
 */

export const API_KEYS = {
  /** 필수. 분류·추출·감독·OCR(Vision) 전부 여기에 의존합니다. */
  anthropic: process.env.ANTHROPIC_API_KEY ?? "", // <<<<<< 여기에 Anthropic API 키

  /** 선택. 이미지 OCR 보조 엔진 (앙상블 정확도 ↑). 없으면 자동 skip. */
  googleVision: process.env.GOOGLE_VISION_API_KEY ?? "", // <<<<<< Google Cloud Vision API 키

  /** 선택. 한국어 문서 특화 OCR. 없으면 자동 skip. */
  clova: {
    invokeUrl: process.env.CLOVA_OCR_INVOKE_URL ?? "", // <<<<<< NAVER CLOVA OCR Invoke URL
    secret: process.env.CLOVA_OCR_SECRET ?? "",        // <<<<<< NAVER CLOVA OCR Secret Key
  },

  /** 선택. 음성/영상 파일 자막 추출(STT). 없으면 미디어 파일은 메타데이터만 사용. */
  openaiWhisper: process.env.OPENAI_API_KEY ?? "", // <<<<<< Whisper STT용 키
} as const;

/** 사용할 모델. 전 단계 동일 모델을 쓰되 effort로 비용을 조절합니다. */
export const MODELS = {
  classifier: "claude-opus-5",
  extractor: "claude-opus-5",
  supervisor: "claude-opus-5",
  guide: "claude-opus-5",
  visionOcr: "claude-opus-5",
} as const;

/** 단계별 effort — 감독 단계만 높게 두어 정확도를 끌어올립니다. */
export const EFFORT = {
  classifier: "medium",
  extractor: "high",
  supervisor: "xhigh",
  guide: "medium",
  visionOcr: "medium",
} as const;

export const PIPELINE = {
  /** 감독 sub-Agent 재검수 최대 횟수 (patch 적용 후 재검사) */
  maxSupervisorRounds: 2,
  /** 분류 신뢰도가 이 값 미만이면 사용자에게 유형 확인을 요청 */
  classificationConfidenceFloor: 0.55,
  /** 필드 신뢰도가 이 값 미만이면 값을 비우고 Fallback 안내로 넘김 */
  fieldConfidenceFloor: 0.4,
  /** LLM에 넘기는 근거 텍스트 최대 길이(문자). 초과분은 요약 청크로 대체 */
  maxEvidenceChars: 180_000,
  /** OCR 앙상블에서 주 엔진과 보조 엔진 일치율이 이 값 미만이면 재판독 */
  ocrAgreementFloor: 0.82,
  /** 이미지 OCR 타일 분할 임계 높이(px) */
  ocrTileThresholdPx: 2200,
  /** 타일 겹침(px) — 경계에서 잘린 글자 복구용 */
  ocrTileOverlapPx: 160,
} as const;

/** 비용 추정용 단가 (USD / 1M tokens) — claude-opus-5 기준 */
export const PRICING = { inputPerMTok: 5.0, outputPerMTok: 25.0, cacheReadPerMTok: 0.5 } as const;

export function assertAnthropicKey(): string {
  if (!API_KEYS.anthropic) {
    throw new Error(
      "ANTHROPIC_API_KEY가 비어 있습니다. src/config.ts의 API_KEYS.anthropic 또는 .env를 채워주세요.",
    );
  }
  return API_KEYS.anthropic;
}
