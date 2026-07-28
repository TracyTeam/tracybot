import { defineConfig } from 'tsup';

export default defineConfig({
    entry: {
        'tracybot-cc-hook': 'src/index.ts',
    },
    format: ['esm'],
    outDir: 'dist',
    clean: true,
    outExtension({ format }) {
        return {
            js: `.js`
        }
    },
});
