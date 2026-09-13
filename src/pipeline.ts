import { PIPELINE } from "./config.js";
import { classify } from "./agents/classifier.js";
import { evidenceSpans } from "./agents/evidence.js";
import { extract } from "./agents/extractor.js";
import { buildFactsheet, factsheetText, type Factsheet } from "./agents/factsheet.js";
import { buildFallbackGuide } from "./agents/guide.js";
import { arbitrate, mergeDrafts } from "./agents/merge.js";
import { supervise } from "./agents/supervisor.js";
import { SourceIndex } from "./ragkor/index.js";
import { ingestFiles } from "./ingest/index.js";
import { createSession, type LlmSession } from "./llm/index.js";
import { CATEGORIES, EXPERIENCE_TYPES, TYPE_BY_ID, resolveLayout } from "./schema/index.js";
import type {
  ExperienceTypeSpec, ExtractionResult, InputFile, OrganizeResult,
  ProgressHandler, ReviewIssue, ReviewResult,
} from "./types.js";
import { checkGrounding } from "./validate/grounding.js";
import { validateStructure } from "./validate/structural.js";
import { setByPath } from "./util/path.js";

export interface OrganizeOptions {
  /** 사용자가 덧붙인 설명 ("작년 여름 인턴 때 만든 자료입니다" 등) */
  userHint?: string;
  /** 유형을 사용자가 직접 지정한 경우 — 분류 단계를 건너뛴다 */
  forceTypeId?: string;
  onProgress?: ProgressHandler;
  session?: LlmSession;
  /**
   * 품질/비용 프리셋.
   *   "fast"     — 앙상블 1회, 전부 값싼 모델
   *   "balanced" — 기본. 값싼 모델 2회 병렬 + 상위 모델 감독
   *   "best"     — 배분도 상위 모델
   */
  quality?: "fast" | "balanced" | "best";
}

/**
 * 산출물 파일 → 정리된 ARC 경험 항목.
 *
 * ┌ 수집/OCR ─ 사실 시트 ─ 분류 ─┬ 배분 A ┐
 * │                             └ 배분 B ┘→ 결정론적 병합 → (충돌만) 중재
 * └───────────────────────────────────────→ 감독(근거 구간만) → 안내
 *
 * 비용 설계
 *   · 무거운 단계(배분)는 **값싼 모델로 병렬 N회**, 필드별로 좋은 쪽만 골라 합친다.
 *   · 감독만 상위 모델을 쓰되, 원문 전체가 아니라 **관련 근거 구간**만 본다.
 *   · RAGKOR로 검증기 오탐이 사라져 재작업 루프가 3회 → 1회로 줄었다.
 */
export async function organizeExperience(
  files: InputFile[],
  options: OrganizeOptions = {},
): Promise<OrganizeResult> {
  const onProgress = options.onProgress;
  const session = options.session ?? (await createSession());

  /* ── 0. 수집 / OCR ─────────────────────────────── */
  const docs = await ingestFiles(session, files, onProgress);
  if (docs.every((d) => !d.text.trim())) {
    throw new Error(
      "업로드한 파일에서 텍스트를 하나도 얻지 못했습니다. " +
        "이미지라면 더 선명한 사진을, 문서라면 PDF로 변환해 다시 올려주세요.",
    );
  }

  const index = new SourceIndex(docs.map((d) => d.text));
  const quality = options.quality ?? "balanced";
  const heavyExtract = quality === "best";
  const ensemble = quality === "fast" ? 1 : PIPELINE.ensemble;

  /* ── 1. 사실 시트 + 분류를 병렬로 ────────────────── */
  onProgress?.({ stage: "extract", message: "사실 시트 작성 + 유형 판별 (병렬)" });
  let factsheet: Factsheet | null = null;

  let classification;
  if (options.forceTypeId && TYPE_BY_ID.has(options.forceTypeId)) {
    const t = TYPE_BY_ID.get(options.forceTypeId)!;
    classification = {
      categoryId: t.category,
      typeId: t.id,
      confidence: 1,
      rationale: "사용자가 유형을 직접 지정했습니다.",
      alternatives: [],
      multipleExperiences: false,
      splitSuggestions: [],
    };
  } else {
    const [fsResult, clsResult] = await Promise.allSettled([
      buildFactsheet(session, docs),
      classify(session, docs, options.userHint),
    ]);
    if (fsResult.status === "fulfilled") factsheet = fsResult.value;
    else onProgress?.({ stage: "extract", message: `사실 시트 실패 — 원문만으로 진행합니다` });
    if (clsResult.status === "rejected") throw clsResult.reason;
    classification = clsResult.value;
    onProgress?.({
      stage: "classify",
      message: `유형 판별: ${TYPE_BY_ID.get(classification.typeId)?.label ?? classification.typeId} (신뢰도 ${(classification.confidence * 100).toFixed(0)}%)`,
      detail: classification,
    });
  }

  if (options.forceTypeId && TYPE_BY_ID.has(options.forceTypeId)) {
    factsheet = await buildFactsheet(session, docs).catch(() => null);
  }
  const fsText = factsheetText(factsheet);
  if (factsheet) {
    onProgress?.({
      stage: "extract",
      message: `사실 시트: ${factsheet.docType}·${factsheet.register} / `
        + `수치 ${factsheet.numbers?.length ?? 0}건 · 성과 ${factsheet.achievements?.length ?? 0}건 `
        + `· 표기 정규화 ${factsheet.normalized?.length ?? 0}건`,
    });
  }

  const initialType = TYPE_BY_ID.get(classification.typeId);
  if (!initialType) throw new Error(`알 수 없는 경험 유형: ${classification.typeId}`);
  let type: ExperienceTypeSpec = initialType;

  /* ── 2~3. 배분 ↔ 감독 루프 ──────────────────────── */
  let draft: ExtractionResult | null = null;
  let feedback: string | undefined;
  const history: ReviewResult[] = [];
  let final: ReviewResult | null = null;
  let rounds = 0;

  for (let round = 0; round <= PIPELINE.maxSupervisorRounds; round++) {
    rounds = round + 1;

    if (!draft || feedback) {
      if (ensemble > 1 && !feedback) {
        onProgress?.({ stage: "extract", message: `값싼 모델 ${ensemble}회 병렬 배분` });
        const temps = [0.05, 0.35, 0.6].slice(0, ensemble);
        const settled = await Promise.allSettled(temps.map((temperature) =>
          extract(session, type!, docs, {
            userHint: options.userHint, factsheet: fsText,
            temperature, light: !heavyExtract,
          })));
        const drafts = settled
          .filter((r): r is PromiseFulfilledResult<ExtractionResult> => r.status === "fulfilled")
          .map((r) => r.value);
        if (!drafts.length) throw (settled[0] as PromiseRejectedResult).reason;

        if (drafts.length === 1) {
          draft = drafts[0]!;
        } else {
          const { result, conflicts } = mergeDrafts(type, drafts, index);
          draft = result;
          onProgress?.({
            stage: "extract",
            message: `필드별 우수안 선택 · 충돌 ${conflicts.length}건`,
          });
          if (conflicts.length) {
            const fixed = await arbitrate(session, conflicts, fsText).catch(() => ({}));
            for (const [k, v] of Object.entries(fixed)) draft.values[k] = v;
            onProgress?.({ stage: "extract", message: `충돌 중재 ${Object.keys(fixed).length}건 확정` });
          }
        }
      } else {
        onProgress?.({
          stage: "extract",
          message: feedback ? `재작업 중 (${round + 1}회차)` : "항목별 배분 중",
        });
        draft = await extract(session, type, docs, {
          userHint: options.userHint, feedback, factsheet: fsText, light: !heavyExtract,
        });
      }
      feedback = undefined;
    }

    onProgress?.({ stage: "validate", message: "형식·근거 기계 검증 (RAGKOR)" });
    const validatorIssues = runValidators(type, draft, docs, index);

    const spans = evidenceSpans(docs, draft.values, draft.provenance, index);
    onProgress?.({
      stage: "supervise",
      message: `감독 검수 (${round + 1}회차) · 근거 ${spans.length.toLocaleString()}자로 압축`,
    });
    const review = await supervise(session, type, draft, docs, validatorIssues,
      { evidenceText: spans, factsheet: fsText });
    history.push(review);
    final = review;
    onProgress?.({
      stage: "supervise",
      message: `검수 결과: ${review.verdict} — 충실도 ${review.scores.faithfulness}점, 이슈 ${review.issues.length}건`,
      detail: review,
    });

    /* 유형 자체가 틀렸다 → 유형 바꾸고 처음부터 다시 배분 */
    if (
      review.verdict === "reclassify" &&
      review.reclassifyTo &&
      TYPE_BY_ID.has(review.reclassifyTo) &&
      review.reclassifyTo !== type.id &&
      round < PIPELINE.maxSupervisorRounds
    ) {
      const next: ExperienceTypeSpec = TYPE_BY_ID.get(review.reclassifyTo)!;
      onProgress?.({
        stage: "classify",
        message: `감독이 유형을 정정했습니다: ${type.label} → ${next.label}`,
      });
      classification = {
        ...classification,
        typeId: next.id,
        categoryId: next.category,
        confidence: Math.min(0.85, classification.confidence + 0.1),
        rationale: `${classification.rationale}\n[감독 정정] ${review.comment}`,
        alternatives: [
          { typeId: type.id, confidence: classification.confidence, reason: "최초 분류 결과" },
          ...classification.alternatives,
        ].slice(0, 3),
      };
      type = next;
      draft = null;
      feedback = undefined;
      continue;
    }

    /* 수정 패치 적용 */
    if (Object.keys(review.patch).length) {
      draft = applyPatch(draft, review.patch);
      onProgress?.({
        stage: "supervise",
        message: `수정 ${Object.keys(review.patch).length}건 적용`,
      });
    }

    if (review.verdict === "approve") break;
    if (round >= PIPELINE.maxSupervisorRounds) break;

    /* 패치로 해결이 안 되는 blocker가 남았으면 배분 단계로 되돌린다 */
    const remaining = review.issues.filter(
      (i) => i.severity === "blocker" && !(i.path in review.patch),
    );
    if (remaining.length) {
      feedback = [
        "이전 회차 결과에서 아래 문제가 발견됐다. 원문을 다시 읽고 처음부터 정확히 다시 작성하라.",
        ...remaining.map((i) => `· [${i.type}] ${i.path} — ${i.detail}`),
        "",
        `감독 총평: ${review.comment}`,
      ].join("\n");
    } else {
      break; // major 이하만 남았고 패치로 처리됨
    }
  }

  if (!draft || !final) throw new Error("정리에 실패했습니다.");

  /* 패치 적용 후 형식 재검증 — 감독이 고치다 형식을 깨뜨렸을 수 있다 */
  const postIssues = runValidators(type, draft, docs, index);
  final = {
    ...final,
    issues: mergeIssues(final.issues, postIssues),
  };

  /* ── 4. Fallback 안내 ──────────────────────────── */
  onProgress?.({ stage: "guide", message: "빈 항목 안내 생성" });
  const fallback = await buildFallbackGuide(session, type, draft, docs, classification);

  const { layout, hiddenCommonKeys } = resolveLayout(type);
  const category = CATEGORIES.find((c) => c.id === type.category)!;

  onProgress?.({
    stage: "done",
    message: `완료 — ${type.label} / 채움률 ${fallback.completeness}% / 남은 이슈 ${final.issues.filter((i) => i.severity !== "minor").length}건`,
  });

  return {
    categoryId: type.category,
    categoryLabel: category.label,
    typeId: type.id,
    typeLabel: type.label,
    classification,
    form: { values: draft.values, layout, hiddenCommonKeys },
    provenance: draft.provenance,
    review: { rounds, final, history },
    fallback,
    factsheet,
    ingest: {
      docs: docs.map((d) => ({
        sourceId: d.sourceId,
        name: d.name,
        kind: d.kind,
        chars: d.text.length,
        confidence: d.confidence,
        warnings: d.warnings,
      })),
    },
    usage: session.usage,
  };
}

function runValidators(
  type: ExperienceTypeSpec,
  draft: ExtractionResult,
  docs: Parameters<typeof checkGrounding>[3],
  index?: SourceIndex,
): ReviewIssue[] {
  return [
    ...validateStructure(type, draft.values),
    ...checkGrounding(type, draft.values, draft.provenance, docs, index),
  ];
}

function applyPatch(draft: ExtractionResult, patch: Record<string, unknown>): ExtractionResult {
  const values = structuredClone(draft.values);
  for (const [path, value] of Object.entries(patch)) {
    try {
      setByPath(values, path, value);
    } catch {
      /* 잘못된 경로는 무시 — 감독이 만든 경로가 스키마에 없을 수 있다 */
    }
  }
  // 비워진 항목의 근거는 떼어낸다
  const cleared = new Set(
    Object.entries(patch)
      .filter(([, v]) => v === null || v === undefined || v === "")
      .map(([p]) => p),
  );
  return {
    values,
    provenance: draft.provenance.filter((p) => !cleared.has(p.path)),
    unfilled: draft.unfilled,
  };
}

function mergeIssues(a: ReviewIssue[], b: ReviewIssue[]): ReviewIssue[] {
  const seen = new Set<string>();
  return [...a, ...b].filter((i) => {
    const k = `${i.path}|${i.type}|${i.detail}`;
    return seen.has(k) ? false : (seen.add(k), true);
  });
}

export { EXPERIENCE_TYPES, CATEGORIES };
