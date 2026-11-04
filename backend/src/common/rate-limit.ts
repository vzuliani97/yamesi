import { NextFunction, Request, Response } from 'express';

/**
 * Fixed-window request limit per client address, for the public demo. Kept in memory and bounded: expired
 * windows are dropped first, then the oldest entries, so a flood of addresses cannot exhaust memory.
 */
export function rateLimit(limitPerMinute: number, maxKeys = 10_000, now: () => number = Date.now) {
  const windows = new Map<string, { count: number; startedAt: number }>();
  const windowMs = 60_000;

  return (req: Request, res: Response, next: NextFunction): void => {
    const key = req.ip ?? 'unknown';
    const time = now();
    let entry = windows.get(key);
    if (!entry || time - entry.startedAt >= windowMs) {
      entry = { count: 0, startedAt: time };
      windows.delete(key);
      windows.set(key, entry);
    }
    entry.count += 1;

    if (windows.size > maxKeys) {
      for (const [stored, value] of windows) {
        if (time - value.startedAt >= windowMs) windows.delete(stored);
      }
      for (const stored of windows.keys()) {
        if (windows.size <= maxKeys) break;
        windows.delete(stored);
      }
    }

    if (entry.count > limitPerMinute) {
      const retryAfterSeconds = Math.ceil((entry.startedAt + windowMs - time) / 1000);
      res.setHeader('Retry-After', String(retryAfterSeconds));
      res.status(429).json({ error: { code: 'RATE_LIMITED', message: 'Too many requests; try again shortly', retryAfterSeconds } });
      return;
    }
    next();
  };
}
