import type { CategorySpec, FieldSpec } from "../types.js";

/**
 * 모든 경험 유형 공통 — '기본 정보' 6종.
 *
 * ⚠ 실제 폼(ExperienceFormV2)에는 '기본 정보'라는 섹션이 없습니다.
 *   데이터 모델상으로만 공통이고, 화면에서는
 *     ① 경험명·한 줄 요약 → 상단 제목/요약 입력란
 *     ② 증빙 자료        → 마지막 전용 섹션 끝
 *     ③ 기간·내 역할/기여도·핵심 성과 → 접힌 '확장 입력'
 *   으로 흩어집니다. 전용 항목과 의미가 겹치면 중복 제거되어 숨겨집니다.
 *   (입력값 자체는 저장됩니다.)
 */
export const BASE_FIELDS: readonly FieldSpec[] = [
  { key: "title", label: "경험명", kind: "text", required: true, hint: "이 경험을 한 줄로 부르는 이름. 파일명이 아니라 활동의 실제 이름." },
  { key: "period", label: "기간", kind: "daterange", required: true, hint: "시작~종료. 진행 중이면 ongoing=true." },
  { key: "summary", label: "한 줄 요약", kind: "text", hint: "80자 내외 한 문장. 무엇을 왜 했고 무엇이 나왔는지." },
  { key: "myRole", label: "내 역할/기여도", kind: "longtext", hint: "'나'가 한 일만. 팀 전체 성과와 구분할 것." },
  { key: "keyAchievement", label: "핵심 성과", kind: "longtext", hint: "가능하면 수치. 원문에 없는 수치는 절대 만들지 말 것." },
  { key: "evidence", label: "증빙 자료", kind: "file", hint: "업로드된 파일 중 증빙이 되는 것의 파일명." },
] as const;

/** 확장 입력 (선택) — 화면에 보이는 유일한 공통 섹션, 기본 접힘 */
export const EXTENDED_FIELDS: readonly FieldSpec[] = [
  { key: "background", label: "배경/목표", kind: "longtext" },
  { key: "actions", label: "내가 한 행동", kind: "longtext" },
  { key: "outcome", label: "결과/성과", kind: "longtext" },
  { key: "learned", label: "배운 점", kind: "longtext" },
  { key: "skills", label: "사용한 스킬", kind: "tags" },
  { key: "team", label: "협업/팀", kind: "text" },
  { key: "difficulty", label: "난이도", kind: "select", options: ["상", "중", "하"] },
  { key: "visibility", label: "공개 설정", kind: "select", options: ["공개", "비공개", "일부 공개"] },
] as const;

/** 화면 상단(제목/요약)에 올라가는 공통 key */
export const HEADER_KEYS = ["title", "summary"] as const;
/** 화면 맨 끝(증빙)으로 가는 공통 key */
export const EVIDENCE_KEYS = ["evidence"] as const;
/** '확장 입력'으로 합쳐지는 기본 정보 key */
export const FOLDED_BASE_KEYS = ["period", "myRole", "keyAchievement"] as const;

export const CATEGORIES: readonly CategorySpec[] = [
  {
    id: "academic",
    label: "학업",
    emoji: "🎓",
    signals: ["학교", "전공", "수업", "학점", "성적표", "학회", "동아리", "논문", "연구", "랩", "교수", "학기"],
  },
  {
    id: "career",
    label: "커리어",
    emoji: "💼",
    signals: ["회사", "인턴", "재직", "근무", "직무", "대외활동", "서포터즈", "수상", "공모전", "자격증", "어학", "토익", "OPIc"],
  },
  {
    id: "project",
    label: "프로젝트",
    emoji: "🚀",
    signals: ["프로젝트", "리포지토리", "배포", "README", "기획서", "포트폴리오", "작품", "디자인", "영상", "커밋"],
  },
  {
    id: "growth",
    label: "개인성장",
    emoji: "🌱",
    signals: ["봉사", "해외", "교환학생", "운동", "훈련", "독서", "회고", "일지", "목표", "계획", "루틴"],
  },
] as const;
