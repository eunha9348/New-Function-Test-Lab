import { tryImport } from "../ingest/optional.js";
import { PIPELINE } from "../config.js";

export interface PreparedImage {
  /** Vision 모델용: 회색조 + 대비 정규화 + 샤픈 (이진화 안 함) */
  enhanced: Uint8Array;
  /** 고전 OCR 엔진용: 위 + 적응 이진화 */
  binary: Uint8Array;
  width: number;
  height: number;
  applied: string[];
  warnings: string[];
}

/**
 * OCR 정확도의 8할은 전처리에서 갈린다.
 *  1) EXIF 회전 보정          — 세로로 찍은 사진이 눕는 문제
 *  2) 회색조 + 대비 정규화     — 조명 얼룩/그림자 제거
 *  3) 업스케일(≥2000px)        — 한글은 획이 많아 저해상도에서 뭉갬. 300DPI 상당까지 올림
 *  4) 언샤프 마스크            — 스캔본 흐림 보정
 *  5) 이진화(보조 엔진용)       — tesseract 계열은 이진화가 있어야 성능이 남
 */
export async function prepareImage(bytes: Uint8Array): Promise<PreparedImage> {
  const sharpMod = await tryImport<any>("sharp");
  if (!sharpMod) {
    return {
      enhanced: bytes,
      binary: bytes,
      width: 0,
      height: 0,
      applied: [],
      warnings: ["sharp 미설치 — 이미지 전처리를 건너뜁니다. `npm i sharp` 시 인식률이 크게 올라갑니다."],
    };
  }
  const sharp = sharpMod.default ?? sharpMod;
  const applied: string[] = [];
  const warnings: string[] = [];

  try {
    const base = sharp(bytes, { failOn: "none" }).rotate(); // EXIF 자동 회전
    const meta = await base.metadata();
    const width = meta.width ?? 0;
    const height = meta.height ?? 0;
    applied.push("exif-rotate");

    const targetWidth = Math.min(4000, Math.max(width, 2000));
    let pipe = sharp(bytes, { failOn: "none" }).rotate().grayscale().normalize();
    applied.push("grayscale", "normalize");
    if (targetWidth > width && width > 0) {
      pipe = pipe.resize({ width: targetWidth, kernel: "lanczos3" });
      applied.push(`upscale:${width}->${targetWidth}`);
    }
    pipe = pipe.median(1).sharpen({ sigma: 1.1 });
    applied.push("median-denoise", "unsharp");

    const enhanced = new Uint8Array(await pipe.clone().png({ compressionLevel: 6 }).toBuffer());
    const binary = new Uint8Array(
      await pipe.clone().threshold(140).png({ compressionLevel: 6 }).toBuffer(),
    );
    applied.push("threshold:140(binary variant)");

    const outMeta = await sharp(enhanced).metadata();
    return {
      enhanced,
      binary,
      width: outMeta.width ?? width,
      height: outMeta.height ?? height,
      applied,
      warnings,
    };
  } catch (e) {
    warnings.push(`이미지 전처리 실패: ${(e as Error).message}. 원본으로 진행합니다.`);
    return { enhanced: bytes, binary: bytes, width: 0, height: 0, applied, warnings };
  }
}

/**
 * 세로로 긴 이미지(스크린샷 이어붙임, 문서 스캔)는 통째로 넘기면
 * 작은 글씨가 뭉개진다. 겹침을 둔 가로 스트립으로 잘라 각각 읽고 합친다.
 */
export async function tileVertically(
  bytes: Uint8Array,
  height: number,
): Promise<Uint8Array[]> {
  if (height <= PIPELINE.ocrTileThresholdPx) return [bytes];
  const sharpMod = await tryImport<any>("sharp");
  if (!sharpMod) return [bytes];
  const sharp = sharpMod.default ?? sharpMod;

  const meta = await sharp(bytes).metadata();
  const w = meta.width ?? 0;
  const h = meta.height ?? height;
  if (!w || !h) return [bytes];

  const step = PIPELINE.ocrTileThresholdPx - PIPELINE.ocrTileOverlapPx;
  const tiles: Uint8Array[] = [];
  for (let top = 0; top < h; top += step) {
    const tileHeight = Math.min(PIPELINE.ocrTileThresholdPx, h - top);
    if (tileHeight < 80) break;
    const buf = await sharp(bytes)
      .extract({ left: 0, top, width: w, height: tileHeight })
      .png()
      .toBuffer();
    tiles.push(new Uint8Array(buf));
    if (top + tileHeight >= h) break;
  }
  return tiles.length ? tiles : [bytes];
}
