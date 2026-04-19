import js from '@eslint/js';
import globals from 'globals';

const sharedRules = {
    'no-unused-vars': ['warn', {
        args: 'after-used',
        argsIgnorePattern: '^_',
        varsIgnorePattern: '^_',
        caughtErrorsIgnorePattern: '^_'
    }],
    'no-console': 'off',
    'no-empty': ['warn', { allowEmptyCatch: true }],
    'no-constant-condition': ['warn', { checkLoops: false }],
    'no-prototype-builtins': 'off',
    'no-inner-declarations': 'off',
    'no-control-regex': 'off',
    'no-cond-assign': ['warn', 'except-parens'],
    'no-useless-escape': 'warn',
    'prefer-const': ['warn', { destructuring: 'all' }],
    'no-var': 'warn',
    eqeqeq: ['warn', 'always', { null: 'ignore' }]
};

export default [
    {
        ignores: [
            'node_modules/**',
            'dist/**',
            'bin/demo/**',
            'Sample/**',
            'src/viewer/public/netlog-viewer/**',
            'coverage/**',
            '**/*.min.js'
        ]
    },
    js.configs.recommended,
    {
        files: [
            'src/core/**/*.js',
            'src/inputs/*.js',
            'src/inputs/utilities/**/*.js',
            'src/outputs/**/*.js',
            'src/platforms/*.js'
        ],
        languageOptions: {
            ecmaVersion: 'latest',
            sourceType: 'module',
            globals: {
                ...globals.browser,
                ...globals.node,
                ...globals.worker
            }
        },
        rules: sharedRules
    },
    {
        files: [
            'src/renderer/**/*.js',
            'src/platforms/browser/**/*.js',
            'src/viewer/**/*.js',
            'src/demo/**/*.js',
            'src/embed/**/*.js'
        ],
        languageOptions: {
            ecmaVersion: 'latest',
            sourceType: 'module',
            globals: { ...globals.browser }
        },
        rules: sharedRules
    },
    {
        files: [
            'src/platforms/node/**/*.js',
            'src/inputs/cli/**/*.js',
            'bin/**/*.js',
            'scripts/**/*.js',
            'vite.*.config.js',
            'vitest.config.js',
            'eslint.config.js'
        ],
        languageOptions: {
            ecmaVersion: 'latest',
            sourceType: 'module',
            globals: { ...globals.node }
        },
        rules: sharedRules
    },
    {
        files: ['src/viewer/public/sw.js'],
        languageOptions: {
            ecmaVersion: 'latest',
            sourceType: 'script',
            globals: { ...globals.serviceworker }
        },
        rules: sharedRules
    },
    {
        files: ['cloudflare-worker/**/*.js'],
        languageOptions: {
            ecmaVersion: 'latest',
            sourceType: 'module',
            globals: {
                ...globals.worker,
                addEventListener: 'readonly',
                fetch: 'readonly',
                Response: 'readonly',
                Request: 'readonly',
                Headers: 'readonly',
                URL: 'readonly',
                ReadableStream: 'readonly',
                TextDecoder: 'readonly',
                TextEncoder: 'readonly',
                crypto: 'readonly'
            }
        },
        rules: sharedRules
    },
    {
        files: ['tests/**/*.js'],
        languageOptions: {
            ecmaVersion: 'latest',
            sourceType: 'module',
            globals: { ...globals.node, ...globals.browser }
        },
        rules: sharedRules
    }
];
