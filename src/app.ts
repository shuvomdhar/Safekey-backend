import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import { rateLimit } from 'express-rate-limit';
import { env, isProduction, supabaseAuthConfigured } from './env.js';
import { supabaseAdmin } from './db.js';
import { authRouter } from './routes/auth.js';
import { foldersRouter } from './routes/folders.js';
import { columnsRouter } from './routes/columns.js';
import { itemsRouter } from './routes/items.js';
import { searchRouter } from './routes/search.js';
import { requireAuth } from './middleware/auth.js';
import { errorHandler, notFoundHandler } from './middleware/error.js';

const errorBody = (code: string, message: string) => ({ error: { code, message } });

export function createApp() {
  const app = express();

  // Trust the first proxy (Render, Railway, Fly, Vercel…) so rate limiting sees
  // the real client address.
  app.set('trust proxy', 1);
  app.disable('x-powered-by');

  app.use(
    helmet({
      crossOriginResourcePolicy: { policy: 'cross-origin' },
      contentSecurityPolicy: false
    })
  );

  app.use(
    cors({
      origin: env.FRONTEND_URL,
      methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
      allowedHeaders: ['Content-Type', 'Authorization'],
      maxAge: 86_400
    })
  );

  app.use(express.json({ limit: '128kb' }));

  const globalLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: isProduction ? 600 : 5_000,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    message: errorBody('RATE_LIMITED', 'Too many requests. Please slow down and try again shortly.')
  });

  app.use('/api', globalLimiter);

  app.get('/api/health', async (_req, res) => {
    try {
      const { error } = await supabaseAdmin
        .from('users')
        .select('id', { head: true, count: 'exact' })
        .limit(1);
      if (error) throw error;
      res.json({ status: 'ok', database: 'up', uptime: Math.round(process.uptime()) });
    } catch {
      res.status(503).json({ status: 'degraded', database: 'down' });
    }
  });

  // Public, non-secret runtime configuration for the browser.
  app.get('/api/config', (_req, res) => {
    res.json({
      appName: 'Safekey',
      googleEnabled: supabaseAuthConfigured
    });
  });

  // Authentication is handled by Supabase in the browser. Every route below
  // verifies the bearer access token before touching the database.
  app.use('/api/auth', authRouter);
  app.use('/api/folders', requireAuth, foldersRouter);
  app.use('/api', requireAuth, columnsRouter);
  app.use('/api', requireAuth, itemsRouter);
  app.use('/api', requireAuth, searchRouter);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
