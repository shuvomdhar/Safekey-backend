import { Router } from 'express';
import { z } from 'zod';
import { supabaseAdmin, unwrap } from '../db.js';
import { ApiError, badRequest, notFound } from '../lib/http.js';
import { decryptSecret, encryptSecret } from '../lib/crypto.js';
import { itemTitleSchema, parseId } from '../lib/validation.js';
import { requireAuth } from '../middleware/auth.js';

export const itemsRouter = Router();

itemsRouter.use(requireAuth);

type ColumnRow = {
  id: number;
  name: string;
  type: string;
  isSecret: boolean;
  isRequired: boolean;
};

type ItemValue = {
  columnId: number;
  value: string | null;
  hasValue: boolean;
};

type ItemRow = {
  id: number;
  title: string;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
  values: ItemValue[];
  folderId: number;
  folderName: string;
};

async function loadColumns(folderId: number): Promise<ColumnRow[]> {
  const rows = unwrap(
    await supabaseAdmin
      .from('folder_columns')
      .select('id, name, type, is_secret, is_required')
      .eq('folder_id', folderId)
      .order('position', { ascending: true })
      .order('created_at', { ascending: true })
  ) as Array<{
    id: number;
    name: string;
    type: string;
    is_secret: boolean;
    is_required: boolean;
  }> | null;

  return (rows ?? []).map((row) => ({
    id: row.id,
    name: row.name,
    type: row.type,
    isSecret: row.is_secret,
    isRequired: row.is_required
  }));
}

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

async function fetchItem(userId: number, itemId: number): Promise<ItemRow> {
  const item = unwrap(
    await supabaseAdmin.rpc('api_get_item', {
      p_user_id: userId,
      p_item_id: itemId
    })
  ) as unknown as ItemRow | null;

  if (!item) throw notFound('That entry does not exist.');
  return item;
}

function escapeLike(value: string): string {
  return `%${value.replace(/[\\%_]/g, (character) => `\\${character}`)}%`;
}

const valuesSchema = z.record(z.string(), z.string().max(20_000));

function numericColumnId(value: string): number | null {
  if (!/^[1-9]\d*$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed <= 2_147_483_647 ? parsed : null;
}

function assertKnownColumns(values: Record<string, string>, columns: ColumnRow[]): void {
  const known = new Set(columns.map((column) => column.id));
  for (const key of Object.keys(values)) {
    const columnId = numericColumnId(key);
    if (columnId === null || !known.has(columnId)) {
      throw badRequest('One of the fields does not belong to this vault.');
    }
  }
}

function assertRequiredColumns(
  values: Record<string, string>,
  columns: ColumnRow[],
  mode: 'create' | 'update'
): void {
  for (const column of columns) {
    if (!column.isRequired) continue;
    if (mode === 'update' && !(String(column.id) in values)) continue;
    const value = values[String(column.id)];
    if (!value || !value.trim()) {
      throw new ApiError(422, 'REQUIRED_FIELD_MISSING', `"${column.name}" is required.`, [
        { path: `values.${column.id}`, message: `${column.name} is required.` }
      ]);
    }
  }
}

itemsRouter.get('/folders/:folderId/items', async (req, res) => {
  const folderId = parseId(req.params.folderId, 'vault');
  const userId = req.user!.id;

  await assertFolder(userId, folderId);

  const search = typeof req.query.search === 'string' ? req.query.search.trim().slice(0, 120) : '';
  const limit = Math.min(
    Math.max(Number.parseInt(String(req.query.limit ?? '200'), 10) || 200, 1),
    500
  );

  const items = unwrap(
    await supabaseAdmin.rpc('api_list_items', {
      p_user_id: userId,
      p_folder_id: folderId,
      p_search: search,
      p_pattern: search ? escapeLike(search) : '',
      p_limit: limit
    })
  ) as unknown as ItemRow[] | null;

  if (items === null) throw notFound('That vault does not exist.');
  res.json({ items });
});

const createItemSchema = z.object({
  title: itemTitleSchema,
  notes: z
    .string()
    .max(5_000, 'Notes can be at most 5000 characters.')
    .optional()
    .nullable(),
  values: valuesSchema.default({})
});

itemsRouter.post('/folders/:folderId/items', async (req, res) => {
  const folderId = parseId(req.params.folderId, 'vault');
  const body = createItemSchema.parse(req.body);
  const userId = req.user!.id;

  await assertFolder(userId, folderId);

  const columns = await loadColumns(folderId);
  assertKnownColumns(body.values, columns);
  assertRequiredColumns(body.values, columns, 'create');

  // Reserve the integer ID first so encrypted values can include it in their
  // context. `api_create_item` then inserts the row and its values atomically.
  const itemId = unwrap(await supabaseAdmin.rpc('api_reserve_item_id')) as unknown as number | null;
  if (!itemId) {
    throw new ApiError(500, 'ITEM_ID_FAILED', 'Could not create that entry.');
  }

  const values = columns.flatMap((column) => {
    const raw = body.values[column.id];
    if (!raw) return [];

    return [
      {
        columnId: column.id,
        value: column.isSecret
          ? encryptSecret(raw, `v1:${userId}:${itemId}:${column.id}`)
          : raw
      }
    ];
  });

  const item = unwrap(
    await supabaseAdmin.rpc('api_create_item', {
      p_user_id: userId,
      p_folder_id: folderId,
      p_item_id: itemId,
      p_title: body.title,
      p_notes: body.notes?.trim() ? body.notes : null,
      p_values: values
    })
  ) as unknown as ItemRow | null;

  if (!item) throw notFound('That vault does not exist.');
  res.status(201).json({ item });
});

itemsRouter.get('/items/:itemId', async (req, res) => {
  const itemId = parseId(req.params.itemId, 'entry');
  const item = await fetchItem(req.user!.id, itemId);
  res.json({ item });
});

const updateItemSchema = z
  .object({
    title: itemTitleSchema.optional(),
    notes: z
      .string()
      .max(5_000, 'Notes can be at most 5000 characters.')
      .nullable()
      .optional(),
    values: valuesSchema.optional()
  })
  .refine((value) => Object.keys(value).length > 0, { message: 'Nothing to update.' });

itemsRouter.patch('/items/:itemId', async (req, res) => {
  const itemId = parseId(req.params.itemId, 'entry');
  const body = updateItemSchema.parse(req.body);
  const userId = req.user!.id;

  const existing = unwrap(
    await supabaseAdmin
      .from('folder_items')
      .select('folder_id, folders!inner(status)')
      .eq('id', itemId)
      .eq('user_id', userId)
      .eq('status', 'active')
      .eq('folders.status', 'active')
      .maybeSingle()
  ) as { folder_id: number } | null;

  if (!existing) throw notFound('That entry does not exist.');

  const columns = await loadColumns(existing.folder_id);

  if (body.values) {
    assertKnownColumns(body.values, columns);
    assertRequiredColumns(body.values, columns, 'update');
  }

  const values: Array<{ columnId: number; value: string }> = [];
  const clearColumnIds: number[] = [];

  for (const [columnId, raw] of Object.entries(body.values ?? {})) {
    if (raw === '') {
      clearColumnIds.push(Number(columnId));
      continue;
    }

    const column = columns.find((entry) => entry.id === Number(columnId));
    if (!column) continue;

    values.push({
      columnId: column.id,
      value: column.isSecret
        ? encryptSecret(raw, `v1:${userId}:${itemId}:${columnId}`)
        : raw
    });
  }

  const updated = unwrap(
    await supabaseAdmin.rpc('api_update_item', {
      p_user_id: userId,
      p_item_id: itemId,
      p_update_title: body.title !== undefined,
      p_title: body.title ?? null,
      p_update_notes: body.notes !== undefined,
      p_notes: body.notes?.trim() ? body.notes : null,
      p_values: values,
      p_clear_column_ids: clearColumnIds
    })
  ) as unknown as ItemRow | null;

  if (!updated) throw notFound('That entry does not exist.');
  res.json({ item: updated });
});

itemsRouter.delete('/items/:itemId', async (req, res) => {
  const itemId = parseId(req.params.itemId, 'entry');

  // Deletion is soft: the row is archived so it disappears from the app while
  // the underlying record remains in the database.
  const folderId = unwrap(
    await supabaseAdmin.rpc('api_archive_item', {
      p_user_id: req.user!.id,
      p_item_id: itemId
    })
  ) as unknown as number | null;

  if (!folderId) throw notFound('That entry does not exist.');
  res.status(204).end();
});

itemsRouter.get('/items/:itemId/reveal/:columnId', async (req, res) => {
  const itemId = parseId(req.params.itemId, 'entry');
  const columnId = parseId(req.params.columnId, 'field');
  const userId = req.user!.id;

  const row = unwrap(
    await supabaseAdmin.rpc('api_reveal_value', {
      p_user_id: userId,
      p_item_id: itemId,
      p_column_id: columnId
    })
  ) as unknown as { value: string | null; isSecret: boolean } | null;

  if (!row || !row.value) {
    throw notFound('There is no value stored in that field.');
  }

  if (!row.isSecret) {
    res.json({ value: row.value });
    return;
  }

  try {
    const value = decryptSecret(row.value, `v1:${userId}:${itemId}:${columnId}`);
    res.json({ value });
  } catch {
    throw new ApiError(
      500,
      'DECRYPTION_FAILED',
      'This secret could not be decrypted. The encryption key may have changed.'
    );
  }
});
