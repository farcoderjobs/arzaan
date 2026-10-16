import mongoose from 'mongoose';
import { User } from '@/models/index';

async function main() {
  const conn = await mongoose.connect(process.env.MONGODB_URI!, { dbName: process.env.MONGODB_DB_NAME! });
  const u = await User.findOne({ email: 'admin@pos.local' }).select('+passwordHash');
  console.log('FOUND admin@pos.local:');
  console.log(JSON.stringify(u, null, 2));
  await conn.disconnect();
}
main().catch((e) => {
  console.error('FATAL', e);
  process.exit(1);
});
