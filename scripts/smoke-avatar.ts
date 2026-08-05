/* Live test of avatar upload to Supabase Storage. Run: npx tsx scripts/smoke-avatar.ts */
import { uploadAvatar } from '@modules/auth/avatar.js';
import { supabaseAdmin } from '@infra/supabase/client.js';
import { pool } from '@infra/db/pool.js';

// 1x1 transparent PNG.
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);

async function main() {
  const { rows } = await pool.query<{ id: string }>(`insert into core.profiles (full_name) values ('Avatar Tester') returning id`);
  const userId = rows[0]!.id;

  const url = await uploadAvatar(userId, { buffer: PNG, mimetype: 'image/png', originalname: 'me.png' });
  const { rows: prof } = await pool.query<{ avatar_url: string }>(`select avatar_url from core.profiles where id=$1`, [userId]);

  console.log('returned url:', url);
  console.log('profile avatar_url:', prof[0]?.avatar_url);

  const pass =
    url.includes(`/avatars/${userId}/avatar.png`) &&
    url.includes('?v=') &&
    prof[0]?.avatar_url === url;
  console.log(pass ? '✅ PASS' : '❌ FAIL');

  await supabaseAdmin.storage.from('avatars').remove([`${userId}/avatar.png`]);
  await pool.query(`delete from core.profiles where id=$1`, [userId]);
  console.log('cleaned up');
}

main().catch((e) => { console.error(e); process.exitCode = 1; }).finally(() => pool.end());
