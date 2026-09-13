import { describe, expect, it } from 'bun:test';
import { Writable } from 'node:stream';
import { PinoLoggerService } from '@/common/logger/pino-logger.service';
import { RequestContext } from '@/common/request-context';

function capture() {
  const lines: any[] = [];
  const stream = new Writable({
    write(chunk, _enc, cb) {
      lines.push(JSON.parse(chunk.toString()));
      cb();
    },
  });
  return { lines, logger: new PinoLoggerService({ level: 'debug', pretty: false }, stream) };
}

describe('PinoLoggerService', () => {
  it('writes JSON with level, msg and context', () => {
    const { lines, logger } = capture();
    logger.log('hello', 'MyContext');
    expect(lines[0]).toMatchObject({ level: 30, msg: 'hello', context: 'MyContext' });
  });

  it('merges requestId and userId from the request context', () => {
    const { lines, logger } = capture();
    RequestContext.run({ requestId: 'r1', userId: 'u1' }, () => logger.warn('inside'));
    expect(lines[0]).toMatchObject({ level: 40, msg: 'inside', requestId: 'r1', userId: 'u1' });
  });

  it('logs error with stack as a field', () => {
    const { lines, logger } = capture();
    logger.error('boom', 'Error: boom\n    at x', 'Ctx');
    expect(lines[0]).toMatchObject({ level: 50, msg: 'boom', context: 'Ctx' });
    expect(lines[0].stack).toContain('at x');
  });

  it('respects the level', () => {
    const lines: any[] = [];
    const stream = new Writable({ write(c, _e, cb) { lines.push(JSON.parse(c.toString())); cb(); } });
    const logger = new PinoLoggerService({ level: 'warn', pretty: false }, stream);
    logger.log('ignored');
    logger.warn('kept');
    expect(lines).toHaveLength(1);
  });
});
