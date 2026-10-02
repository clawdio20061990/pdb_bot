/** Single-line JSON-ish logs; Render shows stdout/stderr in the Logs tab. */
function emit(level: 'info' | 'warn' | 'error', tag: string, msg: string, extra?: unknown): void {
  let line = `${level.toUpperCase()} [${tag}] ${msg}`;
  if (extra !== undefined) {
    try {
      line += ` :: ${JSON.stringify(extra)}`;
    } catch {
      line += ' :: [unserializable]';
    }
  }
  (level === 'info' ? console.log : console.error)(line);
}

export const log = {
  info: (tag: string, msg: string, extra?: unknown) => emit('info', tag, msg, extra),
  warn: (tag: string, msg: string, extra?: unknown) => emit('warn', tag, msg, extra),
  error: (tag: string, msg: string, extra?: unknown) => emit('error', tag, msg, extra),
};

export function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
