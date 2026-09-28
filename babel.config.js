module.exports = {
  presets: ['@react-native/babel-preset'],
  plugins: [
    // Path alias `@/…` → `src/…`, mirroring tsconfig `paths`.
    [
      'module-resolver',
      {
        root: ['./src'],
        alias: { '@': './src' },
      },
    ],
    // reanimated's plugin MUST be listed last.
    'react-native-reanimated/plugin',
  ],
};
