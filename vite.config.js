import { defineConfig } from 'vite';

export default defineConfig({
  // relative asset paths so the build works from any sub-path (e.g. GitHub Pages)
  base: './',
  // three.js alone is ~500 kB; that's expected
  build: { chunkSizeWarningLimit: 1024 },
  // Branch builds (tools/build_site.sh) keep their own saves and say which branch they are.
  define: {
    __SAVE_NAMESPACE__: JSON.stringify(process.env.SAVE_NAMESPACE ?? ''),
    __BRANCH_LABEL__: JSON.stringify(process.env.BRANCH_LABEL ?? ''),
  },
});
