/**
 * Shipping schemas — API_DOCUMENTATION.md §3.8 (public), §4.12 (admin). Admin bodies strict.
 */
import { z } from 'zod';

import { PAGE_LIMITS, paginationQuery } from '../../core/http/pagination.js';
import { ShipmentStatus, ShippingRateType } from '../../generated/prisma/enums.js';
import { MONEY_PATTERN } from '../../lib/money.js';

const id = z.uuid({ message: 'Must be a valid id.' });
const money = z.string().trim().regex(MONEY_PATTERN, 'Use a decimal string, e.g. "99.00".');
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD.');
export const pincodeSchema = z
  .string()
  .trim()
  .regex(/^[1-9][0-9]{5}$/, 'Enter a valid 6-digit pincode.');

export const ServiceabilityQuery = z.object({ pincode: pincodeSchema });

export const PublicMethodsQuery = z.object({
  pincode: pincodeSchema.optional(),
  cartValue: money.optional(),
});
export type PublicMethodsQueryInput = z.infer<typeof PublicMethodsQuery>;

export const MethodIdParams = z.object({ methodId: id });
export const ShipmentIdParams = z.object({ shipmentId: id });

export const MethodListQuery = paginationQuery(PAGE_LIMITS.adminList).extend({
  status: z.enum(['ACTIVE', 'INACTIVE', 'DELETED']).optional(),
  q: z.string().trim().min(1).max(100).optional(),
});
export type MethodListQueryInput = z.infer<typeof MethodListQuery>;

const methodFields = {
  code: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z_]{2,20}$/, 'Use 2–20 capital letters or underscores.'),
  name: z.string().trim().min(2).max(100),
  description: z.string().trim().max(500).nullable(),
  rateType: z.enum(ShippingRateType),
  charge: money,
  freeAbove: money.nullable(),
  estimatedDaysMin: z.number().int().min(0).max(60).nullable(),
  estimatedDaysMax: z.number().int().min(0).max(60).nullable(),
  codAllowed: z.boolean(),
  codCharge: money,
  status: z.enum(['ACTIVE', 'INACTIVE']),
  sortOrder: z.number().int().min(0).max(1_000_000),
};

const etaOrder = (b: {
  estimatedDaysMin?: number | null | undefined;
  estimatedDaysMax?: number | null | undefined;
}) =>
  b.estimatedDaysMin === undefined ||
  b.estimatedDaysMin === null ||
  b.estimatedDaysMax === undefined ||
  b.estimatedDaysMax === null ||
  b.estimatedDaysMin <= b.estimatedDaysMax;
const etaIssue = {
  message: 'Minimum days must not exceed maximum days.',
  path: ['estimatedDaysMax'],
};

export const CreateMethodBody = z
  .strictObject({
    code: methodFields.code,
    name: methodFields.name,
    description: methodFields.description.optional(),
    rateType: methodFields.rateType.default('FLAT'),
    charge: methodFields.charge,
    freeAbove: methodFields.freeAbove.optional(),
    estimatedDaysMin: methodFields.estimatedDaysMin.optional(),
    estimatedDaysMax: methodFields.estimatedDaysMax.optional(),
    codAllowed: methodFields.codAllowed.default(false),
    codCharge: methodFields.codCharge.default('0.00'),
    status: methodFields.status.default('ACTIVE'),
    sortOrder: methodFields.sortOrder.default(0),
  })
  .refine(etaOrder, etaIssue);
export type CreateMethodInput = z.infer<typeof CreateMethodBody>;

export const UpdateMethodBody = z
  .strictObject({
    code: methodFields.code.optional(),
    name: methodFields.name.optional(),
    description: methodFields.description.optional(),
    rateType: methodFields.rateType.optional(),
    charge: methodFields.charge.optional(),
    freeAbove: methodFields.freeAbove.optional(),
    estimatedDaysMin: methodFields.estimatedDaysMin.optional(),
    estimatedDaysMax: methodFields.estimatedDaysMax.optional(),
    codAllowed: methodFields.codAllowed.optional(),
    codCharge: methodFields.codCharge.optional(),
    status: methodFields.status.optional(),
    sortOrder: methodFields.sortOrder.optional(),
  })
  .refine((b) => Object.keys(b).length > 0, { message: 'Provide at least one field to update.' })
  .refine(etaOrder, etaIssue);
export type UpdateMethodInput = z.infer<typeof UpdateMethodBody>;

export const ShipmentListQuery = paginationQuery(PAGE_LIMITS.adminList).extend({
  status: z.enum(ShipmentStatus).optional(),
  courier: z.string().trim().min(1).max(30).optional(),
  q: z.string().trim().min(2).max(100).optional(),
  orderId: id.optional(),
  from: isoDate.optional(),
  to: isoDate.optional(),
});
export type ShipmentListQueryInput = z.infer<typeof ShipmentListQuery>;

const awbSchema = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z0-9]{6,30}$/, 'AWB must be 6–30 letters or digits.');
const courierSchema = z.string().trim().min(2).max(30);

export const CreateShipmentBody = z
  .strictObject({
    orderId: id,
    items: z
      .array(z.strictObject({ orderItemId: id, quantity: z.number().int().min(1).max(10_000) }))
      .min(1)
      .max(200)
      .optional(),
    shippingMethodId: id.optional(),
    courier: courierSchema.optional(),
    awb: awbSchema.optional(),
    createWithProvider: z.boolean().default(false),
    packageWeightGrams: z.number().int().min(1).max(100_000),
    dimensionsCm: z
      .strictObject({
        l: z.number().positive().max(500),
        w: z.number().positive().max(500),
        h: z.number().positive().max(500),
      })
      .optional(),
  })
  .refine((b) => b.createWithProvider || b.courier !== undefined, {
    message: 'Courier is required unless the shipment is booked with the provider.',
    path: ['courier'],
  })
  .refine((b) => !(b.createWithProvider && b.awb !== undefined), {
    message: 'Do not send an AWB when booking with the provider.',
    path: ['awb'],
  });
export type CreateShipmentInput = z.infer<typeof CreateShipmentBody>;

export const UpdateShipmentBody = z
  .strictObject({
    status: z.enum(ShipmentStatus).optional(),
    awb: awbSchema.optional(),
    courier: courierSchema.optional(),
    note: z.string().trim().min(1).max(1000).optional(),
  })
  .refine((b) => b.status !== undefined || b.awb !== undefined || b.courier !== undefined, {
    message: 'Provide status, awb or courier.',
  });
export type UpdateShipmentInput = z.infer<typeof UpdateShipmentBody>;

export const TrackingEventBody = z.strictObject({
  status: z.enum(ShipmentStatus),
  location: z.string().trim().min(1).max(200).optional(),
  description: z.string().trim().min(1).max(500),
  occurredAt: z.iso.datetime({ offset: true }),
});
export type TrackingEventInput = z.infer<typeof TrackingEventBody>;
