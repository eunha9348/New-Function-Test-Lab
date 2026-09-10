import Anthropic from "@anthropic-ai/sdk";
import { API_KEYS, PRICING, assertAnthropicKey } from "../config.js";
import type { UsageStat } from "../types.js";

export type Effort = "low" | "medium" | "high" | "xhigh" | "max";

export interface StructuredCallParams {
  stage: string;
  model: string;
  effort: Effort;
  /** 캐시되는 안정적 프리픽스 (스키마·규칙). 요청마다 바뀌면 안 됨. */
  systemStable: string;
  /** 캐시되지 않는 가변 지시 */
  systemVolatile?: string;
  content: Anthropic.ContentBlockParam[];
  toolName: string;
  toolDescription: string;
  schema: Record<string, unknown>;
  maxTokens?: number;
}

export class LlmSession {
  readonly client: Anthropic;
  readonly usage: UsageStat = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    estimatedCostUsd: 0,
    calls: [],
  };

  constructor(apiKey = API_KEYS.anthropic) {
    assertAnthropicKey();
    this.client = new Anthropic({ apiKey, maxRetries: 3 });
  }

  private track(stage: string, ms: number, usage: Anthropic.Usage) {
    const inp = usage.input_tokens ?? 0;
    const out = usage.output_tokens ?? 0;
    const cacheRead = usage.cache_read_input_tokens ?? 0;
    this.usage.inputTokens += inp;
    this.usage.outputTokens += out;
    this.usage.cacheReadTokens += cacheRead;
    this.usage.estimatedCostUsd +=
      (inp / 1e6) * PRICING.inputPerMTok +
      (out / 1e6) * PRICING.outputPerMTok +
      (cacheRead / 1e6) * PRICING.cacheReadPerMTok;
    this.usage.calls.push({ stage, ms });
  }

  /**
   * 강제 tool 호출로 구조화 JSON을 받아온다.
   * strict:true 라 스키마 위반 응답이 애초에 나오지 않는다.
   */
  async structured<T>(p: StructuredCallParams): Promise<T> {
    const started = Date.now();
    const system: Anthropic.TextBlockParam[] = [
      { type: "text", text: p.systemStable, cache_control: { type: "ephemeral" } },
    ];
    if (p.systemVolatile) system.push({ type: "text", text: p.systemVolatile });

    const response = await this.client.messages.create({
      model: p.model,
      max_tokens: p.maxTokens ?? 16000,
      thinking: { type: "adaptive" },
      output_config: { effort: p.effort },
      system,
      tools: [
        {
          name: p.toolName,
          description: p.toolDescription,
          strict: true,
          input_schema: p.schema as Anthropic.Tool.InputSchema,
        },
      ],
      tool_choice: { type: "tool", name: p.toolName },
      messages: [{ role: "user", content: p.content }],
    });

    this.track(p.stage, Date.now() - started, response.usage);

    if (response.stop_reason === "refusal") {
      throw new Error(
        `[${p.stage}] 모델이 요청을 거절했습니다: ${response.stop_details?.explanation ?? "사유 미상"}`,
      );
    }
    const block = response.content.find(
      (b): b is Anthropic.ToolUseBlock => b.type === "tool_use" && b.name === p.toolName,
    );
    if (!block) {
      throw new Error(`[${p.stage}] 구조화 응답을 받지 못했습니다 (stop_reason=${response.stop_reason}).`);
    }
    return block.input as T;
  }

  /** 자유 텍스트 응답 (OCR 등 긴 출력용, 스트리밍) */
  async text(
    stage: string,
    model: string,
    effort: Effort,
    system: string,
    content: Anthropic.ContentBlockParam[],
    maxTokens = 32000,
  ): Promise<string> {
    const started = Date.now();
    const stream = this.client.messages.stream({
      model,
      max_tokens: maxTokens,
      thinking: { type: "adaptive" },
      output_config: { effort },
      system: [{ type: "text", text: system, cache_control: { type: "ephemeral" } }],
      messages: [{ role: "user", content }],
    });
    const message = await stream.finalMessage();
    this.track(stage, Date.now() - started, message.usage);
    if (message.stop_reason === "refusal") {
      throw new Error(`[${stage}] 모델이 요청을 거절했습니다.`);
    }
    return message.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("\n");
  }
}
