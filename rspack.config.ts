import HtmlWebpackPlugin from "html-webpack-plugin";
import { defineConfig } from "@rspack/cli";
import { resolve } from "node:path";

export default defineConfig({
    entry: "./src/public/logs.ts",
    experiments: {
        css: true,
    },
    module: {
        rules: [
            {
                test: /\.ts?$/,
                exclude: [/node_modules/],
                loader: "builtin:swc-loader",
                options: {
                    jsc: {
                        parser: {
                            syntax: "typescript",
                        },
                    },
                },
                type: "javascript/auto",
            },
        ],
    },
    resolve: {
        extensions: [".ts", ".js"],
    },
    devtool: false,
    output: {
        filename: "[contenthash].bundle.js",
        path: resolve("dist", "public"),
    },
    performance: {
        maxEntrypointSize: 500000,
        maxAssetSize: 500000,
    },
    plugins: [
        new HtmlWebpackPlugin({
            filename: "logs.html",
            template: "src/public/logs.html",
        }),
    ],
    mode: "production",
});
