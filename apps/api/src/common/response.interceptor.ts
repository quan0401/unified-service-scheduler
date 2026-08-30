/**
 * Wraps successful controller returns in the standard envelope.
 *
 * Controllers return plain domain data; the envelope is applied once here so no
 * handler can forget it and no two endpoints can disagree on the shape.
 * Handlers marked @RawResponse() are passed through untouched -- see that
 * decorator for why that escape hatch has to exist.
 */
import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { map, type Observable } from 'rxjs';
import { ok, type ApiResponse } from './api-response';
import { currentRequestId } from './request-context';
import { RAW_RESPONSE_KEY } from './raw-response.decorator';

@Injectable()
export class ResponseEnvelopeInterceptor<T> implements NestInterceptor<T, ApiResponse<T> | T> {
  constructor(private readonly reflector: Reflector) {}

  intercept(context: ExecutionContext, next: CallHandler<T>): Observable<ApiResponse<T> | T> {
    const isRaw = this.reflector.getAllAndOverride<boolean>(RAW_RESPONSE_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (isRaw) return next.handle();

    return next.handle().pipe(map((data) => ok(data, { requestId: currentRequestId() })));
  }
}
