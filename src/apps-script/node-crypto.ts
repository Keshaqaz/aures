// node:crypto in the Apps Script bundle. Of it the worker runs only tick's randomUUID.
import { appsScript } from './runtime.ts';

export const randomUUID = (): string => appsScript().Utilities.getUuid();
const unavailable = (): never => { throw new Error('node:crypto is not available on Apps Script'); };
export const createCipheriv = unavailable, createDecipheriv = unavailable, randomBytes = unavailable;
