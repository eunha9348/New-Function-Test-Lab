import type { UsageStat } from "../types.js";

export type Stage = "classify" | "extract" | "supervise" | "guide" | "ocr";

export type LlmContent =
  | { type: "text"; text: string }
  | { type: "image"; mediaType: string; dataBase64: string }
  /** 오디오/영상 — Gemini는 파일을 그대로 듣고 받아쓸 수 있다 */
  | { type: "audio"; mediaType: string; dataBase64: string };

export interface StructuredRequest {
  stage: Stage;
  /** 캐시/재사용되는 안정적 프리픽스 (스키마·규칙) */
  systemStable: string;
  /** 요청마다 달라지는 지시 */
  systemVolatile?: string;
  content: LlmContent[];
  /** 결과 객체 이름 (로그·툴 이름용) */
  toolName: string;
  toolDescription: string;
  /** JSON Schema (이 저장소 표준 형식). 공급자별 형식 변환은 각 구현이 담당. */
  schema: Record<string, unknown>;
  maxTokens?: number;
}

/** 엔진(공급자) 공통 인터페이스. 파이프라인은 이 인터페이스만 안다. */
export interface LlmSession {
  readonly providerName: string;
  readonly usage: UsageStat;
  /** 어떤 모델이 실제로 선택됐는지 (자동 선택 결과 확인용) */
  resolveModel(stage: Stage): Promise<string>;
  /** 스키마에 맞는 JSON을 받아온다 */
  structured<T>(req: StructuredRequest): Promise<T>;
  /** 자유 텍스트 (OCR 등) */
  text(stage: Stage, systemStable: string, content: LlmContent[], maxTokens?: number): Promise<string>;
  /** 키·권한이 실제로 유효한지 확인 (실제 API를 한 번 찔러본다) */
  verify(): Promise<{ ok: boolean; detail: string }>;
}

export function newUsage(): UsageStat {
  return { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, estimatedCostUsd: 0, calls: [] };
}

export function textPart(text: string): LlmContent {
  return { type: "text", text };
}

export function imagePart(bytes: Uint8Array, mediaType = "image/png"): LlmContent {
  return { type: "image", mediaType, dataBase64: Buffer.from(bytes).toString("base64") };
}

export function audioPart(bytes: Uint8Array, mediaType: string): LlmContent {
  return { type: "audio", mediaType, dataBase64: Buffer.from(bytes).toString("base64") };
}
