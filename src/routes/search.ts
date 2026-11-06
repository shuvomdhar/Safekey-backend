import { Router } from 'express';
import { supabaseAdmin, unwrap } from '../db.js';
import { requireAuth } from '../middleware/auth.js';

export const searchRouter = Router();

searchRouter.use(requireAuth);

type SearchResult = {
  id: number;
  title: string;
  notes: string | null;
  folderId: number;
  folderName: string;
  folderColor: string;
  folderIcon: string;
  updatedAt: string;
  matchedField: string | null;
};

function escapeLike(value: string): string {
  return `%${value.replace(/[\\%_]/g, (character) => `\\${character}`)}%`;
}

/**
 * GET /api/search?q=…&limit=… — search entries across every active vault.
 *
 * Only titles, notes and non-secret values are matched; secret values are never
 * included in the pattern or the response.
 */
searchRouter.get('/search', async (req, res) => {
  const query =
    typeof req.query.q === 'string' ? req.query.q.trim().slice(0, 120) : '';

  if (query.length < 2) {
    res.json({ items: [] });
    return;
  }

  const limit = Math.min(
    Math.max(Number.parseInt(String(req.query.limit ?? '20'), 10) || 20, 1),
    100
  );

  const items = unwrap(
    await supabaseAdmin.rpc('api_search_items', {
      p_user_id: req.user!.id,
      p_pattern: escapeLike(query),
      p_limit: limit
    })
  ) as unknown as SearchResult[] | null;

  res.json({ items: items ?? [] });
});
