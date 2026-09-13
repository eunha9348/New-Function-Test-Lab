/**
 * ARC 자동 정리 엔진 — 설정 / API 키
 *
 * ┌──────────────────────────────────────────────────────────────┐
 * │  ★ API 키는 여기 한 곳에만 넣으면 됩니다.                     │
 * │    Google API 키 하나로 LLM(Gemini)과 OCR이 전부 돕니다.      │
 * └──────────────────────────────────────────────────────────────┘
 */
import { loadEnv } from "./load-env.js";

loadEnv();

export const API_KEYS = {
  /**
   * ★★ 필수 — Google API 키 (Google AI Studio에서 발급) ★★
   * 이 키 하나가 다음 모두를 담당합니다.
   *   · Gemini  … 분류 / 배분 / 감독 / 안내 + 이미지 OCR(Vision)
   *   · Cloud Vision … OCR 보조 엔진 (같은 GCP 프로젝트에서 API를 켠 경우에만)
   *
   * 발급: https://aistudio.google.com/apikey
   */
  google: process.env.GOOGLE_API_KEY ?? "", // <<<<<< 여기에 Google API 키를 넣으세요

  /**
   * 선택 — Cloud Vision을 다른 키로 쓰고 싶을 때만.
   * 비워 두면 위 google 키를 그대로 씁니다.
   */
  googleVision: process.env.GOOGLE_VISION_API_KEY ?? "",

  /** 선택 — 한국어 증명서 특화 OCR 보조 엔진. 없으면 자동 skip. */
  clova: {
    invokeUrl: process.env.CLOVA_OCR_INVOKE_URL ?? "",
    secret: process.env.CLOVA_OCR_SECRET ?? "",
  },

  /** 선택 — Anthropic 엔진으로 바꿔 쓸 때만 (PROVIDER를 "anthropic"으로 둔 경우). */
  anthropic: process.env.ANTHROPIC_API_KEY ?? "",
} as const;

/** 사용할 LLM 엔진. Google 키를 쓰므로 기본은 gemini. */
export const PROVIDER: "gemini" | "anthropic" =
  (process.env.ARC_LLM_PROVIDER as "gemini" | "anthropic") ?? "gemini";

/**
 * 모델 선택.
 *
 * Gemini 모델 ID는 자주 바뀌고 구버전은 종료됩니다(2.5 계열은 2026-10-16 종료 예정).
 * 그래서 **하드코딩하지 않고**, 시작할 때 ListModels API로 실제 사용 가능한 모델을
 * 받아와 아래 우선순위 규칙에 맞는 최신 모델을 자동으로 고릅니다.
 *
 * 특정 모델로 고정하고 싶으면 `pin`에 모델 id를 적으세요. (예: "gemini-2.5-pro")
 */
export const MODELS = {
  gemini: {
    /** 고정하고 싶을 때만 채우세요. 비우면 자동 선택. */
    pin: process.env.GEMINI_MODEL ?? "", // <<<<<< (선택) 모델 고정

    /**
     * 자동 선택은 **세대를 tier보다 먼저** 봅니다.
     * 예전에는 'pro 패턴'을 먼저 훑어서 gemini-3.8-flash 가 있는데도
     * gemini-2.5-pro 를 골랐습니다. 세대 차가 tier 차보다 크므로 순서를 뒤집었습니다.
     */
    pattern: /^gemini-(\d+(?:\.\d+)?)-(pro|flash)(?:-(preview|exp).*)?$/,
    /** 자동 선택이 실패했을 때 마지막으로 시도할 모델 */
    fallback: "gemini-2.5-pro",
    /** 가벼운 단계(안내 생성 등)에 쓸 모델. 비우면 위와 동일 모델 사용 */
    lightPin: process.env.GEMINI_LIGHT_MODEL ?? "",
  },
  anthropic: {
    main: "claude-opus-5",
  },
} as const;

/**
 * 단계별 사고 예산(thinking budget).
 * -1 = 모델이 알아서(dynamic), 0 = 사고 끄기.
 * 감독 단계만 크게 잡아 정확도를 끌어올립니다.
 */
export const THINKING = {
  classifier: -1,
  extractor: -1,
  supervisor: -1,
  guide: 0,
  visionOcr: 0,
} as const;

export const PIPELINE = {
  /**
   * 감독 sub-Agent 재검수 최대 횟수.
   * RAGKOR로 검증기 오탐이 사라져 1회로 충분해졌습니다 (예전 기본 2).
   */
  maxSupervisorRounds: 1,
  /**
   * 배분 앙상블 시도 횟수.
   * 값싼 모델로 N번 시도해 필드별로 좋은 쪽만 합치는 편이,
   * 비싼 모델로 한 번 시도하고 틀려서 재작업하는 것보다 쌉니다.
   */
  ensemble: 2,
  /** 감독에게 넘기는 근거 구간 최대 길이(문자). 원문 전체를 보내지 않습니다. */
  supervisorEvidenceChars: 9000,
  /** 분류 신뢰도가 이 값 미만이면 사용자에게 유형 확인을 요청 */
  classificationConfidenceFloor: 0.55,
  /** 필드 신뢰도가 이 값 미만이면 값을 비우고 Fallback 안내로 넘김 */
  fieldConfidenceFloor: 0.4,
  /** LLM에 넘기는 근거 텍스트 최대 길이(문자) */
  maxEvidenceChars: 180_000,
  /** OCR 앙상블에서 주 엔진과 보조 엔진 일치율이 이 값 미만이면 재판독 */
  ocrAgreementFloor: 0.82,
  /** 이미지 OCR 타일 분할 임계 높이(px) */
  ocrTileThresholdPx: 2200,
  /** 타일 겹침(px) */
  ocrTileOverlapPx: 160,
  /** 업로드 허용 최대 용량 (서버) */
  maxUploadBytes: 40 * 1024 * 1024,
} as const;

/** 비용 추정용 단가 (USD / 1M tokens). 모델·요금제에 맞게 조정하세요. */
export const PRICING = {
  gemini: { inputPerMTok: 1.25, outputPerMTok: 10.0 },
  /** flash 계열은 훨씬 쌉니다 — 무거운 단계를 여기로 옮겨 비용을 줄입니다. */
  geminiFlash: { inputPerMTok: 0.3, outputPerMTok: 2.5 },
  anthropic: { inputPerMTok: 5.0, outputPerMTok: 25.0 },
} as const;

export function googleKey(): string {
  if (!API_KEYS.google) {
    throw new Error(
      "Google API 키가 없습니다.\n" +
        "  1) https://aistudio.google.com/apikey 에서 키를 발급받고\n" +
        "  2) src/config.ts 의 API_KEYS.google 에 붙여넣거나 .env 에 GOOGLE_API_KEY=... 로 넣으세요.",
    );
  }
  return API_KEYS.google;
}

export function visionKey(): string {
  return API_KEYS.googleVision || API_KEYS.google;
}
