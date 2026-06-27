import 'dotenv/config';
import {
  getRuntimeConfig,
  resolveRuntimeEntrypoint,
  validateRuntimeConfig
} from './config/runtime-config.js';

const config = getRuntimeConfig();
validateRuntimeConfig(config);

await import(resolveRuntimeEntrypoint(config));
