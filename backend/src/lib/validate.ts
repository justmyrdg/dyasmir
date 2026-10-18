import 'reflect-metadata';
import { plainToInstance, type ClassConstructor } from 'class-transformer';
import { validate, type ValidationError } from 'class-validator';
import type { NextFunction, Request, Response } from 'express';
import { badRequest } from './http-error';

function flatten(errors: ValidationError[], parent = ''): string[] {
  const out: string[] = [];
  for (const e of errors) {
    const prop = parent ? `${parent}.${e.property}` : e.property;
    if (e.constraints) out.push(...Object.values(e.constraints).map((m) => (m.startsWith(e.property) ? `${prop}${m.slice(e.property.length)}` : `${prop}: ${m}`)));
    if (e.children?.length) out.push(...flatten(e.children, prop));
  }
  return out;
}

/** Validates and transforms a plain object into a DTO instance; throws 400 with messages on failure. */
export async function toDto<T extends object>(cls: ClassConstructor<T>, plain: unknown): Promise<T> {
  if (plain === null || typeof plain !== 'object' || Array.isArray(plain)) {
    throw badRequest('Request body must be a JSON object');
  }
  const instance = plainToInstance(cls, plain);
  const errors = await validate(instance, { whitelist: true, forbidNonWhitelisted: true });
  if (errors.length) throw badRequest('Validation failed', flatten(errors));
  return instance;
}

/** Express middleware: replaces req.body with the validated DTO. */
export function body<T extends object>(cls: ClassConstructor<T>) {
  return async (req: Request, _res: Response, next: NextFunction) => {
    req.body = await toDto(cls, req.body ?? {});
    next();
  };
}

export function intParam(value: unknown, name = 'id'): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) throw badRequest(`${name} must be a positive integer`);
  return n;
}

export function optionalIntQuery(value: unknown, name: string): number | undefined {
  if (value === undefined || value === '') return undefined;
  return intParam(value, name);
}
