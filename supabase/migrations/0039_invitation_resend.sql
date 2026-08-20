-- Tracks the last time an invitation's email was (re)sent, so the resend
-- endpoint can enforce a cooldown instead of letting an admin spam the same
-- inbox on every click. Null means "never reminded" — the original send at
-- creation time doesn't set this, only an explicit resend does.
alter table core.invitations add column if not exists last_reminded_at timestamptz;
