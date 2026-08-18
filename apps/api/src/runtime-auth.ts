import { createCognitoTokenVerifier, type IdentityTokenVerifier } from '@planthepath/identity/src/cognito.js';
import type { RuntimeConfig } from './config.js';

export function createRuntimeIdentityVerifier(config: RuntimeConfig): IdentityTokenVerifier {
  if (config.cognito.userPoolId && config.cognito.clientId) {
    return createCognitoTokenVerifier({
      userPoolId: config.cognito.userPoolId,
      clientId: config.cognito.clientId,
    });
  }

  return {
    async verifyAccessToken(): Promise<never> {
      throw new Error('Cognito runtime authentication is not configured');
    },
  };
}
