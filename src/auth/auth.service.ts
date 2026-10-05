/**
 * Who is asking. Browsers carry a session cookie; scripts and connectors carry an API key.
 *
 * A session or key is looked up on every request (no JWT): revoking one takes effect at once,
 * and the table is tiny.
 */
import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { createHmac, randomBytes } from 'node:crypto';
import { and, eq, gt, isNull, lt } from 'drizzle-orm';
import { newId } from '../common/ids.js';
import { LikhoError, forbidden, invalid, notFound } from '../common/errors.js';
import { CONFIG, type Config } from '../config/config.js';
import { DbService } from '../db/db.module.js';
import { apiKeys, exchangedTokens, sessions, users, workspaceMembers, workspaces } from '../db/schema.js';
import { hashPassword, verifyPassword } from './passwords.js';

export const SESSION_COOKIE = 'likho_session';
const API_KEY_PREFIX = 'lk_';
/** A token an API key exchanged itself for: short-lived, read-only, for another system's browser. */
export const EXCHANGED_TOKEN_PREFIX = 'lt_';
const EXCHANGED_TOKEN_SECONDS = { least: 60, most: 3600, usual: 900 };

/** What a person may do: an admin manages people and settings, a member works with recordings, a viewer reads. */
export const ROLES = ['admin', 'member', 'viewer'] as const;
export type Role = (typeof ROLES)[number];
export const isRole = (value: unknown): value is Role => ROLES.includes(value as Role);

/** The person (or key) behind a request. */
export interface Principal {
  kind: 'user' | 'api_key';
  userId: string | null;
  email: string;
  name: string;
  role: Role;
  /** The workspace the request works in. */
  workspaceId: string;
  workspaceRole: 'owner' | 'member';
  sessionId?: string;
  apiKeyId?: string;
  /** Set when the request carries a token an API key exchanged itself for (read-only). */
  exchangedTokenId?: string;
  /** Where the request came from, for the audit log. */
  ip?: string;
}

export interface UserRow {
  id: string;
  email: string;
  name: string;
  role: string;
  createdAt: Date;
  disabledAt: Date | null;
}

@Injectable()
export class AuthService implements OnModuleInit {
  private readonly log = new Logger('auth');

  constructor(
    @Inject(CONFIG) private readonly config: Config,
    private readonly dbs: DbService,
  ) {}

  private get db() {
    return this.dbs.db;
  }

  /** The first start of a new installation: one admin and one workspace, from the environment. */
  async onModuleInit(): Promise<void> {
    const { BOOTSTRAP_ADMIN_EMAIL: email, BOOTSTRAP_ADMIN_PASSWORD: password } = this.config;
    if (!email || !password) return;
    const anyone = await this.db.select({ id: users.id }).from(users).limit(1);
    if (anyone.length > 0) return;
    const user = await this.createUser({
      email,
      name: this.config.BOOTSTRAP_ADMIN_NAME,
      password,
      role: 'admin',
    });
    const workspace = await this.createWorkspace(this.config.BOOTSTRAP_WORKSPACE_NAME, user.id);
    this.log.log(`created the first admin ${email} and workspace ${workspace.id}`);
  }

  private hashToken(token: string): string {
    return createHmac('sha256', this.config.SESSION_SECRET).update(token).digest('base64url');
  }

  // ---------------------------------------------------------------- users and workspaces

  async createUser(input: { email: string; name: string; password: string; role?: Role }): Promise<UserRow> {
    const email = input.email.trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw invalid('That is not an email address.');
    if (input.password.length < 8) throw invalid('The password must be at least 8 characters.');
    if (!input.name.trim()) throw invalid('A name is required.');
    const [existing] = await this.db.select({ id: users.id }).from(users).where(eq(users.email, email));
    if (existing) throw new LikhoError('conflict', 'A user with that email already exists.');
    const [row] = await this.db
      .insert(users)
      .values({
        id: newId('usr'),
        email,
        name: input.name.trim(),
        passwordHash: await hashPassword(input.password),
        role: input.role ?? 'member',
      })
      .returning();
    return row!;
  }

  async createWorkspace(name: string, ownerId: string): Promise<{ id: string; name: string }> {
    const [workspace] = await this.db
      .insert(workspaces)
      .values({ id: newId('wsp'), name })
      .returning();
    await this.db
      .insert(workspaceMembers)
      .values({ workspaceId: workspace!.id, userId: ownerId, role: 'owner' });
    return workspace!;
  }

  async addMember(workspaceId: string, userId: string, role: 'owner' | 'member' = 'member'): Promise<void> {
    await this.db.insert(workspaceMembers).values({ workspaceId, userId, role }).onConflictDoNothing();
  }

  // ---------------------------------------------------------------- sessions

  /** Checks the password and opens a session. Returns the cookie value. */
  async login(email: string, password: string, userAgent = ''): Promise<{ token: string; user: UserRow }> {
    const [user] = await this.db.select().from(users).where(eq(users.email, email.trim().toLowerCase()));
    // The same answer whether the email or the password is wrong.
    const wrong = new LikhoError('unauthenticated', 'The email or the password is wrong.');
    if (!user || user.disabledAt) throw wrong;
    if (!(await verifyPassword(password, user.passwordHash))) throw wrong;

    const token = randomBytes(32).toString('base64url');
    await this.db.insert(sessions).values({
      id: this.hashToken(token),
      userId: user.id,
      expiresAt: new Date(Date.now() + this.config.SESSION_DAYS * 86_400_000),
      userAgent: userAgent.slice(0, 200),
    });
    return { token, user };
  }

  async logout(sessionId: string): Promise<void> {
    await this.db.update(sessions).set({ revokedAt: new Date() }).where(eq(sessions.id, sessionId));
  }

  /** Ends every session of a person: after a disabling or a password reset. */
  async endSessionsOf(userId: string): Promise<void> {
    await this.db
      .update(sessions)
      .set({ revokedAt: new Date() })
      .where(and(eq(sessions.userId, userId), isNull(sessions.revokedAt)));
  }

  /** The principal behind a session cookie, or null. */
  async fromSession(token: string): Promise<Principal | null> {
    const id = this.hashToken(token);
    const [row] = await this.db
      .select({ user: users, session: sessions })
      .from(sessions)
      .innerJoin(users, eq(users.id, sessions.userId))
      .where(
        and(
          eq(sessions.id, id),
          isNull(sessions.revokedAt),
          gt(sessions.expiresAt, new Date()),
          isNull(users.disabledAt),
        ),
      );
    if (!row) return null;
    const membership = await this.firstMembership(row.user.id);
    if (!membership) return null;
    return {
      kind: 'user',
      userId: row.user.id,
      email: row.user.email,
      name: row.user.name,
      role: isRole(row.user.role) ? row.user.role : 'viewer',
      workspaceId: membership.workspaceId,
      workspaceRole: membership.role as 'owner' | 'member',
      sessionId: id,
    };
  }

  private async firstMembership(userId: string) {
    const [membership] = await this.db
      .select()
      .from(workspaceMembers)
      .where(eq(workspaceMembers.userId, userId))
      .orderBy(workspaceMembers.createdAt)
      .limit(1);
    return membership ?? null;
  }

  // ---------------------------------------------------------------- API keys

  /** Makes a key for scripts and connectors. The key is returned once and never stored. */
  async createApiKey(
    workspaceId: string,
    name: string,
    createdBy: string | null,
  ): Promise<{ id: string; key: string }> {
    if (!name.trim()) throw invalid('A name for the key is required.');
    const key = API_KEY_PREFIX + randomBytes(24).toString('base64url');
    const [row] = await this.db
      .insert(apiKeys)
      .values({ id: newId('key'), workspaceId, name: name.trim(), hash: this.hashToken(key), createdBy })
      .returning({ id: apiKeys.id });
    return { id: row!.id, key };
  }

  async revokeApiKey(workspaceId: string, id: string): Promise<void> {
    const changed = await this.db
      .update(apiKeys)
      .set({ revokedAt: new Date() })
      .where(and(eq(apiKeys.id, id), eq(apiKeys.workspaceId, workspaceId), isNull(apiKeys.revokedAt)))
      .returning({ id: apiKeys.id });
    if (changed.length === 0) throw notFound('The API key');
  }

  async listApiKeys(workspaceId: string) {
    return this.db
      .select({
        id: apiKeys.id,
        name: apiKeys.name,
        createdAt: apiKeys.createdAt,
        lastUsedAt: apiKeys.lastUsedAt,
        revokedAt: apiKeys.revokedAt,
      })
      .from(apiKeys)
      .where(eq(apiKeys.workspaceId, workspaceId))
      .orderBy(apiKeys.createdAt);
  }

  /** The principal behind an API key, or null. */
  async fromApiKey(key: string): Promise<Principal | null> {
    if (!key.startsWith(API_KEY_PREFIX)) return null;
    const [row] = await this.db
      .select({ key: apiKeys, workspace: workspaces })
      .from(apiKeys)
      .innerJoin(workspaces, eq(workspaces.id, apiKeys.workspaceId))
      .where(and(eq(apiKeys.hash, this.hashToken(key)), isNull(apiKeys.revokedAt)));
    if (!row) return null;
    // Last use is informational; not worth a write on every request.
    if (!row.key.lastUsedAt || Date.now() - row.key.lastUsedAt.getTime() > 60_000) {
      void this.db.update(apiKeys).set({ lastUsedAt: new Date() }).where(eq(apiKeys.id, row.key.id));
    }
    return {
      kind: 'api_key',
      userId: null,
      email: '',
      name: row.key.name,
      role: 'member',
      workspaceId: row.workspace.id,
      workspaceRole: 'member',
      apiKeyId: row.key.id,
    };
  }

  // ---------------------------------------------------------------- exchanged tokens

  /**
   * Hands an API key a short-lived viewer token for another system's browser (a reports portal
   * embedding the transcript beside a call). The token reads the key's workspace and cannot
   * change anything or make more tokens. ttlSeconds is held between a minute and an hour.
   */
  async exchange(
    me: Principal,
    subject: string,
    ttlSeconds: number = EXCHANGED_TOKEN_SECONDS.usual,
  ): Promise<{ token: string; expiresAt: Date }> {
    if (me.kind !== 'api_key' || !me.apiKeyId || me.exchangedTokenId) {
      throw forbidden('Only an API key can exchange itself for a token.');
    }
    if (
      !Number.isInteger(ttlSeconds) ||
      ttlSeconds < EXCHANGED_TOKEN_SECONDS.least ||
      ttlSeconds > EXCHANGED_TOKEN_SECONDS.most
    ) {
      throw invalid(
        `ttlSeconds is between ${EXCHANGED_TOKEN_SECONDS.least} and ${EXCHANGED_TOKEN_SECONDS.most}.`,
      );
    }
    const token = EXCHANGED_TOKEN_PREFIX + randomBytes(24).toString('base64url');
    const expiresAt = new Date(Date.now() + ttlSeconds * 1000);
    await this.db.insert(exchangedTokens).values({
      id: this.hashToken(token),
      workspaceId: me.workspaceId,
      apiKeyId: me.apiKeyId,
      subject: subject.trim().slice(0, 200),
      expiresAt,
    });
    // Tokens that ran out are of no use to anyone: a little housekeeping on every exchange.
    void this.db.delete(exchangedTokens).where(lt(exchangedTokens.expiresAt, new Date()));
    return { token, expiresAt };
  }

  /** The principal behind an exchanged token: a viewer of the key's workspace, or null. */
  async fromExchangedToken(token: string): Promise<Principal | null> {
    if (!token.startsWith(EXCHANGED_TOKEN_PREFIX)) return null;
    const id = this.hashToken(token);
    const [row] = await this.db
      .select({ token: exchangedTokens, key: apiKeys })
      .from(exchangedTokens)
      .innerJoin(apiKeys, eq(apiKeys.id, exchangedTokens.apiKeyId))
      .where(
        and(eq(exchangedTokens.id, id), gt(exchangedTokens.expiresAt, new Date()), isNull(apiKeys.revokedAt)),
      );
    if (!row) return null;
    return {
      kind: 'api_key',
      userId: null,
      email: '',
      name: row.token.subject ? `${row.token.subject} (${row.key.name})` : row.key.name,
      role: 'viewer',
      workspaceId: row.token.workspaceId,
      workspaceRole: 'member',
      apiKeyId: row.key.id,
      exchangedTokenId: id,
    };
  }

  async workspaceName(workspaceId: string): Promise<string> {
    const [row] = await this.db
      .select({ name: workspaces.name })
      .from(workspaces)
      .where(eq(workspaces.id, workspaceId));
    return row?.name ?? '';
  }
}
