/** Fixed-window limiter per key, in memory. Good enough for one instance; move to Redis when we scale out. */
export function rateLimiter(limit: number, windowMs: number, now: () => number = Date.now) {
  const hits = new Map<string, { count: number; resetAt: number }>();
  return (key: string): boolean => {
    const t = now();
    const h = hits.get(key);
    if (!h || t >= h.resetAt) {
      hits.set(key, { count: 1, resetAt: t + windowMs });
      if (hits.size > 10_000) for (const [k, v] of hits) if (t >= v.resetAt) hits.delete(k);
      return true;
    }
    h.count++;
    return h.count <= limit;
  };
}
