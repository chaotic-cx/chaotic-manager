import Notifier from '../src/notifier';
import TelegramBot from "node-telegram-bot-api";
import {describe, expect, test} from '@jest/globals';

describe('Notifier', () => {
    let notifier: Notifier;
    let mockSendMessage: jest.Mock;

    beforeEach(() => {
        process.env.TELEGRAM_BOT_TOKEN = 'test_token';
        process.env.TELEGRAM_CHAT_ID = 'test_chat_id';
        mockSendMessage = jest.fn();
        TelegramBot.prototype.sendMessage = mockSendMessage;
        notifier = new Notifier();
    });

    test('should throw an error if TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID are not set', () => {
        delete process.env.TELEGRAM_BOT_TOKEN;
        delete process.env.TELEGRAM_CHAT_ID;
        expect(() => new Notifier()).toThrowError("TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID must be set");
    });

    test('should send a message to the Telegram chat', async () => {
        const message = 'Test message';
        await notifier.notify(message);
        expect(mockSendMessage).toHaveBeenCalledWith(process.env.TELEGRAM_CHAT_ID, message);
    });

    test('should log an error if sending a message fails', async () => {
        const message = 'Test message';
        const error = new Error('Test error');
        mockSendMessage.mockRejectedValue(error);
        const consoleSpy = jest.spyOn(console, 'error').mockImplementation();
        await notifier.notify(message);
        expect(consoleSpy).toHaveBeenCalledWith('An error occurred:', error);
    });
});