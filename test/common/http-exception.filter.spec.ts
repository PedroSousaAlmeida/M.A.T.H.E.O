import { describe, expect, it, mock } from 'bun:test';
import { ArgumentsHost, BadRequestException, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { HttpExceptionFilter } from '@/common/http-exception.filter';

function hostWithResponse() {
  const json = mock();
  const status = mock(() => ({ json }));
  const host = {
    switchToHttp: () => ({ getResponse: () => ({ status }), getRequest: () => ({ url: '/x', method: 'GET' }) }),
  } as unknown as ArgumentsHost;
  return { host, status, json };
}

describe('HttpExceptionFilter', () => {
  const filter = new HttpExceptionFilter();

  it('formats a plain HttpException', () => {
    const { host, status, json } = hostWithResponse();
    filter.catch(new NotFoundException('Company not found'), host);
    expect(status).toHaveBeenCalledWith(404);
    expect(json).toHaveBeenCalledWith({ statusCode: 404, message: 'Company not found' });
  });

  it('keeps message and details from an object response', () => {
    const { host, json } = hostWithResponse();
    filter.catch(new UnprocessableEntityException({ message: 'NFS-e rejected', details: { code: 'E1' } }), host);
    expect(json).toHaveBeenCalledWith({ statusCode: 422, message: 'NFS-e rejected', details: { code: 'E1' } });
  });

  it('moves class-validator message arrays into details', () => {
    const { host, json } = hostWithResponse();
    filter.catch(new BadRequestException(['cnpj must be 14 digits', 'razaoSocial must be longer']), host);
    expect(json).toHaveBeenCalledWith({ statusCode: 400, message: 'Validation failed', details: ['cnpj must be 14 digits', 'razaoSocial must be longer'] });
  });

  it('hides unknown errors behind a 500', () => {
    const { host, status, json } = hostWithResponse();
    filter.catch(new Error('db exploded'), host);
    expect(status).toHaveBeenCalledWith(500);
    expect(json).toHaveBeenCalledWith({ statusCode: 500, message: 'Internal server error' });
  });
});
