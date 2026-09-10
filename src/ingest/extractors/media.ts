import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { API_KEYS } from "../../config.js";
import type { ExtractedPage } from "../../types.js";
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

/** Whisper STT (OpenAI). 키가 없으면 조용히 건너뛴다. */
async function transcribe(file: string): Promise<{ text: string; warning?: string }> {
  if (!API_KEYS.openaiWhisper) {
    return { text: "", warning: "STT 키가 없어 음성은 변환하지 않았습니다 (config.API_KEYS.openaiWhisper)." };
  }
  try {
    const buf = await fs.readFile(file);
    const form = new FormData();
    form.append("file", new Blob([new Uint8Array(buf)]), path.basename(file));
    form.append("model", "whisper-1");
    form.append("language", "ko");
    form.append("response_format", "text");
    const res = await fetch("https://api.openai.com/v1/audio/transcriptions", {
      method: "POST",
      headers: { authorization: `Bearer ${API_KEYS.openaiWhisper}` },
      body: form,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return { text: (await res.text()).trim() };
  } catch (e) {
    return { text: "", warning: `STT 실패: ${(e as Error).message}` };
  }
}

export async function extractAudio(bytes: Uint8Array, name: string): Promise<MediaExtraction> {
  const out: MediaExtraction = { pages: [], frames: [], metadata: {}, warnings: [] };
  const dir = await tmpDir();
  const file = path.join(dir, name.replace(/[^\w.\-]/g, "_"));
  try {
    await fs.writeFile(file, bytes);
    Object.assign(out.metadata, await probe(file));
    const { text, warning } = await transcribe(file);
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
export async function extractVideo(bytes: Uint8Array, name: string): Promise<MediaExtraction> {
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
      const { text, warning } = await transcribe(audio);
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
