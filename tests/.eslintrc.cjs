const path = require('path');

const backendNodeModules = path.resolve(__dirname, '../backend/node_modules');

module.exports = {
  root: true,
  parser: require.resolve('@typescript-eslint/parser', {
    paths: [backendNodeModules],
  }),
  parserOptions: {
    ecmaVersion: 'latest',
    sourceType: 'module',
  },
  env: {
    es2022: true,
    node: true,
  },
  plugins: ['@typescript-eslint'],
  extends: ['plugin:@typescript-eslint/recommended'],
  rules: {
    '@typescript-eslint/no-explicit-any': 'warn',
    '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
  },
};
