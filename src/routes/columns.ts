import { Router } from 'express';
import { z } from 'zod';
import { isRaised, isUniqueViolation, supabaseAdmin, unwrap } from '../db.js';
import { ApiError, badRequest, notFound } from '../lib/http.js';
import { decryptSecret, encryptSecret, isEncrypted } from '../lib/crypto.js';
import { parseId } from '../lib/validation.js';
import { columnNameSchema } from '../lib/validation.js';
import { requireAuth } from '../middleware/auth.js';
import { COLUMN_TYPES, type ColumnType } from '../lib/templates.js';

export const columnsRouter = Router();

columnsRouter.use(requireAuth);

const MAX_COLUMNS_PER_FOLDER = 20;

type ColumnRow = {
  id: number;
  name: string;
  type: ColumnType;
  isSecret: boolean;
  isRequired: boolean;
  position: number;
};

async function assertFolder(userId: number, folderId: number): Promise<void> {
  const folder = unwrap(
    await supabaseAdmin
      .from('folders')
      .select('id')
      .eq('id', folderId)
      .eq('user_id', userId)
      .eq('status', 'active')
      .maybeSingle()
  ) as { id: number } | null;

  if (!folder) throw notFound('That vault does not exist.');
}

const createColumnSchema = z.object({
  name: columnNameSchema,
  type: z.enum([...COLUMN_TYPES]).default('text'),
  isSecret: z.boolean().optional(),
  isRequired: z.boolean().optional()
});

/**
 * Encrypt or decrypt every stored value when a column's secrecy changes.
 * Crypto stays in Node; `api_update_column` applies the prepared rows in one
 * database transaction.
 */
async function buildSecrecyUpdates(
  columnId: number,
  userId: number,
  toSecret: boolean
): Promise<Array<{ id: number; value: string }>> {
  const rows = unwrap(
    await supabaseAdmin.rpc('api_column_values', {
      p_user_id: userId,
      p_column_id: columnId
    })
  ) as unknown as Array<{ id: number; value: string | null; itemId: number }> | null;

  const updates: Array<{ id: number; value: string }> = [];

  for (const row of rows ?? []) {
    if (!row.value) continue;
    const context = `v1:${userId}:${row.itemId}:${columnId}`;

    if (toSecret && !isEncrypted(row.value)) {
      updates.push({ id: row.id, value: encryptSecret(row.value, context) });
    } else if (!toSecret && isEncrypted(row.value)) {
      updates.push({ id: row.id, value: decryptSecret(row.value, context) });
    }
  }

  return updates;
}

columnsRouter.post('/folders/:folderId/columns', async (req, res) => {
  const folderId = parseId(req.params.folderId, 'vault');
  const body = createColumnSchema.parse(req.body);
  const userId = req.user!.id;

  await assertFolder(userId, folderId);

  const isSecret = body.type === 'password' ? true : Boolean(body.isSecret);

  try {
    const column = unwrap(
      await supabaseAdmin.rpc('api_create_column', {
        p_user_id: userId,
        p_folder_id: folderId,
        p_name: body.name,
        p_type: body.type,
        p_is_secret: isSecret,
        p_is_required: body.isRequired ?? false,
        p_max_columns: MAX_COLUMNS_PER_FOLDER
      })
    ) as unknown as ColumnRow | null;

    if (!column) throw notFound('That vault does not exist.');
    res.status(201).json({ column });
  } catch (error) {
    if (isRaised(error, 'COLUMN_LIMIT_REACHED')) {
      throw new ApiError(
        422,
        'COLUMN_LIMIT_REACHED',
        `A vault can have up to ${MAX_COLUMNS_PER_FOLDER} columns.`
      );
    }
    if (isUniqueViolation(error)) {
      throw new ApiError(409, 'COLUMN_NAME_TAKEN', 'This vault already has a column with that name.');
    }
    throw error;
  }
});

const updateColumnSchema = z
  .object({
    name: columnNameSchema.optional(),
    type: z.enum([...COLUMN_TYPES]).optional(),
    isSecret: z.boolean().optional(),
    isRequired: z.boolean().optional()
  })
  .refine((value) => Object.keys(value).length > 0, { message: 'Nothing to update.' });

columnsRouter.patch('/columns/:columnId', async (req, res) => {
  const columnId = parseId(req.params.columnId, 'column');
  const body = updateColumnSchema.parse(req.body);
  const userId = req.user!.id;

  const column = unwrap(
    await supabaseAdmin.rpc('api_get_column', {
      p_user_id: userId,
      p_column_id: columnId
    })
  ) as unknown as (ColumnRow & { folderId: number }) | null;

  if (!column) throw notFound('That column does not exist.');

  const nextType = body.type ?? column.type;
  const nextSecret = nextType === 'password' ? true : body.isSecret ?? column.isSecret;
  const nextRequired = body.isRequired ?? column.isRequired;
  const secrecyChanged = nextSecret !== column.isSecret;

  const valueUpdates = secrecyChanged
    ? await buildSecrecyUpdates(columnId, userId, nextSecret)
    : [];

  try {
    const updated = unwrap(
      await supabaseAdmin.rpc('api_update_column', {
        p_user_id: userId,
        p_column_id: columnId,
        p_name: body.name ?? null,
        p_type: nextType,
        p_is_secret: nextSecret,
        p_is_required: nextRequired,
        p_value_updates: valueUpdates
      })
    ) as unknown as ColumnRow | null;

    if (!updated) throw notFound('That column does not exist.');
    res.json({ column: updated });
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new ApiError(409, 'COLUMN_NAME_TAKEN', 'This vault already has a column with that name.');
    }
    throw error;
  }
});

columnsRouter.delete('/columns/:columnId', async (req, res) => {
  const columnId = parseId(req.params.columnId, 'column');
  const userId = req.user!.id;

  const folderId = unwrap(
    await supabaseAdmin.rpc('api_delete_column', {
      p_user_id: userId,
      p_column_id: columnId
    })
  ) as unknown as number | null;

  if (!folderId) throw notFound('That column does not exist.');
  res.status(204).end();
});

const reorderSchema = z.object({
  ids: z
    .array(z.union([z.number().int().positive(), z.string()]))
    .min(1, 'Send the column order.')
});

columnsRouter.put('/folders/:folderId/columns/order', async (req, res) => {
  const folderId = parseId(req.params.folderId, 'vault');
  const { ids } = reorderSchema.parse(req.body);
  const userId = req.user!.id;

  await assertFolder(userId, folderId);

  const parsedIds = ids.map((id) => parseId(String(id), 'column'));
  if (new Set(parsedIds).size !== parsedIds.length) {
    throw badRequest('The column order contains duplicates.');
  }

  try {
    const columns = unwrap(
      await supabaseAdmin.rpc('api_reorder_columns', {
        p_user_id: userId,
        p_folder_id: folderId,
        p_ids: parsedIds
      })
    ) as unknown as ColumnRow[] | null;

    if (!columns) throw notFound('That vault does not exist.');
    res.json({ columns });
  } catch (error) {
    if (isRaised(error, 'COLUMN_ORDER_STALE')) {
      throw badRequest('The column order is out of date. Refresh and try again.');
    }
    throw error;
  }
});
