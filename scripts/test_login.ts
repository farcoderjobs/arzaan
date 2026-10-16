import mongoose from 'mongoose';
import { config } from 'dotenv';
config({ path: '.env' }); // load .env into process.env

import { login } from '@/lib/auth';

async function main() {
  const conn = await mongoose.connect(process.env.MONGODB_URI!, { dbName: process.env.MONGODB_DB_NAME! });
  try {
    const r = await login('admin@pos.local', 'admin123');
    console.log('login success: user=', JSON.stringify(r.user), 'accessToken=', r.accessToken ? r.accessToken.slice(0, 20) + '...' : 'none');
  } catch (e) {
    console.error('login ERROR:', e);
  }
  await conn.disconnect();
}
main().catch((e) => { console.error('FATAL', e); process.exit(1); });
