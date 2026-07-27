import css from "@eslint/css";
import globals from "globals";
import js from "@eslint/js";
import stylistic from "@stylistic/eslint-plugin";
import { defineConfig } from "eslint/config";

export default defineConfig([
	{
		ignores: ["node_modules/**"]
	},
	{
		files: ["**/*.css"],
		plugins: { css },
		language: "css/css",
		extends: ["css/recommended"]
	},
	{
		files: ["**/*.js", "**/*.mjs"],
		extends: [js.configs.recommended, stylistic.configs.recommended],
		languageOptions: {
			ecmaVersion: "latest",
			sourceType: "commonjs",
			globals: {
				...globals.browser,
				...globals.node,
				Log: "readonly",
				MM: "readonly",
				Module: "readonly",
				config: "readonly",
				moment: "readonly"
			}
		},
		/*
		 * Style rules deliberately mirror MagicMirror² core's own
		 * eslint.config.mjs so this module reads like the project it plugs into.
		 */
		rules: {
			"@stylistic/arrow-parens": ["error", "always"],
			"@stylistic/brace-style": ["error", "1tbs", { allowSingleLine: true }],
			"@stylistic/comma-dangle": ["error", "never"],
			"@stylistic/indent": ["error", "tab"],
			"@stylistic/max-statements-per-line": ["error", { max: 2 }],
			"@stylistic/no-tabs": "off",
			"@stylistic/quote-props": ["error", "as-needed"],
			"@stylistic/quotes": ["error", "double"],
			"@stylistic/semi": ["error", "always"],
			"@stylistic/space-before-function-paren": ["error", "always"],
			eqeqeq: "error",
			"no-unused-vars": ["error", { caughtErrors: "none" }]
		}
	},
	{
		files: ["**/*.mjs"],
		languageOptions: { sourceType: "module" }
	}
]);
