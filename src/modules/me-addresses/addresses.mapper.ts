/**
 * Address DTO — API_DOCUMENTATION.md §2.10 request shape + `id`, `isDefault` (§3.2).
 */
import type { AddressRow } from './me-addresses.repository.js';
import { ADDRESS_TYPES } from './me-addresses.schemas.js';

type AddressType = (typeof ADDRESS_TYPES)[number];

function addressType(label: string | null): AddressType {
  return (ADDRESS_TYPES as readonly string[]).includes(label ?? '')
    ? (label as AddressType)
    : 'OTHER';
}

export function toAddressDto(row: AddressRow) {
  return {
    id: row.id,
    fullName: row.fullName,
    phone: row.phone,
    line1: row.line1,
    line2: row.line2,
    landmark: row.landmark,
    city: row.city,
    district: row.district,
    stateCode: row.stateCode,
    stateName: row.state.name,
    pincode: row.postalCode,
    country: row.countryCode,
    addressType: addressType(row.label),
    companyName: row.companyName,
    gstin: row.gstin,
    isDefault: row.isDefault,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export type AddressDto = ReturnType<typeof toAddressDto>;
