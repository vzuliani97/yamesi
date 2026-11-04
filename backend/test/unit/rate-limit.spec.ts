import { Request, Response } from 'express';
import { rateLimit } from '../../src/common/rate-limit';

describe('public demo rate limit', () => {
  const call = (limiter: ReturnType<typeof rateLimit>, ip: string) => {
    const res = { status: jest.fn().mockReturnThis(), json: jest.fn(), setHeader: jest.fn() };
    const next = jest.fn();
    limiter({ ip } as Request, res as unknown as Response, next);
    return { res, next };
  };

  it('lets requests through up to the limit, then answers 429 with Retry-After until the window ends', () => {
    let time = 0;
    const limiter = rateLimit(3, 100, () => time);
    for (let i = 0; i < 3; i += 1) expect(call(limiter, '1.1.1.1').next).toHaveBeenCalled();

    const blocked = call(limiter, '1.1.1.1');
    expect(blocked.next).not.toHaveBeenCalled();
    expect(blocked.res.status).toHaveBeenCalledWith(429);
    expect(blocked.res.setHeader).toHaveBeenCalledWith('Retry-After', '60');
    expect(call(limiter, '2.2.2.2').next).toHaveBeenCalled();

    time = 60_000;
    expect(call(limiter, '1.1.1.1').next).toHaveBeenCalled();
  });

  it('stays bounded when many addresses appear', () => {
    let time = 0;
    const limiter = rateLimit(1, 2, () => time);
    call(limiter, 'a');
    call(limiter, 'b');
    call(limiter, 'c');
    // "a" was the oldest entry and was dropped, so it starts a fresh window.
    expect(call(limiter, 'a').next).toHaveBeenCalled();
    expect(call(limiter, 'c').next).not.toHaveBeenCalled();
  });
});
