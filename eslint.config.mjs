import eslint from "@eslint/js";
import eslintPluginDeprecation from "@eslint/js";
import eslintConfigPrettier from "eslint-config-prettier";
import tseslint from "typescript-eslint";
import eslintPluginTsdoc from "eslint-plugin-tsdoc";

export default tseslint.config(
    {
        files: ["src/*.ts"],
        extends: [
            eslint.configs.recommended,
            ...tseslint.configs.recommended,
            ...tseslint.configs.stylistic,
            eslintConfigPrettier,
        ],
        ignores: ["jest.config.ts"],
        languageOptions: {
            parser: tseslint.parser,
            parserOptions: {
                project: "./tsconfig.json",
                tsconfigRootDir: import.meta.dirname,
            },
        },
        linterOptions: {
            reportUnusedDisableDirectives: true,
        },
        plugins: {
            "eslint-plugin-tsdoc": eslintPluginTsdoc,
            deprecation: eslintPluginDeprecation,
        },
        rules: {
            ...eslintPluginDeprecation.configs.recommended.rules,
            "no-undef": "off",
        },
    },
    {
        // disable type-aware linting on JS files
        files: ["**/*.js"],
        ...tseslint.configs.disableTypeChecked,
    },
    {
        files: ["*.test.ts"],
        plugins: ["jest"],
        extends: ["plugin:jest/recommended"],
        rules: {
            "jest/no-focused-tests": "error",
            "jest/no-identical-title": "error",
            "jest/valid-expect": "error",
            "jest/max-expects": ["error", { max: 5 }],
            "jest/no-disabled-tests": "warn",
            "jest/prefer-to-have-length": "warn",
            "jest/prefer-expect-assertions": "off",
        },
    },
);
