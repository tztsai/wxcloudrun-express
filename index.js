import path from 'path';
import { fileURLToPath } from 'url';

import cors from 'cors';
import express from 'express';
import morgan from 'morgan';

import { init as initDB, Kv } from './db.js';
import { createSequelizeKvAdapter } from './ruminer/kvAdapter.js';
import { mountRuminerWeChatRoutes } from './ruminer/wechatRoutes.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const logger = morgan('tiny');

const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());
app.use(cors());
app.use(logger);

// 首页
app.get('/', async (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});



const port = process.env.PORT || 80;

async function bootstrap() {
  await initDB();

  const kv = createSequelizeKvAdapter({ Kv });
  const env = {
    ...process.env,
    RUMI_KV: kv,
  };
  const ctx = {
    waitUntil(promise) {
      Promise.resolve(promise).catch((err) => {
        console.error('waitUntil_error', err);
      });
    },
  };

  mountRuminerWeChatRoutes(app, { env, ctx });

  app.listen(port, () => {
    console.log('启动成功', port);
  });
}

bootstrap();
