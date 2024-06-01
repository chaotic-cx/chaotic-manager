import ChaoticTelegramBot from "./telegram-bot";

/**
 * Notifier class to send messages to the implemented destinations.
 * Currently implemented is sending messages to a given Telegram chat.
 */
export default class Notifier {
    private readonly telegramBot: ChaoticTelegramBot | undefined;

    constructor() {
        if (process.env.TELEGRAM_BOT_TOKEN !== undefined && process.env.TELEGRAM_CHAT_ID !== undefined) {
            this.telegramBot = new ChaoticTelegramBot({
                telegramChatId: process.env.TELEGRAM_CHAT_ID,
                telegramToken: process.env.TELEGRAM_BOT_TOKEN,
            });
        }
    }

    /**
     * Notifies the enabled targets with the given message.
     *
     * @param {string} message The message to be sent to each target
     * @returns {Promise<void>} Resolves after each target has been notified successfully
     */
    async notify(message: string): Promise<void> {
        if (this.telegramBot !== undefined) {
            void this.telegramBot.notify(message);
        }
    }
}
