import { Router } from 'express';
import { z } from 'zod';
import { isUniqueViolation, supabaseAdmin, unwrap } from '../db.js';
import { ApiError, notFound } from '../lib/http.js';
import { parseId } from '../lib/validation.js';
import { folderNameSchema } from '../lib/validation.js';
import { requireAuth } from '../middleware/auth.js';
import {
  FOLDER_COLORS,
  FOLDER_ICONS,
  FOLDER_TEMPLATES,
  TEMPLATE_KEYS,
  type ColumnType
} from '../lib/templates.js';

export const foldersRouter = Router();

foldersRouter.use(requireAuth);

type FolderRow = {
  id: number;
  name: string;
  description: string | null;
  color: string;
  icon: string;
  status: 'active' | 'archived' | 'failed';
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
  itemCount: number;
  columnNames: string[];
};

type ColumnRow = {
  id: number;
  name: string;
  type: ColumnType;
  isSecret: boolean;
  isRequired: boolean;
  position: number;
};

const createFolderSchema = z.object({
  name: folderNameSchema,
  description: z
    .string()
    .trim()
    .max(240, 'Descriptions can be at most 240 characters.')
    .optional()
    .nullable(),
  color: z.enum([...FOLDER_COLORS]).default('olive'),
  icon: z.enum([...FOLDER_ICONS]).default('folder'),
  template: z.enum([...TEMPLATE_KEYS]).default('blank')
});

const updateFolderSchema = z
  .object({
    name: folderNameSchema.optional(),
    description: z
      .string()
      .trim()
      .max(240, 'Descriptions can be at most 240 characters.')
      .nullable()
      .optional(),
    color: z.enum([...FOLDER_COLORS]).optional(),
    icon: z.enum([...FOLDER_ICONS]).optional()
  })
  .refine((value) => Object.keys(value).length > 0, {
    message: 'Nothing to update.'
  });

export async function loadFolderWithColumns(
  userId: number,
  folderId: number
): Promise<FolderRow & { columns: ColumnRow[] }> {
  const folder = unwrap(
    await supabaseAdmin.rpc('api_get_folder', {
      p_user_id: userId,
      p_folder_id: folderId
    })
  ) as unknown as (FolderRow & { columns: ColumnRow[] }) | null;

  if (!folder) throw notFound('That vault does not exist.');
  return folder;
}

foldersRouter.get('/', async (req, res) => {
  const folders = unwrap(
    await supabaseAdmin.rpc('api_list_folders', { p_user_id: req.user!.id })
  ) as unknown as FolderRow[] | null;

  res.json({ folders: folders ?? [] });
});

foldersRouter.post('/', async (req, res) => {
  const body = createFolderSchema.parse(req.body);
  const userId = req.user!.id;
  const template = FOLDER_TEMPLATES[body.template];

  const columns = template.columns.map((column) => ({
    name: column.name,
    type: column.type,
    isSecret: column.isSecret ?? column.type === 'password',
    isRequired: column.isRequired ?? false
  }));

  let folderId: number | null;

  try {
    const created = unwrap(
      await supabaseAdmin.rpc('api_create_folder', {
        p_user_id: userId,
        p_name: body.name,
        p_description: body.description?.trim() ? body.description.trim() : null,
        p_color: body.color,
        p_icon: body.icon,
        p_columns: columns
      })
    ) as unknown as { id: number; status: 'active' | 'failed'; error?: string } | null;

    if (!created) {
      throw new ApiError(500, 'FOLDER_CREATE_FAILED', 'Could not create that vault.');
    }

    folderId = created.id;

    if (created.status !== 'active') {
      throw new ApiError(500, 'FOLDER_CREATE_FAILED', 'Could not create that vault.');
    }
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new ApiError(
        409,
        'FOLDER_NAME_TAKEN',
        'You already have a vault with this name. Try a slightly different one.'
      );
    }
    throw error;
  }

  if (!folderId) {
    throw new ApiError(500, 'FOLDER_CREATE_FAILED', 'Could not create that vault.');
  }

  const folder = await loadFolderWithColumns(userId, folderId);
  res.status(201).json({ folder });
});

foldersRouter.get('/:folderId', async (req, res) => {
  const folderId = parseId(req.params.folderId, 'vault');
  const folder = await loadFolderWithColumns(req.user!.id, folderId);
  res.json({ folder });
});

foldersRouter.patch('/:folderId', async (req, res) => {
  const folderId = parseId(req.params.folderId, 'vault');
  const body = updateFolderSchema.parse(req.body);
  const userId = req.user!.id;

  const updates: Record<string, unknown> = {};

  if (body.name !== undefined) updates.name = body.name;
  if (body.description !== undefined) {
    updates.description = body.description?.trim() ? body.description.trim() : null;
  }
  if (body.color !== undefined) updates.color = body.color;
  if (body.icon !== undefined) updates.icon = body.icon;

  try {
    const updated = unwrap(
      await supabaseAdmin
        .from('folders')
        .update(updates)
        .eq('id', folderId)
        .eq('user_id', userId)
        .eq('status', 'active')
        .select('id')
    ) as Array<{ id: number }> | null;

    if (!updated?.length) throw notFound('That vault does not exist.');
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new ApiError(409, 'FOLDER_NAME_TAKEN', 'You already have a vault with this name.');
    }
    throw error;
  }

  const folder = await loadFolderWithColumns(userId, folderId);
  res.json({ folder });
});

foldersRouter.delete('/:folderId', async (req, res) => {
  const folderId = parseId(req.params.folderId, 'vault');

  // Deleting a vault archives it: the row and its columns/entries stay in
  // Supabase, but the vault disappears from active reads.
  const archived = unwrap(
    await supabaseAdmin
      .from('folders')
      .update({ status: 'archived', archived_at: new Date().toISOString() })
      .eq('id', folderId)
      .eq('user_id', req.user!.id)
      .eq('status', 'active')
      .select('id')
  ) as Array<{ id: number }> | null;

  if (!archived?.length) throw notFound('That vault does not exist.');
  res.status(204).end();
});
