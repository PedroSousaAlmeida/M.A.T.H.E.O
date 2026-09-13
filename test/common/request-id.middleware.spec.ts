import { describe, expect, it, mock } from 'bun:test';
import { RequestContext } from '@/common/request-context';
import { RequestIdMiddleware } from '@/common/request-id.middleware';

function run(headers: Record<string, string>) {
  const req: any = { headers };
  const setHeader = mock();
  const res: any = { setHeader };
  let inside: string | undefined;
  new RequestIdMiddleware().use(req, res, () => {
    inside = RequestContext.get()?.requestId;
  });
  return { req, setHeader, inside };
}

describe('RequestIdMiddleware', () => {
  it('reuses a valid incoming x-request-id', () => {
    const { req, setHeader, inside } = run({ 'x-request-id': 'abc-123.XYZ_9' });
    expect(req.id).toBe('abc-123.XYZ_9');
    expect(setHeader).toHaveBeenCalledWith('x-request-id', 'abc-123.XYZ_9');
    expect(inside).toBe('abc-123.XYZ_9');
  });

  it('generates a uuid when the header is missing or invalid', () => {
    const uuid = /^[0-9a-f-]{36}$/;
    expect(run({}).req.id).toMatch(uuid);
    expect(run({ 'x-request-id': 'has space' }).req.id).toMatch(uuid);
    expect(run({ 'x-request-id': 'x'.repeat(129) }).req.id).toMatch(uuid);
  });
});
