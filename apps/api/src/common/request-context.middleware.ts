/**
 * Establishes the correlation ID for each request and echoes it back.
 *
 * An inbound X-Request-Id is honoured so a trace started at the edge (load
 * balancer, gateway, or calling service) stays continuous through this service.
 */
import { Injectable, NestMiddleware } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { runWithRequestContext } from './request-context';

export const REQUEST_ID_HEADER = 'x-request-id';

@Injectable()
export class RequestContextMiddleware implements NestMiddleware {
  use(request: Request, response: Response, next: NextFunction): void {
    const inbound = request.headers[REQUEST_ID_HEADER];
    const requestId = typeof inbound === 'string' && inbound.length > 0 ? inbound : randomUUID();

    response.setHeader(REQUEST_ID_HEADER, requestId);
    runWithRequestContext({ requestId }, () => next());
  }
}
