import type { Request } from 'express';
import { z } from 'zod';

/** A route parameter (an id), validated: non-empty and at most 64 characters. */
export const param = (req: Request, name: string) => z.string().min(1).max(64).parse(req.params[name]);
