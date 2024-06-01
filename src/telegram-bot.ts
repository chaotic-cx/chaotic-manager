import TelegramBot from "node-telegram-bot-api";

/**
 * Class for instantiating a Telegram bot, which can be used to query
 * information Chaotic Manager and connected services.
 */
export default class ChaoticTelegramBot {
    protected telegramToken: string;
    protected telegramChatId: string;
    protected validChatIds: string[];
    private readonly bot: TelegramBot;

    constructor({
        telegramToken,
        telegramChatId,
        validChatIds,
    }: {
        telegramToken: string;
        telegramChatId: string;
        validChatIds?: string[];
    }) {
        this.telegramToken = telegramToken;
        this.telegramChatId = telegramChatId;
        this.validChatIds = validChatIds ?? [];
        this.bot = new TelegramBot(telegramToken, { polling: true });

        if (this.validChatIds.length > 0) {
            void this.setupListeners();
        }
    }

    /**
     * Formats the given message for Telegram to prevent Markdown formatting issues.
     *
     * @param message The message to be formatted
     * @returns The MarkdownV2 compliant string
     */
    private formatMarkdownV2(message: string): string {
        return message.replaceAll(/-/g, "\\-").replaceAll(/>/g, "\\>").replaceAll(/\./g, "\\.").replaceAll(/=/g, "\\=");
    }

    /**
     * Checks if the given chat ID is allowed to send admin commands to the bot.
     *
     * @param chat The chat against which to check the ID
     * @returns True if the chat ID is allowed to send messages, false otherwise
     */
    private isAllowedChat(chat: TelegramBot.Chat): boolean {
        return this.validChatIds.includes(chat.id.toString());
    }

    /**
     * Notifies the enabled targets with the given message.
     *
     * @param message The message to be sent to each target
     * @returns A promise that resolves after each target has been notified successfully
     */
    async notify(message: string): Promise<void> {
        try {
            if (this.bot !== undefined) {
                await this.bot.sendMessage(this.telegramChatId, this.formatMarkdownV2(message), {
                    parse_mode: "MarkdownV2",
                });
            }
        } catch (e) {
            console.error("An error occurred:", e);
        }
    }

    /**
     * Sets up the chat listeners for the bot.
     *
     * @returns A promise that resolves after the listeners have been set up
     */
    async setupListeners(): Promise<void> {
        this.bot.on("message", (msg: TelegramBot.Message): void => {
            if (this.isAllowedChat(msg.chat)) {
                console.error("Unauthorized user tried to send a message");
                return;
            } else {
                this.bot.sendMessage(msg.chat.id, "Received your message");
            }
        });
    }
}
