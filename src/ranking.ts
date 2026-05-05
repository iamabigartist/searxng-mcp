export const INSTANCES_LIST_URL = process.env.SEARXNG_INSTANCES_LIST_URL ?? "https://searx.space/data/instances.json";

const ENGINE_PRIORITY = ["google", "brave", "bing", "duckduckgo"] as const;

export interface RankedInstance {
  url: string;
  speedBucket: number;
  engineVec: boolean[];
  uptimeBucket: number;
  totalEngines: number;
  speed: number;
  uptimeMonth: number;
}

interface SearxSpaceInstance {
  network_type?: unknown;
  engines?: Record<string, unknown>;
  uptime?: {
    uptimeMonth?: unknown;
  };
  timing?: {
    search?: {
      all?: {
        median?: unknown;
      };
    };
  };
}

interface EngineInfo {
  error_rate?: unknown;
}

/** Check if an engine is healthy (present and 0% error rate). */
function engineOk(engines: Record<string, unknown>, name: string): boolean {
  const ei = engines[name];
  if (!ei) return false;
  return !isObject(ei) || (typeof ei.error_rate === "number" && Number.isFinite(ei.error_rate) ? ei.error_rate : 0) === 0;
}

function engineVector(engines: Record<string, unknown>): boolean[] {
  return ENGINE_PRIORITY.map((e) => engineOk(engines, e));
}

/** Compare two engine vectors lexicographically. Returns <0 if a ranks higher. */
function compareEngineVectors(a: boolean[], b: boolean[]): number {
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return a[i] ? -1 : 1;
  }
  return 0;
}

/** log0.5 with rounding */
function logHalfBucket(v: number): number {
  return Math.round(Math.log(v) / Math.log(0.5));
}

export function rankInstances(instances: Record<string, unknown>): RankedInstance[] {
  const ranked: RankedInstance[] = [];

  for (const [url, instance] of Object.entries(instances)) {
    if (!isObject(instance)) continue;
    const inst = instance as SearxSpaceInstance;

    if (inst.network_type !== "normal") continue;

    const engines = inst.engines ?? {};
    const vec = engineVector(engines);
    const uptimeMonth = numericOr(inst.uptime?.uptimeMonth, 0);
    const speed = numericOr(inst.timing?.search?.all?.median, 999);

    ranked.push({
      url,
      speedBucket: logHalfBucket(speed),
      engineVec: vec,
      uptimeBucket: Math.round(uptimeMonth),
      totalEngines: Object.keys(engines).length,
      speed,
      uptimeMonth,
    });
  }

  ranked.sort((a, b) => {
    if (b.speedBucket !== a.speedBucket) return b.speedBucket - a.speedBucket;
    const ec = compareEngineVectors(a.engineVec, b.engineVec);
    if (ec !== 0) return ec;
    if (b.uptimeBucket !== a.uptimeBucket) return b.uptimeBucket - a.uptimeBucket;
    return b.totalEngines - a.totalEngines;
  });

  return ranked;
}

export function engineLabel(v: boolean[]): string {
  return ENGINE_PRIORITY.map((e, i) => v[i] ? e[0].toUpperCase() : "-").join("");
}

function numericOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
