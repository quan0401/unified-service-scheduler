/**
 * Marks a handler whose response must bypass the standard JSON envelope.
 *
 * Almost every endpoint benefits from a uniform shape, but some responses have
 * a format dictated by their consumer. The Prometheus exposition format is
 * plain text with a precise grammar -- wrapping it in JSON produces a body that
 * looks fine to a human and is unparseable by every scraper.
 */
import { SetMetadata } from '@nestjs/common';

export const RAW_RESPONSE_KEY = 'raw_response';
export const RawResponse = (): MethodDecorator => SetMetadata(RAW_RESPONSE_KEY, true);
