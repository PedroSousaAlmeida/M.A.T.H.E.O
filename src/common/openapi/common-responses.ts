import { applyDecorators } from '@nestjs/common';
import { ApiBadRequestResponse, ApiNotFoundResponse, ApiPaymentRequiredResponse, ApiTooManyRequestsResponse, ApiUnauthorizedResponse } from '@nestjs/swagger';
import { ErrorResponse } from './error.response';

/** Error responses every authenticated route can produce. */
export function ApiCommonErrors() {
  return applyDecorators(
    ApiBadRequestResponse({ type: ErrorResponse, description: 'Validation failed (details lists the field messages)' }),
    ApiUnauthorizedResponse({ type: ErrorResponse, description: 'Missing or invalid Logto token' }),
    ApiPaymentRequiredResponse({ type: ErrorResponse, description: 'Trial expired (only on routes not allowed after expiry)' }),
    ApiNotFoundResponse({ type: ErrorResponse, description: 'Company not registered yet, or resource not found' }),
    ApiTooManyRequestsResponse({ type: ErrorResponse, description: 'Rate limit' }),
  );
}
