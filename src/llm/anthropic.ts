import type Anthropic from "@anthropic-ai/sdk";
import { API_KEYS, MODELS, PRICING, THINKING } from "../config.js";
import type { UsageStat } from "../types.js";
import { newUsage, type LlmContent, type LlmSession, type Stage, type StructuredRequest } from "./provider.js";

/**
 * Anthropic 엔진 (선택). config.PROVIDER를 "anthropic"으로 두면 쓰입니다.
 * Google 키만 쓸 거라면 이 파일은 신경 쓰지 않아도 됩니다.
 */
export class AnthropicSession implements LlmSession {
  readonly providerName = "anthropic";
  readonly usage: UsageStat = newUsage();
  private clientPromise: Promise<Anthropic> | null = null;

  constructor(private readonly apiKey: string = API_KEYS.anthropic) {
    if (!apiKey) {
      throw new Error("ANTHROPIC_API_KEY가 비어 있습니다. config.PROVIDER를 'gemini'로 두거나 키를 넣어주세요.");
    }
  }

  private async client(): Promise<Anthropic> {
    if (!this.clientPromise) {
      this.clientPromise = import("@anthropic-ai/sdk").then(
        (m) => new m.default({ apiKey: this.apiKey, maxRetries: 3 }),
      );
    }
    return this.clientPromise;
  }

  async resolveModel(): Promise<string> {
    return MODELS.anthropic.main;
  }

  async verify(): Promise<{ ok: boolean; detail: string }> {
    try {
      const client = await this.client();
      await client.models.retrieve(MODELS.anthropic.main);
      return { ok: true, detail: `모델 "${MODELS.anthropic.main}" 사용 가능` };
    } catch (e) {
      return { ok: false, detail: (e as Error).message };
    }
  }

  async structured<T>(req: StructuredRequest): Promise<T> {
    const client = await this.client();
    const started = Date.now();
    const system: Anthropic.TextBlockParam[] = [
      { type: "text", text: req.systemStable, cache_control: { type: "ephemeral" } },
    ];
    if (req.systemVolatile) system.push({ type: "text", text: req.systemVolatile });

    const response = await client.messages.create({
      model: MODELS.anthropic.main,
      max_tokens: req.maxTokens ?? 16000,
      thinking: { type: "adaptive" },
      // Anthropic 4.6+ 는 temperature를 받지 않습니다. 다양성은 effort로만 조절합니다.
      output_config: { effort: req.stage === "supervise" ? "xhigh" : req.light ? "medium" : "high" },
      system,
      tools: [
        {
          name: req.toolName,
          description: req.toolDescription,
          strict: true,
          input_schema: req.schema as Anthropic.Tool.InputSchema,
        },
      ],
      tool_choice: { type: "tool", name: req.toolName },
      messages: [{ role: "user", content: req.content.map(toBlock) }],
    });

    this.track(req.stage, Date.now() - started, response.usage);
    if (response.stop_reason === "refusal") {
      throw new Error(`[${req.stage}] 모델이 요청을 거절했습니다.`);
    }
    const block = response.content.find(
      (b): b is Anthropic.ToolUseBlock => b.type === "tool_use" && b.name === req.toolName,
    );
    if (!block) throw new Error(`[${req.stage}] 구조화 응답을 받지 못했습니다.`);
    return block.input as T;
  }

  async text(stage: Stage, systemStable: string, content: LlmContent[], maxTokens = 32000): Promise<string> {
    const client = await this.client();
    const started = Date.now();
    const stream = client.messages.stream({
      model: MODELS.anthropic.main,
      max_tokens: maxTokens,
      thinking: THINKING.visionOcr === 0 ? { type: "disabled" } : { type: "adaptive" },
      system: [{ type: "text", text: systemStable, cache_control: { type: "ephemeral" } }],
      messages: [{ role: "user", content: content.map(toBlock) }],
    });
    const message = await stream.finalMessage();
    this.track(stage, Date.now() - started, message.usage);
    return message.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("\n");
  }

  private track(stage: Stage, ms: number, usage: Anthropic.Usage) {
    const inp = usage.input_tokens ?? 0;
    const out = usage.output_tokens ?? 0;
    this.usage.inputTokens += inp;
    this.usage.outputTokens += out;
    this.usage.cacheReadTokens += usage.cache_read_input_tokens ?? 0;
    this.usage.estimatedCostUsd +=
      (inp / 1e6) * PRICING.anthropic.inputPerMTok + (out / 1e6) * PRICING.anthropic.outputPerMTok;
    this.usage.calls.push({ stage, ms });
  }
}

function toBlock(c: LlmContent): Anthropic.ContentBlockParam {
  if (c.type === "audio") {
    throw new Error("Anthropic 엔진은 오디오 입력을 지원하지 않습니다. PROVIDER를 'gemini'로 두세요.");
  }
  return c.type === "text"
    ? { type: "text", text: c.text }
    : {
        type: "image",
        source: {
          type: "base64",
          media_type: c.mediaType as "image/png" | "image/jpeg" | "image/webp" | "image/gif",
          data: c.dataBase64,
        },
      };
}
