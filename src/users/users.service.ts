/**
 * People of a workspace: invitations (a one-time link, seven days), roles (admin, member,
 * viewer), disabling, password resets and changes. Tokens are stored hashed; the link itself
 * goes by mail when mail is set up, or is handed to the admin to pass on.
 */
import { Inject, Injectable, Logger } from '@nestjs/common';
import { randomBytes, createHmac } from 'node:crypto';
import { and, desc, eq, gt, isNull } from 'drizzle-orm';
import { AuthService, type Role, ROLES, type UserRow } from '../auth/auth.service.js';
import { hashPassword, verifyPassword } from '../auth/passwords.js';
import { newId } from '../common/ids.js';
import { invalid, LikhoError, notFound } from '../common/errors.js';
import { CONFIG, type Config } from '../config/config.js';
import { DbService } from '../db/db.module.js';
import { invitations, passwordResets, users, workspaceMembers } from '../db/schema.js';
import { MailService } from '../mail/mail.service.js';

export type InvitationRow = typeof invitations.$inferSelect;

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const INVITATION_DAYS = 7;
const RESET_HOURS = 2;

@Injectable()
export class UsersService {
  private readonly log = new Logger('users');

  constructor(
    @Inject(CONFIG) private readonly config: Config,
    private readonly dbs: DbService,
    private readonly auth: AuthService,
    private readonly mail: MailService,
  ) {}

  private get db() {
    return this.dbs.db;
  }

  private hashToken(token: string): string {
    return createHmac('sha256', this.config.SESSION_SECRET).update(token).digest('base64url');
  }

  /** The people of a workspace, newest first. */
  async list(workspaceId: string): Promise<UserRow[]> {
    const rows = await this.db
      .select({ user: users })
      .from(workspaceMembers)
      .innerJoin(users, eq(users.id, workspaceMembers.userId))
      .where(eq(workspaceMembers.workspaceId, workspaceId))
      .orderBy(desc(users.createdAt));
    return rows.map((r) => r.user);
  }

  async get(workspaceId: string, userId: string): Promise<UserRow> {
    const [row] = await this.db
      .select({ user: users })
      .from(workspaceMembers)
      .innerJoin(users, eq(users.id, workspaceMembers.userId))
      .where(and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.userId, userId)));
    if (!row) throw notFound('That person');
    return row.user;
  }

  // ---------------------------------------------------------------- invitations

  /** Makes an invitation. The link is mailed when mail is set up, and returned to the admin either way. */
  async invite(
    workspaceId: string,
    invitedBy: string | null,
    input: { email: string; name?: string; role: Role },
  ): Promise<{ invitation: InvitationRow; link: string; sent: boolean }> {
    const email = input.email.trim().toLowerCase();
    if (!EMAIL.test(email)) throw invalid('That is not an email address.');
    if (!ROLES.includes(input.role)) throw invalid('The role is admin, member or viewer.');
    const [existing] = await this.db.select({ id: users.id }).from(users).where(eq(users.email, email));
    if (existing) throw new LikhoError('conflict', 'A user with that email already exists.');
    // One open invitation per address: a new one replaces it.
    await this.db
      .update(invitations)
      .set({ revokedAt: new Date() })
      .where(
        and(
          eq(invitations.workspaceId, workspaceId),
          eq(invitations.email, email),
          isNull(invitations.acceptedAt),
          isNull(invitations.revokedAt),
        ),
      );

    const token = randomBytes(32).toString('base64url');
    const [invitation] = await this.db
      .insert(invitations)
      .values({
        id: newId('inv'),
        workspaceId,
        email,
        name: input.name?.trim() ?? '',
        role: input.role,
        tokenHash: this.hashToken(token),
        invitedBy,
        expiresAt: new Date(Date.now() + INVITATION_DAYS * 86_400_000),
      })
      .returning();
    const link = `${this.config.PUBLIC_ORIGIN}/invite/${token}`;
    const workspace = await this.auth.workspaceName(workspaceId);
    const sent = await this.mail.send({
      to: email,
      subject: `You are invited to ${workspace} on Likho`,
      text: `You have been invited to ${workspace} on Likho as ${input.role}.\n\nOpen this link to choose a password and sign in (it works for ${INVITATION_DAYS} days):\n${link}\n`,
    });
    this.log.log(
      `invited ${email} to ${workspaceId} as ${input.role} (${sent ? 'mailed' : 'link handed over'})`,
    );
    return { invitation: invitation!, link, sent };
  }

  async listInvitations(workspaceId: string): Promise<InvitationRow[]> {
    return this.db
      .select()
      .from(invitations)
      .where(eq(invitations.workspaceId, workspaceId))
      .orderBy(desc(invitations.createdAt))
      .limit(100);
  }

  async revokeInvitation(workspaceId: string, id: string): Promise<InvitationRow> {
    const [row] = await this.db
      .update(invitations)
      .set({ revokedAt: new Date() })
      .where(
        and(eq(invitations.id, id), eq(invitations.workspaceId, workspaceId), isNull(invitations.acceptedAt)),
      )
      .returning();
    if (!row) throw notFound('That invitation');
    return row;
  }

  /** What an invitation link is for, without accepting it (the page shows whom it is for). */
  async peekInvitation(
    token: string,
  ): Promise<{ email: string; name: string; role: string; workspace: string }> {
    const invitation = await this.openInvitation(token);
    return {
      email: invitation.email,
      name: invitation.name,
      role: invitation.role,
      workspace: await this.auth.workspaceName(invitation.workspaceId),
    };
  }

  private async openInvitation(token: string): Promise<InvitationRow> {
    const [invitation] = await this.db
      .select()
      .from(invitations)
      .where(
        and(
          eq(invitations.tokenHash, this.hashToken(token)),
          isNull(invitations.acceptedAt),
          isNull(invitations.revokedAt),
          gt(invitations.expiresAt, new Date()),
        ),
      );
    if (!invitation) throw new LikhoError('not_found', 'This invitation link is not valid any more.');
    return invitation;
  }

  /** The invited person chooses a name and a password: a user, a membership, and a session. */
  async accept(
    token: string,
    input: { name: string; password: string },
    userAgent = '',
  ): Promise<{ token: string; user: UserRow }> {
    const invitation = await this.openInvitation(token);
    const user = await this.auth.createUser({
      email: invitation.email,
      name: input.name || invitation.name,
      password: input.password,
      role: invitation.role as Role,
    });
    await this.auth.addMember(
      invitation.workspaceId,
      user.id,
      invitation.role === 'admin' ? 'owner' : 'member',
    );
    await this.db
      .update(invitations)
      .set({ acceptedAt: new Date() })
      .where(eq(invitations.id, invitation.id));
    this.log.log(`${user.email} accepted the invitation to ${invitation.workspaceId}`);
    return this.auth.login(user.email, input.password, userAgent);
  }

  // ---------------------------------------------------------------- roles and standing

  async setRole(workspaceId: string, actorId: string | null, userId: string, role: Role): Promise<UserRow> {
    if (!ROLES.includes(role)) throw invalid('The role is admin, member or viewer.');
    const user = await this.get(workspaceId, userId);
    if (user.id === actorId && role !== 'admin') throw invalid('You cannot take your own admin role away.');
    const [updated] = await this.db.update(users).set({ role }).where(eq(users.id, userId)).returning();
    await this.db
      .update(workspaceMembers)
      .set({ role: role === 'admin' ? 'owner' : 'member' })
      .where(and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.userId, userId)));
    return updated!;
  }

  /** A disabled person cannot sign in; their sessions end at once. */
  async disable(workspaceId: string, actorId: string | null, userId: string): Promise<UserRow> {
    if (userId === actorId) throw invalid('You cannot disable yourself.');
    await this.get(workspaceId, userId);
    const [updated] = await this.db
      .update(users)
      .set({ disabledAt: new Date() })
      .where(eq(users.id, userId))
      .returning();
    await this.auth.endSessionsOf(userId);
    return updated!;
  }

  async enable(workspaceId: string, userId: string): Promise<UserRow> {
    await this.get(workspaceId, userId);
    const [updated] = await this.db
      .update(users)
      .set({ disabledAt: null })
      .where(eq(users.id, userId))
      .returning();
    return updated!;
  }

  // ---------------------------------------------------------------- passwords

  /**
   * Makes a reset link for an address. Always answers the same, so an address cannot be probed;
   * the link is mailed when mail is set up, else logged for an admin to pass on (never returned).
   */
  async requestPasswordReset(email: string): Promise<void> {
    const address = email.trim().toLowerCase();
    const [user] = await this.db
      .select()
      .from(users)
      .where(and(eq(users.email, address), isNull(users.disabledAt)));
    if (!user) return;
    const token = randomBytes(32).toString('base64url');
    await this.db.insert(passwordResets).values({
      id: newId('prt'),
      userId: user.id,
      tokenHash: this.hashToken(token),
      expiresAt: new Date(Date.now() + RESET_HOURS * 3_600_000),
    });
    const link = `${this.config.PUBLIC_ORIGIN}/reset/${token}`;
    const sent = await this.mail.send({
      to: address,
      subject: 'Your Likho password',
      text: `Open this link to choose a new password (it works for ${RESET_HOURS} hours):\n${link}\n\nIf you did not ask for this, ignore it.\n`,
    });
    if (!sent)
      this.log.warn(
        `password reset asked for ${address}; mail is not set up - an admin can make a new invitation instead`,
      );
  }

  async resetPassword(
    token: string,
    password: string,
    userAgent = '',
  ): Promise<{ token: string; user: UserRow }> {
    if (password.length < 8) throw invalid('The password must be at least 8 characters.');
    const [reset] = await this.db
      .select()
      .from(passwordResets)
      .where(
        and(
          eq(passwordResets.tokenHash, this.hashToken(token)),
          isNull(passwordResets.usedAt),
          gt(passwordResets.expiresAt, new Date()),
        ),
      );
    if (!reset) throw new LikhoError('not_found', 'This reset link is not valid any more.');
    const [user] = await this.db
      .select()
      .from(users)
      .where(and(eq(users.id, reset.userId), isNull(users.disabledAt)));
    if (!user) throw new LikhoError('not_found', 'This reset link is not valid any more.');
    await this.db
      .update(users)
      .set({ passwordHash: await hashPassword(password) })
      .where(eq(users.id, user.id));
    await this.db.update(passwordResets).set({ usedAt: new Date() }).where(eq(passwordResets.id, reset.id));
    await this.auth.endSessionsOf(user.id);
    return this.auth.login(user.email, password, userAgent);
  }

  async changePassword(userId: string, current: string, next: string): Promise<void> {
    if (next.length < 8) throw invalid('The password must be at least 8 characters.');
    const [user] = await this.db.select().from(users).where(eq(users.id, userId));
    if (!user || !(await verifyPassword(current, user.passwordHash)))
      throw invalid('The current password is wrong.');
    await this.db
      .update(users)
      .set({ passwordHash: await hashPassword(next) })
      .where(eq(users.id, userId));
  }
}
