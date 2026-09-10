/** 'courses[0].courseName' 같은 경로로 중첩 객체를 읽고 쓴다. */

type Seg = { key: string; index?: number };

export function parsePath(path: string): Seg[] {
  return path.split(".").map((raw) => {
    const m = /^([^[]+)\[(\d+)\]$/.exec(raw);
    return m ? { key: m[1]!, index: Number(m[2]) } : { key: raw };
  });
}

export function getByPath(obj: unknown, path: string): unknown {
  let cur: any = obj;
  for (const seg of parsePath(path)) {
    if (cur == null) return undefined;
    cur = cur[seg.key];
    if (seg.index !== undefined) {
      if (!Array.isArray(cur)) return undefined;
      cur = cur[seg.index];
    }
  }
  return cur;
}

export function setByPath(obj: Record<string, unknown>, path: string, value: unknown): void {
  const segs = parsePath(path);
  let cur: any = obj;
  for (let i = 0; i < segs.length; i++) {
    const seg = segs[i]!;
    const last = i === segs.length - 1;
    if (last) {
      if (seg.index === undefined) cur[seg.key] = value;
      else {
        if (!Array.isArray(cur[seg.key])) cur[seg.key] = [];
        cur[seg.key][seg.index] = value;
      }
      return;
    }
    if (seg.index === undefined) {
      if (cur[seg.key] == null || typeof cur[seg.key] !== "object") cur[seg.key] = {};
      cur = cur[seg.key];
    } else {
      if (!Array.isArray(cur[seg.key])) cur[seg.key] = [];
      if (cur[seg.key][seg.index] == null) cur[seg.key][seg.index] = {};
      cur = cur[seg.key][seg.index];
    }
  }
}

export function isEmptyValue(v: unknown): boolean {
  if (v === null || v === undefined) return true;
  if (typeof v === "string") return v.trim() === "";
  if (Array.isArray(v)) return v.length === 0 || v.every(isEmptyValue);
  if (typeof v === "object") return Object.values(v as Record<string, unknown>).every(isEmptyValue);
  return false;
}

/** 값이 채워진 리프 경로를 모두 나열 */
export function leafPaths(value: unknown, prefix = ""): string[] {
  if (value === null || value === undefined) return [];
  if (Array.isArray(value)) {
    return value.flatMap((v, i) => leafPaths(v, `${prefix}[${i}]`));
  }
  if (typeof value === "object") {
    return Object.entries(value as Record<string, unknown>).flatMap(([k, v]) =>
      leafPaths(v, prefix ? `${prefix}.${k}` : k),
    );
  }
  return prefix ? [prefix] : [];
}
