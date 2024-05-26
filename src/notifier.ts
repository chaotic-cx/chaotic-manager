import TelegramBot from "node-telegram-bot-api";

/**
 * Notifier class to send messages to the implemented destinations.
 * Currently implemented is sending messages to a given Telegram chat.
 */
class Notifier {
    private readonly token: string = ''
    private readonly chatId: string = ''
    bot: TelegramBot | undefined

    constructor() {
        if (process.env.TELEGRAM_BOT_TOKEN !== undefined && process.env.TELEGRAM_CHAT_ID !== undefined) {
            this.token = process.env.TELEGRAM_BOT_TOKEN
            this.chatId = process.env.TELEGRAM_CHAT_ID
            this.bot = new TelegramBot(this.token, {polling: false});
        }
    }

    /**
     * Notifies the enabled targets with the given message.
     *
     * @param message The message to be sent to each target
     * @returns Promise<void> Resolves after each target has been notified successfully
     */
    async notify(message: string): Promise<void> {
        try {
            if (this.bot !== undefined) {
                // While MarkdownV2 is the non-legacy parse mode, it is annoying to work with because
                // some characters like "-" in package names need to be escaped. We don't need the extra
                // features, so lets go with the simpler Markdown parse mode.
                await this.bot.sendMessage(this.chatId, message, {parse_mode: "Markdown"});
            }
        } catch (e) {
            console.error("An error occurred:", e)
        }
    }
}

export default Notifier;