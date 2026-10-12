/**
 * Location contracts. 36 states + FCT = 37 jurisdictions, 774 LGAs.
 * Areas are user-driven and fuzzy-matched through `area_alias`.
 */

import { z } from 'zod';
import { cuid } from './primitives.js';

export const stateSchema = z.object({
  code: z.string().length(2),
  name: z.string(),
  slug: z.string(),
  lgaCount: z.number().int().nonnegative().optional(),
});
export type NigerianState = z.infer<typeof stateSchema>;

export const lgaSchema = z.object({
  code: z.string(),
  name: z.string(),
  stateCode: z.string().length(2),
});
export type NigerianLga = z.infer<typeof lgaSchema>;

export const areaSchema = z.object({
  id: cuid,
  name: z.string(),
  slug: z.string(),
  lgaCode: z.string(),
  lgaName: z.string(),
  stateCode: z.string().length(2),
  stateName: z.string(),
  centreLat: z.number().nullable(),
  centreLng: z.number().nullable(),
  listingCount: z.number().int().nonnegative().optional(),
});
export type Area = z.infer<typeof areaSchema>;

/** Proposed by a poster during listing creation, curated by an admin later. */
export const proposeAreaSchema = z.object({
  name: z.string().trim().min(2, 'Enter the area name').max(120),
  lgaCode: z.string().min(1).max(12),
});
export type ProposeAreaInput = z.infer<typeof proposeAreaSchema>;

/**
 * A local government area the poster named that is not in the reference data.
 *
 * Nigeria has created more LGAs than any table here holds, and a landlord in one
 * of them otherwise has no way to list at all. The name is recorded inactive and
 * an admin curates it later, rather than the listing being refused.
 *
 * `stateCode` is required because an LGA only means something within a state, and
 * the derived code has to be unique per state.
 */
export const proposeLgaSchema = z.object({
  name: z.string().trim().min(2, 'Enter the local government area name').max(120),
  stateCode: z.string().regex(/^[A-Z]{2}$/, 'Select a valid state'),
});
export type ProposeLgaInput = z.infer<typeof proposeLgaSchema>;

export const mapBoundsSchema = z.object({
  northEast: z.tuple([z.number(), z.number()]),
  southWest: z.tuple([z.number(), z.number()]),
});
