import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ExtractedPage } from "../../types.js";
import type { LlmSession } from "../../llm/index.js";
import { hasBinary, run } from "../optional.js";

export interface MediaExtraction {
  pages: ExtractedPage[];
  /** 영상에서 뽑은 대표 프레임 — 슬라이드·자막·화면 캡처를 OCR로 읽는다 */
  frames: Uint8Array[];
  metadata: Record<string, string | number>;
  warnings: string[];
}

async function tmpDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "arc-media-"));
}

/** ffprobe로 길이·해상도 등 메타데이터 */
async function probe(file: string): Promise<Record<string, string | number>> {
  if (!(await hasBinary("ffprobe"))) return {};
  try {
    const { stdout } = await run("ffprobe", [
      "-v", "quiet", "-print_format", "json", "-show_format", "-show_streams", file,
    ]);
    const j = JSON.parse(stdout);
    const out: Record<string, string | number> = {};
    if (j.format?.duration) out.durationSec = Math.round(Number(j.format.duration));
    if (j.format?.tags?.creation_time) out.createdAt = String(j.format.tags.creation_time);
    if (j.format?.tags?.title) out.title = String(j.format.tags.title);
    const v = (j.streams ?? []).find((s: any) => s.codec_type === "video");
    if (v) out.resolution = `${v.width}x${v.height}`;
    return out;
  } catch {
    return {};
  }
}

/**
 * 음성 → 텍스트.
 * 별도 STT 서비스를 쓰지 않고 **Gemini에 오디오를 그대로 들려준다.**
 * Google API 키 하나로 끝나고, 한국어 발표·인터뷰 맥락을 같이 이해해 정확도도 높다.
 */
const STT_SYSTEM = `당신은 한국어 음성 받아쓰기 엔진이다.
1. 들리는 말을 그대로 받아 적는다. 요약·의역 금지.
2. 화자가 여럿이면 "화자1:", "화자2:" 로 구분한다.
3. 안 들리는 구간은 «불명» 으로 표시한다. 추측해서 채우지 않는다.
4. 숫자·고유명사·기관명은 특히 정확하게 적는다.
5. 말소리가 전혀 없으면 정확히 "[[NO_SPEECH]]" 만 출력한다.
6. 설명을 붙이지 말고 받아쓴 내용만 출력한다.`;

const AUDIO_MIME: Record<string, string> = {
  mp3: "audio/mp3", m4a: "audio/mp4", wav: "audio/wav",
  flac: "audio/flac", ogg: "audio/ogg", aac: "audio/aac",
};

/** Gemini 인라인 업로드 한도를 고려한 상한 */
const MAX_INLINE_AUDIO = 18 * 1024 * 1024;

async function transcribe(
  session: LlmSession,
  bytes: Uint8Array,
  fileName: string,
): Promise<{ text: string; warning?: string }> {
  const ext = (/\.([a-z0-9]+)$/i.exec(fileName)?.[1] ?? "mp3").toLowerCase();
  const mediaType = AUDIO_MIME[ext] ?? "audio/mp3";
  if (bytes.length > MAX_INLINE_AUDIO) {
    return {
      text: "",
      warning: `음성 파일이 ${(bytes.length / 1024 / 1024).toFixed(1)}MB로 너무 큽니다(18MB 이하 권장). 잘라서 올려주세요.`,
    };
  }
  try {
    const text = await session.text("ocr", STT_SYSTEM, [
      { type: "audio", mediaType, dataBase64: Buffer.from(bytes).toString("base64") },
      { type: "text", text: `파일명: ${fileName}. 규칙대로 받아 적어라.` },
    ]);
    return { text: text.trim() === "[[NO_SPEECH]]" ? "" : text.trim() };
  } catch (e) {
    return { text: "", warning: `음성 인식 실패: ${(e as Error).message}` };
  }
}

export async function extractAudio(
  session: LlmSession,
  bytes: Uint8Array,
  name: string,
): Promise<MediaExtraction> {
  const out: MediaExtraction = { pages: [], frames: [], metadata: {}, warnings: [] };
  const dir = await tmpDir();
  const file = path.join(dir, name.replace(/[^\w.\-]/g, "_"));
  try {
    await fs.writeFile(file, bytes);
    Object.assign(out.metadata, await probe(file));
    const { text, warning } = await transcribe(session, bytes, name);
    if (warning) out.warnings.push(warning);
    if (text) out.pages.push({ index: 1, text, method: "stt" });
  } finally {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
  return out;
}

/**
 * 영상은 두 갈래로 뽑는다.
 *  ① 오디오 → STT (발표/인터뷰 내용)
 *  ② 장면 전환 프레임 → OCR (발표 슬라이드, 화면 녹화 UI, 자막)
 * 둘 다 있으면 근거가 훨씬 두꺼워진다.
 */
export async function extractVideo(
  session: LlmSession,
  bytes: Uint8Array,
  name: string,
): Promise<MediaExtraction> {
  const out: MediaExtraction = { pages: [], frames: [], metadata: {}, warnings: [] };
  if (!(await hasBinary("ffmpeg"))) {
    out.warnings.push("ffmpeg 미설치 — 영상에서 음성/화면을 추출하지 못했습니다. 파일명만 근거로 씁니다.");
    return out;
  }
  const dir = await tmpDir();
  const file = path.join(dir, name.replace(/[^\w.\-]/g, "_"));
  try {
    await fs.writeFile(file, bytes);
    Object.assign(out.metadata, await probe(file));

    // ① 오디오 트랙 분리 → STT
    const audio = path.join(dir, "audio.mp3");
    try {
      await run("ffmpeg", ["-y", "-i", file, "-vn", "-ac", "1", "-ar", "16000", "-b:a", "64k", audio], 300_000);
      const audioBytes = new Uint8Array(await fs.readFile(audio));
      const { text, warning } = await transcribe(session, audioBytes, "audio.mp3");
      if (warning) out.warnings.push(warning);
      if (text) out.pages.push({ index: 1, text, method: "stt" });
    } catch (e) {
      out.warnings.push(`오디오 분리 실패: ${(e as Error).message}`);
    }

    // ② 장면 전환 프레임 최대 8장
    try {
      await run(
        "ffmpeg",
        ["-y", "-i", file, "-vf", "select='gt(scene,0.35)',scale=1600:-1", "-vsync", "vfr", "-frames:v", "8",
          path.join(dir, "frame-%02d.png")],
        300_000,
      );
      const files = (await fs.readdir(dir)).filter((f) => f.startsWith("frame-")).sort();
      for (const f of files) out.frames.push(new Uint8Array(await fs.readFile(path.join(dir, f))));
    } catch (e) {
      out.warnings.push(`프레임 추출 실패: ${(e as Error).message}`);
    }
  } finally {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
  return out;
}
