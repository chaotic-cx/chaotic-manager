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
                // Properly escape markdown characters used in messages, because API requires it
                message = message.replaceAll(/-/g, '\\-')
                    .replaceAll(/>/g, '\\>')
                    .replaceAll(/\./g, '\\.')
                    .replaceAll(/=/g, '\\=')
                console.log(message)
                await this.bot.sendMessage(this.chatId, message, {parse_mode: "MarkdownV2"});
            }
        } catch (e) {
            console.error("An error occurred:", e)
        }
    }
}

export default Notifier;