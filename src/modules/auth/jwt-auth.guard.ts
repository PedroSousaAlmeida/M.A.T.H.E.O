import { CanActivate, ExecutionContext, Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import { jwtVerify, type JWTVerifyGetKey } from 'jose';
import type { Env } from '../../config/env';
import { JWKS } from './jwks.provider';
import { IS_PUBLIC_KEY } from './public.decorator';

@Injectable()
export class JwtAuthGuard implements CanActivate {
  private readonly issuer: string;
  private readonly audience: string;

  constructor(
    config: ConfigService<Env, true>,
    private readonly reflector: Reflector,
    @Inject(JWKS) private readonly jwks: JWTVerifyGetKey,
  ) {
    this.issuer = `${config.get('LOGTO_ENDPOINT', { infer: true })}/oidc`;
    this.audience = config.get('LOGTO_API_RESOURCE', { infer: true });
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [context.getHandler(), context.getClass()]);
    if (isPublic) return true;

    const request = context.switchToHttp().getRequest();
    const header: string | undefined = request.headers?.authorization;
    if (!header?.startsWith('Bearer ')) {
      throw new UnauthorizedException('Missing bearer token');
    }

    try {
      const { payload } = await jwtVerify(header.slice('Bearer '.length), this.jwks, {
        issuer: this.issuer,
        audience: this.audience,
      });
      if (!payload.sub) throw new Error('missing sub');
      request.user = { id: payload.sub };
      return true;
    } catch {
      throw new UnauthorizedException('Invalid token');
    }
  }
}
