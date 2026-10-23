import 'reflect-metadata';
import fs from 'node:fs';
import path from 'node:path';
import { Prisma } from '@prisma/client';
import cookieParser from 'cookie-parser';
import cors from 'cors';
import express, { type NextFunction, type Request, type Response } from 'express';
import helmet from 'helmet';
import { attemptsRouter, studentRouter } from './attempts/student.routes';
import { accountRouter } from './auth/account.routes';
import { authRouter } from './auth/auth.routes';
import { config } from './config';
import { HttpError } from './lib/http-error';
import { teacherRouter } from './teacher/teacher.routes';

export function createApp() {
  const app = express();

  const trustProxy = trustProxySetting(process.env.TRUST_PROXY);
  if (trustProxy !== undefined) app.set('trust proxy', trustProxy);
  app.disable('x-powered-by');
  app.use(helmet());
  app.use(
    cors({
      origin: config.frontendUrl, // only the Angular app
      credentials: true,
      methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
    }),
  );
  app.use(express.json({ limit: '5mb' }));
  app.use(cookieParser());

  app.get('/api/health', (_req, res) => {
    res.json({ ok: true });
  });

  app.use('/api/auth', authRouter);
  app.use('/api/account', accountRouter);
  app.use('/api/teacher', teacherRouter);
  app.use('/api/student', studentRouter);
  app.use('/api/attempts', attemptsRouter);

  app.use('/api', (_req, res) => {
    res.status(404).json({ message: 'Not found', code: 'NOT_FOUND' });
  });

  // Optional: serve the built Angular app from the same origin in production.
  if (config.frontendDistDir && fs.existsSync(config.frontendDistDir)) {
    const dir = path.resolve(config.frontendDistDir);
    app.use(
      helmet.contentSecurityPolicy({
        directives: { ...helmet.contentSecurityPolicy.getDefaultDirectives(), 'style-src': ["'self'", "'unsafe-inline'"] },
      }),
    );
    app.use(express.static(dir, { index: false, maxAge: '1h' }));
    app.get(/^(?!\/api\/).*/, (_req, res) => {
      res.sendFile(path.join(dir, 'index.html'));
    });
  }

  app.use(errorHandler);
  return app;
}

/**
 * TRUST_PROXY: a hop count ("1"), "true"/"false", or addresses/subnets ("loopback", "10.0.0.0/8"). Express reads
 * a plain string as addresses only, so "true" would crash at startup.
 */
export function trustProxySetting(value: string | undefined): boolean | number | string | undefined {
  const v = value?.trim();
  if (!v) return undefined;
  if (v.toLowerCase() === 'true') return true;
  if (v.toLowerCase() === 'false') return false;
  if (/^\d+$/.test(v)) return Number(v);
  return v;
}

function errorHandler(err: unknown, _req: Request, res: Response, _next: NextFunction) {
  if (err instanceof HttpError) {
    res.status(err.status).json({ message: err.message, code: err.code, details: err.details });
    return;
  }
  const e = err as { type?: string; status?: number; message?: string };
  if (e?.type === 'entity.parse.failed') {
    res.status(400).json({ message: 'Malformed JSON body', code: 'BAD_REQUEST' });
    return;
  }
  if (e?.type === 'entity.too.large') {
    res.status(413).json({ message: 'Request body is too large', code: 'TOO_LARGE' });
    return;
  }
  if (err instanceof Prisma.PrismaClientKnownRequestError) {
    if (err.code === 'P2002') {
      res.status(409).json({ message: 'That record already exists', code: 'DUPLICATE' });
      return;
    }
    if (err.code === 'P2003') {
      res.status(409).json({ message: 'This record is still in use', code: 'IN_USE' });
      return;
    }
    if (err.code === 'P2025') {
      res.status(404).json({ message: 'Not found', code: 'NOT_FOUND' });
      return;
    }
  }
  // CHECK constraints / triggers raised by PostgreSQL (SQLSTATE 23514).
  const msg = (err as Error)?.message ?? '';
  if (/check_violation|23514|violates check constraint|must have exactly 4 choices|only allowed on identification|cannot have choices|can be enrolled|not offered to the section/.test(msg)) {
    res.status(400).json({ message: 'The data breaks a database rule (check your questions and dates).', code: 'CONSTRAINT' });
    return;
  }
  console.error(err);
  res.status(500).json({ message: 'Something went wrong on the server', code: 'INTERNAL' });
}
