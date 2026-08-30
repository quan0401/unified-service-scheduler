/**
 * Read-only reference data needed to build a booking request.
 *
 * Grouped into one module because these are all small, static, cacheable lists
 * with no business rules -- splitting them per entity would add files without
 * adding meaning.
 */
import { Controller, Get, Param, ParseUUIDPipe } from '@nestjs/common';
import { CatalogService } from './catalog.service';

@Controller()
export class CatalogController {
  constructor(private readonly catalog: CatalogService) {}

  @Get('dealerships')
  listDealerships() {
    return this.catalog.listDealerships();
  }

  @Get('service-types')
  listServiceTypes() {
    return this.catalog.listServiceTypes();
  }

  @Get('customers')
  listCustomers() {
    return this.catalog.listCustomers();
  }

  @Get('customers/:customerId/vehicles')
  listVehicles(@Param('customerId', ParseUUIDPipe) customerId: string) {
    return this.catalog.listVehicles(customerId);
  }
}
