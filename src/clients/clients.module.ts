/**
 * The other services, called over gRPC (Connect clients; the Python services are plain gRPC
 * servers and likho-media is a Connect server, both speak HTTP/2 without TLS).
 */
import { Global, Inject, Injectable, Module } from '@nestjs/common';
import { Client, Code, ConnectError, createClient } from '@connectrpc/connect';
import { createGrpcTransport } from '@connectrpc/connect-node';
import { LanguageService } from '@likho-ai/contracts/language/v1/language_pb';
import { MediaService } from '@likho-ai/contracts/media/v1/media_pb';
import { TranscriptionService } from '@likho-ai/contracts/transcription/v1/transcription_pb';
import { LikhoError } from '../common/errors.js';
import { CONFIG, type Config } from '../config/config.js';

export type MediaClient = Client<typeof MediaService>;
export type TranscriptionClient = Client<typeof TranscriptionService>;
export type LanguageClient = Client<typeof LanguageService>;

@Injectable()
export class Clients {
  readonly media: MediaClient;
  readonly transcription: TranscriptionClient;
  readonly language: LanguageClient;

  constructor(@Inject(CONFIG) config: Config) {
    const transport = (address: string) =>
      createGrpcTransport({
        baseUrl: `http://${address}`,
        defaultTimeoutMs: config.RPC_TIMEOUT_SECONDS * 1000,
      });
    this.media = createClient(MediaService, transport(config.MEDIA_GRPC_ADDR));
    this.transcription = createClient(TranscriptionService, transport(config.TRANSCRIPTION_GRPC_ADDR));
    this.language = createClient(LanguageService, transport(config.LANGUAGE_GRPC_ADDR));
  }
}

/** Turns a failed call into the error a person should see. */
export function fromRpc(error: unknown, service: string): LikhoError {
  if (error instanceof ConnectError) {
    switch (error.code) {
      case Code.NotFound:
        return new LikhoError('not_found', error.rawMessage);
      case Code.InvalidArgument:
      case Code.FailedPrecondition:
        return new LikhoError('invalid', error.rawMessage);
      case Code.Unavailable:
      case Code.DeadlineExceeded:
        return new LikhoError(
          'service_unavailable',
          `The ${service} service is not answering right now. Try again.`,
        );
      default:
        return new LikhoError(
          'service_unavailable',
          `The ${service} service could not complete the request.`,
        );
    }
  }
  return new LikhoError('service_unavailable', `The ${service} service could not be reached.`);
}

@Global()
@Module({
  providers: [Clients],
  exports: [Clients],
})
export class ClientsModule {}
