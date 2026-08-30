/**
 * Builders for a minimal but realistic dealership.
 *
 * Defaults describe the common case (one qualified technician, one capable bay,
 * open all week); tests override only the dimension they are exercising, so the
 * intent of each test stays visible at its call site.
 */
import { testDb } from './db';

export const MON_TO_SUN = [1, 2, 3, 4, 5, 6, 7];

export interface Scenario {
  dealershipId: string;
  serviceTypeId: string;
  technicianIds: string[];
  bayIds: string[];
  customerId: string;
  vehicleIds: string[];
}

export interface ScenarioOptions {
  timezone?: string;
  /** Minutes from local midnight. Defaults to 08:00-18:00. */
  openMinute?: number;
  closeMinute?: number;
  durationMinutes?: number;
  technicianCount?: number;
  bayCount?: number;
  vehicleCount?: number;
  /** When false, technicians are created without the required skill. */
  techniciansQualified?: boolean;
  /** When false, bays are created without the required capability. */
  baysCapable?: boolean;
  /** Technician shift window, minutes from local midnight. Defaults to opening hours. */
  shiftStartMinute?: number;
  shiftEndMinute?: number;
}

let sequence = 0;
const unique = (): string => `${Date.now()}-${++sequence}`;

/**
 * A real VIN is exactly 17 characters, so the uniqueness suffix has to fit
 * inside that budget rather than be truncated into a collision.
 */
const uniqueVin = (): string => `VIN${String(++sequence).padStart(14, '0')}`;

export async function createScenario(options: ScenarioOptions = {}): Promise<Scenario> {
  const {
    timezone = 'America/Los_Angeles',
    openMinute = 8 * 60,
    closeMinute = 18 * 60,
    durationMinutes = 60,
    technicianCount = 1,
    bayCount = 1,
    vehicleCount = 1,
    techniciansQualified = true,
    baysCapable = true,
    shiftStartMinute = openMinute,
    shiftEndMinute = closeMinute,
  } = options;

  const dealership = await testDb.dealership.create({
    data: {
      name: `Dealership ${unique()}`,
      timezone,
      openingHours: {
        create: MON_TO_SUN.map((dayOfWeek) => ({ dayOfWeek, openMinute, closeMinute })),
      },
    },
  });

  const serviceType = await testDb.serviceType.create({
    data: { name: `Service ${unique()}`, durationMinutes },
  });

  const technicianIds: string[] = [];
  for (let i = 0; i < technicianCount; i++) {
    const technician = await testDb.technician.create({
      data: {
        dealershipId: dealership.id,
        name: `Technician ${i + 1}`,
        shifts: {
          create: MON_TO_SUN.map((dayOfWeek) => ({
            dayOfWeek,
            startMinute: shiftStartMinute,
            endMinute: shiftEndMinute,
          })),
        },
        ...(techniciansQualified
          ? { skills: { create: [{ serviceTypeId: serviceType.id }] } }
          : {}),
      },
    });
    technicianIds.push(technician.id);
  }

  const bayIds: string[] = [];
  for (let i = 0; i < bayCount; i++) {
    const bay = await testDb.serviceBay.create({
      data: {
        dealershipId: dealership.id,
        name: `Bay ${i + 1}`,
        ...(baysCapable ? { capabilities: { create: [{ serviceTypeId: serviceType.id }] } } : {}),
      },
    });
    bayIds.push(bay.id);
  }

  const customer = await testDb.customer.create({
    data: { name: 'Ada Lovelace', email: `ada-${unique()}@example.com` },
  });

  const vehicleIds: string[] = [];
  for (let i = 0; i < vehicleCount; i++) {
    const vehicle = await testDb.vehicle.create({
      data: {
        customerId: customer.id,
        vin: uniqueVin(),
        make: 'Volvo',
        model: 'XC90',
        year: 2024,
      },
    });
    vehicleIds.push(vehicle.id);
  }

  return {
    dealershipId: dealership.id,
    serviceTypeId: serviceType.id,
    technicianIds,
    bayIds,
    customerId: customer.id,
    vehicleIds,
  };
}

/**
 * Bulk vehicles for contention tests.
 *
 * Each concurrent booker needs a distinct vehicle so the vehicle exclusion
 * constraint does not mask which resource was actually contended -- the test
 * must prove the *bay* or *technician* was the bottleneck, not the car.
 */
export async function createVehicles(customerId: string, count: number): Promise<string[]> {
  const data = Array.from({ length: count }, () => ({
    customerId,
    vin: uniqueVin(),
    make: 'Volvo',
    model: 'XC90',
    year: 2024,
  }));
  await testDb.vehicle.createMany({ data });

  const vehicles = await testDb.vehicle.findMany({
    where: { vin: { in: data.map((vehicle) => vehicle.vin) } },
    select: { id: true },
  });
  return vehicles.map((vehicle) => vehicle.id);
}
