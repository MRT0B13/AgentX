const SENSITIVE_KEYS = new Set([
  'TG_BOT_TOKEN',
  'TG_CHAT_ID',
  'X_API_KEY',
  'X_API_SECRET',
  'X_ACCESS_TOKEN',
  'X_ACCESS_SECRET',
  'apiKey',
  'wallet',
  'walletSecret',
  'wallet_secret',
  'PUMP_PORTAL_WALLET_SECRET',
  'mint',
  'secret',
  'privateKey',
  'private_key',
]);

export function redactSensitive(value: any): any {
  if (value === null || value === undefined) return value;
  if (typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((item) => redactSensitive(item));

  const result: Record<string, any> = {};
  for (const [key, val] of Object.entries(value)) {
    if (SENSITIVE_KEYS.has(key)) {
      result[key] = '[redacted]';
    } else {
      result[key] = redactSensitive(val);
    }
  }
  return result;
}
