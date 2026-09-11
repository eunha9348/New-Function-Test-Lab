import { MODELS, PRICING, THINKING, googleKey } from "../config.js";
import type { UsageStat } from "../types.js";
import { coerceToSchema, toGeminiSchema } from "./gemini-schema.js";
import { newUsage, type LlmContent, type LlmSession, type Stage, type StructuredRequest } from "./provider.js";

const BASE = "https://generativelanguage.googleapis.com/v1beta";

interface GeminiModelInfo {
  name: string;
  displayName?: string;
  supportedGenerationMethods?: string[];
  inputTokenLimit?: number;
}

/**
 * Gemini 엔진.
 *
 * 모델 ID를 하드코딩하지 않는다. 첫 호출 때 ListModels로 실제 계정에서 쓸 수 있는
 * 모델 목록을 받아, config.MODELS.gemini.prefer 우선순위에 따라 **가장 최신 세대**를
 * 자동으로 고른다. config.MODELS.gemini.pin 을 채우면 그 모델로 고정된다.
 */
export class GeminiSession implements LlmSession {
  readonly providerName = "gemini";
  readonly usage: UsageStat = newUsage();
  private modelPromise: Promise<{ main: string; light: string }> | null = null;
  private noThinking = new Set<string>();

  constructor(private readonly apiKey: string = googleKey()) {}

  /* ───────────────── 모델 자동 선택 ───────────────── */

  async listModels(): Promise<GeminiModelInfo[]> {
    const res = await fetch(`${BASE}/models?key=${this.apiKey}&pageSize=200`);
    if (!res.ok) throw new Error(await describeError(res, "모델 목록 조회"));
    const json = (await res.json()) as { models?: GeminiModelInfo[] };
    return json.models ?? [];
  }

  private async resolveModels(): Promise<{ main: string; light: string }> {
    if (!this.modelPromise) {
      this.modelPromise = (async () => {
        const cfg = MODELS.gemini;
        if (cfg.pin) return { main: cfg.pin, light: cfg.lightPin || cfg.pin };
        try {
          const models = await this.listModels();
          const usable = models
            .filter((m) => (m.supportedGenerationMethods ?? []).includes("generateContent"))
            .map((m) => m.name.replace(/^models\//, ""));
          const main = pickByPreference(usable, cfg.prefer) ?? cfg.fallback;
          const light = cfg.lightPin || pickLight(usable) || main;
          return { main, light };
        } catch {
          // 목록 조회가 막혀 있어도 파이프라인은 계속 돌아야 한다
          return { main: cfg.fallback, light: cfg.lightPin || cfg.fallback };
        }
      })();
    }
    return this.modelPromise;
  }

  /** 키가 실제로 유효한지, 어떤 모델을 쓸 수 있는지 실제 호출로 확인한다 */
  async verify(): Promise<{ ok: boolean; detail: string }> {
    try {
      const models = await this.listModels();
      const usable = models
        .filter((m) => (m.supportedGenerationMethods ?? []).includes("generateContent"))
        .map((m) => m.name.replace(/^models\//, ""));
      if (!usable.length) {
        return { ok: false, detail: "generateContent를 지원하는 모델이 없습니다. API 키의 권한을 확인해 주세요." };
      }
      const chosen = await this.resolveModel("extract");
      const pinned = MODELS.gemini.pin;
      if (pinned && !usable.includes(pinned)) {
        return {
          ok: false,
          detail: `고정한 모델 "${pinned}" 을 쓸 수 없습니다. 사용 가능: ${usable.slice(0, 8).join(", ")}`,
        };
      }
      return { ok: true, detail: `사용 가능한 모델 ${usable.length}개 중 "${chosen}" 선택` };
    } catch (e) {
      return { ok: false, detail: (e as Error).message };
    }
  }

  async resolveModel(stage: Stage): Promise<string> {
    const { main, light } = await this.resolveModels();
    return stage === "guide" || stage === "ocr" ? light : main;
  }

  /* ───────────────── 호출 ───────────────── */

  async structured<T>(req: StructuredRequest): Promise<T> {
    const model = await this.resolveModel(req.stage);
    const schema = toGeminiSchema(req.schema);
    const system = [req.systemStable, req.systemVolatile].filter(Boolean).join("\n\n");

    const raw = await this.generate(req.stage, model, system, req.content, {
      responseMimeType: "application/json",
      responseSchema: schema,
      maxOutputTokens: req.maxTokens ?? 32_768,
      temperature: 0.1,
    });

    let parsed: unknown;
    try {
      parsed = JSON.parse(stripCodeFence(raw));
    } catch {
      throw new Error(
        `[${req.stage}] 모델이 JSON을 반환하지 않았습니다. 앞부분: ${raw.slice(0, 200)}`,
      );
    }
    return coerceToSchema(parsed, req.schema) as T;
  }

  async text(
    stage: Stage,
    systemStable: string,
    content: LlmContent[],
    maxTokens = 32_768,
  ): Promise<string> {
    const model = await this.resolveModel(stage);
    return this.generate(stage, model, systemStable, content, {
      maxOutputTokens: maxTokens,
      temperature: 0,
    });
  }

  private async generate(
    stage: Stage,
    model: string,
    system: string,
    content: LlmContent[],
    generationConfig: Record<string, unknown>,
  ): Promise<string> {
    const started = Date.now();
    const budget = THINKING[stageToThinkingKey(stage)];
    const withThinking =
      budget !== undefined && !this.noThinking.has(model)
        ? { ...generationConfig, thinkingConfig: { thinkingBudget: budget } }
        : generationConfig;

    let json = await this.post(model, system, content, withThinking);

    // thinkingConfig를 모르는 모델이면 한 번만 빼고 재시도
    if (json.error && /thinking/i.test(JSON.stringify(json.error))) {
      this.noThinking.add(model);
      json = await this.post(model, system, content, generationConfig);
    }
    if (json.error) throw new Error(`[${stage}] Gemini 오류: ${json.error.message ?? JSON.stringify(json.error)}`);

    const candidate = json.candidates?.[0];
    const finish = candidate?.finishReason;
    if (finish === "SAFETY" || finish === "PROHIBITED_CONTENT" || finish === "BLOCKLIST") {
      throw new Error(
        `[${stage}] 안전 필터에 걸려 응답이 차단됐습니다 (${finish}). ` +
          "개인정보가 많이 담긴 파일이면 해당 부분을 가리고 다시 시도해 주세요.",
      );
    }
    if (finish === "MAX_TOKENS") {
      throw new Error(`[${stage}] 응답이 최대 길이를 넘었습니다. 파일을 나눠 올려 주세요.`);
    }

    const text = (candidate?.content?.parts ?? [])
      .map((p: any) => p.text ?? "")
      .join("")
      .trim();

    const usage = json.usageMetadata ?? {};
    this.track(stage, Date.now() - started, usage);

    if (!text) throw new Error(`[${stage}] 빈 응답을 받았습니다 (finishReason=${finish ?? "없음"}).`);
    return text;
  }

  private async post(
    model: string,
    system: string,
    content: LlmContent[],
    generationConfig: Record<string, unknown>,
  ): Promise<any> {
    const body = {
      systemInstruction: system ? { parts: [{ text: system }] } : undefined,
      contents: [{ role: "user", parts: content.map(toPart) }],
      generationConfig,
      safetySettings: [
        "HARM_CATEGORY_HARASSMENT",
        "HARM_CATEGORY_HATE_SPEECH",
        "HARM_CATEGORY_SEXUALLY_EXPLICIT",
        "HARM_CATEGORY_DANGEROUS_CONTENT",
      ].map((category) => ({ category, threshold: "BLOCK_ONLY_HIGH" })),
    };

    return withRetry(async () => {
      const res = await fetch(`${BASE}/models/${model}:generateContent?key=${this.apiKey}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      if (res.status === 429 || res.status >= 500) {
        throw Object.assign(new Error(await describeError(res, "생성")), { retryable: true });
      }
      return res.json();
    });
  }

  private track(stage: Stage, ms: number, usage: any) {
    const inp = usage.promptTokenCount ?? 0;
    const out = (usage.candidatesTokenCount ?? 0) + (usage.thoughtsTokenCount ?? 0);
    const cached = usage.cachedContentTokenCount ?? 0;
    this.usage.inputTokens += inp;
    this.usage.outputTokens += out;
    this.usage.cacheReadTokens += cached;
    this.usage.estimatedCostUsd +=
      (inp / 1e6) * PRICING.gemini.inputPerMTok + (out / 1e6) * PRICING.gemini.outputPerMTok;
    this.usage.calls.push({ stage, ms });
  }
}

/* ───────────────── 헬퍼 ───────────────── */

function toPart(c: LlmContent) {
  // 이미지든 오디오든 Gemini는 같은 inline_data로 받는다
  return c.type === "text"
    ? { text: c.text }
    : { inline_data: { mime_type: c.mediaType, data: c.dataBase64 } };
}

function stageToThinkingKey(stage: Stage): keyof typeof THINKING {
  switch (stage) {
    case "classify": return "classifier";
    case "extract": return "extractor";
    case "supervise": return "supervisor";
    case "guide": return "guide";
    case "ocr": return "visionOcr";
  }
}

/** 우선순위 패턴에 맞는 모델 중 세대 숫자가 가장 큰 것 */
export function pickByPreference(models: string[], prefer: readonly RegExp[]): string | null {
  for (const re of prefer) {
    const hits = models
      .map((m) => ({ m, g: re.exec(m) }))
      .filter((x): x is { m: string; g: RegExpExecArray } => x.g !== null)
      .map((x) => ({ m: x.m, gen: Number(x.g[1]) }))
      .filter((x) => Number.isFinite(x.gen))
      .sort((a, b) => b.gen - a.gen || a.m.length - b.m.length);
    if (hits.length) return hits[0]!.m;
  }
  return null;
}

/** 가벼운 단계용 — flash 계열 중 최신 */
function pickLight(models: string[]): string | null {
  return pickByPreference(models, [/^gemini-(\d+(?:\.\d+)?)-flash$/, /^gemini-(\d+(?:\.\d+)?)-flash-preview/]);
}

function stripCodeFence(s: string): string {
  const m = /^\s*```(?:json)?\s*([\s\S]*?)\s*```\s*$/.exec(s);
  return m ? m[1]! : s;
}

async function describeError(res: Response, what: string): Promise<string> {
  let detail = "";
  try {
    const j: any = await res.json();
    detail = j?.error?.message ?? "";
  } catch {
    /* 본문이 JSON이 아닐 수 있다 */
  }
  if (res.status === 400 && /API key not valid/i.test(detail)) {
    return "Google API 키가 올바르지 않습니다. https://aistudio.google.com/apikey 에서 키를 확인해 주세요.";
  }
  if (res.status === 403) {
    return `권한이 없습니다(403). Generative Language API가 켜져 있는지 확인해 주세요. ${detail}`;
  }
  if (res.status === 429) return `요청 한도를 초과했습니다(429). 잠시 후 다시 시도합니다. ${detail}`;
  return `${what} 실패 (HTTP ${res.status}) ${detail}`;
}

async function withRetry<T>(fn: () => Promise<T>, tries = 4): Promise<T> {
  let lastError: unknown;
  for (let i = 0; i < tries; i++) {
    try {
      return await fn();
    } catch (e) {
      lastError = e;
      if (!(e as any)?.retryable && i > 0) break;
      await new Promise((r) => setTimeout(r, 1000 * 2 ** i));
    }
  }
  throw lastError;
}
