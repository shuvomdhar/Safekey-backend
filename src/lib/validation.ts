import { z } from 'zod';
import { notFound } from './http.js';

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export const emailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .min(3, 'Enter your email address.')
  .max(254, 'That email address is too long.')
  .regex(EMAIL_PATTERN, 'Enter a valid email address.');

export const passwordSchema = z
  .string()
  .min(8, 'Use at least 8 characters.')
  .max(200, 'Passwords can be at most 200 characters.');

export const displayNameSchema = z
  .string()
  .trim()
  .max(80, 'Names can be at most 80 characters.')
  .optional();

export const folderNameSchema = z
  .string()
  .trim()
  .min(1, 'Give this vault a name.')
  .max(60, 'Vault names can be at most 60 characters.');

export const columnNameSchema = z
  .string()
  .trim()
  .min(1, 'Give this column a name.')
  .max(40, 'Column names can be at most 40 characters.');

export const itemTitleSchema = z
  .string()
  .trim()
  .min(1, 'Give this entry a title.')
  .max(120, 'Titles can be at most 120 characters.');

const ID_PATTERN = /^[1-9]\d*$/;
const MAX_INT_ID = 2_147_483_647;

/**
 * Safekey uses 32-bit integer primary keys. Reject anything that is not a
 * positive, in-range integer so bad URLs become a clean 404 instead of a
 * database error.
 */
export function parseId(value: string, label = 'resource'): number {
  const parsed = Number(value);

  if (!ID_PATTERN.test(value) || !Number.isSafeInteger(parsed) || parsed > MAX_INT_ID) {
    throw notFound(`We could not find that ${label}.`);
  }

  return parsed;
}

export const optionalText = (max: number) =>
  z
    .string()
    .max(max, `Keep this under ${max} characters.`)
    .optional()
    .nullable()
    .transform((value) => (value === undefined ? undefined : value === null ? '' : value));
