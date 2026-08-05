import { supabaseAdmin } from '@infra/supabase/client.js';
import { AppError } from '@common/errors/index.js';
import { authRepo } from './repositories/auth.repository.js';

const BUCKET = 'avatars';

/**
 * Store a user's avatar in the public `avatars` bucket (keyed by user id) and
 * save its URL on the profile. Overwrites any previous avatar for the user.
 */
export async function uploadAvatar(
  userId: string,
  file: { buffer: Buffer; mimetype: string; originalname: string },
): Promise<string> {
  const ext = (file.originalname.split('.').pop() ?? 'png').toLowerCase().replace(/[^a-z0-9]/g, '') || 'png';
  const path = `${userId}/avatar.${ext}`;

  const { error } = await supabaseAdmin.storage.from(BUCKET).upload(path, file.buffer, {
    contentType: file.mimetype,
    upsert: true,
  });
  if (error) {
    throw new AppError(`Avatar upload failed: ${error.message}`, 502, 'AVATAR_UPLOAD_FAILED');
  }

  const { data } = supabaseAdmin.storage.from(BUCKET).getPublicUrl(path);
  // Cache-bust so clients pick up the new image at the stable path.
  const url = `${data.publicUrl}?v=${Date.now()}`;
  await authRepo.updateProfile(userId, { avatarUrl: url });
  return url;
}
