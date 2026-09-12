import { createParamDecorator, ExecutionContext } from '@nestjs/common';

export interface AuthUser {
  id: string;
}

export const CurrentUser = createParamDecorator((_data: unknown, ctx: ExecutionContext): AuthUser => {
  return ctx.switchToHttp().getRequest().user;
});
