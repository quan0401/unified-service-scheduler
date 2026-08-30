/**
 * Single exit point for every failure leaving the API.
 *
 * Domain errors map to deliberate status codes; anything unrecognised becomes a
 * generic 500 with the detail logged rather than returned, so a driver message
 * or stack trace can never reach a client.
 */
import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import type { Response } from 'express';
import { fail } from './api-response';
import { DomainError, type DomainErrorCode } from './domain-errors';
import { currentRequestId } from './request-context';

const STATUS_BY_CODE: Record<DomainErrorCode, HttpStatus> = {
  DEALERSHIP_NOT_FOUND: HttpStatus.NOT_FOUND,
  SERVICE_TYPE_NOT_FOUND: HttpStatus.NOT_FOUND,
  CUSTOMER_NOT_FOUND: HttpStatus.NOT_FOUND,
  VEHICLE_NOT_FOUND: HttpStatus.NOT_FOUND,
  APPOINTMENT_NOT_FOUND: HttpStatus.NOT_FOUND,
  HOLD_NOT_FOUND: HttpStatus.NOT_FOUND,

  VEHICLE_NOT_OWNED: HttpStatus.FORBIDDEN,
  HOLD_NOT_OWNED: HttpStatus.FORBIDDEN,

  OUTSIDE_OPENING_HOURS: HttpStatus.UNPROCESSABLE_ENTITY,
  VALIDATION_FAILED: HttpStatus.BAD_REQUEST,

  // 409 for all three: the request was well-formed but the world moved on.
  SLOT_UNAVAILABLE: HttpStatus.CONFLICT,
  SLOT_CONTENDED: HttpStatus.CONFLICT,
  HOLD_EXPIRED: HttpStatus.CONFLICT,
  APPOINTMENT_NOT_CANCELLABLE: HttpStatus.CONFLICT,

  // Capacity, not conflict. Retryable, and the one code here that should
  // page someone if it becomes common.
  SERVICE_OVERLOADED: HttpStatus.SERVICE_UNAVAILABLE,
};

@Catch()
export class DomainExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(DomainExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<Response>();
    const meta = { requestId: currentRequestId() };

    if (exception instanceof DomainError) {
      const status = STATUS_BY_CODE[exception.code] ?? HttpStatus.BAD_REQUEST;
      response
        .status(status)
        .json(
          fail(
            { code: exception.code, message: exception.message, details: exception.details },
            meta,
          ),
        );
      return;
    }

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const payload = exception.getResponse();
      response.status(status).json(
        fail(
          {
            code: httpErrorCode(status),
            message: exception.message,
            details: typeof payload === 'object' ? (payload as Record<string, unknown>) : undefined,
          },
          meta,
        ),
      );
      return;
    }

    // Unexpected: log everything, return nothing.
    this.logger.error(
      `Unhandled exception on request ${meta.requestId}`,
      exception instanceof Error ? exception.stack : String(exception),
    );
    response
      .status(HttpStatus.INTERNAL_SERVER_ERROR)
      .json(fail({ code: 'INTERNAL_ERROR', message: 'An unexpected error occurred.' }, meta));
  }
}

function httpErrorCode(status: number): string {
  return HttpStatus[status] ?? 'HTTP_ERROR';
}
