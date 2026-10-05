/**
 * Small administrative commands, run against the same database as the service:
 *
 *   pnpm users:add --email a@b.c --name "Name" --password "..." [--role admin|member|viewer] [--workspace wsp_...]
 *
 * Without --workspace the user joins the first workspace; with none at all, one is created.
 * (--admin still works and means --role admin.) Day to day, admins invite people from the admin app instead.
 */
import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { parseArgs } from 'node:util';
import { appModule } from '../app.module.js';
import { AuthService, isRole } from '../auth/auth.service.js';
import { loadConfig } from '../config/config.js';
import { DbService } from '../db/db.module.js';
import { workspaces } from '../db/schema.js';

const [command, ...rest] = process.argv.slice(2);
if (command !== 'users:add') {
  console.error(
    'usage: likho-api users:add --email <email> --name <name> --password <password> [--role admin|member|viewer] [--workspace <id>]',
  );
  process.exit(2);
}
const { values } = parseArgs({
  args: rest,
  options: {
    email: { type: 'string' },
    name: { type: 'string' },
    password: { type: 'string' },
    role: { type: 'string' },
    admin: { type: 'boolean', default: false },
    workspace: { type: 'string' },
  },
});
if (!values.email || !values.name || !values.password) {
  console.error('--email, --name and --password are required');
  process.exit(2);
}
const role = values.role ?? (values.admin ? 'admin' : 'member');
if (!isRole(role)) {
  console.error('--role is admin, member or viewer');
  process.exit(2);
}

const config = loadConfig({ ...process.env, CONSUMERS_ENABLED: 'false' });
const app = await NestFactory.createApplicationContext(appModule(config), { logger: ['warn', 'error'] });
try {
  const auth = app.get(AuthService);
  const db = app.get(DbService).db;
  const user = await auth.createUser({
    email: values.email,
    name: values.name,
    password: values.password,
    role,
  });
  let workspaceId = values.workspace;
  if (!workspaceId) {
    const [first] = await db
      .select({ id: workspaces.id })
      .from(workspaces)
      .orderBy(workspaces.createdAt)
      .limit(1);
    workspaceId = first?.id ?? (await auth.createWorkspace(config.BOOTSTRAP_WORKSPACE_NAME, user.id)).id;
  }
  await auth.addMember(workspaceId, user.id, role === 'admin' ? 'owner' : 'member');
  console.log(`created ${user.role} ${user.email} (${user.id}) in workspace ${workspaceId}`);
} finally {
  await app.close();
}
