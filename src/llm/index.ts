import { PROVIDER } from "../config.js";
import { GeminiSession } from "./gemini.js";
import type { LlmSession } from "./provider.js";

export * from "./provider.js";
export { GeminiSession } from "./gemini.js";
export { toGeminiSchema, coerceToSchema } from "./gemini-schema.js";

/**
 * 설정에 맞는 엔진을 만든다.
 * 기본은 Gemini — Google API 키 하나면 끝이다.
 * config.PROVIDER를 "anthropic"으로 바꾸면 Anthropic 엔진으로 전환된다
 * (그때만 @anthropic-ai/sdk가 필요하고, 없으면 안내 메시지를 던진다).
 */
export async function createSession(): Promise<LlmSession> {
  if (PROVIDER === "anthropic") {
    try {
      const { AnthropicSession } = await import("./anthropic.js");
      return new AnthropicSession();
    } catch (e) {
      throw new Error(
        `Anthropic 엔진을 불러오지 못했습니다: ${(e as Error).message}\n` +
          "`npm i @anthropic-ai/sdk` 를 설치하거나 config.PROVIDER를 'gemini'로 되돌리세요.",
      );
    }
  }
  return new GeminiSession();
}
