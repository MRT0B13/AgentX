import { auditEntrySchema } from '../model/launchPack.ts';
import { nowIso } from './time.ts';

export function appendAudit(log: unknown, message: string, actor = 'eliza') {
  const parsedLog = auditEntrySchema.array().catch([]).parse(log || []);
  const entry = { at: nowIso(), message, actor };
  return [...parsedLog, entry];
}
