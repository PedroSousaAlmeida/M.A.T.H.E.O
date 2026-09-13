import { describe, expect, it } from 'bun:test';
import { RequestContext } from '@/common/request-context';

describe('RequestContext', () => {
  it('is undefined outside a run', () => {
    expect(RequestContext.get()).toBeUndefined();
  });

  it('exposes the store inside run and supports set()', () => {
    RequestContext.run({ requestId: 'r1' }, () => {
      expect(RequestContext.get()).toEqual({ requestId: 'r1' });
      RequestContext.set({ userId: 'u1' });
      expect(RequestContext.get()).toEqual({ requestId: 'r1', userId: 'u1' });
    });
  });

  it('isolates concurrent async contexts', async () => {
    const seen: string[] = [];
    await Promise.all([
      RequestContext.run({ requestId: 'a' }, async () => {
        await new Promise((r) => setTimeout(r, 5));
        seen.push(RequestContext.get()!.requestId);
      }),
      RequestContext.run({ requestId: 'b' }, async () => {
        seen.push(RequestContext.get()!.requestId);
      }),
    ]);
    expect(seen.sort()).toEqual(['a', 'b']);
  });
});
