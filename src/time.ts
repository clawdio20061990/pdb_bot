/** Human-readable "now" in the city's timezone, given to the model so it can resolve "Saturday 7pm". */
export function nowInZone(timeZone: string, now: Date = new Date()): string {
  const fmt = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  return `${fmt.format(now)} (${timeZone})`;
}

/** English name of a language code, e.g. 'pl' -> 'Polish'. */
export function languageName(code: string, inLanguage = 'en'): string {
  try {
    const name = new Intl.DisplayNames([inLanguage], { type: 'language' }).of(code);
    return name && name !== code ? name : code;
  } catch {
    return code;
  }
}
