import { soundApi } from './sound-api.mjs';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import fs from 'node:fs';
import path from 'node:path';

export default defineConfig({
  plugins: [
    react(),
    soundApi(),
    {
      name: 'video-renderer-api',
      configureServer(server) {
        server.middlewares.use('/__save-tsx', (req, res) => {
          if (req.method !== 'POST') {
            res.statusCode = 405;
            return res.end('POST required');
          }

          let body = '';
          req.setEncoding('utf8');

          req.on('data', chunk => body += chunk);

          req.on('end', () => {
            try {
              const data = JSON.parse(body);

              if (typeof data.code !== 'string' || !data.code.trim()) {
                throw new Error('TSX code is empty');
              }

              const target = path.join(process.cwd(), 'user-video.tsx');
              fs.writeFileSync(target, data.code);

              res.setHeader('Content-Type', 'application/json');
              res.end(JSON.stringify({ success: true }));
            } catch (error) {
              res.statusCode = 400;
              res.end(error.message);
            }
          });
        });
      }
    }
  ],
  server: {
    host: '0.0.0.0',
    port: 8781,
    strictPort: true,
    fs: { allow: ['..'] },
    watch: {
      ignored: ['**/user-video.tsx']
    }
  }
});
