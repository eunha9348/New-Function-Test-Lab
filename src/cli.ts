#!/usr/bin/env node
import { promises as fs } from "node:fs";
import { createSession } from "./llm/index.js";
import { toFormState } from "./form.js";
import { organizeExperience } from "./pipeline.js";
import { readInputFiles } from "./read-files.js";
import { EXPERIENCE_TYPES } from "./schema/index.js";
import type { OrganizeResult, ProgressEvent } from "./types.js";
import { isEmptyValue } from "./util/path.js";

const HELP = `ARC 경험 자동 정리

사용법:
  npm run organize -- <파일...> [옵션]

옵션:
  --out <경로>        결과 JSON 저장 경로
  --hint "<설명>"     활동에 대한 추가 설명
  --type <유형id>     유형을 직접 지정 (분류 단계 생략)
  --list-types        18종 유형 목록 출력
  --json              사람이 읽는 요약 대신 전체 JSON 출력
  --form              프론트엔드 바인딩용 FormState JSON만 출력
  --check             API 키와 선택된 모델만 확인하고 종료
  --quality <모드>    fast | balanced(기본) | best
                      fast=앙상블 1회·전부 값싼 모델, best=배분도 상위 모델

예시:
  npm run organize -- ./인턴_최종보고서.pdf ./상장.jpg --hint "작년 여름 인턴"
`;

function parseArgs(argv: string[]) {
  const files: string[] = [];
  const opts: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--out" || a === "--hint" || a === "--type" || a === "--quality") {
      opts[a.slice(2)] = argv[++i] ?? "";
    }
    else if (a.startsWith("--")) opts[a.slice(2)] = true;
    else files.push(a);
  }
  return { files, opts };
}

function fmtValue(v: unknown, indent = ""): string {
  if (isEmptyValue(v)) return "—";
  if (Array.isArray(v)) {
    if (v.every((x) => typeof x === "string")) return v.join(", ");
    return (
      "\n" +
      v
        .map((row, i) =>
          `${indent}  [${i + 1}] ` +
          Object.entries(row as Record<string, unknown>)
            .filter(([, val]) => !isEmptyValue(val))
            .map(([k, val]) => `${k}=${fmtValue(val, indent + "    ")}`)
            .join("\n" + indent + "      "),
        )
        .join("\n")
    );
  }
  if (typeof v === "object") {
    const o = v as Record<string, unknown>;
    if ("start" in o) return `${o.start ?? "?"} ~ ${o.ongoing ? "진행 중" : (o.end ?? "?")}`;
    return JSON.stringify(o);
  }
  return String(v).replace(/\n/g, `\n${indent}    `);
}

function printSummary(r: OrganizeResult) {
  const line = "─".repeat(64);
  console.log(`\n${line}`);
  console.log(`  ${r.categoryLabel} › ${r.typeLabel}   (신뢰도 ${(r.classification.confidence * 100).toFixed(0)}%)`);
  console.log(`  ${r.classification.rationale.replace(/\n/g, "\n  ")}`);
  console.log(line);

  for (const sec of r.form.layout) {
    const rows = sec.fields
      .map((f) => ({ f, v: (r.form.values as Record<string, unknown>)[f.key] }))
      .filter((x) => !isEmptyValue(x.v));
    if (!rows.length) continue;
    console.log(`\n【${sec.title}】`);
    for (const { f, v } of rows) console.log(`  ${f.label}: ${fmtValue(v, "  ")}`);
  }

  console.log(`\n${line}`);
  console.log(`  검수: ${r.review.final.verdict} (${r.review.rounds}회차)`);
  const s = r.review.final.scores;
  console.log(`  점수 — 유형 ${s.classification} / 채움 ${s.coverage} / 충실도 ${s.faithfulness} / 형식 ${s.formatting}`);
  const notable = r.review.final.issues.filter((i) => i.severity !== "minor");
  if (notable.length) {
    console.log(`  남은 이슈 ${notable.length}건:`);
    for (const i of notable.slice(0, 8)) console.log(`    · [${i.severity}] ${i.path} — ${i.detail}`);
  }

  console.log(`\n  채움률 ${r.fallback.completeness}%`);
  if (r.fallback.confirmTypeWith) {
    console.log(`  ⚠ ${r.fallback.confirmTypeWith.question}`);
    console.log(`     후보: ${r.fallback.confirmTypeWith.candidates.map((c) => c.label).join(" / ")}`);
  }
  if (r.fallback.nextQuestions.length) {
    console.log(`\n  더 채우려면 이걸 알려주세요:`);
    r.fallback.nextQuestions.forEach((q, i) => console.log(`    ${i + 1}. ${q}`));
  }
  if (r.fallback.recommendedUploads.length) {
    console.log(`  추가로 올리면 좋은 자료: ${r.fallback.recommendedUploads.join(", ")}`);
  }
  const high = r.fallback.missing.filter((m) => m.priority === "high");
  if (high.length) {
    console.log(`\n  비어 있는 주요 항목:`);
    for (const m of high.slice(0, 8)) console.log(`    · ${m.label} — ${m.whatToProvide}`);
  }
  console.log(`\n  비용 추정 $${r.usage.estimatedCostUsd.toFixed(4)} (in ${r.usage.inputTokens.toLocaleString()} / out ${r.usage.outputTokens.toLocaleString()} tok)`);
  console.log(line + "\n");
}

async function main() {
  const { files, opts } = parseArgs(process.argv.slice(2));

  if (opts.check) {
    try {
      const session = await createSession();
      const check = await session.verify();
      console.log(`엔진    : ${session.providerName}`);
      console.log(`모델    : ${await session.resolveModel("extract")}`);
      console.log(`보조모델: ${await session.resolveModel("guide")}`);
      console.log(`상태    : ${check.ok ? "정상" : "오류"} — ${check.detail}`);
      if (!check.ok) process.exit(1);
    } catch (e) {
      console.error(`상태   : 오류\n${(e as Error).message}`);
      process.exit(1);
    }
    return;
  }

  if (opts["list-types"]) {
    for (const t of EXPERIENCE_TYPES) console.log(`${t.id.padEnd(26)} ${t.emoji} ${t.label}`);
    return;
  }
  if (!files.length || opts.help) {
    console.log(HELP);
    process.exit(files.length ? 0 : 1);
  }

  const inputs = await readInputFiles(files);
  const quiet = !!opts.json || !!opts.form;

  const result = await organizeExperience(inputs, {
    userHint: typeof opts.hint === "string" ? opts.hint : undefined,
    forceTypeId: typeof opts.type === "string" ? opts.type : undefined,
    quality: (typeof opts.quality === "string" ? opts.quality : undefined) as
      "fast" | "balanced" | "best" | undefined,
    onProgress: (e: ProgressEvent) => {
      if (!quiet) console.error(`  [${e.stage}] ${e.message}`);
    },
  });

  if (typeof opts.out === "string" && opts.out) {
    await fs.writeFile(opts.out, JSON.stringify(result, null, 2), "utf-8");
    if (!quiet) console.error(`  결과 저장: ${opts.out}`);
  }
  if (opts.form) console.log(JSON.stringify(toFormState(result), null, 2));
  else if (quiet) console.log(JSON.stringify(result, null, 2));
  else printSummary(result);
}

main().catch((e) => {
  console.error(`\n오류: ${(e as Error).message}\n`);
  process.exit(1);
});
