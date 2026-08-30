/**
 * Development seed.
 *
 * Deliberately asymmetric: the two dealerships differ in timezone, opening
 * hours, and staffing depth so that timezone handling and resource scarcity are
 * both demonstrable without hand-editing rows. Northgate is the contention
 * demo -- one bay capable of transmission work means concurrent requests for it
 * must serialise down to a single winner.
 */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const WEEKDAYS = [1, 2, 3, 4, 5];
const WEEKDAYS_AND_SATURDAY = [1, 2, 3, 4, 5, 6];

const hours = (h: number, m = 0): number => h * 60 + m;

const SERVICE_TYPES = [
  { name: 'Oil Change', durationMinutes: 30 },
  { name: 'Tire Rotation', durationMinutes: 45 },
  { name: 'Brake Inspection', durationMinutes: 60 },
  { name: 'Full Service', durationMinutes: 120 },
  { name: 'Transmission Repair', durationMinutes: 240 },
] as const;

async function main(): Promise<void> {
  console.log('Seeding...');

  // Order matters: children reference parents, and TRUNCATE ... CASCADE would
  // be heavier than simply clearing in dependency order.
  await prisma.outboxEvent.deleteMany();
  await prisma.appointment.deleteMany();
  await prisma.vehicle.deleteMany();
  await prisma.customer.deleteMany();
  await prisma.technicianShift.deleteMany();
  await prisma.technicianSkill.deleteMany();
  await prisma.technician.deleteMany();
  await prisma.bayCapability.deleteMany();
  await prisma.serviceBay.deleteMany();
  await prisma.openingHour.deleteMany();
  await prisma.serviceType.deleteMany();
  await prisma.dealership.deleteMany();

  const serviceTypes = new Map<string, string>();
  for (const definition of SERVICE_TYPES) {
    const created = await prisma.serviceType.create({ data: definition });
    serviceTypes.set(created.name, created.id);
  }
  const serviceTypeId = (name: string): string => {
    const id = serviceTypes.get(name);
    if (!id) throw new Error(`Unknown service type: ${name}`);
    return id;
  };

  // --- Westside Motors: US Pacific, generously staffed -----------------------
  const westside = await prisma.dealership.create({
    data: {
      name: 'Westside Motors',
      timezone: 'America/Los_Angeles',
      openingHours: {
        create: [
          ...WEEKDAYS.map((dayOfWeek) => ({
            dayOfWeek,
            openMinute: hours(8),
            closeMinute: hours(18),
          })),
          { dayOfWeek: 6, openMinute: hours(9), closeMinute: hours(14) },
        ],
      },
    },
  });

  await prisma.technician.create({
    data: {
      dealershipId: westside.id,
      name: 'Grace Hopper',
      skills: {
        create: [
          { serviceTypeId: serviceTypeId('Oil Change') },
          { serviceTypeId: serviceTypeId('Tire Rotation') },
          { serviceTypeId: serviceTypeId('Brake Inspection') },
          { serviceTypeId: serviceTypeId('Full Service') },
          { serviceTypeId: serviceTypeId('Transmission Repair') },
        ],
      },
      shifts: {
        create: WEEKDAYS.map((dayOfWeek) => ({
          dayOfWeek,
          startMinute: hours(8),
          endMinute: hours(16),
        })),
      },
    },
  });

  await prisma.technician.create({
    data: {
      dealershipId: westside.id,
      name: 'Alan Turing',
      skills: {
        create: [
          { serviceTypeId: serviceTypeId('Oil Change') },
          { serviceTypeId: serviceTypeId('Tire Rotation') },
          { serviceTypeId: serviceTypeId('Brake Inspection') },
        ],
      },
      // Late shift -- creates windows where only one technician is on duty.
      shifts: {
        create: WEEKDAYS.map((dayOfWeek) => ({
          dayOfWeek,
          startMinute: hours(10),
          endMinute: hours(18),
        })),
      },
    },
  });

  // Saturday-only technician: proves shift filtering is per-day, not global.
  await prisma.technician.create({
    data: {
      dealershipId: westside.id,
      name: 'Katherine Johnson',
      skills: {
        create: [
          { serviceTypeId: serviceTypeId('Oil Change') },
          { serviceTypeId: serviceTypeId('Full Service') },
        ],
      },
      shifts: { create: [{ dayOfWeek: 6, startMinute: hours(9), endMinute: hours(14) }] },
    },
  });

  const quickLane = await prisma.serviceBay.create({
    data: {
      dealershipId: westside.id,
      name: 'Quick Lane 1',
      capabilities: {
        create: [
          { serviceTypeId: serviceTypeId('Oil Change') },
          { serviceTypeId: serviceTypeId('Tire Rotation') },
        ],
      },
    },
  });

  await prisma.serviceBay.create({
    data: {
      dealershipId: westside.id,
      name: 'Service Bay 2',
      capabilities: {
        create: SERVICE_TYPES.map((s) => ({ serviceTypeId: serviceTypeId(s.name) })),
      },
    },
  });

  await prisma.serviceBay.create({
    data: {
      dealershipId: westside.id,
      name: 'Heavy Lift 1',
      capabilities: {
        create: [
          { serviceTypeId: serviceTypeId('Brake Inspection') },
          { serviceTypeId: serviceTypeId('Full Service') },
          { serviceTypeId: serviceTypeId('Transmission Repair') },
        ],
      },
    },
  });

  // --- Northgate Auto: different timezone, deliberately scarce --------------
  const northgate = await prisma.dealership.create({
    data: {
      name: 'Northgate Auto',
      timezone: 'Europe/London',
      openingHours: {
        create: WEEKDAYS_AND_SATURDAY.map((dayOfWeek) => ({
          dayOfWeek,
          openMinute: hours(7, 30),
          closeMinute: hours(17, 30),
        })),
      },
    },
  });

  await prisma.technician.create({
    data: {
      dealershipId: northgate.id,
      name: 'Ada Lovelace',
      skills: {
        create: [
          { serviceTypeId: serviceTypeId('Oil Change') },
          { serviceTypeId: serviceTypeId('Transmission Repair') },
        ],
      },
      shifts: {
        create: WEEKDAYS_AND_SATURDAY.map((dayOfWeek) => ({
          dayOfWeek,
          startMinute: hours(7, 30),
          endMinute: hours(17, 30),
        })),
      },
    },
  });

  // Unqualified for transmission work on purpose: availability must reject a
  // technician who is free but not certified.
  await prisma.technician.create({
    data: {
      dealershipId: northgate.id,
      name: 'Charles Babbage',
      skills: { create: [{ serviceTypeId: serviceTypeId('Oil Change') }] },
      shifts: {
        create: WEEKDAYS_AND_SATURDAY.map((dayOfWeek) => ({
          dayOfWeek,
          startMinute: hours(7, 30),
          endMinute: hours(17, 30),
        })),
      },
    },
  });

  // The contention demo: exactly one bay in the estate can take a transmission
  // job at Northgate, so concurrent requests for the same slot must produce
  // exactly one winner.
  await prisma.serviceBay.create({
    data: {
      dealershipId: northgate.id,
      name: 'Ramp A',
      capabilities: {
        create: [
          { serviceTypeId: serviceTypeId('Oil Change') },
          { serviceTypeId: serviceTypeId('Transmission Repair') },
        ],
      },
    },
  });

  await prisma.serviceBay.create({
    data: {
      dealershipId: northgate.id,
      name: 'Ramp B',
      capabilities: { create: [{ serviceTypeId: serviceTypeId('Oil Change') }] },
    },
  });

  // --- Customers and vehicles ----------------------------------------------
  const chen = await prisma.customer.create({
    data: {
      name: 'Mei Chen',
      email: 'mei.chen@example.com',
      phone: '+1-555-0142',
      vehicles: {
        create: [
          { vin: '1HGCM82633A004352', make: 'Honda', model: 'Accord', year: 2021 },
          { vin: 'WVWZZZ1JZ3W128761', make: 'Volkswagen', model: 'Golf', year: 2019 },
        ],
      },
    },
    include: { vehicles: true },
  });

  const okafor = await prisma.customer.create({
    data: {
      name: 'Daniel Okafor',
      email: 'daniel.okafor@example.com',
      phone: '+44-20-7946-0958',
      vehicles: {
        create: [{ vin: 'YV1RS58D712345678', make: 'Volvo', model: 'S60', year: 2023 }],
      },
    },
    include: { vehicles: true },
  });

  console.log(`
Seed complete.

  Westside Motors  ${westside.id}
    America/Los_Angeles, Mon-Fri 08:00-18:00, Sat 09:00-14:00
    3 technicians, 3 bays

  Northgate Auto   ${northgate.id}
    Europe/London, Mon-Sat 07:30-17:30
    2 technicians, 2 bays -- only Ramp A handles Transmission Repair

  Customers
    Mei Chen         ${chen.id}
      Honda Accord   ${chen.vehicles[0].id}
      VW Golf        ${chen.vehicles[1].id}
    Daniel Okafor    ${okafor.id}
      Volvo S60      ${okafor.vehicles[0].id}

  Service types
${SERVICE_TYPES.map((s) => `    ${s.name.padEnd(22)} ${String(s.durationMinutes).padStart(3)} min  ${serviceTypeId(s.name)}`).join('\n')}

  Quick Lane 1 (oil/tires only) ${quickLane.id}
`);
}

main()
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
