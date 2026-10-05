/** The GraphQL shapes of people and invitations. */
import { Field, InputType, ObjectType, registerEnumType } from '@nestjs/graphql';

export enum RoleEnum {
  admin = 'admin',
  member = 'member',
  viewer = 'viewer',
}
registerEnumType(RoleEnum, {
  name: 'Role',
  description: 'admin manages people and settings; member works with recordings; viewer reads and searches.',
});

@ObjectType()
export class User {
  @Field() id: string;
  @Field() email: string;
  @Field() name: string;
  @Field(() => RoleEnum) role: RoleEnum;
  @Field() createdAt: Date;
  @Field(() => Date, { nullable: true, description: 'Set while the person cannot sign in.' })
  disabledAt: Date | null;
}

@ObjectType()
export class Invitation {
  @Field() id: string;
  @Field() email: string;
  @Field() name: string;
  @Field(() => RoleEnum) role: RoleEnum;
  @Field(() => String, { nullable: true }) invitedBy: string | null;
  @Field() createdAt: Date;
  @Field() expiresAt: Date;
  @Field(() => Date, { nullable: true }) acceptedAt: Date | null;
  @Field(() => Date, { nullable: true }) revokedAt: Date | null;
}

@ObjectType()
export class NewInvitation {
  @Field(() => Invitation) invitation: Invitation;
  @Field({ description: 'The link to pass on. It was also mailed when `sent` is true.' }) link: string;
  @Field({ description: 'Whether the link went out by mail (SMTP_URL is set).' }) sent: boolean;
}

@ObjectType({ description: 'What an invitation link is for, shown before it is accepted.' })
export class InvitationPreview {
  @Field() email: string;
  @Field() name: string;
  @Field(() => RoleEnum) role: RoleEnum;
  @Field() workspace: string;
}

@InputType()
export class InviteUserInput {
  @Field() email: string;
  @Field({ nullable: true }) name?: string;
  @Field(() => RoleEnum) role: RoleEnum;
}
