import { type Api, GrammyError, type InlineKeyboard } from 'grammy';
import { clip, stripHtml } from '../html.js';
import { t } from '../i18n.js';
import { log } from '../log.js';

/**
 * Thin wrapper: HTML parse mode, no link previews, error classification.
 * Views keep messages short by clipping their plain-text parts; if Telegram still rejects the markup
 * or the length, the message is re-sent once as plain text so the user always gets it.
 */
export class Tg {
  constructor(
    readonly api: Api,
    /** Reader's language, for the AI-disclosure footer. */
    private readonly languageOf: (chatId: number) => Promise<string> = async () => 'en',
  ) {}

  /** EU AI Act transparency: every message the bot writes says that its text was generated with AI. */
  private async withFooter(chatId: number, text: string): Promise<string> {
    return `${text}\n\n<i>${t(await this.languageOf(chatId), 'ai_footer')}</i>`;
  }

  async send(chatId: number, body: string, keyboard?: InlineKeyboard): Promise<number> {
    const text = await this.withFooter(chatId, body);
    const extra = { link_preview_options: { is_disabled: true }, ...(keyboard ? { reply_markup: keyboard } : {}) };
    try {
      return (await this.api.sendMessage(chatId, text, { parse_mode: 'HTML', ...extra })).message_id;
    } catch (err) {
      if (!isBadMarkup(err)) throw err;
      log.warn('tg', 'HTML rejected, sending plain text', { chatId, error: describe(err) });
      return (await this.api.sendMessage(chatId, clip(stripHtml(text), 4000), extra)).message_id;
    }
  }

  /** Edit text (+ keyboard). "message is not modified" is not an error. Returns false when the edit was impossible. */
  async edit(chatId: number, messageId: number, body: string, keyboard?: InlineKeyboard): Promise<boolean> {
    const text = await this.withFooter(chatId, body);
    const extra = { link_preview_options: { is_disabled: true }, ...(keyboard ? { reply_markup: keyboard } : {}) };
    try {
      try {
        await this.api.editMessageText(chatId, messageId, text, { parse_mode: 'HTML', ...extra });
      } catch (err) {
        if (!isBadMarkup(err)) throw err;
        await this.api.editMessageText(chatId, messageId, clip(stripHtml(text), 4000), extra);
      }
      return true;
    } catch (err) {
      if (isNotModified(err)) return true;
      log.warn('tg', 'editMessageText failed', { chatId, messageId, error: describe(err) });
      return false;
    }
  }

  /** Replace (or remove, when keyboard is undefined) the inline keyboard of a message. */
  async setKeyboard(chatId: number, messageId: number, keyboard?: InlineKeyboard): Promise<void> {
    try {
      await this.api.editMessageReplyMarkup(chatId, messageId, keyboard ? { reply_markup: keyboard } : {});
    } catch (err) {
      if (!isNotModified(err)) log.warn('tg', 'editMessageReplyMarkup failed', { chatId, messageId, error: describe(err) });
    }
  }

  /** Send, but never throw (for best-effort notifications). */
  async trySend(chatId: number, text: string, keyboard?: InlineKeyboard): Promise<number | null> {
    try {
      return await this.send(chatId, text, keyboard);
    } catch (err) {
      log.warn('tg', 'sendMessage failed', { chatId, error: describe(err) });
      return null;
    }
  }
}

function isBadMarkup(err: unknown): boolean {
  return err instanceof GrammyError && err.error_code === 400 && /can't parse entities|message is too long|text is too long/i.test(err.description);
}

export function isNotModified(err: unknown): boolean {
  return err instanceof GrammyError && err.error_code === 400 && /message is not modified/i.test(err.description);
}

/** The recipient can't receive messages from the bot: never started it, blocked it, or deleted the account. */
export function isUnreachable(err: unknown): boolean {
  if (!(err instanceof GrammyError)) return false;
  if (err.error_code === 403) return true;
  return err.error_code === 400 && /chat not found|user not found|PEER_ID_INVALID/i.test(err.description);
}

/** Telegram errors worth retrying later (flood control, server errors); other 4xx are permanent. */
export function isTransientTelegramError(err: unknown): boolean {
  if (!(err instanceof GrammyError)) return true;
  return err.error_code === 429 || err.error_code >= 500;
}

export function describe(err: unknown): string {
  if (err instanceof GrammyError) return `${err.error_code} ${err.description}`;
  return err instanceof Error ? err.message : String(err);
}
