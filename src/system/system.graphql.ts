import { Field, Float, ObjectType } from '@nestjs/graphql';

@ObjectType({ description: 'One service of the platform and whether it answers right now.' })
export class ServiceStatus {
  @Field() name: string;
  @Field({ description: 'Where likho-api reaches it.' }) address: string;
  @Field() ok: boolean;
  @Field({ description: 'What it said, or why it did not answer.' }) detail: string;
  @Field(() => Float, { description: 'How long the answer took, in milliseconds.' }) latencyMs: number;
}

@ObjectType()
export class SystemStatus {
  @Field({ description: 'likho-api’s version.' }) version: string;
  @Field(() => Date) checkedAt: Date;
  @Field(() => [ServiceStatus]) services: ServiceStatus[];
}
