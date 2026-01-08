export function nowIso(): string {
  return new Date().toISOString();
}

export function addHoursIso(hours: number, base?: Date): string {
  const d = base ? new Date(base) : new Date();
  d.setUTCHours(d.getUTCHours() + hours);
  return d.toISOString();
}

// Round up to the next 10-minute boundary to keep schedules deterministic across retries.
export function nextRoundedBaseDate(): Date {
  const d = new Date();
  const minutes = d.getUTCMinutes();
  const remainder = minutes % 10;
  if (remainder !== 0) {
    const add = 10 - remainder;
    d.setUTCMinutes(minutes + add, 0, 0);
  } else if (d.getUTCSeconds() !== 0 || d.getUTCMilliseconds() !== 0) {
    d.setUTCSeconds(0, 0);
  }
  return d;
}
