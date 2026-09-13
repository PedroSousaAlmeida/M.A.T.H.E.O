import { describe, expect, it, mock } from 'bun:test';
import { EventEmitter } from 'node:events';
import { RequestContext } from '@/common/request-context';
import { RequestIdMiddleware } from '@/common/request-id.middleware';

function run(headers: Record<string, string>, url = '/x', ip = '10.0.0.1') {
  const req: any = { headers, method: 'GET', url, originalUrl: url, ip };
  const setHeader = mock();
  const res: any = Object.assign(new EventEmitter(), { setHeader, statusCode: 200 });
  const logger = { log: mock(), debug: mock() };
  let inside: string | undefined;
  let store: ReturnType<typeof RequestContext.get>;
  new RequestIdMiddleware(logger as any).use(req, res, () => {
    inside = RequestContext.get()?.requestId;
    store = RequestContext.get();
  });
  return { req, res, setHeader, inside, logger, store };
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

  it('logs an access line without the query string when the response finishes', () => {
    const { res, logger } = run({}, '/api/v0/companies/me?x=1');
    res.statusCode = 401;
    res.emit('finish');
    expect(logger.log).toHaveBeenCalledTimes(1);
    const [message, context] = logger.log.mock.calls[0];
    expect(message).toMatch(/^GET \/api\/v0\/companies\/me 401 \d+ms$/);
    expect(context).toBe('HTTP');
    expect(logger.debug).not.toHaveBeenCalled();
  });

  it('logs /health access lines at debug, not log', () => {
    const { res, logger } = run({}, '/api/v0/health');
    res.statusCode = 200;
    res.emit('finish');
    expect(logger.debug).toHaveBeenCalledTimes(1);
    const [message, context] = logger.debug.mock.calls[0];
    expect(message).toMatch(/^GET \/api\/v0\/health 200 \d+ms$/);
    expect(context).toBe('HTTP');
    expect(logger.log).not.toHaveBeenCalled();
  });

  it('stores ip and user agent from the request in the request context', () => {
    const { store } = run({ 'user-agent': 'curl/8.0' }, '/x', '203.0.113.5');
    expect(store?.ip).toBe('203.0.113.5');
    expect(store?.userAgent).toBe('curl/8.0');
  });

  it('normalizes an array user-agent header to its first element', () => {
    const { store } = run({ 'user-agent': ['curl/8.0', 'other'] as any }, '/x');
    expect(store?.userAgent).toBe('curl/8.0');
  });
});
