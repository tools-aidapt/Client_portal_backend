// Helper to create / list ClickUp webhooks and reveal the signing secret.
//
// Usage:
//   node scripts/clickup-webhook.mjs list   --team 9012897228
//   node scripts/clickup-webhook.mjs create --team 9012897228 --endpoint https://host/api/v1/webhooks/clickup
//   node scripts/clickup-webhook.mjs delete --id <webhook-id>
//
// Reads CLICKUP_API_TOKEN from .env (or the environment). --team defaults to
// CLICKUP_TEAM_ID if set. On create, copy the printed `secret` into
// CLICKUP_WEBHOOK_SECRET in .env.

import 'dotenv/config';

const API = 'https://api.clickup.com/api/v2';
const DEFAULT_EVENTS = ['taskCreated', 'taskUpdated', 'taskStatusUpdated', 'taskDeleted'];

const token = process.env.CLICKUP_API_TOKEN;
if (!token) {
  console.error('❌ CLICKUP_API_TOKEN is not set. Add it to .env (ClickUp → Settings → Apps → API Token).');
  process.exit(1);
}

// --- tiny arg parser ---
const [command, ...rest] = process.argv.slice(2);
const args = {};
for (let i = 0; i < rest.length; i += 2) {
  if (rest[i]?.startsWith('--')) args[rest[i].slice(2)] = rest[i + 1];
}
const team = args.team ?? process.env.CLICKUP_TEAM_ID;

async function clickup(path, init = {}) {
  const res = await fetch(API + path, {
    ...init,
    headers: { Authorization: token, 'Content-Type': 'application/json', ...(init.headers ?? {}) },
  });
  const text = await res.text();
  let body;
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    body = { raw: text };
  }
  if (!res.ok) {
    console.error(`❌ ClickUp ${res.status}:`, JSON.stringify(body, null, 2));
    process.exit(1);
  }
  return body;
}

async function main() {
  switch (command) {
    case 'list': {
      if (!team) throw new Error('--team (or CLICKUP_TEAM_ID) is required');
      const { webhooks = [] } = await clickup(`/team/${team}/webhook`);
      if (webhooks.length === 0) {
        console.log('No webhooks registered for this workspace.');
        return;
      }
      for (const w of webhooks) {
        console.log(`\n• id:       ${w.id}`);
        console.log(`  endpoint: ${w.endpoint}`);
        console.log(`  events:   ${(w.events ?? []).join(', ')}`);
        console.log(`  health:   ${w.health?.status ?? 'unknown'}`);
        console.log(`  secret:   ${w.secret}`);
      }
      break;
    }
    case 'create': {
      if (!team) throw new Error('--team (or CLICKUP_TEAM_ID) is required');
      if (!args.endpoint) throw new Error('--endpoint https://.../api/v1/webhooks/clickup is required');
      const events = args.events ? args.events.split(',').map((e) => e.trim()) : DEFAULT_EVENTS;
      const out = await clickup(`/team/${team}/webhook`, {
        method: 'POST',
        body: JSON.stringify({ endpoint: args.endpoint, events }),
      });
      const secret = out.webhook?.secret ?? out.secret;
      console.log('✅ Webhook created.');
      console.log('   id:      ', out.webhook?.id ?? out.id);
      console.log('   events:  ', events.join(', '));
      console.log('\n   Add this to .env:\n');
      console.log(`   CLICKUP_WEBHOOK_SECRET=${secret}\n`);
      break;
    }
    case 'delete': {
      if (!args.id) throw new Error('--id <webhook-id> is required');
      await clickup(`/webhook/${args.id}`, { method: 'DELETE' });
      console.log(`✅ Deleted webhook ${args.id}`);
      break;
    }
    default:
      console.log('Usage: node scripts/clickup-webhook.mjs <list|create|delete> [--team ID] [--endpoint URL] [--id ID] [--events a,b,c]');
      process.exit(1);
  }
}

main().catch((e) => {
  console.error('❌', e.message);
  process.exit(1);
});
