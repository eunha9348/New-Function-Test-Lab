# ==============================================================================
#  ARC 경험 자동 정리 — Colab 단일 파일 테스트본
# ------------------------------------------------------------------------------
#  파일을 올리면 → ① 경험 유형(대분류 4 / 세부 18종) 판별
#                → ② 유형별 입력 항목에 요약해서 배분
#                → ③ 감독 에이전트가 원문과 대조해 검수·수정
#                → ④ 못 채운 칸은 비우고 "무엇을 주면 채워지는지" 안내
#  실행: 이 셀을 그대로 붙여넣고 ▶ 누르면 됩니다. (Google API 키만 있으면 됨)
# ==============================================================================

GOOGLE_API_KEY = ""  #@param {type:"string"}
# ↑ https://aistudio.google.com/apikey 에서 발급한 키를 넣으세요 (AIza... 로 시작)

GEMINI_MODEL = ""  #@param {type:"string"}
# ↑ 비워두면 사용 가능한 최신 모델을 자동으로 고릅니다. 고정하려면 예: gemini-2.5-pro

import base64, io, json, os, re, sys, time, zipfile, mimetypes, textwrap
from typing import Any, Dict, List, Optional, Tuple

try:
    import requests
except ImportError:
    os.system(f"{sys.executable} -m pip install -q requests")
    import requests

API = "https://generativelanguage.googleapis.com/v1beta"


def _pip(mod: str, pkg: str = ""):
    """필요할 때만 조용히 설치한다."""
    try:
        return __import__(mod)
    except ImportError:
        os.system(f"{sys.executable} -m pip install -q {pkg or mod}")
        try:
            return __import__(mod)
        except ImportError:
            return None


# ==============================================================================
#  1. 스키마 — 공통 항목 + 경험 유형 18종
# ==============================================================================

def F(key, label, kind, req=False, options=None, group=None, fields=None,
      supersedes=None, hint=None, free=False):
    d = {"key": key, "label": label, "kind": kind}
    if req: d["req"] = True
    if options: d["options"] = options
    if group: d["group"] = group
    if fields: d["fields"] = fields
    if supersedes: d["supersedes"] = supersedes
    if hint: d["hint"] = hint
    if free: d["free"] = True
    return d


def T(tid, cat, label, emoji, aliases, signals, fields):
    return {"id": tid, "category": cat, "label": label, "emoji": emoji,
            "aliases": aliases, "signals": signals, "fields": fields}


# ── 기본 정보 6종 (데이터 모델 공통. 화면에는 제목/요약·확장입력·증빙으로 흩어짐) ──
BASE_FIELDS = [
    F("title", "경험명", "text", req=True, hint="활동의 실제 이름. 파일명이 아님."),
    F("period", "기간", "daterange", req=True),
    F("summary", "한 줄 요약", "text", hint="80자 내외 한 문장."),
    F("myRole", "내 역할/기여도", "longtext", hint="'나'가 한 일만. 팀 성과와 구분."),
    F("keyAchievement", "핵심 성과", "longtext", hint="원문에 있는 수치만. 지어내지 말 것."),
    F("evidence", "증빙 자료", "file", hint="업로드된 파일명 그대로."),
]

# ── 확장 입력 8종 (화면에 보이는 유일한 공통 섹션, 기본 접힘) ──
EXTENDED_FIELDS = [
    F("background", "배경/목표", "longtext"),
    F("actions", "내가 한 행동", "longtext"),
    F("outcome", "결과/성과", "longtext"),
    F("learned", "배운 점", "longtext"),
    F("skills", "사용한 스킬", "tags"),
    F("team", "협업/팀", "text"),
    F("difficulty", "난이도", "select", options=["상", "중", "하"]),
    F("visibility", "공개 설정", "select", options=["공개", "비공개", "일부 공개"]),
]

HEADER_KEYS = ["title", "summary"]
EVIDENCE_KEYS = ["evidence"]

CATEGORIES = [
    {"id": "academic", "label": "학업", "emoji": "🎓",
     "signals": ["학교", "전공", "수업", "학점", "성적표", "학회", "동아리", "논문", "연구", "랩", "교수", "학기"]},
    {"id": "career", "label": "커리어", "emoji": "💼",
     "signals": ["회사", "인턴", "재직", "근무", "직무", "대외활동", "서포터즈", "수상", "공모전", "자격증", "어학"]},
    {"id": "project", "label": "프로젝트", "emoji": "🚀",
     "signals": ["프로젝트", "리포지토리", "배포", "README", "기획서", "포트폴리오", "작품", "디자인", "영상"]},
    {"id": "growth", "label": "개인성장", "emoji": "🌱",
     "signals": ["봉사", "해외", "교환학생", "운동", "훈련", "독서", "회고", "일지", "목표", "계획", "루틴"]},
]

EXPERIENCE_TYPES = [
    # ══════════════ 🎓 학업 ══════════════
    T("academic.major_course", "academic", "전공 및 수강 수업", "🎓",
      ["전공", "수강", "수업", "강의", "학점", "성적표"],
      ["성적증명서", "수강신청 내역", "강의계획서", "학기 성적", "교수님", "과제 제출물"], [
        F("schoolName", "학교명", "text", req=True, group="학교 정보"),
        F("major", "전공", "text", group="학교 정보"),
        F("enrollmentStatus", "재학/졸업 상태", "select", options=["재학중", "졸업", "휴학중", "졸업예정"], group="학교 정보"),
        F("admissionDate", "입학일", "date", group="학교 정보"),
        F("graduationDate", "졸업(예정)일", "date", group="학교 정보"),
        F("transcript", "전체 학기 성적표", "file", group="학교 정보"),
        F("courses", "수업 기록", "repeater", group="수업 기록",
          hint="수업 하나당 항목 1개. 과목이 여러 개면 전부 나눠서.", fields=[
            F("courseName", "수업명", "text", req=True),
            F("professor", "교수", "text"),
            F("department", "담당 전공 학과", "text"),
            F("semester", "수강 학기/연도", "text", req=True),
            F("grade", "취득 성적", "text"),
            F("courseSummary", "수업 요약", "longtext"),
            F("keyOutcome", "핵심 성과 기록", "longtext"),
            F("teamProject", "팀프로젝트/과제 내용", "longtext")]),
        F("careerImpact", "커리어에 준 영향", "tags", group="수업 기록"),
      ]),
    T("academic.society", "academic", "학회", "📚",
      ["학회", "학술단체", "학술동아리"], ["학회 활동 인증서", "학술대회", "세미나 발표", "학회장", "기수"], [
        F("societyName", "학회명", "text", req=True, group="학회 정보"),
        F("societyIntro", "학회 소개", "longtext", group="학회 정보"),
        F("officialUrl", "공식 URL/웹사이트", "link", group="학회 정보"),
        F("period", "기간", "daterange", req=True, group="학회 정보", supersedes=["period"]),
        F("certificate", "활동 인증서", "file", group="학회 정보"),
        F("motivation", "지원 동기", "longtext", group="학회 정보"),
        F("role", "역할/직책", "text", req=True, group="학회 정보", supersedes=["myRole"]),
        F("projects", "프로젝트/연구활동", "repeater", group="프로젝트/연구활동 기록", fields=[
            F("name", "프로젝트/연구활동명", "text", req=True),
            F("detailPeriod", "세부 기간", "text", req=True),
            F("role", "직책/역할", "text", req=True),
            F("goal", "연구/프로젝트 목표", "longtext"),
            F("whatIDid", "내가 한 일", "longtext"),
            F("keyOutcome", "핵심 성과", "longtext"),
            F("presentation", "발표/포스터/세미나 여부", "text"),
            F("feedback", "피드백/질문과 대응", "longtext")]),
      ]),
    T("academic.club", "academic", "동아리/교내 단체", "👥",
      ["동아리", "교내 단체", "학생회", "소모임"], ["동아리 활동 인증서", "총무", "회장", "운영진", "정기 모임"], [
        F("clubName", "동아리/단체명", "text", req=True, group="동아리/단체 정보"),
        F("clubIntro", "단체 소개", "longtext", group="동아리/단체 정보"),
        F("period", "기간", "daterange", req=True, group="동아리/단체 정보", supersedes=["period"]),
        F("certificate", "활동 인증서/수료 증빙", "file", group="동아리/단체 정보"),
        F("role", "직책/역할", "text", req=True, group="동아리/단체 정보", supersedes=["myRole"]),
        F("activities", "활동 기록", "repeater", group="활동 기록", fields=[
            F("activityName", "활동명", "text", req=True),
            F("detailPeriod", "세부 기간", "text"),
            F("role", "직책/역할", "text"),
            F("detail", "활동내용 상세", "longtext"),
            F("result", "행사/운영 성과", "longtext")]),
      ]),
    T("academic.research", "academic", "연구 경험/논문", "🔬",
      ["연구", "논문", "학부연구생", "RA", "랩", "저널"], ["초록", "Abstract", "실험 설계", "선행연구", "참고문헌", "게재"], [
        F("researchTitle", "연구 주제/논문 제목", "text", req=True, group="연구 정보"),
        F("affiliation", "소속/기관/랩", "text", group="연구 정보"),
        F("period", "기간", "daterange", req=True, group="연구 정보", supersedes=["period"]),
        F("role", "역할", "select", options=["주저자", "공저", "연구원", "RA", "기타"], group="연구 정보"),
        F("researchQuestion", "연구 질문/가설", "longtext", group="연구 정보"),
        F("method", "방법/설계", "longtext", group="연구 정보"),
        F("dataSource", "데이터/자료 출처", "text", group="연구 정보"),
        F("myPart", "내가 맡은 파트", "longtext", req=True, group="연구 정보", supersedes=["myRole"]),
        F("resultSummary", "결과 요약", "longtext", group="연구 정보"),
        F("achievements", "성과", "tags", group="연구 정보", supersedes=["keyAchievement"]),
        F("shareLink", "재현/공유 자료", "link", group="연구 정보"),
        F("references", "참고문헌/관련 읽을거리", "longtext", group="연구 정보"),
        F("artifacts", "산출물", "file", group="연구 정보", supersedes=["evidence"]),
      ]),
    # ══════════════ 💼 커리어 ══════════════
    T("career.work", "career", "인턴 및 업무 경력", "💼",
      ["인턴", "근무", "재직", "회사", "업무", "경력", "직무"],
      ["경력증명서", "재직증명서", "근로계약", "온보딩", "스프린트", "퇴사"], [
        F("companyName", "회사명", "text", req=True, group="근무 정보"),
        F("employmentPeriod", "재직기간", "daterange", req=True, group="근무 정보", supersedes=["period"]),
        F("employmentType", "고용 형태", "select", options=["인턴", "계약직", "정규직", "프리랜서"], group="근무 정보"),
        F("position", "직책/직급", "text", req=True, group="근무 정보"),
        F("jobFunction", "직무(업무분야)", "text", req=True, group="근무 정보"),
        F("salary", "급여", "text", group="근무 정보", hint="원문에 명시된 경우에만."),
        F("motivation", "지원 동기", "longtext", group="근무 정보"),
        F("team", "팀/조직", "text", group="근무 정보", supersedes=["team"]),
        F("workMode", "근무 형태", "select", options=["재택", "출근", "혼합"], group="근무 정보"),
        F("tasks", "업무내용", "repeater", group="업무내용 기록",
          hint="담당 프로젝트/업무 단위로 쪼갤 것. 한 문단으로 뭉치지 말 것.", fields=[
            F("name", "프로젝트/업무명", "text", req=True),
            F("detailPeriod", "세부 기간", "text"),
            F("role", "역할", "text", req=True),
            F("detail", "업무내용 상세", "longtext"),
            F("tools", "활용 툴", "text"),
            F("collaborators", "협업 대상", "text"),
            F("metrics", "성과 지표", "longtext"),
            F("risks", "리스크/이슈 및 대응", "longtext")]),
        F("resignReason", "퇴사 사유", "longtext", group="업무내용 기록"),
      ]),
    T("career.external", "career", "대외활동", "📣",
      ["대외활동", "서포터즈", "앰배서더", "기자단", "부트캠프", "멘토링"], ["활동 인증서", "위촉장", "미션 수행", "주최"], [
        F("activityName", "활동명", "text", req=True, group="활동 정보"),
        F("organizer", "주최/기관명", "text", group="활동 정보"),
        F("period", "기간", "daterange", req=True, group="활동 정보", supersedes=["period"]),
        F("certificate", "활동 인증서", "file", group="활동 정보"),
        F("role", "직책/역할", "text", req=True, group="활동 정보", supersedes=["myRole"]),
        F("motivation", "지원 동기", "longtext", group="활동 정보"),
        F("mission", "담당 업무/미션", "longtext", group="활동내용 상세"),
        F("whatIDid", "내가 한 일", "repeater", group="활동내용 상세",
          fields=[F("action", "행동", "longtext")]),
        F("collaboration", "협업/커뮤니케이션 방식", "longtext", group="활동내용 상세", supersedes=["team"]),
        F("results", "결과/성과", "repeater", group="활동내용 상세", supersedes=["keyAchievement", "outcome"], fields=[
            F("type", "성과 유형", "text"),
            F("value", "수치", "text", hint="원문에 있는 숫자만."),
            F("desc", "설명", "longtext")]),
        F("outputFile", "결과물/작업물", "file", group="활동내용 상세"),
        F("reference", "추천인/증언", "text", group="활동내용 상세"),
      ]),
    T("career.award", "career", "수상 경력", "🏆",
      ["수상", "공모전", "해커톤", "경진대회", "장학금"], ["상장", "대상", "최우수상", "우수상", "장려상", "심사평", "본선"], [
        F("awardName", "수상명", "text", req=True, group="수상 정보"),
        F("organizer", "주최/기관", "text", req=True, group="수상 정보"),
        F("awardDate", "수상일", "date", group="수상 정보"),
        F("competitionName", "대회/프로그램명", "text", group="수상 정보"),
        F("awardRank", "수상 구분", "select", options=["대상", "최우수", "우수", "장려", "기타"], group="수상 정보"),
        F("participationType", "참가 형태", "select", options=["개인", "팀"], group="수상 정보"),
        F("teamMembers", "팀명/팀원", "text", group="수상 정보", supersedes=["team"]),
        F("criteria", "평가 기준/요구사항", "longtext", group="수상 정보"),
        F("myContribution", "내 역할/기여", "longtext", req=True, group="수상 정보", supersedes=["myRole"]),
        F("submission", "제출물/발표 자료", "file", group="수상 정보"),
        F("awardEvidence", "수상 증빙", "file", group="수상 정보", supersedes=["evidence"]),
        F("keyAchievement", "핵심 성과", "longtext", group="수상 정보", supersedes=["keyAchievement"]),
        F("competencyTags", "이 수상이 의미하는 역량", "tags", group="수상 정보"),
      ]),
    T("career.certificate", "career", "보유 자격증", "✅",
      ["자격증", "면허", "인증", "기사", "컴활", "정보처리"], ["합격증", "자격증 번호", "발급기관", "취득일", "유효기간"], [
        F("certName", "자격증명", "text", req=True, group="자격증 정보"),
        F("issuer", "발급 기관", "text", req=True, group="자격증 정보"),
        F("acquiredDate", "취득일", "date", group="자격증 정보"),
        F("validity", "유효기간/갱신 필요 여부", "text", group="자격증 정보"),
        F("certNumber", "자격 번호", "text", group="자격증 정보"),
        F("gradeScore", "성적/등급", "text", group="자격증 정보"),
        F("prepPeriod", "준비 기간", "daterange", group="자격증 정보", supersedes=["period"]),
        F("studyMethod", "학습 방식", "select", options=["강의", "독학", "스터디", "부트캠프"], group="자격증 정보"),
        F("studyMaterials", "핵심 공부 자료", "link", group="자격증 정보"),
        F("applications", "실무 적용 사례", "repeater", group="실무 적용 사례", fields=[
            F("context", "적용 상황/프로젝트명", "text", req=True),
            F("whatIDid", "내가 한 일", "longtext"),
            F("effect", "결과/효과", "longtext")]),
        F("certEvidence", "자격증 증빙", "file", group="실무 적용 사례", supersedes=["evidence"]),
      ]),
    T("career.language", "career", "어학 능력", "🗣",
      ["어학", "토익", "토플", "OPIc", "JLPT", "HSK", "TOEIC"], ["성적표", "점수", "등급", "응시일", "유효기간"], [
        F("language", "언어", "text", req=True, group="어학 정보"),
        F("testName", "시험/인증명", "text", group="어학 정보"),
        F("score", "점수/등급", "text", group="어학 정보"),
        F("testDate", "응시일", "date", group="어학 정보"),
        F("validity", "유효기간", "text", group="어학 정보"),
        F("strengths", "강점 영역", "checklist", options=["듣기", "읽기", "말하기", "쓰기"], group="어학 정보"),
        F("studyPeriod", "학습 기간", "daterange", group="어학 정보", supersedes=["period"]),
        F("studyMethod", "학습 방식", "select", options=["학원", "독학", "회화", "첨삭", "스터디"], group="어학 정보"),
        F("usages", "활용 사례", "repeater", group="실제 활용 사례", fields=[
            F("situation", "상황", "text", req=True),
            F("myRole", "내가 한 역할", "longtext"),
            F("difficulty", "어려웠던 점과 해결", "longtext"),
            F("result", "결과", "longtext")]),
      ]),
    # ══════════════ 🚀 프로젝트 ══════════════
    T("project.personal", "project", "개인 프로젝트", "🚀",
      ["개인 프로젝트", "토이 프로젝트", "사이드 프로젝트", "1인 개발"], ["README", "커밋 로그", "배포 링크", "기술 스택"], [
        F("projectName", "프로젝트명", "text", req=True, group="프로젝트 정보"),
        F("period", "기간", "daterange", req=True, group="프로젝트 정보", supersedes=["period"]),
        F("oneLiner", "한 줄 설명", "text", req=True, group="프로젝트 정보", supersedes=["summary"]),
        F("goal", "목표/만들고 싶었던 이유", "longtext", group="프로젝트 정보", supersedes=["background"]),
        F("targetUser", "대상 사용자/사용 상황", "longtext", group="프로젝트 정보"),
        F("features", "주요 기능", "checklist", free=True, group="프로젝트 정보"),
        F("techStack", "기술/도구", "tags", group="프로젝트 정보", supersedes=["skills"]),
        F("decisions", "설계/결정", "repeater", group="설계/결정 기록", fields=[
            F("topic", "결정 주제", "text", req=True),
            F("alternatives", "대안 비교", "longtext"),
            F("reason", "선택 이유", "longtext"),
            F("resultLearned", "결과/배운 점", "longtext")]),
        F("outcome", "성과", "longtext", group="설계/결정 기록", supersedes=["keyAchievement", "outcome"]),
        F("demoLink", "데모/배포 링크", "link", group="설계/결정 기록"),
        F("repoLink", "저장소 링크", "link", group="설계/결정 기록"),
        F("screenshots", "스크린샷/영상", "file", group="설계/결정 기록"),
        F("nextPlan", "다음 개선 계획", "longtext", group="설계/결정 기록"),
      ]),
    T("project.team", "project", "팀 프로젝트", "👨‍👩‍👧‍👦",
      ["팀 프로젝트", "협업 프로젝트", "조별과제"], ["역할 분담", "스크럼", "PR 리뷰", "팀원", "회고", "일정 조율"], [
        F("projectName", "프로젝트명", "text", req=True, group="프로젝트 정보"),
        F("period", "기간", "daterange", req=True, group="프로젝트 정보", supersedes=["period"]),
        F("teamComposition", "팀 구성", "longtext", group="프로젝트 정보", supersedes=["team"]),
        F("myRole", "내 역할", "longtext", req=True, group="프로젝트 정보", supersedes=["myRole"]),
        F("problemDefinition", "목표/문제 정의", "longtext", group="프로젝트 정보", supersedes=["background"]),
        F("collaboration", "협업 방식", "longtext", group="프로젝트 정보"),
        F("roleMatrix", "역할 분담표", "longtext", group="프로젝트 정보"),
        F("workLogs", "작업 기록", "repeater", group="작업 기록",
          hint="'내가' 한 작업 단위로. 팀 전체 작업을 내 것으로 적지 말 것.", fields=[
            F("name", "작업/이슈명", "text", req=True),
            F("period", "기간", "text"),
            F("whatIDid", "내가 한 일", "longtext", req=True),
            F("result", "결과", "longtext")]),
        F("conflictResolution", "갈등/의견 차이와 조율", "longtext", group="작업 기록"),
        F("outputLink", "결과물 링크", "link", group="작업 기록"),
        F("retrospective", "회고 (잘된 점/아쉬운 점/다음엔)", "longtext", group="작업 기록", supersedes=["learned"]),
      ]),
    T("project.creative", "project", "창작물/작업물", "🎨",
      ["창작물", "작업물", "포트폴리오", "디자인", "영상", "음악", "사진"], ["작품", "레퍼런스", "컨셉", "스토리보드", "연재"], [
        F("workName", "작품/작업물명", "text", req=True, group="작품 정보"),
        F("field", "분야", "select", options=["디자인", "글", "영상", "음악", "사진", "일러스트", "기타"], group="작품 정보"),
        F("productionPeriod", "제작 기간", "daterange", group="작품 정보", supersedes=["period"]),
        F("oneLiner", "한 줄 소개", "text", req=True, group="작품 정보", supersedes=["summary"]),
        F("intent", "의도/주제", "longtext", group="작품 정보", supersedes=["background"]),
        F("tools", "사용 도구", "tags", group="작품 정보", supersedes=["skills"]),
        F("process", "제작 과정", "repeater", group="제작 과정", fields=[
            F("stage", "단계명", "text", req=True),
            F("whatIDid", "한 일", "longtext"),
            F("decisions", "고민/결정", "longtext"),
            F("result", "결과", "longtext")]),
        F("publicLink", "공개 링크", "link", group="제작 과정"),
        F("reception", "반응/성과", "longtext", group="제작 과정", supersedes=["outcome", "keyAchievement"]),
        F("copyright", "저작권/사용 범위", "text", group="제작 과정"),
      ]),
    # ══════════════ 🌱 개인성장 ══════════════
    T("growth.volunteer", "growth", "봉사활동", "❤️",
      ["봉사", "자원봉사", "재능기부", "나눔"], ["봉사 확인서", "1365", "VMS", "봉사시간", "복지관"], [
        F("volunteerName", "봉사활동명", "text", req=True, group="봉사 정보"),
        F("organization", "기관/장소", "text", group="봉사 정보"),
        F("period", "기간", "daterange", req=True, group="봉사 정보", supersedes=["period"]),
        F("totalHours", "총 시간", "text", group="봉사 정보"),
        F("target", "대상", "select", options=["아동", "노인", "동물", "환경", "기타"], group="봉사 정보"),
        F("activityType", "활동 형태", "select", options=["오프라인", "온라인", "기획", "현장"], group="봉사 정보"),
        F("myRole", "내 역할", "longtext", req=True, group="봉사 정보", supersedes=["myRole"]),
        F("activityDetail", "활동 내용", "longtext", group="봉사 정보"),
        F("impact", "임팩트/변화", "longtext", group="봉사 정보", supersedes=["outcome", "keyAchievement"]),
        F("reflection", "느낀 점/가치관 변화", "longtext", group="봉사 정보", supersedes=["learned"]),
        F("certificate", "봉사 확인서", "file", group="봉사 정보", supersedes=["evidence"]),
      ]),
    T("growth.overseas", "growth", "해외 경험", "🌍",
      ["해외", "교환학생", "어학연수", "워홀", "해외 인턴"], ["비자", "출입국", "현지", "홈스테이", "문화 차이"], [
        F("experienceType", "경험 유형", "select", options=["교환학생", "연수", "여행", "해외 인턴", "기타"], group="해외 경험 정보"),
        F("countryCity", "국가/도시", "text", req=True, group="해외 경험 정보"),
        F("period", "기간", "daterange", req=True, group="해외 경험 정보", supersedes=["period"]),
        F("purpose", "목적", "longtext", group="해외 경험 정보", supersedes=["background"]),
        F("activitySummary", "활동 요약", "longtext", req=True, group="해외 경험 정보"),
        F("languageLevel", "언어 사용 수준", "text", group="해외 경험 정보"),
        F("challenges", "어려웠던 상황", "repeater", group="어려웠던 상황", fields=[
            F("situation", "상황", "text", req=True),
            F("response", "내가 한 대응", "longtext"),
            F("result", "결과", "longtext"),
            F("learned", "배운 점", "longtext")]),
        F("outcome", "성과/산출물", "longtext", group="어려웠던 상황", supersedes=["outcome", "keyAchievement"]),
        F("evidence", "증빙", "file", group="어려웠던 상황", supersedes=["evidence"]),
      ]),
    T("growth.fitness", "growth", "운동 및 신체 역량", "🏃",
      ["운동", "헬스", "러닝", "마라톤", "클라이밍", "수영", "체력"], ["훈련 일지", "PB", "기록 단축", "인바디", "대회 참가"], [
        F("sport", "종목", "text", req=True, group="운동 정보"),
        F("period", "기간", "daterange", req=True, group="운동 정보", supersedes=["period"]),
        F("goal", "목표", "longtext", group="운동 정보", supersedes=["background"]),
        F("currentLevel", "현재 수준", "text", group="운동 정보"),
        F("trainingPlan", "훈련 계획", "text", group="운동 정보"),
        F("logs", "기록 로그", "repeater", group="기록 로그",
          hint="날짜별 로그. 원문에 날짜가 여러 개면 각각 분리.", fields=[
            F("date", "날짜", "date", req=True),
            F("content", "훈련 내용", "longtext", req=True),
            F("record", "기록", "text"),
            F("condition", "컨디션/메모", "longtext")]),
        F("competition", "대회/인증", "longtext", group="기록 로그"),
        F("change", "변화/성과", "longtext", group="기록 로그", supersedes=["outcome", "keyAchievement"]),
        F("consistencyEvidence", "꾸준함 증거", "file", group="기록 로그", supersedes=["evidence"]),
      ]),
    T("growth.reading", "growth", "독서", "📖",
      ["독서", "책", "완독", "서평", "독후감", "북클럽"], ["저자", "출판사", "챕터", "밑줄", "인용", "발췌"], [
        F("bookTitle", "도서명", "text", req=True, group="독서 정보"),
        F("author", "저자", "text", group="독서 정보"),
        F("readPeriod", "읽은 기간/완독일", "text", group="독서 정보", supersedes=["period"]),
        F("reason", "읽은 이유", "longtext", group="독서 정보", supersedes=["background"]),
        F("summary3", "핵심 요약 (3줄)", "longtext", req=True, group="독서 정보", hint="정확히 3줄."),
        F("quotes", "인상 깊은 문장", "longtext", group="독서 정보"),
        F("applications", "적용/실험", "repeater", group="적용/실험", fields=[
            F("topic", "적용할 주제", "text", req=True),
            F("action", "내가 한 행동", "longtext"),
            F("result", "결과/느낌 점", "longtext")]),
        F("relatedLink", "관련 자료", "link", group="적용/실험"),
        F("recommendTo", "추천 대상", "text", group="적용/실험"),
      ]),
    T("growth.journal", "growth", "기록 (일지/회고)", "🗒",
      ["일지", "회고", "저널", "다이어리", "TIL", "일기"], ["오늘", "이번 주", "KPT", "잘한 점", "아쉬운 점", "다음 액션"], [
        F("topic", "기록 주제", "text", req=True, group="기록 정보"),
        F("recordDate", "기록 날짜", "date", group="기록 정보"),
        F("frequency", "기록 빈도", "select", options=["매일", "주1회", "월1회", "비정기"], group="기록 정보"),
        F("trigger", "기록 트리거", "longtext", group="기록 정보"),
        F("whatIDid", "오늘/이번 주에 한 일", "longtext", req=True, group="기록 정보", supersedes=["actions"]),
        F("didWell", "잘한 점 1개", "longtext", group="기록 정보", hint="정확히 1개."),
        F("regret", "아쉬운 점 1개", "longtext", group="기록 정보", hint="정확히 1개."),
        F("learned", "배운 점 1개", "longtext", group="기록 정보", supersedes=["learned"], hint="정확히 1개."),
        F("nextAction", "다음 행동 1개", "longtext", group="기록 정보", hint="정확히 1개."),
        F("insights", "인사이트/패턴", "repeater", group="인사이트/패턴", fields=[
            F("pattern", "발견한 패턴", "text", req=True),
            F("evidence", "근거", "text"),
            F("behaviorChange", "바꿀 행동", "longtext")]),
        F("attachment", "첨부", "file", group="인사이트/패턴", supersedes=["evidence"]),
      ]),
    T("growth.goal", "growth", "목표/계획", "🎯",
      ["목표", "계획", "플랜", "로드맵", "OKR", "버킷리스트"], ["마감일", "우선순위", "체크포인트", "달성", "진행률", "성공 기준"], [
        F("goalName", "목표명", "text", req=True, group="목표 정보"),
        F("period", "기간", "daterange", req=True, group="목표 정보", supersedes=["period"]),
        F("goalType", "목표 유형", "select", options=["학습", "커리어", "건강", "프로젝트", "기타"], group="목표 정보"),
        F("goalLevel", "목표 수준", "select", options=["상", "중", "하"], group="목표 정보", supersedes=["difficulty"]),
        F("successCriteria", "성공 기준", "longtext", req=True, group="목표 정보"),
        F("plans", "세부 계획", "repeater", group="세부 계획", fields=[
            F("task", "할 일", "text", req=True),
            F("deadline", "마감일", "date"),
            F("estimate", "예상 소요", "text"),
            F("priority", "우선순위", "text"),
            F("checkpoint", "체크포인트/측정 지표", "longtext")]),
        F("progress", "진행 기록", "repeater", group="진행 기록", fields=[
            F("date", "날짜", "date", req=True),
            F("content", "진행 내용", "longtext", req=True),
            F("blockers", "막힌 점/리스크", "longtext"),
            F("nextAction", "다음 액션", "longtext")]),
        F("evidence", "증빙", "file", group="진행 기록", supersedes=["evidence"]),
      ]),
]

TYPE_BY_ID = {t["id"]: t for t in EXPERIENCE_TYPES}
CAT_BY_ID = {c["id"]: c for c in CATEGORIES}


# ── 공통 항목 중복 제거 + 화면 배치 (ExperienceFormV2.formLayout 재현) ──

def superseded_keys(t) -> set:
    out = set()
    def walk(fs):
        for f in fs:
            for k in f.get("supersedes", []): out.add(k)
            if f.get("fields"): walk(f["fields"])
    walk(t["fields"])
    return out


def all_fields(t) -> List[dict]:
    hidden = superseded_keys(t)
    commons = [f for f in BASE_FIELDS + EXTENDED_FIELDS if f["key"] not in hidden]
    return commons + t["fields"]


def resolve_layout(t) -> Tuple[List[dict], List[str]]:
    hidden = superseded_keys(t)
    header = [f for f in BASE_FIELDS if f["key"] in HEADER_KEYS and f["key"] not in hidden]
    groups: List[dict] = []
    for f in t["fields"]:
        title = f.get("group") or t["label"]
        g = next((x for x in groups if x["title"] == title), None)
        if not g:
            g = {"title": title, "fields": []}
            groups.append(g)
        g["fields"].append(f)
    folded = [f for f in BASE_FIELDS
              if f["key"] not in HEADER_KEYS and f["key"] not in EVIDENCE_KEYS and f["key"] not in hidden]
    extended = folded + [f for f in EXTENDED_FIELDS if f["key"] not in hidden]
    evidence = [f for f in BASE_FIELDS if f["key"] in EVIDENCE_KEYS and f["key"] not in hidden]

    layout = [{"zone": "header", "title": "제목/요약", "collapsed": False, "fields": header}]
    layout += [{"zone": "specialized", "title": g["title"], "collapsed": False, "fields": g["fields"]} for g in groups]
    layout.append({"zone": "extended", "title": "확장 입력 (선택)", "collapsed": True, "fields": extended})
    if evidence:
        layout.append({"zone": "evidence", "title": "증빙 자료", "collapsed": False, "fields": evidence})
    return layout, sorted(hidden)


def label_for_path(t, path: str) -> str:
    fields = all_fields(t)
    labels = []
    for raw in path.split("."):
        key = re.sub(r"\[\d+\]$", "", raw)
        f = next((x for x in fields if x["key"] == key), None)
        if not f: return path
        labels.append(f["label"])
        fields = f.get("fields", [])
    return " > ".join(labels)


# ── FieldSpec → Gemini responseSchema ──────────────────────────────────────────
# Gemini는 type 유니온을 못 받는다 → 대표 타입 + nullable. additionalProperties도 없음.

def _desc(f) -> str:
    bits = [f["label"]]
    if f.get("req"): bits.append("(필수)")
    if f.get("options"):
        bits.append(f"반드시 다음 중 하나: {' | '.join(f['options'])}. 해당 없으면 null.")
    if f.get("hint"): bits.append(f"※ {f['hint']}")
    return " ".join(bits)


def _fschema(f) -> dict:
    k, d = f["kind"], _desc(f)
    if k in ("text", "longtext", "link", "file", "select"):
        extra = {"text": " [한 줄]", "longtext": " [서술형]", "link": " [원문에 있는 URL만]",
                 "file": " [업로드된 파일명 그대로]", "select": ""}[k]
        return {"type": "STRING", "nullable": True, "description": d + extra}
    if k == "date":
        return {"type": "STRING", "nullable": True,
                "description": d + " [YYYY-MM-DD. 월까지만 알면 YYYY-MM, 연도만 알면 YYYY]"}
    if k == "daterange":
        return {"type": "OBJECT", "nullable": True, "description": d + " [기간]",
                "properties": {
                    "start": {"type": "STRING", "nullable": True, "description": "시작일"},
                    "end": {"type": "STRING", "nullable": True, "description": "종료일. 진행 중이면 null"},
                    "ongoing": {"type": "BOOLEAN", "nullable": True, "description": "진행 중 여부"}},
                "propertyOrdering": ["start", "end", "ongoing"]}
    if k in ("checklist", "tags"):
        return {"type": "ARRAY", "nullable": True, "description": d + " [복수]",
                "items": {"type": "STRING"}}
    if k == "repeater":
        return {"type": "ARRAY", "nullable": True,
                "description": d + " [반복 입력. 원문에 있는 건수만큼만 생성. 억지로 채우지 말 것]",
                "items": obj_schema(f.get("fields", []))}
    return {"type": "STRING", "nullable": True, "description": d}


def obj_schema(fields: List[dict]) -> dict:
    return {"type": "OBJECT",
            "properties": {f["key"]: _fschema(f) for f in fields},
            "propertyOrdering": [f["key"] for f in fields]}


def extraction_schema(fields: List[dict]) -> dict:
    return {"type": "OBJECT", "properties": {
        "values": obj_schema(fields),
        "evidence": {"type": "ARRAY", "description":
            "채운 값마다 원문 근거 1개 이상. 근거를 못 대는 값은 채우지 말 것.",
            "items": {"type": "OBJECT", "properties": {
                "path": {"type": "STRING", "description": "필드 경로. 예: courses[0].courseName"},
                "sourceId": {"type": "STRING"},
                "quote": {"type": "STRING", "description": "원문에서 그대로 복사한 문장(200자 이내)"},
                "confidence": {"type": "NUMBER", "description": "0~1"}},
                "propertyOrdering": ["path", "sourceId", "quote", "confidence"]}},
        "unfilled": {"type": "ARRAY", "description": "비워 둔 항목과 그 이유.",
            "items": {"type": "OBJECT", "properties": {
                "path": {"type": "STRING"}, "reason": {"type": "STRING"}},
                "propertyOrdering": ["path", "reason"]}},
    }, "propertyOrdering": ["values", "evidence", "unfilled"]}


# ── 응답 정리: 보기 밖 값·가짜 null·누락 키를 결정론적으로 교정 ──
BLANK = {"", "null", "none", "n/a", "na", "-", "없음", "미상", "해당없음", "해당 없음",
         "알 수 없음", "미기재", "정보 없음", "확인 불가", "undefined"}


def _blank(v) -> bool:
    if v is None: return True
    if isinstance(v, str): return v.strip().lower() in BLANK
    if isinstance(v, (list, dict)): return len(v) == 0
    return False


def _norm(s: str) -> str:
    return re.sub(r"[\s·.\-_/]", "", str(s)).lower()


def coerce(value, f) -> Any:
    """모델 응답을 폼 형태로 되돌린다."""
    k = f["kind"]
    if _blank(value): return None
    if k == "daterange":
        if not isinstance(value, dict): return None
        out = {"start": None, "end": None, "ongoing": None}
        for key in out:
            v = value.get(key)
            out[key] = None if _blank(v) else v
        return None if all(v is None for v in out.values()) else out
    if k == "repeater":
        rows = value if isinstance(value, list) else [value]
        subs = f.get("fields", [])
        out = []
        for row in rows:
            if not isinstance(row, dict): continue
            r = {s["key"]: coerce(row.get(s["key"]), s) for s in subs}
            if any(v is not None for v in r.values()): out.append(r)
        return out or None
    if k in ("checklist", "tags"):
        arr = value if isinstance(value, list) else [value]
        arr = [str(x).strip() for x in arr if not _blank(x)]
        if f.get("options") and not f.get("free"):
            arr = [m for m in (_match_enum(x, f["options"]) for x in arr) if m]
        return arr or None
    if k == "select" and f.get("options"):
        return _match_enum(str(value), f["options"])
    return str(value).strip() or None


def _match_enum(raw: str, options: List[str]) -> Optional[str]:
    n = _norm(raw)
    for o in options:
        if _norm(o) == n: return o
    for o in options:
        if n and (n in _norm(o) or _norm(o) in n): return o
    return None


def coerce_values(values: dict, fields: List[dict]) -> dict:
    src = values if isinstance(values, dict) else {}
    return {f["key"]: coerce(src.get(f["key"]), f) for f in fields}


# ── 경로 유틸 ──
def _segs(p: str):
    for raw in p.split("."):
        m = re.match(r"^([^\[]+)\[(\d+)\]$", raw)
        yield (m.group(1), int(m.group(2))) if m else (raw, None)


def get_path(obj, path: str):
    cur = obj
    for key, idx in _segs(path):
        if not isinstance(cur, dict): return None
        cur = cur.get(key)
        if idx is not None:
            if not isinstance(cur, list) or idx >= len(cur): return None
            cur = cur[idx]
    return cur


def set_path(obj: dict, path: str, value):
    segs = list(_segs(path))
    cur = obj
    for i, (key, idx) in enumerate(segs):
        last = i == len(segs) - 1
        if last:
            if idx is None: cur[key] = value
            else:
                cur.setdefault(key, [])
                while len(cur[key]) <= idx: cur[key].append({})
                cur[key][idx] = value
            return
        if idx is None:
            if not isinstance(cur.get(key), dict): cur[key] = {}
            cur = cur[key]
        else:
            cur.setdefault(key, [])
            while len(cur[key]) <= idx: cur[key].append({})
            cur = cur[key][idx]


def leaf_paths(value, prefix="") -> List[str]:
    if value is None: return []
    if isinstance(value, list):
        out = []
        for i, v in enumerate(value): out += leaf_paths(v, f"{prefix}[{i}]")
        return out
    if isinstance(value, dict):
        out = []
        for k, v in value.items(): out += leaf_paths(v, f"{prefix}.{k}" if prefix else k)
        return out
    return [prefix] if prefix else []


# ==============================================================================
#  2. Gemini 클라이언트 — 모델 자동 선택 + 재시도 + 한국어 오류 안내
# ==============================================================================

class Gemini:
    PREFER = [r"^gemini-(\d+(?:\.\d+)?)-pro$", r"^gemini-(\d+(?:\.\d+)?)-pro-preview",
              r"^gemini-(\d+(?:\.\d+)?)-flash$", r"^gemini-(\d+(?:\.\d+)?)-flash-preview"]
    FALLBACK = "gemini-2.5-pro"

    def __init__(self, api_key: str, pin: str = ""):
        if not api_key or not api_key.strip():
            raise RuntimeError(
                "Google API 키가 비어 있습니다.\n"
                "  https://aistudio.google.com/apikey 에서 키를 발급받아\n"
                "  맨 위 GOOGLE_API_KEY = \"...\" 에 넣어주세요.")
        self.key = api_key.strip()
        self.pin = pin.strip()
        self._models = None
        self.usage = {"in": 0, "out": 0, "calls": []}

    def list_models(self) -> List[str]:
        r = requests.get(f"{API}/models", params={"key": self.key, "pageSize": 200}, timeout=30)
        if not r.ok: raise RuntimeError(self._err(r, "모델 목록 조회"))
        return [m["name"].replace("models/", "") for m in r.json().get("models", [])
                if "generateContent" in m.get("supportedGenerationMethods", [])]

    def models(self) -> Tuple[str, str]:
        """(주 모델, 보조 모델). 실패해도 파이프라인은 계속 돈다."""
        if self._models: return self._models
        if self.pin:
            self._models = (self.pin, self.pin)
            return self._models
        try:
            usable = self.list_models()
            main = self._pick(usable, self.PREFER) or self.FALLBACK
            light = self._pick(usable, self.PREFER[2:]) or main
            self._models = (main, light)
        except Exception:
            self._models = (self.FALLBACK, self.FALLBACK)
        return self._models

    @staticmethod
    def _pick(models: List[str], prefer: List[str]) -> Optional[str]:
        for pat in prefer:
            hits = []
            for m in models:
                g = re.match(pat, m)
                if g:
                    try: hits.append((float(g.group(1)), len(m), m))
                    except ValueError: pass
            if hits:
                hits.sort(key=lambda x: (-x[0], x[1]))
                return hits[0][2]
        return None

    def verify(self) -> Tuple[bool, str]:
        try:
            usable = self.list_models()
            if not usable: return False, "generateContent를 지원하는 모델이 없습니다."
            main, light = self.models()
            if self.pin and self.pin not in usable:
                return False, f'고정 모델 "{self.pin}" 사용 불가. 가능: {", ".join(usable[:8])}'
            return True, f'모델 {len(usable)}개 중 "{main}" (보조 "{light}") 선택'
        except Exception as e:
            return False, str(e)

    # ── 호출 ──
    def generate(self, stage: str, parts: List[dict], system: str,
                 schema: Optional[dict] = None, max_tokens: int = 32768,
                 thinking: Optional[int] = -1, light: bool = False) -> str:
        main, lite = self.models()
        model = lite if light else main
        cfg: Dict[str, Any] = {"temperature": 0.1, "maxOutputTokens": max_tokens}
        if schema:
            cfg["responseMimeType"] = "application/json"
            cfg["responseSchema"] = schema
        if thinking is not None:
            cfg["thinkingConfig"] = {"thinkingBudget": thinking}

        body = {"contents": [{"role": "user", "parts": parts}], "generationConfig": cfg,
                "safetySettings": [{"category": c, "threshold": "BLOCK_ONLY_HIGH"} for c in (
                    "HARM_CATEGORY_HARASSMENT", "HARM_CATEGORY_HATE_SPEECH",
                    "HARM_CATEGORY_SEXUALLY_EXPLICIT", "HARM_CATEGORY_DANGEROUS_CONTENT")]}
        if system: body["systemInstruction"] = {"parts": [{"text": system}]}

        t0 = time.time()
        data = self._post(model, body)
        if "error" in data and re.search("thinking", json.dumps(data["error"]), re.I):
            cfg.pop("thinkingConfig", None)
            data = self._post(model, body)
        if "error" in data:
            raise RuntimeError(f"[{stage}] Gemini 오류: {data['error'].get('message', data['error'])}")

        cand = (data.get("candidates") or [{}])[0]
        finish = cand.get("finishReason")
        if finish in ("SAFETY", "PROHIBITED_CONTENT", "BLOCKLIST"):
            raise RuntimeError(f"[{stage}] 안전 필터에 걸렸습니다({finish}). "
                               "개인정보가 많은 문서라면 해당 부분을 가리고 다시 시도해 주세요.")
        if finish == "MAX_TOKENS":
            raise RuntimeError(f"[{stage}] 응답이 최대 길이를 넘었습니다. 파일을 나눠 올려 주세요.")

        u = data.get("usageMetadata", {})
        self.usage["in"] += u.get("promptTokenCount", 0)
        self.usage["out"] += u.get("candidatesTokenCount", 0) + u.get("thoughtsTokenCount", 0)
        self.usage["calls"].append((stage, round(time.time() - t0, 1), model))

        text = "".join(p.get("text", "") for p in cand.get("content", {}).get("parts", [])).strip()
        if not text:
            raise RuntimeError(f"[{stage}] 빈 응답 (finishReason={finish})")
        return text

    def structured(self, stage: str, parts, system, schema, max_tokens=32768,
                   thinking=-1, light=False) -> dict:
        raw = self.generate(stage, parts, system, schema, max_tokens, thinking, light)
        raw = re.sub(r"^\s*```(?:json)?\s*|\s*```\s*$", "", raw)
        try:
            return json.loads(raw)
        except json.JSONDecodeError as e:
            raise RuntimeError(f"[{stage}] JSON 파싱 실패: {e}\n앞부분: {raw[:300]}")

    def _post(self, model: str, body: dict) -> dict:
        last = None
        for i in range(4):
            try:
                r = requests.post(f"{API}/models/{model}:generateContent",
                                  params={"key": self.key}, json=body, timeout=300)
                if r.status_code == 429 or r.status_code >= 500:
                    last = RuntimeError(self._err(r, "생성"))
                    time.sleep(2 ** i)
                    continue
                return r.json()
            except requests.RequestException as e:
                last = e
                time.sleep(2 ** i)
        raise last or RuntimeError("요청 실패")

    @staticmethod
    def _err(r, what: str) -> str:
        try: detail = r.json().get("error", {}).get("message", "")
        except Exception: detail = r.text[:200]
        if r.status_code == 400 and "API key not valid" in detail:
            return "Google API 키가 올바르지 않습니다. https://aistudio.google.com/apikey 에서 확인하세요."
        if r.status_code == 403:
            return f"권한 없음(403). Generative Language API가 켜져 있는지 확인하세요. {detail}"
        if r.status_code == 429:
            return f"요청 한도 초과(429). 잠시 후 다시 시도합니다. {detail}"
        return f"{what} 실패 (HTTP {r.status_code}) {detail}"


# ==============================================================================
#  3. 파일 수집 — 어떤 형식이든 텍스트로
# ==============================================================================

OCR_SYSTEM = """당신은 한국어/영어 혼용 문서 전용 판독 엔진이다.
1. 보이는 모든 글자를 **있는 그대로** 옮겨 적는다. 요약·의역·맞춤법 교정 금지.
2. 읽기 순서를 지킨다. 다단이면 왼쪽 단을 끝까지 읽고 오른쪽으로.
3. 표는 마크다운 표로. 체크박스는 [x] / [ ] 로.
4. 확신 없는 글자는 그 부분만 «불명» 으로 감싼다. 추측 금지.
5. 손글씨·도장·워터마크 안의 글자도 읽는다.
6. 숫자와 단위는 특히 정확하게. 0/O, 1/l/I, 5/S, 8/B 혼동 주의.
7. 글자가 하나도 없으면 정확히 "[[NO_TEXT]]" 만 출력한다.
8. 설명·머리말 없이 추출된 텍스트만 출력한다."""

STT_SYSTEM = """당신은 한국어 음성 받아쓰기 엔진이다.
1. 들리는 말을 그대로 받아 적는다. 요약·의역 금지.
2. 화자가 여럿이면 "화자1:", "화자2:" 로 구분한다.
3. 안 들리는 구간은 «불명» 으로 표시한다.
4. 말소리가 없으면 정확히 "[[NO_SPEECH]]" 만 출력한다."""

NATIVE_MIME = {  # Gemini가 직접 읽는 형식
    "pdf": "application/pdf",
    "png": "image/png", "jpg": "image/jpeg", "jpeg": "image/jpeg",
    "webp": "image/webp", "heic": "image/heic", "heif": "image/heif", "gif": "image/gif",
    "mp3": "audio/mp3", "m4a": "audio/mp4", "wav": "audio/wav",
    "flac": "audio/flac", "ogg": "audio/ogg", "aac": "audio/aac",
    "mp4": "video/mp4", "mov": "video/quicktime", "webm": "video/webm",
}
TEXT_EXT = {"txt", "md", "markdown", "csv", "tsv", "json", "jsonl", "yaml", "yml", "log",
            "srt", "vtt", "html", "htm", "xml", "rtf", "tex", "eml",
            "py", "js", "ts", "tsx", "jsx", "java", "go", "rb", "c", "cpp", "cs",
            "php", "kt", "swift", "rs", "sql", "sh", "css", "ipynb"}
MAX_INLINE = 18 * 1024 * 1024


def _ext(name: str) -> str:
    m = re.search(r"\.([A-Za-z0-9]+)$", name.strip())
    return m.group(1).lower() if m else ""


def _decode(b: bytes) -> str:
    for enc in ("utf-8", "cp949", "euc-kr", "utf-16"):
        try:
            s = b.decode(enc)
            if s.count("�") / max(1, len(s)) < 0.01: return s
        except (UnicodeDecodeError, LookupError):
            continue
    return b.decode("utf-8", errors="replace")


def _html_to_text(s: str) -> str:
    s = re.sub(r"<(script|style)[\s\S]*?</\1>", " ", s, flags=re.I)
    s = re.sub(r"<br\s*/?>|</(p|div|li|tr|h[1-6])>", "\n", s, flags=re.I)
    s = re.sub(r"<[^>]+>", " ", s)
    for a, b in [("&nbsp;", " "), ("&amp;", "&"), ("&lt;", "<"), ("&gt;", ">"), ("&quot;", '"')]:
        s = s.replace(a, b)
    return re.sub(r"\n{3,}", "\n\n", re.sub(r"[ \t]{2,}", " ", s)).strip()


def _office_text(name: str, data: bytes) -> Tuple[str, List[str]]:
    """docx / pptx / xlsx / hwpx — 라이브러리가 없으면 zip+xml로 직접 긁는다."""
    ext, warn = _ext(name), []
    try:
        if ext in ("docx", "doc"):
            docx = _pip("docx", "python-docx")
            if docx:
                d = docx.Document(io.BytesIO(data))
                paras = [p.text for p in d.paragraphs]
                for tb in d.tables:
                    for row in tb.rows:
                        paras.append(" | ".join(c.text.strip() for c in row.cells))
                return "\n".join(x for x in paras if x.strip()), warn
        if ext in ("pptx", "ppt"):
            pptx = _pip("pptx", "python-pptx")
            if pptx:
                pr = pptx.Presentation(io.BytesIO(data))
                out = []
                for i, s in enumerate(pr.slides, 1):
                    bits = [sh.text for sh in s.shapes if getattr(sh, "has_text_frame", False)]
                    note = ""
                    if s.has_notes_slide and s.notes_slide.notes_text_frame:
                        note = s.notes_slide.notes_text_frame.text
                    out.append(f"[슬라이드 {i}]\n" + "\n".join(b for b in bits if b.strip())
                               + (f"\n[발표자 노트]\n{note}" if note.strip() else ""))
                return "\n\n".join(out), warn
        if ext in ("xlsx", "xls", "xlsm"):
            ox = _pip("openpyxl")
            if ox:
                wb = ox.load_workbook(io.BytesIO(data), data_only=True)
                out = []
                for ws in wb.worksheets:
                    rows = []
                    for r in ws.iter_rows(values_only=True):
                        if any(c is not None for c in r):
                            rows.append(" | ".join("" if c is None else str(c) for c in r))
                        if len(rows) >= 400: break
                    out.append(f"[시트: {ws.title}]\n" + "\n".join(rows))
                return "\n\n".join(out), warn
    except Exception as e:
        warn.append(f"{name}: 전용 파서 실패({e}) → XML에서 직접 추출")

    # 폴백: OOXML/HWPX zip 안의 XML에서 텍스트만 긁어낸다
    try:
        with zipfile.ZipFile(io.BytesIO(data)) as z:
            names = [n for n in z.namelist()
                     if re.search(r"(word/document|ppt/slides/slide\d+|xl/sharedStrings|Contents/section\d+)\.xml$", n)]
            chunks = []
            for n in sorted(names):
                xml = z.read(n).decode("utf-8", errors="ignore")
                xml = re.sub(r"</(w:p|a:p|hp:p)>", "\n", xml)
                xml = re.sub(r"</(w:tc|a:tc|hp:tc)>", " | ", xml)
                chunks.append(re.sub(r"<[^>]+>", "", xml))
            txt = re.sub(r"\n{3,}", "\n\n", "\n".join(chunks)).strip()
            if txt: return txt, warn
    except Exception:
        pass
    warn.append(f"{name}: 본문을 읽지 못했습니다. PDF로 저장해 올리면 정확히 인식됩니다.")
    return "", warn


def ingest(g: Gemini, name: str, data: bytes, log=print) -> List[dict]:
    """파일 하나 → 문서 레코드(들). 압축이면 안쪽 파일마다 하나씩."""
    ext = _ext(name)
    warn: List[str] = []

    # 압축 → 재귀
    if ext == "zip" or (data[:4] == b"PK\x03\x04" and ext not in
                        ("docx", "pptx", "xlsx", "hwpx", "doc", "ppt", "xls")):
        try:
            with zipfile.ZipFile(io.BytesIO(data)) as z:
                inner = [n for n in z.namelist()
                         if not n.endswith("/") and "__MACOSX" not in n and not n.endswith(".DS_Store")]
                if inner and not any(n.startswith(("word/", "ppt/", "xl/")) for n in inner):
                    log(f"  [수집] 압축 해제: {name} ({len(inner)}개)")
                    docs = []
                    for n in inner[:20]:
                        docs += ingest(g, f"{name}/{n}", z.read(n), log)
                    return docs
        except zipfile.BadZipFile:
            pass

    # Gemini가 직접 읽는 형식 (PDF·이미지·오디오·영상)
    if ext in NATIVE_MIME:
        mime = NATIVE_MIME[ext]
        if len(data) > MAX_INLINE:
            return [_doc(name, ext, "", 0.1,
                         [f"{name}: {len(data)/1e6:.1f}MB로 너무 큽니다(18MB 이하). 잘라서 올려주세요."])]
        kind = "audio" if mime.startswith(("audio", "video")) else ("pdf" if ext == "pdf" else "image")
        log(f"  [{'받아쓰기' if kind == 'audio' else 'OCR/판독'}] {name}")
        system = STT_SYSTEM if kind == "audio" else OCR_SYSTEM
        try:
            text = g.generate("ocr", [
                {"inline_data": {"mime_type": mime, "data": base64.b64encode(data).decode()}},
                {"text": f"파일명: {name}. 위 규칙대로 처리하라."},
            ], system, thinking=0, light=True)
        except Exception as e:
            return [_doc(name, kind, "", 0.0, [f"{name}: 판독 실패 — {e}"])]
        if text.strip() in ("[[NO_TEXT]]", "[[NO_SPEECH]]"):
            return [_doc(name, kind, "", 0.2, [f"{name}: 읽을 수 있는 내용이 없습니다."])]
        unknown = text.count("«불명»")
        conf = max(0.35, 0.92 - unknown * 0.02)
        if conf < 0.6:
            warn.append(f"{name}: 판독 신뢰도가 낮습니다(«불명» {unknown}곳). 더 선명한 원본을 올리면 좋아집니다.")
        return [_doc(name, kind, text, conf, warn)]

    # 오피스/한글
    if ext in ("docx", "doc", "pptx", "ppt", "xlsx", "xls", "xlsm", "hwpx", "odt", "odp", "ods"):
        text, w = _office_text(name, data)
        return [_doc(name, ext, text, 1.0 if text else 0.1, w)]

    if ext == "hwp":
        return [_doc(name, "hwp", "", 0.1,
                     [f"{name}: 구형 HWP는 직접 읽지 못합니다. 한글에서 PDF로 저장해 올려주세요."])]

    # 텍스트 계열
    if ext in TEXT_EXT or not ext:
        s = _decode(data)
        if ext in ("html", "htm", "xml"): s = _html_to_text(s)
        elif ext in ("srt", "vtt"):
            s = "\n".join(l for l in s.splitlines()
                          if l.strip() and "-->" not in l and not l.strip().isdigit())
        elif ext in ("csv", "tsv"):
            delim = "\t" if ext == "tsv" else ","
            lines = [l for l in s.splitlines() if l.strip()][:400]
            if len(lines) > 1:
                head = lines[0].split(delim)
                body = ["  ".join(f"{h.strip()}: {c.strip()}"
                                  for h, c in zip(head, r.split(delim)) if c.strip())
                        for r in lines[1:]]
                s = f"[표: {name}] 열: {' | '.join(head)}\n" + "\n".join(body)
        elif ext == "ipynb":
            try:
                nb = json.loads(s)
                s = "\n\n".join(
                    ("".join(c.get("source", [])) if c.get("cell_type") == "markdown"
                     else "```\n" + "".join(c.get("source", [])) + "\n```")
                    for c in nb.get("cells", []))
            except Exception: pass
        return [_doc(name, "text", s, 1.0, warn)]

    return [_doc(name, "unknown", "", 0.1,
                 [f"{name}: 지원하지 않는 형식입니다. PDF·이미지·텍스트로 변환해 올려주세요."])]


def _doc(name, kind, text, conf, warn) -> dict:
    return {"sourceId": "", "name": name, "kind": kind,
            "text": (text or "").strip(), "confidence": conf, "warnings": warn or []}


# ==============================================================================
#  4. 에이전트 — ① 분류 → ② 배분 → ③ 감독 → ④ Fallback 안내
# ==============================================================================

def _catalog() -> str:
    out = []
    for c in CATEGORIES:
        ts = [f"  · {t['id']} — {t['label']}\n      동의어: {', '.join(t['aliases'])}"
              f"\n      신호: {', '.join(t['signals'])}"
              f"\n      전용 항목: {', '.join(f['label'] for f in t['fields'])}"
              for t in EXPERIENCE_TYPES if t["category"] == c["id"]]
        out.append(f"[{c['id']}] {c['emoji']} {c['label']}\n"
                   f"  대분류 신호: {', '.join(c['signals'])}\n" + "\n".join(ts))
    return "\n\n".join(out)


CLASSIFY_SYSTEM = """당신은 ARC 경험 기록 서비스의 **1단계 분류 에이전트**다.
사용자가 올린 산출물을 읽고 그것이 어떤 경험인지 판별한다.

작업 순서는 반드시 이 순서다.
  1) 먼저 **대분류**(학업 / 커리어 / 프로젝트 / 개인성장) 4개 중 하나를 고른다.
  2) 그 대분류 안의 **세부 유형**을 고른다.

── 판별 원칙 ──
1. **산출물의 형식이 아니라 활동의 성격**으로 판단한다.
   PDF라서 논문이 아니고, 코드라서 개인 프로젝트가 아니다. 누가·어디서·왜 한 일인지를 본다.
2. 경계는 이렇게 자른다.
   · 회사에서 급여를 받고 한 일 → career.work (팀 프로젝트처럼 보여도)
   · 학교 수업의 일부로 한 팀 과제 → academic.major_course (수업 기록 안에 담는다)
   · 수업/회사와 무관하게 스스로 만든 것 → project.personal / project.team
   · 대회에서 상을 받은 게 핵심이면 → career.award
   · 상을 못 받았거나 참가가 핵심이면 → career.external 또는 project.*
   · 학회·동아리는 소속 단체가 주체, 대외활동은 외부 기관이 주최
   · 결과물의 '완성도·작품성'이 핵심이면 project.creative
   · 배운 것/느낀 것이 핵심이고 산출물이 부차적이면 growth.*
3. 근거가 약하면 confidence를 정직하게 낮춘다.
4. 한 파일에 서로 다른 경험이 여러 개 섞여 있으면 multipleExperiences=true.
5. rationale은 한국어 2~3문장. 원문 표현을 인용해 근거를 밝힌다.

── 경험 유형 카탈로그 (18종) ──
""" + _catalog()

CLASSIFY_SCHEMA = {"type": "OBJECT", "properties": {
    "categoryId": {"type": "STRING", "description": "academic | career | project | growth"},
    "typeId": {"type": "STRING", "description": "카탈로그의 유형 id"},
    "confidence": {"type": "NUMBER", "description": "0~1. 근거가 약하면 낮출 것."},
    "rationale": {"type": "STRING", "description": "한국어 2~3문장. 원문 인용."},
    "alternatives": {"type": "ARRAY", "items": {"type": "OBJECT", "properties": {
        "typeId": {"type": "STRING"}, "confidence": {"type": "NUMBER"}, "reason": {"type": "STRING"}},
        "propertyOrdering": ["typeId", "confidence", "reason"]}},
    "multipleExperiences": {"type": "BOOLEAN"},
}, "propertyOrdering": ["categoryId", "typeId", "confidence", "rationale",
                        "alternatives", "multipleExperiences"]}


def classify(g: Gemini, docs: List[dict], hint: str = "") -> dict:
    listing = "\n".join(f"- {d['name']} ({d['kind']}, {len(d['text']):,}자, "
                        f"품질 {d['confidence']*100:.0f}%)" for d in docs)
    body = "\n\n".join(f"[{d['sourceId']} {d['name']}]\n{d['text'][:6000]}" for d in docs)
    parts = [{"text": f"[업로드된 파일]\n{listing}\n\n[본문 발췌]\n{body}"}]
    if hint: parts.append({"text": f"사용자가 준 추가 맥락: {hint}"})

    r = g.structured("classify", parts, CLASSIFY_SYSTEM, CLASSIFY_SCHEMA,
                     max_tokens=8000, thinking=-1)
    tid = r.get("typeId")
    if tid not in TYPE_BY_ID:                      # 모델이 이상한 id를 주면 라벨로 재매칭
        tid = next((t["id"] for t in EXPERIENCE_TYPES
                    if t["label"] in str(r.get("typeId", ""))), "project.personal")
        r["typeId"] = tid
    r["categoryId"] = TYPE_BY_ID[tid]["category"]
    r.setdefault("alternatives", [])
    r.setdefault("confidence", 0.5)
    return r


EXTRACT_RULES = """당신은 ARC 경험 기록 서비스의 **2단계 배분 에이전트**다.
확정된 경험 유형의 입력 항목에, 원문 내용을 요약해서 나눠 담는 것이 임무다.

── 절대 규칙 ──
1. **원문에 없는 사실을 만들지 않는다.** 이름·숫자·날짜·기관명·성과는 원문에 있는 것만.
   추정·보간 금지. 근거를 못 대면 그 항목은 null로 비운다.
2. **비우는 것이 틀리게 채우는 것보다 낫다.** 빈 항목은 뒤에서 사용자에게 되묻는다.
3. 채운 값마다 evidence에 근거를 남긴다. quote는 원문에서 **그대로 복사**한 문장이어야 한다.
   요약한 문장을 quote에 넣지 말 것.
4. **'나'와 '팀'을 구분한다.** 팀 전체가 한 일을 '내 역할'에 쓰지 않는다.
5. **한 항목에 몰아넣지 않는다.** 반복 입력이 있으면 원문의 건수만큼 항목을 만들어 쪼갠다.
   거꾸로 원문에 1건뿐인데 억지로 여러 건을 만들지 않는다.
6. 같은 내용을 여러 항목에 중복해서 넣지 않는다. 가장 적합한 한 곳에만.
7. 형식을 지킨다. 날짜는 YYYY-MM-DD, 선택 항목은 주어진 보기 중에서만, 없으면 null.
8. 서술형은 **원문의 사실을 유지하되 군더더기를 덜어낸 요약**으로. 과장·미화 금지. 한국어로.
9. '한 줄 요약'은 80자 내외 한 문장. '핵심 성과'는 원문에 있는 수치만 포함한다.
10. 파일 항목에는 업로드된 파일명을 그대로. 없으면 null.
11. 텍스트 품질이 낮은 문서에서만 나온 값은 confidence를 0.5 이하로. «불명» 주변 값은 신뢰하지 않는다.
12. unfilled에 비워 둔 항목을 **왜** 비웠는지와 함께 모두 적는다."""


def _outline(t) -> str:
    layout, _ = resolve_layout(t)
    def render(f, depth=0):
        pad = "  " * depth
        opt = f" 〔{'·'.join(f['options'])}〕" if f.get("options") else ""
        req = " (필수)" if f.get("req") else ""
        hint = f"  ※ {f['hint']}" if f.get("hint") else ""
        head = f"{pad}- {f['key']} | {f['label']} — {f['kind']}{opt}{req}{hint}"
        kids = "\n".join(render(c, depth + 2) for c in f.get("fields", []))
        return f"{head}\n{kids}" if kids else head
    return "\n\n".join(
        f"### {s['title']}{' (접힘)' if s['collapsed'] else ''}\n"
        + "\n".join(render(f) for f in s["fields"]) for s in layout)


def evidence_bundle(docs: List[dict], budget: int = 120_000) -> str:
    total = sum(len(d["text"]) for d in docs) or 1
    out = []
    for d in docs:
        share = len(d["text"]) if total <= budget else max(2000, int(len(d["text"]) / total * budget))
        body = d["text"] if len(d["text"]) <= share else (
            d["text"][:int(share * .62)] + "\n…(중략)…\n" + d["text"][-int(share * .35):])
        q = "높음" if d["confidence"] >= .85 else ("보통 (오독 가능)" if d["confidence"] >= .6
             else "낮음 (오독 주의 — 이 문서만 근거인 값은 신뢰도를 낮출 것)")
        w = f"\n[경고] {' / '.join(d['warnings'])}" if d["warnings"] else ""
        out.append(f"<<<파일 sourceId={d['sourceId']} 이름=\"{d['name']}\" "
                   f"형식={d['kind']} 텍스트품질={q}>>>{w}\n{body or '(텍스트 없음)'}\n"
                   f"<<<파일 끝 {d['sourceId']}>>>")
    return "\n\n".join(out)


def extract(g: Gemini, t: dict, docs: List[dict], hint: str = "", feedback: str = "") -> dict:
    fields = all_fields(t)
    system = (f"{EXTRACT_RULES}\n\n── 이번 경험 유형: {t['emoji']} {t['label']} ({t['id']}) ──\n"
              f"아래가 채워야 할 전체 항목이다. 화면 배치 순서 그대로다.\n\n{_outline(t)}\n\n"
              f"업로드된 파일명: {', '.join(d['name'] for d in docs)}")
    parts = [{"text": evidence_bundle(docs)}]
    if hint: parts.append({"text": f"사용자가 준 추가 맥락: {hint}"})
    if feedback: parts.append({"text": f"── 감독 에이전트의 재작업 지시 ──\n{feedback}"})

    r = g.structured("extract", parts, system, extraction_schema(fields),
                     max_tokens=32768, thinking=-1)

    values = coerce_values(r.get("values") or {}, fields)
    prov: Dict[str, dict] = {}
    for e in (r.get("evidence") or []):
        p = e.get("path")
        if not p: continue
        c = float(e.get("confidence") or 0.5)
        slot = prov.setdefault(p, {"path": p, "confidence": c, "quotes": []})
        slot["confidence"] = max(slot["confidence"], c)
        if e.get("quote"):
            slot["quotes"].append({"sourceId": e.get("sourceId", ""), "text": e["quote"]})

    unfilled = [{"path": u["path"], "label": label_for_path(t, u["path"]),
                 "reason": u.get("reason", "")} for u in (r.get("unfilled") or []) if u.get("path")]

    # 신뢰도 미달 값은 비운다 — "틀리게 채우느니 비운다"
    for p, fv in list(prov.items()):
        if fv["confidence"] < 0.4:
            try: set_path(values, p, None)
            except Exception: pass
            unfilled.append({"path": p, "label": label_for_path(t, p),
                             "reason": f"근거가 약해 비웠습니다 (신뢰도 {fv['confidence']*100:.0f}%)"})
            prov.pop(p)

    seen, dedup = set(), []
    for u in unfilled:
        if u["path"] in seen: continue
        seen.add(u["path"]); dedup.append(u)
    return {"values": values, "provenance": list(prov.values()), "unfilled": dedup}


SUPERVISE_SYSTEM = """당신은 ARC 경험 기록 서비스의 **3단계 감독(Supervisor) 에이전트**다.
앞 단계가 만든 결과를 **원문과 대조해 검수**한다. 당신은 작성자가 아니라 심사자다.
좋게 봐주지 말고, 틀린 것을 찾아내는 것이 임무다.

── 검수 항목 (이 순서로) ──
1. **유형 판별이 맞나** — 명백히 다른 유형이면 verdict="reclassify", reclassifyTo에 올바른 id.
   애매한 정도로는 재분류하지 않는다. 확실할 때만.
2. **환각** — 원문에 근거가 없는 이름·숫자·날짜·기관·성과가 들어갔는가.
   ※ 가장 중요하다. 하나라도 있으면 verdict는 최소 "revise". patch로 null 또는 근거 있는 값으로.
3. **주어 왜곡** — 팀이 한 일을 '내 역할'에 쓰지 않았는가.
4. **오배치** — 다른 항목에 들어가야 할 내용이 엉뚱한 칸에 있는가.
5. **요약 왜곡** — "참여했다"를 "주도했다"로, "시도했다"를 "달성했다"로 바꾼 것은 왜곡이다.
6. **중복** — 같은 내용이 두 항목 이상에 들어갔는가. 한 곳만 남긴다.
7. **분해 누락** — 반복 입력에 담아야 할 여러 건이 한 칸에 뭉쳐 있는가.
8. **과소 추출** — 원문에 분명히 있는데 비워 둔 항목. 근거가 있을 때만 채운다.
9. **형식** — 기계 검증기가 이미 찾은 것은 아래에 목록으로 준다.

── 판정 ──
· blocker(환각·필수 누락·유형 오류)가 있으면 "revise" 또는 "reclassify"
· patch로 다 고쳤으면 "approve"
· 점수는 0~100. 후하게 주지 말 것. 환각이 하나라도 있으면 faithfulness는 60 이하.

── patch 작성법 ──
· path는 값의 경로. 예: "myRole", "tasks[0].metrics", "period.start"
· valueJson은 넣을 값을 **JSON으로 인코딩한 문자열**. 예: "\\"백엔드 API 설계\\"", "null", "[\\"Python\\"]"
· 비워야 하면 valueJson을 "null"로. 고칠 게 없으면 patch는 빈 배열.
· comment는 한국어 3~5문장으로 무엇이 문제였고 무엇을 고쳤는지."""

SUPERVISE_SCHEMA = {"type": "OBJECT", "properties": {
    "verdict": {"type": "STRING", "description": "approve | revise | reclassify"},
    "scores": {"type": "OBJECT", "properties": {
        "classification": {"type": "NUMBER"}, "coverage": {"type": "NUMBER"},
        "faithfulness": {"type": "NUMBER"}, "formatting": {"type": "NUMBER"}},
        "propertyOrdering": ["classification", "coverage", "faithfulness", "formatting"]},
    "issues": {"type": "ARRAY", "items": {"type": "OBJECT", "properties": {
        "severity": {"type": "STRING", "description": "blocker | major | minor"},
        "type": {"type": "STRING",
                 "description": "hallucination | misplaced | format | summary_drift | duplication | missing_required | wrong_type"},
        "path": {"type": "STRING"},
        "detail": {"type": "STRING", "description": "한국어. 원문을 인용해 설명."}},
        "propertyOrdering": ["severity", "type", "path", "detail"]}},
    "reclassifyTo": {"type": "STRING", "nullable": True},
    "patch": {"type": "ARRAY", "items": {"type": "OBJECT", "properties": {
        "path": {"type": "STRING"}, "valueJson": {"type": "STRING"}, "note": {"type": "STRING"}},
        "propertyOrdering": ["path", "valueJson", "note"]}},
    "comment": {"type": "STRING"},
}, "propertyOrdering": ["verdict", "scores", "issues", "reclassifyTo", "patch", "comment"]}


def supervise(g: Gemini, t: dict, draft: dict, docs: List[dict], vissues: List[dict]) -> dict:
    field_list = "\n".join(
        f"- {f['key']} | {f['label']} — {f['kind']}"
        f"{' 〔' + '·'.join(f['options']) + '〕' if f.get('options') else ''}"
        f"{' (필수)' if f.get('req') else ''}" for f in all_fields(t))
    system = (f"{SUPERVISE_SYSTEM}\n\n── 검수 대상 유형: {t['emoji']} {t['label']} ({t['id']}) ──\n{field_list}")

    vrep = "\n".join(f"[{i['severity']}/{i['type']}] {i['path']} — {i['detail']}"
                     for i in vissues) or "(기계 검증기가 찾은 문제 없음)"
    prep = "\n".join(
        f"· {p['path']} (신뢰도 {p['confidence']*100:.0f}%) ← " +
        " / ".join(f"[{q['sourceId']}] \"{q['text'][:120]}\"" for q in p["quotes"])
        for p in draft["provenance"]) or "(근거 없음 — 이 자체가 문제다)"
    unf = "\n".join(f"· {u['label']} ({u['path']}) — {u['reason']}" for u in draft["unfilled"]) or "(없음)"

    r = g.structured("supervise", [
        {"text": f"## 원문 (근거)\n{evidence_bundle(docs)}"},
        {"text": "## 정리 결과 (검수 대상)\n```json\n"
                 + json.dumps(draft["values"], ensure_ascii=False, indent=2) + "\n```"},
        {"text": f"## 값별 근거\n{prep}"},
        {"text": f"## 비워 둔 항목\n{unf}"},
        {"text": f"## 기계 검증기 결과\n{vrep}"},
    ], system, SUPERVISE_SCHEMA, max_tokens=24000, thinking=-1)

    patch = {}
    for p in (r.get("patch") or []):
        if not p.get("path"): continue
        try: patch[p["path"]] = json.loads(p.get("valueJson", "null"))
        except json.JSONDecodeError: patch[p["path"]] = p.get("valueJson")

    return {"verdict": r.get("verdict", "approve"),
            "scores": r.get("scores") or {},
            "issues": vissues + [dict(i, foundBy="supervisor") for i in (r.get("issues") or [])],
            "reclassifyTo": r.get("reclassifyTo"),
            "patch": patch, "comment": r.get("comment", "")}


GUIDE_SYSTEM = """당신은 ARC 경험 기록 서비스의 **Fallback 안내 에이전트**다.
자동 정리 후 **비어 있는 항목**을 보고, 사용자가 무엇을 더 주면 채울 수 있는지 안내한다.

1. 사용자를 탓하지 않는다. "자료가 부족합니다"가 아니라 "○○을 알려주시면 △△칸이 채워집니다".
2. 각 항목마다 **구체적으로 무엇을** 주면 되는지 적는다.
   나쁜 예: "성과를 입력해주세요"
   좋은 예: "이 캠페인으로 팔로워가 몇 명 늘었는지 숫자로 알려주세요.
             주최 측 결과 리포트가 있으면 그 파일을 올려주셔도 됩니다."
3. question은 사용자에게 그대로 보여줄 **한 문장 질문**. 존댓말, 40자 내외.
4. priority — 필수 항목과 이 경험의 가치를 보여주는 항목(성과·내 역할·기간)은 high.
5. nextQuestions에는 **가장 효율적인 질문 3~5개**만. 하나의 답으로 여러 칸이 채워지는 질문을 우선.
6. recommendedUploads에는 이 유형에서 흔히 빈칸을 메워주는 파일 종류를 적는다.
7. 모든 출력은 한국어."""

GUIDE_SCHEMA = {"type": "OBJECT", "properties": {
    "missing": {"type": "ARRAY", "items": {"type": "OBJECT", "properties": {
        "path": {"type": "STRING"}, "why": {"type": "STRING"},
        "whatToProvide": {"type": "STRING"}, "question": {"type": "STRING"},
        "priority": {"type": "STRING", "description": "high | medium | low"}},
        "propertyOrdering": ["path", "why", "whatToProvide", "question", "priority"]}},
    "recommendedUploads": {"type": "ARRAY", "items": {"type": "STRING"}},
    "nextQuestions": {"type": "ARRAY", "items": {"type": "STRING"}},
}, "propertyOrdering": ["missing", "recommendedUploads", "nextQuestions"]}


def empty_paths(t: dict, values: dict) -> List[dict]:
    out = []
    def walk(fields, prefix=""):
        for f in fields:
            path = f"{prefix}.{f['key']}" if prefix else f["key"]
            v = get_path(values, path)
            if f["kind"] == "repeater":
                if _blank(v):
                    out.append({"path": path, "label": label_for_path(t, path),
                                "req": f.get("req", False), "kind": f["kind"]})
                elif isinstance(v, list):
                    for i in range(len(v)): walk(f.get("fields", []), f"{path}[{i}]")
                continue
            if _blank(v):
                out.append({"path": path, "label": label_for_path(t, path),
                            "req": f.get("req", False), "kind": f["kind"]})
    walk(all_fields(t))
    return out


def completeness(t: dict, values: dict) -> int:
    total = filled = 0
    for f in all_fields(t):
        w = 3 if f.get("req") else 1
        total += w
        if not _blank(get_path(values, f["key"])): filled += w
    return round(filled / total * 100) if total else 0


def build_guide(g: Gemini, t: dict, draft: dict, docs: List[dict], cls: dict) -> dict:
    empties = empty_paths(t, draft["values"])
    score = completeness(t, draft["values"])
    base = {"completeness": score, "missing": [], "recommendedUploads": [], "nextQuestions": []}

    if cls.get("confidence", 1) < 0.55:
        cands = [{"typeId": cls["typeId"], "label": TYPE_BY_ID[cls["typeId"]]["label"]}]
        for a in cls.get("alternatives", [])[:2]:
            if a.get("typeId") in TYPE_BY_ID:
                cands.append({"typeId": a["typeId"], "label": TYPE_BY_ID[a["typeId"]]["label"]})
        base["confirmType"] = {"candidates": cands,
                               "question": f"이 활동이 '{cands[0]['label']}'이 맞나요? 아니라면 골라주세요."}
    if not empties: return base

    reasons = {u["path"]: u["reason"] for u in draft["unfilled"]}
    listing = "\n".join(
        f"- {e['path']} | {e['label']} ({e['kind']}{', 필수' if e['req'] else ''})"
        + (f" ← 추출기 메모: {reasons[e['path']]}" if e["path"] in reasons else "")
        for e in empties)

    r = g.structured("guide", [
        {"text": "## 사용자가 올린 자료\n" + "\n".join(f"- {d['name']} ({d['kind']})" for d in docs)},
        {"text": f"## 지금까지 채워진 내용 (채움률 {score}%)\n```json\n"
                 + json.dumps(draft["values"], ensure_ascii=False, indent=2) + "\n```"},
        {"text": f"## 비어 있는 항목 ({len(empties)}개)\n{listing}"},
    ], f"{GUIDE_SYSTEM}\n\n── 대상 유형: {t['emoji']} {t['label']} ({t['id']}) ──",
       GUIDE_SCHEMA, max_tokens=12000, thinking=0, light=True)

    labels = {e["path"]: e["label"] for e in empties}
    rank = {"high": 2, "medium": 1, "low": 0}
    missing = [dict(m, label=labels.get(m.get("path"), label_for_path(t, m.get("path", ""))))
               for m in (r.get("missing") or []) if m.get("path")]
    missing.sort(key=lambda m: -rank.get(m.get("priority", "low"), 0))
    base.update({"missing": missing,
                 "recommendedUploads": r.get("recommendedUploads") or [],
                 "nextQuestions": (r.get("nextQuestions") or [])[:5]})
    return base


# ==============================================================================
#  5. 결정론적 검증기 — 감독에게 넘기기 전에 기계가 잡을 수 있는 건 기계가 잡는다
# ==============================================================================

DATE_RE = re.compile(r"^(19|20)\d{2}(-(0[1-9]|1[0-2])(-(0[1-9]|[12]\d|3[01]))?)?$")
URL_RE = re.compile(r"^(https?://|www\.)\S+$", re.I)
COMMON_LATIN = {"and", "the", "for", "with", "from", "team", "project", "data", "web", "app",
                "api", "ui", "ux", "pm", "qa", "ai", "ml", "it", "hr", "ceo", "cto", "kpi",
                "roi", "pdf", "png", "jpg", "url", "http", "https", "www", "com", "net", "org"}


def validate_structure(t: dict, values: dict) -> List[dict]:
    issues = []
    def add(sev, typ, path, detail):
        issues.append({"severity": sev, "type": typ, "path": path,
                       "detail": detail, "foundBy": "validator"})

    def walk(fields, obj, prefix=""):
        for f in fields:
            path = f"{prefix}.{f['key']}" if prefix else f["key"]
            v = obj.get(f["key"]) if isinstance(obj, dict) else None
            label = label_for_path(t, path)
            if f.get("req") and _blank(v):
                add("blocker", "missing_required", path, f"필수 항목 '{label}'이 비어 있습니다.")
                continue
            if _blank(v): continue
            k = f["kind"]
            if k == "date" and not DATE_RE.match(str(v).strip()):
                add("major", "format", path, f"'{label}'의 날짜 형식 오류: {v} (YYYY-MM-DD)")
            elif k == "daterange" and isinstance(v, dict):
                for key, ko in (("start", "시작"), ("end", "종료")):
                    if v.get(key) and not DATE_RE.match(str(v[key]).strip()):
                        add("major", "format", f"{path}.{key}", f"'{label}'의 {ko}일 형식 오류: {v[key]}")
                if v.get("start") and v.get("end") and str(v["start"]) > str(v["end"]):
                    add("major", "format", path, f"'{label}' 시작일이 종료일보다 뒤입니다 ({v['start']} > {v['end']}).")
                if v.get("ongoing") and v.get("end"):
                    add("minor", "format", path, f"'{label}'이 진행 중인데 종료일이 있습니다.")
            elif k == "select" and f.get("options") and str(v) not in f["options"]:
                add("major", "format", path,
                    f"'{label}'의 값 \"{v}\"은 보기에 없습니다. 보기: {', '.join(f['options'])}")
            elif k == "checklist" and f.get("options") and not f.get("free"):
                bad = [x for x in (v if isinstance(v, list) else []) if x not in f["options"]]
                if bad: add("major", "format", path, f"'{label}'에 보기에 없는 값: {', '.join(map(str, bad))}")
            elif k == "tags" and isinstance(v, list) and len(v) > 20:
                add("minor", "format", path, f"'{label}' 태그가 {len(v)}개로 과합니다.")
            elif k == "link" and not URL_RE.match(str(v).strip()):
                add("minor", "format", path, f"'{label}'이 URL 형식이 아닙니다: {v}")
            elif k == "text":
                if "\n" in str(v):
                    add("minor", "format", path, f"'{label}'은 한 줄 입력인데 줄바꿈이 있습니다.")
                if f["key"] in ("summary", "oneLiner") and len(str(v)) > 120:
                    add("minor", "format", path, f"'{label}'이 {len(str(v))}자로 깁니다. 80자 내외로.")
            elif k == "longtext" and len(str(v).strip()) < 5:
                add("minor", "format", path, f"'{label}'의 내용이 너무 짧습니다. 비우거나 제대로 채우세요.")
            elif k == "repeater" and isinstance(v, list):
                for i, row in enumerate(v): walk(f.get("fields", []), row, f"{path}[{i}]")
    walk(all_fields(t), values)
    return issues


def _nrm(s: str) -> str:
    s = str(s).replace("«불명»", "")
    return re.sub(r"[.,·:;'\"“”‘’()\[\]{}\-—_/\\|\s​]", "", s).lower()


def check_grounding(t: dict, values: dict, provenance: List[dict], docs: List[dict]) -> List[dict]:
    """환각 탐지 — 값 속 '검증 가능한 토큰'이 원문에 실제로 있는지 대조한다."""
    issues, seen = [], set()
    src = _nrm("\n".join(d["text"] for d in docs))
    names = [d["name"] for d in docs]

    def add(sev, path, detail):
        k = (path, detail)
        if k in seen: return
        seen.add(k)
        issues.append({"severity": sev, "type": "hallucination", "path": path,
                       "detail": detail, "foundBy": "validator"})

    # 1) 근거 문장이 실제 원문에 있는가
    for p in provenance:
        for q in p["quotes"]:
            nq = _nrm(q["text"])
            if len(nq) >= 8 and nq not in src:
                add("blocker", p["path"],
                    f"'{label_for_path(t, p['path'])}'의 근거 문장이 원문에 없습니다: \"{q['text'][:60]}…\"")

    prov_paths = [p["path"] for p in provenance]
    # 2) 값 속 숫자·영문 고유명사가 원문에 있는가
    for path in leaf_paths(values):
        v = get_path(values, path)
        if not isinstance(v, str) or not v.strip(): continue
        key = re.sub(r"\[\d+\]$", "", path.split(".")[-1])
        if re.search(r"evidence|certificate|file|transcript|screenshot|submission|artifact|attachment",
                     key, re.I):
            if not any(n in v or v in n for n in names):
                add("major", path, f"'{label_for_path(t, path)}'의 파일명 \"{v}\"이 업로드 목록에 없습니다. "
                                   f"업로드: {', '.join(names)}")
            continue
        for raw in re.findall(r"\d[\d,.]*%?", v):
            if len(_nrm(raw)) >= 2 and _nrm(raw) not in src:
                add("major", path, f"'{label_for_path(t, path)}'의 수치 \"{raw}\"가 원문에서 확인되지 않습니다.")
        for tok in re.findall(r"[A-Za-z][A-Za-z0-9+#.]{2,}", v):
            if tok.lower() in COMMON_LATIN: continue
            if _nrm(tok) not in src:
                add("minor", path, f"'{label_for_path(t, path)}'의 \"{tok}\"이 원문에서 확인되지 않습니다.")
        if len(v.strip()) > 25 and not any(path.startswith(p) or p.startswith(path) for p in prov_paths):
            add("minor", path, f"'{label_for_path(t, path)}'에 근거(quote)가 붙어 있지 않습니다.")
    return issues


# ==============================================================================
#  6. 파이프라인
# ==============================================================================

MAX_ROUNDS = 2


def organize(api_key: str, files: List[Tuple[str, bytes]], hint: str = "",
             force_type: str = "", model_pin: str = "", log=print) -> dict:
    g = Gemini(api_key, model_pin)
    main, light = g.models()
    log(f"  [엔진] gemini — 주 모델 {main} / 보조 {light}")

    # ── 0. 수집 ──
    docs: List[dict] = []
    for name, data in files:
        docs += ingest(g, name, data, log)
    for i, d in enumerate(docs, 1):
        d["sourceId"] = f"src{i}"
    if not any(d["text"].strip() for d in docs):
        raise RuntimeError("업로드한 파일에서 텍스트를 하나도 얻지 못했습니다. "
                           "이미지라면 더 선명한 사진을, 문서라면 PDF로 변환해 올려주세요.")
    log(f"  [수집] 문서 {len(docs)}개 / {sum(len(d['text']) for d in docs):,}자")

    # ── 1. 분류 ──
    if force_type and force_type in TYPE_BY_ID:
        cls = {"categoryId": TYPE_BY_ID[force_type]["category"], "typeId": force_type,
               "confidence": 1.0, "rationale": "사용자가 유형을 직접 지정했습니다.",
               "alternatives": [], "multipleExperiences": False}
    else:
        log("  [분류] 경험 유형 판별 중…")
        cls = classify(g, docs, hint)
    t = TYPE_BY_ID[cls["typeId"]]
    log(f"  [분류] {CAT_BY_ID[t['category']]['label']} › {t['label']} "
        f"(신뢰도 {cls['confidence']*100:.0f}%)")

    # ── 2~3. 배분 ↔ 감독 루프 ──
    draft, feedback, history, final, rounds = None, "", [], None, 0
    for rnd in range(MAX_ROUNDS + 1):
        rounds = rnd + 1
        if draft is None or feedback:
            log(f"  [배분] 항목별 배분 중… ({rnd + 1}회차)" if rnd else "  [배분] 항목별 배분 중…")
            draft = extract(g, t, docs, hint, feedback)
            feedback = ""

        vissues = validate_structure(t, draft["values"]) + \
                  check_grounding(t, draft["values"], draft["provenance"], docs)
        log(f"  [검증] 기계 검증기 {len(vissues)}건 발견")

        log(f"  [감독] 검수 중… ({rnd + 1}회차)")
        review = supervise(g, t, draft, docs, vissues)
        history.append(review); final = review
        sc = review.get("scores", {})
        log(f"  [감독] {review['verdict']} — 충실도 {sc.get('faithfulness', '?')}점, "
            f"이슈 {len(review['issues'])}건")

        if (review["verdict"] == "reclassify" and review.get("reclassifyTo") in TYPE_BY_ID
                and review["reclassifyTo"] != t["id"] and rnd < MAX_ROUNDS):
            nxt = TYPE_BY_ID[review["reclassifyTo"]]
            log(f"  [분류] 감독이 유형 정정: {t['label']} → {nxt['label']}")
            cls = dict(cls, typeId=nxt["id"], categoryId=nxt["category"],
                       rationale=cls["rationale"] + f"\n[감독 정정] {review['comment']}",
                       alternatives=[{"typeId": t["id"], "confidence": cls["confidence"],
                                      "reason": "최초 분류"}] + cls.get("alternatives", []))
            t, draft, feedback = nxt, None, ""
            continue

        if review["patch"]:
            for p, v in review["patch"].items():
                try: set_path(draft["values"], p, v)
                except Exception: pass
            cleared = {p for p, v in review["patch"].items() if v in (None, "", [])}
            draft["provenance"] = [x for x in draft["provenance"] if x["path"] not in cleared]
            log(f"  [감독] 수정 {len(review['patch'])}건 적용")

        if review["verdict"] == "approve" or rnd >= MAX_ROUNDS: break
        remaining = [i for i in review["issues"]
                     if i.get("severity") == "blocker" and i.get("path") not in review["patch"]]
        if not remaining: break
        feedback = ("이전 회차 결과에서 아래 문제가 발견됐다. 원문을 다시 읽고 정확히 다시 작성하라.\n"
                    + "\n".join(f"· [{i.get('type')}] {i.get('path')} — {i.get('detail')}"
                                for i in remaining)
                    + f"\n\n감독 총평: {review['comment']}")

    # 패치 적용 뒤 형식 재검증
    final["issues"] = final["issues"] + validate_structure(t, draft["values"])

    # ── 4. Fallback 안내 ──
    log("  [안내] 빈 항목 안내 생성 중…")
    fallback = build_guide(g, t, draft, docs, cls)

    layout, hidden = resolve_layout(t)
    log(f"  [완료] 채움률 {fallback['completeness']}% / "
        f"남은 이슈 {len([i for i in final['issues'] if i.get('severity') != 'minor'])}건")

    return {"category": CAT_BY_ID[t["category"]], "type": t, "classification": cls,
            "values": draft["values"], "layout": layout, "hiddenCommonKeys": hidden,
            "provenance": draft["provenance"], "unfilled": draft["unfilled"],
            "review": {"rounds": rounds, "final": final, "history": history},
            "fallback": fallback, "docs": docs,
            "usage": {**g.usage,
                      "cost": g.usage["in"] / 1e6 * 1.25 + g.usage["out"] / 1e6 * 10.0}}


# ==============================================================================
#  7. 프론트 바인딩 형태 + 화면 렌더
# ==============================================================================

def to_form_state(r: dict) -> dict:
    """프론트엔드가 그대로 쓰는 형태 (TS판 toFormState와 동일한 계약)."""
    t = r["type"]
    prov = {p["path"]: p for p in r["provenance"]}
    guide = {m["path"]: m for m in r["fallback"].get("missing", [])}
    fname = {d["sourceId"]: d["name"] for d in r["docs"]}

    def build(f, path, section, zone, collapsed):
        v = get_path(r["values"], path)
        p = prov.get(path)
        out = {"key": f["key"], "label": f["label"], "kind": f["kind"],
               "section": section, "zone": zone, "collapsed": collapsed,
               "required": f.get("req", False), "value": v, "filled": not _blank(v),
               "confidence": p["confidence"] if p else None,
               "evidence": [{"sourceId": q["sourceId"], "fileName": fname.get(q["sourceId"], q["sourceId"]),
                             "text": q["text"]} for q in (p["quotes"] if p else [])]}
        if f.get("options"): out["options"] = f["options"]
        if f.get("free"): out["freeOptions"] = True
        if path in guide:
            gd = guide[path]
            out["guide"] = {"question": gd.get("question", ""),
                            "whatToProvide": gd.get("whatToProvide", ""),
                            "priority": gd.get("priority", "low")}
        if f["kind"] == "repeater":
            out["itemFields"] = [dict(build(s, f"{path}[0].{s['key']}", section, zone, collapsed),
                                      value=None, filled=False, confidence=None, evidence=[])
                                 for s in f.get("fields", [])]
        return out

    sections = [{"title": s["title"], "zone": s["zone"], "collapsed": s["collapsed"],
                 "fields": [build(f, f["key"], s["title"], s["zone"], s["collapsed"])
                            for f in s["fields"]]} for s in r["layout"]]
    fin = r["review"]["final"]
    return {"categoryId": r["category"]["id"], "categoryLabel": r["category"]["label"],
            "typeId": t["id"], "typeLabel": t["label"],
            "typeConfidence": r["classification"].get("confidence", 0),
            "typeRationale": r["classification"].get("rationale", ""),
            "confirmType": r["fallback"].get("confirmType"),
            "values": r["values"], "sections": sections,
            "fields": [f for s in sections for f in s["fields"]],
            "completeness": r["fallback"]["completeness"],
            "questions": r["fallback"].get("nextQuestions", []),
            "recommendedUploads": r["fallback"].get("recommendedUploads", []),
            "warnings": [f"{d['name']}: {w}" for d in r["docs"] for w in d["warnings"]],
            "review": {"verdict": fin["verdict"],
                       "faithfulness": fin.get("scores", {}).get("faithfulness", 0),
                       "attentionFields": [
                           {"label": label_for_path(t, i.get("path", "")), "detail": i.get("detail", "")}
                           for i in fin["issues"] if i.get("severity") != "minor"][:8]},
            "hiddenCommonKeys": r["hiddenCommonKeys"],
            "meta": {"files": [{"name": d["name"], "kind": d["kind"], "chars": len(d["text"]),
                                "confidence": d["confidence"]} for d in r["docs"]],
                     "estimatedCostUsd": r["usage"]["cost"]}}


def _esc(s) -> str:
    return (str(s).replace("&", "&amp;").replace("<", "&lt;")
            .replace(">", "&gt;").replace('"', "&quot;"))


def _fmt(v, kind) -> str:
    if _blank(v): return ""
    if kind == "daterange" and isinstance(v, dict):
        end = "진행 중" if v.get("ongoing") else (v.get("end") or "?")
        return f"{v.get('start') or '?'} ~ {end}"
    if isinstance(v, list):
        if all(isinstance(x, str) for x in v): return ", ".join(v)
        rows = []
        for i, row in enumerate(v, 1):
            cells = " · ".join(f"<b>{_esc(k)}</b> {_esc(x)}"
                               for k, x in row.items() if not _blank(x))
            rows.append(f"<div class='r'><span class='n'>{i}</span>{cells}</div>")
        return "".join(rows)
    return _esc(v).replace("\n", "<br>")


def render_html(form: dict) -> str:
    """Colab 출력창에 실제 폼처럼 보여준다 (프론트가 받는 데이터 그대로 그린 것)."""
    css = """<style>
    .arc{font-family:-apple-system,BlinkMacSystemFont,'Apple SD Gothic Neo','Malgun Gothic',sans-serif;
         max-width:860px;color:#1f2024;line-height:1.6}
    .arc .hd{display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin-bottom:10px}
    .arc .b{background:#f0f0ee;border-radius:99px;padding:4px 11px;font-size:12.5px}
    .arc .b.t{background:#e5edff;color:#2f6df6;font-weight:700}
    .arc .b.ok{color:#1a8a54}.arc .b.w{color:#b4690e}
    .arc .bar{height:6px;background:#eee;border-radius:9px;overflow:hidden;margin:8px 0 18px}
    .arc .bar i{display:block;height:100%;background:#2f6df6}
    .arc section{border:1px solid #e5e5e3;border-radius:11px;padding:14px 16px;margin-bottom:11px;background:#fff}
    .arc h3{font-size:13px;margin:0 0 11px;color:#444;letter-spacing:-.01em}
    .arc .f{margin-bottom:11px}
    .arc .lb{font-size:12px;color:#6b6f76;margin-bottom:3px}
    .arc .lb .a{background:#e3f5eb;color:#1a8a54;border-radius:4px;padding:0 5px;font-size:10.5px;margin-left:5px}
    .arc .lb .s{color:#9a9ea6;font-size:10.5px;margin-left:5px;border-bottom:1px dotted #bbb;cursor:help}
    .arc .lb .rq{color:#d1453b;margin-left:2px}
    .arc .v{border:1px solid #e5e5e3;border-radius:7px;padding:7px 10px;background:#fbfbfa;font-size:14px}
    .arc .v.e{border-style:dashed;color:#b4690e;background:#fffdf7;font-size:12.5px}
    .arc .r{border:1px solid #eee;border-radius:6px;padding:6px 9px;margin:4px 0;background:#fff;font-size:13px}
    .arc .r .n{display:inline-block;min-width:18px;color:#9a9ea6;font-size:11px}
    .arc .ask{background:#f5f8ff;border-color:#cfe0ff}
    .arc .warn{border-color:#f0dcb4;background:#fffdf7}
    .arc .mut{color:#6b6f76;font-size:12.5px}
    .arc ol{margin:0;padding-left:20px}</style>"""

    v = form["review"]["verdict"]
    h = [css, "<div class='arc'>", "<div class='hd'>",
         f"<span class='b t'>{_esc(form['categoryLabel'])} › {_esc(form['typeLabel'])}</span>",
         f"<span class='b'>유형 신뢰도 {form['typeConfidence']*100:.0f}%</span>",
         f"<span class='b {'ok' if v == 'approve' else 'w'}'>검수 {'통과' if v == 'approve' else '수정됨'} "
         f"· 충실도 {form['review']['faithfulness']}</span>",
         f"<span class='b'>채움률 {form['completeness']}%</span>", "</div>",
         f"<p class='mut'>{_esc(form['typeRationale'])}</p>",
         f"<div class='bar'><i style='width:{form['completeness']}%'></i></div>"]

    if form.get("confirmType"):
        cands = " / ".join(_esc(c["label"]) for c in form["confirmType"]["candidates"])
        h.append(f"<section class='ask'><h3>유형 확인이 필요합니다</h3>"
                 f"<p>{_esc(form['confirmType']['question'])}</p><p class='mut'>후보: {cands}</p></section>")

    if form["review"]["attentionFields"]:
        h.append("<section class='warn'><h3>확인해 보세요</h3>" + "".join(
            f"<p class='mut'>· <b>{_esc(a['label'])}</b> — {_esc(a['detail'])}</p>"
            for a in form["review"]["attentionFields"]) + "</section>")

    for s in form["sections"]:
        rows = []
        for f in s["fields"]:
            lb = f"<div class='lb'>{_esc(f['label'])}"
            if f.get("required"): lb += "<span class='rq'>*</span>"
            if f["filled"]: lb += "<span class='a'>자동</span>"
            if f["evidence"]:
                tip = _esc(" / ".join(f"[{e['fileName']}] {e['text']}" for e in f["evidence"])[:400])
                lb += f"<span class='s' title=\"{tip}\">출처 {len(f['evidence'])}</span>"
            lb += "</div>"
            if f["filled"]:
                body = f"<div class='v'>{_fmt(f['value'], f['kind'])}</div>"
            else:
                gd = f.get("guide") or {}
                msg = gd.get("whatToProvide") or gd.get("question") or "비어 있음"
                body = f"<div class='v e'>{_esc(msg)}</div>"
            rows.append(f"<div class='f'>{lb}{body}</div>")
        title = s["title"] + (" (기본 접힘)" if s["collapsed"] else "")
        h.append(f"<section><h3>{_esc(title)}</h3>{''.join(rows)}</section>")

    if form["questions"]:
        h.append("<section class='ask'><h3>이것만 알려주시면 더 채워집니다</h3><ol>"
                 + "".join(f"<li>{_esc(q)}</li>" for q in form["questions"]) + "</ol>"
                 + (f"<p class='mut'>추가로 올리면 좋은 자료: "
                    f"{_esc(', '.join(form['recommendedUploads']))}</p>"
                    if form["recommendedUploads"] else "") + "</section>")

    if form["warnings"]:
        h.append("<section class='warn'><h3>파일 처리 안내</h3>"
                 + "".join(f"<p class='mut'>· {_esc(w)}</p>" for w in form["warnings"]) + "</section>")

    files = "".join(f"<p class='mut'>· {_esc(f['name'])} ({f['kind']}, {f['chars']:,}자, "
                    f"품질 {f['confidence']*100:.0f}%)</p>" for f in form["meta"]["files"])
    h.append(f"<section><h3>처리 정보</h3>{files}"
             f"<p class='mut'>추정 비용 ${form['meta']['estimatedCostUsd']:.4f}</p></section>")
    h.append("</div>")
    return "".join(h)


def show(form: dict):
    try:
        from IPython.display import HTML, display
        display(HTML(render_html(form)))
    except ImportError:
        print(json.dumps(form["values"], ensure_ascii=False, indent=2))


# ==============================================================================
#  8. 실행
# ==============================================================================

SAMPLE_NAME = "샘플_하계인턴십_최종보고서.md"
SAMPLE = """# 하계 인턴십 최종 보고서

- 회사: 주식회사 라온테크
- 소속: 플랫폼개발팀
- 기간: 2024.06.24 ~ 2024.08.30
- 직무: 백엔드 엔지니어링 인턴
- 근무 형태: 주 3일 출근 / 2일 재택

## 1. 지원 동기
대규모 트래픽을 다루는 서비스의 백엔드 구조를 실제로 보고 싶어 지원했습니다.

## 2. 수행 업무

### 2-1. 주문 조회 API 응답 개선 (6/24 ~ 7/19)
- 역할: 단독 담당 (멘토 코드리뷰)
- 기존 주문 조회 API가 N+1 쿼리로 평균 응답 820ms가 나오고 있었습니다.
- JPA fetch join과 Redis 캐시를 적용해 평균 210ms로 줄였습니다.
- 활용 툴: Spring Boot, JPA, Redis, Grafana
- 이슈: 캐시 무효화 시점을 놓쳐 재고 수량이 잠깐 어긋난 적이 있었고,
  주문 이벤트 발행 시점에 캐시를 evict 하도록 바꿔 해결했습니다.

### 2-2. 사내 배치 모니터링 대시보드 (7/22 ~ 8/23)
- 역할: 팀원 2명과 공동 작업, 저는 백엔드 집계 API를 맡았습니다.
- 실패한 배치 잡을 슬랙으로 알림 보내는 기능까지 붙였습니다.
- 도입 후 배치 실패 인지 시간이 평균 40분에서 5분 이내로 줄었습니다.

## 3. 배운 점
성능 문제는 추측이 아니라 측정에서 시작해야 한다는 걸 체감했습니다.

## 4. 종료
인턴 기간 만료로 8월 30일자 종료되었습니다.
"""


def self_test() -> bool:
    """API 키 없이 도는 무결성 검사. 코드가 온전한지 먼저 확인한다."""
    ok, fail = 0, []
    def chk(name, cond):
        nonlocal ok
        if cond: ok += 1
        else: fail.append(name)

    chk("경험 유형 18종", len(EXPERIENCE_TYPES) == 18)
    chk("대분류 4종", len(CATEGORIES) == 4)
    chk("유형 id 중복 없음", len({t["id"] for t in EXPERIENCE_TYPES}) == 18)
    chk("id 접두사 = 대분류", all(t["id"].split(".")[0] == t["category"] for t in EXPERIENCE_TYPES))
    common = {f["key"] for f in BASE_FIELDS + EXTENDED_FIELDS}
    chk("supersedes가 실재 공통항목만 가리킴",
        all(k in common for t in EXPERIENCE_TYPES for k in superseded_keys(t)))
    chk("select에 보기 있음", all(f.get("options") for t in EXPERIENCE_TYPES
                                  for f in t["fields"] if f["kind"] == "select"))
    chk("repeater에 하위칸 있음", all(f.get("fields") for t in EXPERIENCE_TYPES
                                      for f in t["fields"] if f["kind"] == "repeater"))
    chk("18종 전부 레이아웃 전개", all(len(resolve_layout(t)[0]) >= 3 for t in EXPERIENCE_TYPES))

    def walk_schema(n, where):
        assert n["type"] in ("STRING", "NUMBER", "INTEGER", "BOOLEAN", "ARRAY", "OBJECT"), where
        assert "additionalProperties" not in n, where
        for k, v in (n.get("properties") or {}).items(): walk_schema(v, f"{where}.{k}")
        if n.get("items"): walk_schema(n["items"], where + "[]")
    try:
        for t in EXPERIENCE_TYPES: walk_schema(extraction_schema(all_fields(t)), t["id"])
        chk("Gemini 스키마 변환 무결", True)
    except AssertionError as e:
        chk(f"Gemini 스키마 변환 무결 ({e})", False)

    work = TYPE_BY_ID["career.work"]
    chk("경로→라벨", label_for_path(work, "tasks[0].metrics") == "업무내용 > 성과 지표")
    o: dict = {}
    set_path(o, "tasks[1].name", "리팩터링"); set_path(o, "period.start", "2024-03-01")
    chk("경로 읽기/쓰기", get_path(o, "tasks[1].name") == "리팩터링"
        and get_path(o, "period.start") == "2024-03-01")

    iss = validate_structure(work, {
        "companyName": None,
        "employmentPeriod": {"start": "2024-08-01", "end": "2024-03-01", "ongoing": False},
        "employmentType": "알바", "position": "인턴", "jobFunction": "백엔드"})
    kinds = {f"{i['type']}:{i['path']}" for i in iss}
    chk("필수누락 탐지", "missing_required:companyName" in kinds)
    chk("날짜 역전 탐지", "format:employmentPeriod" in kinds)
    chk("보기 위반 탐지", "format:employmentType" in kinds)

    award = TYPE_BY_ID["career.award"]
    docs = [{"sourceId": "src1", "name": "상장.png", "kind": "image",
             "text": "제12회 교내 창업 경진대회 최우수상 수상. 주최: 창업지원단",
             "confidence": .9, "warnings": []}]
    gi = check_grounding(award, {"awardName": "최우수상", "keyAchievement": "참가팀 250팀 중 1위"},
                         [{"path": "awardName", "confidence": .9,
                           "quotes": [{"sourceId": "src1", "text": "최우수상 수상"}]}], docs)
    chk("환각(없는 수치) 탐지", any("250" in i["detail"] for i in gi))
    gi2 = check_grounding(award, {"awardName": "최우수상"},
                          [{"path": "awardName", "confidence": .9,
                            "quotes": [{"sourceId": "src1", "text": "전국 대회에서 대상을 받았습니다"}]}], docs)
    chk("환각(근거 위조) 탐지", any(i["severity"] == "blocker" for i in gi2))

    cv = coerce_values({"employmentType": "인턴십", "companyName": "라온테크",
                        "salary": "해당 없음", "tasks": []}, all_fields(work))
    chk("보기 밖 값 정규화", cv["employmentType"] == "인턴")
    chk("가짜 null 정리", cv["salary"] is None and cv["tasks"] is None)
    chk("누락 키 채움", "position" in cv and cv["position"] is None)

    chk("모델 자동 선택", Gemini._pick(
        ["gemini-2.5-flash", "gemini-2.5-pro", "gemini-3-pro", "embedding-001"],
        Gemini.PREFER) == "gemini-3-pro")

    print(f"  자체 점검: {ok}개 통과" + (f" / 실패 {len(fail)}개 → {fail}" if fail else ""))
    return not fail


def run(files: Optional[List[Tuple[str, bytes]]] = None, hint: str = "",
        force_type: str = "", show_json: bool = False) -> dict:
    """정리 실행. files=[(파일명, bytes), ...]. 비우면 샘플 문서를 씁니다."""
    if not files:
        files = [(SAMPLE_NAME, SAMPLE.encode("utf-8"))]
        print(f"  (업로드가 없어 샘플 문서로 실행합니다: {SAMPLE_NAME})")
    t0 = time.time()
    r = organize(GOOGLE_API_KEY, files, hint=hint, force_type=force_type, model_pin=GEMINI_MODEL)
    form = to_form_state(r)
    print(f"  소요 {time.time() - t0:.1f}초 · 추정 비용 ${r['usage']['cost']:.4f}\n")
    show(form)
    if show_json:
        print("\n── 프론트엔드로 넘어가는 값(form.values) ──")
        print(json.dumps(form["values"], ensure_ascii=False, indent=2))
    r["form"] = form
    return r


def _upload() -> List[Tuple[str, bytes]]:
    try:
        from google.colab import files as colab_files  # type: ignore
    except ImportError:
        return []
    print("정리할 파일을 선택하세요. (건너뛰려면 '취소')")
    try:
        up = colab_files.upload()
    except Exception:
        return []
    return [(n, b) for n, b in up.items()]


if __name__ == "__main__":
    print("=" * 66)
    print("  ARC 경험 자동 정리 — 테스트")
    print("=" * 66)
    self_test()

    if not GOOGLE_API_KEY.strip():
        print("""
  ⚠ Google API 키가 비어 있습니다.
    1) https://aistudio.google.com/apikey 에서 키 발급 (무료)
    2) 이 셀 맨 위 GOOGLE_API_KEY = "" 안에 붙여넣기
    3) 다시 실행

  키 없이도 위 '자체 점검'은 통과해야 정상입니다(스키마·검증기 무결성 확인).
""")
    else:
        ok, detail = Gemini(GOOGLE_API_KEY, GEMINI_MODEL).verify()
        print(f"  키 확인: {'정상' if ok else '오류'} — {detail}\n")
        if ok:
            RESULT = run(_upload(), hint="")
            print("\n  다시 돌리려면:  run(_upload(), hint='활동 설명')")
            print("  샘플로 돌리려면: run()")
            print("  유형 고정:      run(_upload(), force_type='career.work')")
            print("  전체 결과:      RESULT  /  폼 데이터: RESULT['form']")
