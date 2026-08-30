/**
 * OpenAPI document generation.
 *
 * The brief asks for the client layer to be stubbed with an API contract. That
 * contract is generated from the same Zod schemas the server validates against,
 * so it cannot drift from the implementation the way a hand-written spec does.
 *
 * Written to disk on boot in development, and served at /docs, so the committed
 * artefact is always regenerated rather than maintained by hand.
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { INestApplication } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { cleanupOpenApiDoc } from 'nestjs-zod';

export function writeOpenApiDocument(app: INestApplication): void {
  const config = new DocumentBuilder()
    .setTitle('Unified Service Scheduler API')
    .setDescription(
      'Dealership service-appointment booking. Availability is advisory; ' +
        'booking is atomic and enforced by PostgreSQL exclusion constraints, ' +
        'so a slot can never be double-booked regardless of concurrency.',
    )
    .setVersion('1.0.0')
    .build();

  // cleanupOpenApiDoc resolves the Zod-generated schemas into plain OpenAPI --
  // nestjs-zod v5 emits them inline, and without this pass the document
  // contains unresolved internal references.
  const document = cleanupOpenApiDoc(SwaggerModule.createDocument(app, config));
  SwaggerModule.setup('docs', app, document);

  if (process.env.NODE_ENV !== 'production') {
    const target = resolve(process.cwd(), 'docs/openapi.json');
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, JSON.stringify(document, null, 2));
  }
}
