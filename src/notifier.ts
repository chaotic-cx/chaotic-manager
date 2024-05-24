import TelegramBot from "node-telegram-bot-api";

/**
 * Notifier class to send messages to the implemented destinations.
 * Currently implemented is sending messages to a given Telegram chat.
 */
class Notifier {
    private readonly token: string = ''
    private readonly chatId: string = ''
    bot: TelegramBot

    constructor() {
        if (process.env.TELEGRAM_BOT_TOKEN !== undefined && process.env.TELEGRAM_CHAT_ID !== undefined) {
            this.token = process.env.TELEGRAM_BOT_TOKEN
            this.chatId = process.env.TELEGRAM_CHAT_ID
            this.bot = new TelegramBot(this.token, {polling: false});
        } else {
            throw new Error("TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID must be set")
        }
    }

    /**
     * Notifies the given Telegram Chat with the given message.
     *
     * @param message The message to send
     */
    async notify(message: string) {
        try {
            await this.bot.sendMessage(this.chatId, message);
        } catch (e) {
            console.error("An error occurred:", e)
        }
    }
}

export default Notifier;