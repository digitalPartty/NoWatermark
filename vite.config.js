import { defineConfig } from 'vite';

export default defineConfig({
  // 相对路径，保证 dist 可部署到任意静态托管的任意子路径
  base: './',
  build: {
    outDir: 'dist',
    target: 'es2018',
  },
});
