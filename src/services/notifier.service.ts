import { to } from "await-to-js";
import { Context, type LoggerInstance, Service, type ServiceBroker } from "moleculer";
import ChaoticTelegramBot from "../telegram-bot";
import type { FailureNotificationParams, GenericNotificationParams, SuccessNotificationParams } from "../types";
import { MoleculerConfigCommonService } from "./moleculer.config";

/**
 * Notifier class to send messages to the implemented destinations.
 * Currently implemented is sending messages to a given Telegram chat.
 */
export class NotifierService extends Service {
    private readonly telegramBot: ChaoticTelegramBot | undefined;
    private readonly base_logs_url: string | undefined;
    private chaoticLogger: LoggerInstance = this.broker.getLogger("CHAOTIC");

    constructor(broker: ServiceBroker) {
        super(broker);

        if (process.env.TELEGRAM_BOT_TOKEN !== undefined && process.env.TELEGRAM_CHAT_ID !== undefined) {
            this.telegramBot = new ChaoticTelegramBot(
                {
                    telegramChatId: process.env.TELEGRAM_CHAT_ID,
                    telegramToken: process.env.TELEGRAM_BOT_TOKEN,
                },
                this.chaoticLogger,
            );
        }

        this.base_logs_url = process.env.LOGS_URL ? process.env.LOGS_URL : undefined;
        this.package_repos = process.env.PACKAGE_REPOS ? process.env.PACKAGE_REPOS : undefined;

        this.parseServiceSchema({
            name: "notifier",

            actions: {
                notifyPackages: this.createDeploymentNotification,
                notifyFailure: this.createFailedBuildNotification,
                notifyGeneric: this.createTrivialNotification,
            },
            ...MoleculerConfigCommonService,
        });
    }

    /**
     * Notifies the enabled targets with the given message.
     * @param params An object containing all necessary event metadata
     * @returns Resolves after each target has been notified successfully
     */
    private async notify(params: GenericNotificationParams): Promise<void> {
        try {
            if (this.telegramBot !== undefined) {
                void this.telegramBot.notify(params.message);
            }
        } catch (err) {
            this.chaoticLogger.error(`Failed sending general notification: ${err}`);
        }
    }

    /**
     * Creates a notification text for a deployment event.
     * @param ctx The Moleculer context object
     * @returns A promise that resolves when the notification is sent.
     */
    async createDeploymentNotification(ctx: Context): Promise<void> {
        const params = ctx.params as SuccessNotificationParams;
        try {
            let text = `*${params.event} from ${params.node?.match(/\b.*(?=-\w{5})\b/)}:*\n`;
            for (const pkg of params.packages) {
                text += ` > ${pkg.replace(/\.pkg.tar.zst$/, "")}\n`;
            }
            this.chaoticLogger.debug(`Sending deployment notification.`);
            this.chaoticLogger.debug(params);
            void this.createTrivialNotification({ message: text });
        } catch (err) {
            this.chaoticLogger.error(`Failed sending deployment notification: ${err}`);
        }
    }

    /**
     * Creates a notification text for a failed event.
     * @param ctx The Moleculer context object
     * @returns A promise that resolves when the notification is sent.
     */
    async createFailedBuildNotification(ctx: Context): Promise<void> {
        const params = ctx.params as FailureNotificationParams;
        try {
            let text = `${params.event} on ${params.node?.match(/\b.*(?=-\w{5})\b/)}:\n > ${params.pkgbase}`;

            if (this.base_logs_url !== undefined) {
                // We use the non-live logs URL here to preserve functionality on mobile devices.
                const base_logs_url_api = this.base_logs_url.split("logs.html")[0] + `api/logs`;
                const logsUrl = `${base_logs_url_api}/${params.pkgbase}/${params.timestamp}`;
                text += ` - [logs](${logsUrl})`;
            }

            // If we have a package_repos object, as well as a commit hash, we can add a link to the commit.
            // But only if it is either a GitHub or a GitLab repo as of now.
            if (params.commit !== undefined) {
                if (params.source_repo_url.includes("gitlab.com")) {
                    const commitUrl = `${params.source_repo_url}/-/commit/${params.commit}`;
                    text += ` - [commit](${commitUrl})\n`;
                } else if (params.source_repo_url.includes("github.com")) {
                    const commitUrl = `${params.source_repo_url}/commit/${params.commit}`;
                    text += ` - [commit](${commitUrl})\n`;
                }
            } else {
                text += "\n";
            }
            this.chaoticLogger.debug(`Sending failure notification.`);
            this.chaoticLogger.debug(params);
            void this.createTrivialNotification({ message: text });
        } catch (err) {
            this.chaoticLogger.error(`Failed sending build failure notification: ${err}`);
        }
    }

    /**
     * Helper function for sending a notification containing one string for the given event and logging
     * eventual errors gracefully.
     * @param ctx The Moleculer context object
     */
    async createTrivialNotification(ctx: Context | { message: string }): Promise<void> {
        let params: GenericNotificationParams;
        if (ctx instanceof Context) params = ctx.params as GenericNotificationParams;
        else params = ctx;

        this.chaoticLogger.debug(`Instructed to send this notification: '${params.message}'.`);
        this.chaoticLogger.debug(params);
        const [err]: [Error, undefined] | [null, void] = await to(this.notify({ message: params.message }));
        if (err) this.chaoticLogger.error(err);
    }
}
