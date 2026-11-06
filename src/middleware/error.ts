import type { ErrorRequestHandler, NextFunction, Request, RequestHandler, Response } from 'express';
import { ZodError } from 'zod';
import { isProduction } from '../env.js';
import { DbError } from '../db.js';
import { ApiError } from '../lib/http.js';

export const notFoundHandler: RequestHandler = (req, res) => {
  res.status(404).json({
    error: { code: 'NOT_FOUND', message: `No route matches ${req.method} ${req.path}.` }
  });
};

export const errorHandler: ErrorRequestHandler = (
  error: unknown,
  _req: Request,
  res: Response,
  _next: NextFunction
) => {
  if (res.headersSent) return;

  if (error instanceof ZodError) {
    res.status(422).json({
      error: {
        code: 'VALIDATION_ERROR',
        message: 'Some of the details need another look.',
        details: error.issues.map((issue) => ({
          path: issue.path.join('.'),
          message: issue.message
        }))
      }
    });
    return;
  }

  if (error instanceof ApiError) {
    res.status(error.status).json({
      error: { code: error.code, message: error.message, details: error.details }
    });
    return;
  }

  // Supabase/PostgREST error fallback (expected cases are handled in routes).
  if (error instanceof DbError) {
    if (error.postgrest.code === '23505') {
      res.status(409).json({
        error: { code: 'CONFLICT', message: 'That value is already in use.' }
      });
      return;
    }

    console.error('[db] Unhandled Supabase error:', error.postgrest);

    res.status(500).json({
      error: {
        code: 'DATABASE_ERROR',
        message: 'The database request failed. Please try again.',
        ...(isProduction ? {} : { debug: error.postgrest.message })
      }
    });
    return;
  }

  console.error('[api] Unhandled error:', error);

  res.status(500).json({
    error: {
      code: 'INTERNAL_ERROR',
      message: 'Something went wrong on our end. Please try again.',
      ...(isProduction ? {} : { debug: error instanceof Error ? error.message : String(error) })
    }
  });
};
