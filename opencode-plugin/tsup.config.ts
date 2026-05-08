import { defineConfig } from 'tsup';

export default defineConfig({
    entry: {
        'tracybot-oc': 'src/index.ts',
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
