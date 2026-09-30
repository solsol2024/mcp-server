import { Ratelimit } from "@upstash/ratelimit";
import { Redis } from "@upstash/redis";

/** Minimal key-value surface used by the OAuth layer. Values are JSON-serialisable. */
export interface KV {
  get<T>(key: string): Promise<T | null>;
  set(key: string, value: unknown, ttlSeconds: number): Promise<void>;
  /** Atomic read-and-delete, used for single-use codes and rotating refresh tokens. */
  getdel<T>(key: string): Promise<T | null>;
  del(...keys: string[]): Promise<void>;
}

export interface Limiter {
  limit(key: string): Promise<{ success: boolean; reset: number }>;
}

const PREFIX = "solsol-mcp:";

function redisClient(): Redis {
  const url = process.env.KV_REST_API_URL ?? process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN ?? process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) throw new Error("Upstash Redis is not configured (KV_REST_API_URL / KV_REST_API_TOKEN)");
  return new Redis({ url, token });
}

function redisKV(redis: Redis): KV {
  return {
    get: (key) => redis.get(PREFIX + key),
    set: async (key, value, ttl) => {
      await redis.set(PREFIX + key, value, { ex: ttl });
    },
    getdel: (key) => redis.getdel(PREFIX + key),
    del: async (...keys) => {
      if (keys.length) await redis.del(...keys.map((k) => PREFIX + k));
    },
  };
}

export function memoryKV(): KV & { dump(): Record<string, unknown> } {
  const data = new Map<string, { value: string; exp: number }>();
  const read = (key: string) => {
    const hit = data.get(key);
    if (!hit) return null;
    if (hit.exp < Date.now()) {
      data.delete(key);
      return null;
    }
    return JSON.parse(hit.value);
  };
  return {
    get: async (key) => read(key),
    set: async (key, value, ttl) => {
      data.set(key, { value: JSON.stringify(value), exp: Date.now() + ttl * 1000 });
    },
    getdel: async (key) => {
      const v = read(key);
      data.delete(key);
      return v;
    },
    del: async (...keys) => keys.forEach((k) => data.delete(k)),
    dump: () => Object.fromEntries([...data].map(([k, v]) => [k, v.value])),
  };
}

export function memoryLimiter(max: number, windowMs: number): Limiter {
  const hits = new Map<string, number[]>();
  return {
    limit: async (key) => {
      const now = Date.now();
      const recent = (hits.get(key) ?? []).filter((t) => t > now - windowMs);
      const success = recent.length < max;
      if (success) recent.push(now);
      hits.set(key, recent);
      return { success, reset: (recent[0] ?? now) + windowMs };
    },
  };
}

interface Runtime {
  kv: KV;
  loginLimiter: Limiter;
  registerLimiter: Limiter;
}

let runtime: Runtime | null = null;

function defaultRuntime(): Runtime {
  const redis = redisClient();
  return {
    kv: redisKV(redis),
    loginLimiter: new Ratelimit({
      redis,
      prefix: `${PREFIX}rl:login`,
      limiter: Ratelimit.slidingWindow(5, "15 m"),
    }),
    registerLimiter: new Ratelimit({
      redis,
      prefix: `${PREFIX}rl:register`,
      limiter: Ratelimit.slidingWindow(20, "1 h"),
    }),
  };
}

export function getRuntime(): Runtime {
  return (runtime ??= defaultRuntime());
}

/** Test hook: swap Redis for in-memory implementations. */
export function setRuntime(next: Runtime | null) {
  runtime = next;
}

export function clientIp(req: Request): string {
  const fwd = req.headers.get("x-forwarded-for");
  return fwd?.split(",")[0]?.trim() || req.headers.get("x-real-ip") || "unknown";
}
