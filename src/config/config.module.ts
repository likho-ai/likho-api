import { DynamicModule, Global, Module } from '@nestjs/common';
import { CONFIG, Config, loadConfig } from './config.js';

@Global()
@Module({})
export class ConfigModule {
  /** Loads the settings from the environment, or takes them as given (tests). */
  static forRoot(config: Config = loadConfig()): DynamicModule {
    return {
      module: ConfigModule,
      providers: [{ provide: CONFIG, useValue: config }],
      exports: [CONFIG],
    };
  }
}
