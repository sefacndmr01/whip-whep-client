import tsPlugin from '@typescript-eslint/eslint-plugin';
import tsParser from '@typescript-eslint/parser';
import prettierPlugin from 'eslint-plugin-prettier';

// Read the canonical Prettier config once and pass it explicitly to the
// prettier/prettier rule. This prevents eslint-plugin-prettier from falling
// back to its own defaults (useTabs: false, tabWidth: 2) in ESLint flat-config
// mode, where automatic .prettierrc discovery is unreliable.
const prettierOptions = {
	useTabs: true,
	tabWidth: 4,
	semi: true,
	singleQuote: true,
	trailingComma: 'all',
	printWidth: 100,
	arrowParens: 'always',
	endOfLine: 'lf',
};

const sharedRules = {
	...tsPlugin.configs['recommended'].rules,
	// Delegate all formatting to Prettier. The explicit options object ensures
	// ESLint and the Prettier CLI always agree, regardless of config discovery.
	'prettier/prettier': ['error', prettierOptions],
	'@typescript-eslint/explicit-function-return-type': 'off',
	'@typescript-eslint/explicit-module-boundary-types': 'off',
	'@typescript-eslint/no-explicit-any': 'warn',
	'@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
	'@typescript-eslint/consistent-type-imports': ['error', { prefer: 'type-imports' }],
	'no-console': ['warn', { allow: ['warn', 'error'] }],
};

export default [
	// Source files
	{
		files: ['src/**/*.ts'],
		languageOptions: {
			parser: tsParser,
			parserOptions: {
				project: './tsconfig.json',
				ecmaVersion: 2022,
				sourceType: 'module',
			},
		},
		plugins: {
			'@typescript-eslint': tsPlugin,
			prettier: prettierPlugin,
		},
		rules: sharedRules,
	},

	// Test files – use tsconfig.test.json so the tests/ directory is included
	{
		files: ['tests/**/*.ts'],
		languageOptions: {
			parser: tsParser,
			parserOptions: {
				project: './tsconfig.test.json',
				ecmaVersion: 2022,
				sourceType: 'module',
			},
		},
		plugins: {
			'@typescript-eslint': tsPlugin,
			prettier: prettierPlugin,
		},
		rules: {
			...sharedRules,
			// Test files commonly cast private members for inspection
			'@typescript-eslint/no-explicit-any': 'off',
		},
	},

	{
		ignores: ['dist/**', 'node_modules/**', 'examples/**', 'coverage/**'],
	},
];
