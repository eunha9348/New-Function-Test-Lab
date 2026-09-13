/** ARC 자동 정리 엔진 — 공통 타입 */

/* ────────────────── 스키마 ────────────────── */

/** 문서 '입력 형태 범례' 11종 */
export type FieldKind =
  | "text" // 한 줄 입력
  | "longtext" // 서술형 (여러 줄)
  | "date" // 날짜 1개
  | "daterange" // 기간 (시작~종료, 진행 중 표시 가능)
  | "select" // 드롭다운 1개 선택
  | "checklist" // 보기 중 복수 선택
  | "tags" // 자유 입력 복수 태그
  | "link" // URL
  | "file" // 파일 업로드
  | "repeater"; // 반복 입력 (하위 칸 구성)

export interface FieldSpec {
  key: string;
  /** 화면 라벨 (한국어, 문서와 1:1) */
  label: string;
  kind: FieldKind;
  required?: boolean;
  /** select / checklist 보기 */
  options?: readonly string[];
  /** checklist에서 보기 외 자유 입력 허용 */
  freeOptions?: boolean;
  /** 하위 섹션명 (예: '학교 정보', '수업 기록') */
  group?: string;
  /** repeater 하위 칸 */
  fields?: readonly FieldSpec[];
  /** 이 전용 항목이 대체하는 공통 항목 key — 채워지면 공통 쪽은 화면에서 숨김 */
  supersedes?: readonly string[];
  /** 추출 에이전트에게 주는 힌트 */
  hint?: string;
}

export type CategoryId = "academic" | "career" | "project" | "growth";

export interface CategorySpec {
  id: CategoryId;
  label: string;
  emoji: string;
  /** 이 대분류로 라우팅되는 신호 */
  signals: readonly string[];
}

export interface ExperienceTypeSpec {
  /** 예: 'career.work' */
  id: string;
  category: CategoryId;
  label: string;
  emoji: string;
  /** 분류기가 참고하는 동의어 */
  aliases: readonly string[];
  /** 이 유형을 강하게 시사하는 산출물/문구 */
  signals: readonly string[];
  /** 전용 항목 */
  fields: readonly FieldSpec[];
}

/* ────────────────── 입력 / 수집 ────────────────── */

export type SourceKind =
  | "text"
  | "code"
  | "pdf"
  | "docx"
  | "pptx"
  | "xlsx"
  | "hwp"
  | "image"
  | "audio"
  | "video"
  | "archive"
  | "html"
  | "email"
  | "unknown";

export interface InputFile {
  /** 파일명 (확장자 포함) */
  name: string;
  /** 원본 바이트. 텍스트만 있을 땐 생략하고 `text`만 채워도 됨 */
  bytes?: Uint8Array;
  /** 이미 텍스트를 갖고 있는 경우 (사용자가 직접 붙여넣은 설명 등) */
  text?: string;
  mimeType?: string;
  /** 파일 경로(선택) — CLI에서 사용 */
  path?: string;
}

export interface ExtractedPage {
  index: number;
  text: string;
  /** 이 페이지 텍스트가 어떻게 나왔는지 */
  method: "native" | "ocr" | "stt" | "metadata";
  ocrConfidence?: number;
}

export interface ExtractedDoc {
  sourceId: string;
  name: string;
  kind: SourceKind;
  mimeType: string;
  bytesLength: number;
  text: string;
  pages: ExtractedPage[];
  /** 파일에서 뽑아낸 구조적 힌트 (EXIF 날짜, 문서 제목, 작성자 등) */
  metadata: Record<string, string | number>;
  /** 추출 과정에서 생긴 경고 (라이브러리 없음, 저품질 OCR 등) */
  warnings: string[];
  /** 0~1. 텍스트 신뢰도 (네이티브 추출=1, OCR은 앙상블 점수) */
  confidence: number;
}

/* ────────────────── 에이전트 산출물 ────────────────── */

export interface ClassificationResult {
  categoryId: CategoryId;
  typeId: string;
  confidence: number;
  rationale: string;
  alternatives: { typeId: string; confidence: number; reason: string }[];
  /** 한 파일에 여러 경험이 섞여 있는 경우 */
  multipleExperiences: boolean;
  splitSuggestions: { title: string; typeId: string; hint: string }[];
}

/** 값 + 근거. 근거 없는 값은 감독 단계에서 걸러진다. */
export interface FieldValue {
  /** 필드 경로. repeater는 'courses[0].courseName' 형태 */
  path: string;
  value: unknown;
  confidence: number;
  /** 원문에서 그대로 가져온 근거 문장 */
  quotes: { sourceId: string; text: string }[];
}

export interface ExtractionResult {
  /** 최종 폼 값 (중첩 객체) */
  values: Record<string, unknown>;
  /** 경로별 근거·신뢰도 */
  provenance: FieldValue[];
  /** 채우지 못한 항목 */
  unfilled: { path: string; label: string; reason: string }[];
}

export type IssueType =
  | "hallucination" // 원문에 근거 없음
  | "misplaced" // 다른 항목에 들어가야 함
  | "format" // 형식/보기 위반
  | "summary_drift" // 요약이 원문 의미를 왜곡
  | "duplication" // 같은 내용 중복 배치
  | "missing_required" // 필수 누락
  | "wrong_type"; // 유형 자체가 틀림

export interface ReviewIssue {
  severity: "blocker" | "major" | "minor";
  type: IssueType;
  path: string;
  detail: string;
  suggestedValue?: unknown;
  /** 결정론적 검증기가 잡았는지, 감독 에이전트가 잡았는지 */
  foundBy: "validator" | "supervisor";
}

export interface ReviewResult {
  verdict: "approve" | "revise" | "reclassify";
  scores: {
    classification: number; // 유형 판별 적합도
    coverage: number; // 채울 수 있는 항목을 얼마나 채웠나
    faithfulness: number; // 원문 충실도(환각 없음)
    formatting: number; // 형식 준수
  };
  issues: ReviewIssue[];
  reclassifyTo?: string;
  /** 감독이 제안한 수정 패치 (path → value) */
  patch: Record<string, unknown>;
  comment: string;
}

export interface MissingGuide {
  path: string;
  label: string;
  /** 왜 못 채웠는지 */
  why: string;
  /** 무엇을 주면 채울 수 있는지 */
  whatToProvide: string;
  /** 사용자에게 그대로 보여줄 한 줄 질문 */
  question: string;
  exampleAnswer: string;
  priority: "high" | "medium" | "low";
}

export interface FallbackGuide {
  completeness: number; // 0~100
  missing: MissingGuide[];
  /** 추가로 올리면 좋은 파일 종류 */
  recommendedUploads: string[];
  /** 사용자에게 먼저 물어볼 질문 3~5개 */
  nextQuestions: string[];
  /** 유형 확정이 불확실할 때 사용자에게 확인 요청 */
  confirmTypeWith?: { candidates: { typeId: string; label: string }[]; question: string };
}

export interface UsageStat {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  estimatedCostUsd: number;
  calls: { stage: string; ms: number }[];
}

export interface OrganizeResult {
  categoryId: CategoryId;
  categoryLabel: string;
  typeId: string;
  typeLabel: string;
  classification: ClassificationResult;
  /** 화면 배치까지 반영된 최종 폼 */
  form: {
    values: Record<string, unknown>;
    /** 화면에 그릴 순서 (헤더 → 전용 섹션 → 확장 입력 → 증빙) */
    layout: LayoutSection[];
    /** 전용 항목과 겹쳐 화면에서 숨겨진 공통 항목 key */
    hiddenCommonKeys: string[];
  };
  provenance: FieldValue[];
  review: {
    rounds: number;
    final: ReviewResult;
    history: ReviewResult[];
  };
  fallback: FallbackGuide;
  /** 원문에서 먼저 뽑아 둔 사실 시트 (수치·고유명사 누락 방지용) */
  factsheet?: unknown;
  ingest: {
    docs: {
      sourceId: string;
      name: string;
      kind: SourceKind;
      chars: number;
      confidence: number;
      warnings: string[];
    }[];
  };
  usage: UsageStat;
}

export interface LayoutSection {
  /** 'header' | 'specialized' | 'extended' | 'evidence' */
  zone: "header" | "specialized" | "extended" | "evidence";
  title: string;
  collapsedByDefault?: boolean;
  fields: FieldSpec[];
}

export interface ProgressEvent {
  stage:
    | "ingest"
    | "ocr"
    | "classify"
    | "extract"
    | "validate"
    | "supervise"
    | "guide"
    | "done";
  message: string;
  detail?: unknown;
}

export type ProgressHandler = (e: ProgressEvent) => void;
