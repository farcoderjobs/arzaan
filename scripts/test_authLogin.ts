import mongoose from 'mongoose';
import { login as authLogin } from '@/lib/auth';

async function main() {
  const conn = await mongoose.connect(process.env.MONGODB_URI!, { dbName: process.env.MONGODB_DB_NAME! });
  try {
    const r = await authLogin('admin@pos.local', 'admin123');
    console.log('authLogin success:', JSON.stringify(r, null, 2));
  } catch (e) {
    console.error('authLogin ERROR:', e);
  }
  await conn.disconnect();
}
main().catch((e) => { console.error('FATAL', e); process.exit(1); });
