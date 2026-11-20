/**
 * `/me` profile schemas — API_DOCUMENTATION.md §3.2. Email change is not supported via PATCH (v1).
 */
import { z } from 'zod';

import { firstNameSchema, lastNameSchema, phoneSchema } from '../auth/auth.schemas.js';

export { ChangePasswordBody, SessionIdParams } from '../auth/auth.schemas.js';

export const UpdateMeBody = z
  .strictObject({
    firstName: firstNameSchema.optional(),
    lastName: lastNameSchema.nullable().optional(),
    phone: phoneSchema.nullable().optional(),
  })
  .refine((body) => Object.values(body).some((v) => v !== undefined), {
    message: 'Provide at least one field to update.',
  });
export type UpdateMeInput = z.output<typeof UpdateMeBody>;
