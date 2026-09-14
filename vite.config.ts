import react from '@vitejs/plugin-react'
import path from 'path'
import { defineConfig } from 'vite'
import dts from 'vite-plugin-dts'
import federation from '@originjs/vite-plugin-federation'

export default defineConfig({
  base: './',
  plugins: [
    react(),
    dts({
      insertTypesEntry: true,
    }),
    federation({
      name: 'xrift_xrift_item_super_cub',
      filename: 'remoteEntry.js',
      exposes: {
        './Item': './src/index.tsx',
      },
      // shared は必ずホストが提供する実体を使う。
      // requiredVersion に狭い範囲を書くと、ホストが更新された時点で
      // アイテム同梱の __federation_shared_*.js へフォールバックするが、
      // その共有チャンクは配信されないためアイテムごと読み込めなくなる。
      // strictVersion は生成される実行時コードから参照されないので効かない。
      shared: {
        react: {
          singleton: true,
          requiredVersion: '*',
        },
        'react-dom': {
          singleton: true,
          requiredVersion: '*',
        },
        'react-dom/client': {
          singleton: true,
        },
        'react/jsx-runtime': {
          singleton: true,
        },
        three: {
          singleton: true,
          requiredVersion: '*',
        },
        'three/addons/loaders/DRACOLoader.js': {
          singleton: true,
          version: '0.0.0',
        },
        '@react-three/fiber': {
          singleton: true,
          requiredVersion: '*',
        },
        '@react-three/rapier': {
          singleton: true,
          requiredVersion: '*',
        },
        '@react-three/drei': {
          singleton: true,
          requiredVersion: '*',
        },
        '@react-three/uikit': {
          singleton: true,
          requiredVersion: '*',
        },
        '@pmndrs/uikit': {
          singleton: true,
          requiredVersion: '*',
        },
        '@xrift/world-components': {
          singleton: true,
          requiredVersion: '*',
        },
      },
    }),
  ],
  build: {
    target: 'esnext',
    minify: false,
    cssCodeSplit: false,
    assetsDir: '',
  },
  resolve: {
    alias: {
      '~': path.resolve(__dirname, './src'),
    },
  },
  define: {
    global: 'globalThis',
  },
})
