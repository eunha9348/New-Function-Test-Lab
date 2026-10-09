import type { FieldSpec } from "../types.js";

/**
 * 필드 계약 — "이 칸에 무엇이 들어가야 하고, 무엇이 들어가면 안 되는가".
 *
 * 추출 실패의 대부분은 '없는 말을 지어내기'보다 **맞는 말을 틀린 칸에 넣기**다.
 * 한계 문장을 성과 칸에, 팀이 한 일을 내 역할 칸에, 목표를 결과 칸에.
 * 18종 유형의 필드 수백 개에 일일이 설명을 달 수는 없으므로, 필드마다
 * **역할(role)** 하나를 붙이고 역할별 계약을 공유한다.
 *
 * 배분 에이전트(프롬프트), 감독 에이전트(검수 기준), 필드 감사관(최종 검수)이
 * 모두 이 정의를 같이 쓴다. 기준이 하나여야 단계끼리 서로 뒤집지 않는다.
 */
export type FieldRole =
  | "identity"     // 이름·명칭·기관 — 고유명사
  | "date"         // 날짜·기간
  | "choice"       // 보기 중 선택
  | "file"         // 파일·링크
  | "summary"      // 요약·소개
  | "background"   // 배경·목표·동기·문제 정의
  | "action"       // 내가 한 일·역할
  | "outcome"      // 결과·성과·변화
  | "issue"        // 어려움·리스크·갈등과 대응
  | "reflection"   // 배운 점·아쉬운 점·다음 계획
  | "team"         // 팀 구성·협업
  | "skill"        // 기술·도구·역량 태그
  | "other";

export interface RoleContract {
  label: string;
  belongs: string;
  notBelongs: string;
}

export const ROLE_CONTRACTS: Record<FieldRole, RoleContract> = {
  identity: {
    label: "명칭",
    belongs: "원문에 적힌 고유명사 그대로(활동·회사·학교·기관·도서·시험 이름). 원문 표기 유지.",
    notBelongs: "설명 문장, 추측한 정식 명칭, 파일명.",
  },
  date: {
    label: "날짜",
    belongs: "원문에 적힌 날짜·기간. YYYY-MM-DD(모르면 YYYY-MM, YYYY).",
    notBelongs: "추정한 날짜, 파일 생성일·업로드일, 다른 활동의 날짜.",
  },
  choice: {
    label: "선택",
    belongs: "주어진 보기 중 원문이 뒷받침하는 하나.",
    notBelongs: "보기에 없는 값, 근거 없는 선택(모르면 null).",
  },
  file: {
    label: "파일·링크",
    belongs: "업로드된 파일명 또는 원문에 적힌 URL 그대로.",
    notBelongs: "만들어 낸 URL, 업로드되지 않은 파일명.",
  },
  summary: {
    label: "요약",
    belongs: "무엇을 왜 했고 무엇이 나왔는지 원문 사실만으로 압축.",
    notBelongs: "원문에 없는 평가·과장('성공적으로', '주도적으로'), 미래 계획.",
  },
  background: {
    label: "배경·목표",
    belongs: "왜 시작했나 — 문제 상황, 목표, 동기, 요구사항.",
    notBelongs: "실제로 나온 결과, 내가 한 행동, 배운 점.",
  },
  action: {
    label: "내가 한 일",
    belongs: "주어가 '나'인 행동·담당 업무. 무엇을 어떻게 했는지 동사로.",
    notBelongs: "팀 전체가 한 일(주어가 팀·우리), 결과 수치, 배경 설명, 조직 소개.",
  },
  outcome: {
    label: "성과·결과",
    belongs: "행동의 결과로 실제 생긴 변화 — 수치(가능하면 전→후), 수상·채택·반응.",
    notBelongs: "행동 자체('~를 적용했다'), 목표·계획('~할 예정'), 한계·못 한 일·아쉬운 점, 팀 성과를 내 것처럼.",
  },
  issue: {
    label: "어려움·대응",
    belongs: "겪은 문제·리스크·갈등과 그에 대한 대응.",
    notBelongs: "성과, 일반적인 업무 나열.",
  },
  reflection: {
    label: "회고",
    belongs: "배운 점, 아쉬운 점, 다음에 바꿀 행동 — 원문이 말한 것만.",
    notBelongs: "성과 나열, 원문에 없는 교훈 창작.",
  },
  team: {
    label: "팀·협업",
    belongs: "팀 이름·인원·구성, 역할 분담, 협업 방식.",
    notBelongs: "내 개인 역할만의 설명, 성과.",
  },
  skill: {
    label: "기술·역량",
    belongs: "원문에 등장한 도구·기술·역량 이름.",
    notBelongs: "원문에 없는 기술 추정, 문장.",
  },
  other: {
    label: "기타",
    belongs: "항목 이름이 가리키는 내용 중 원문에 있는 것.",
    notBelongs: "다른 칸에 더 맞는 내용.",
  },
};

/* 키 이름으로 역할을 정한다 — 순서가 중요하다(앞에서 먼저 걸린다). */
const KEY_RULES: [RegExp, FieldRole][] = [
  [/^(title|projectName|schoolName|companyName|clubName|societyName|activityName|competitionName|awardName|certName|testName|bookTitle|researchTitle|workName|volunteerName|goalName|organizer|organization|issuer|affiliation|author|major|position|jobFunction|language|sport|countryCity|name|courseName|professor|department|topic|context|stage|task|type|certNumber|languageLevel|currentLevel)$/, "identity"],
  [/(Period|Date|^date$|^deadline$|^semester$|^readPeriod$|^period$)/, "date"],
  [/^(keyAchievement|outcome|achievements|keyOutcome|results?|metrics|change|impact|effect|reception|resultSummary|gradeScore|score|grade|value|awardRank)$/, "outcome"],
  [/^(myRole|actions?|whatIDid|myContribution|myPart|mission|detail|activityDetail|content|response|role)$/, "action"],
  [/^(background|goal|problemDefinition|motivation|purpose|reason|intent|researchQuestion|targetUser|successCriteria|criteria|trigger|situation|trainingPlan|resignReason)$/, "background"],
  [/^(learned|retrospective|reflection|regret|didWell|resultLearned|behaviorChange|pattern|nextAction|nextPlan|feedback|careerImpact)$/, "reflection"],
  [/^(risks|blockers|conflictResolution|challenges|difficulty)$/, "issue"],
  [/^(team|teamComposition|teamMembers|collaboration|collaborators|roleMatrix)$/, "team"],
  [/^(skills|techStack|tools|features|strengths|competencyTags)$/, "skill"],
  [/^(summary|summary3|oneLiner|activitySummary|courseSummary|societyIntro|clubIntro)$/, "summary"],
];

export function roleOf(field: Pick<FieldSpec, "key" | "kind">): FieldRole {
  if (field.kind === "file" || field.kind === "link") return "file";
  if (field.kind === "date" || field.kind === "daterange") return "date";
  if (field.kind === "select" || field.kind === "checklist") return "choice";
  // 짧은 '역할/직책' 칸은 직함이다. 서술형 '역할'만 '내가 한 일'로 본다
  if (field.key === "role" && field.kind === "text") return "identity";
  for (const [re, role] of KEY_RULES) if (re.test(field.key)) return role;
  if (field.kind === "tags") return "skill";
  return "other";
}

/** 경로('tasks[0].metrics')의 마지막 키로 역할을 정한다 */
export function roleOfPath(path: string, kind: FieldSpec["kind"] = "longtext"): FieldRole {
  const key = path.split(".").pop()!.replace(/\[\d+\]$/, "");
  return roleOf({ key, kind });
}

/** 프롬프트에 한 번만 넣는 역할 범례 — 필드마다 계약을 반복하지 않아 토큰을 아낀다 */
export function roleLegend(roles?: Iterable<FieldRole>): string {
  const want = roles ? new Set(roles) : null;
  return (Object.entries(ROLE_CONTRACTS) as [FieldRole, RoleContract][])
    .filter(([r]) => r !== "other" && (!want || want.has(r)))
    .map(([, c]) => `[${c.label}] 넣을 것: ${c.belongs} / 넣지 말 것: ${c.notBelongs}`)
    .join("\n");
}
