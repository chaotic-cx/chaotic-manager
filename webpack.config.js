const path = require("path");
const HtmlWebpackPlugin = require("html-webpack-plugin");

module.exports = {
    entry: "./src/public/logs.ts",
    module: {
        rules: [
            {
                test: /\.tsx?$/,
                use: "ts-loader",
                exclude: /node_modules/,
            },
            {
                test: /\.css$/i,
                use: ["style-loader", "css-loader"],
            },
        ],
    },
    resolve: {
        extensions: [".tsx", ".ts", ".js"],
    },
    output: {
        filename: "[contenthash].bundle.js",
        path: path.resolve(__dirname, "dist", "public"),
    },
    plugins: [
        new HtmlWebpackPlugin({
            // Also generate a test.html
            filename: "logs.html",
            template: "src/public/logs.html",
        }),
    ],
    mode: "production",
};
