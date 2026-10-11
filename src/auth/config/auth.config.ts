import { registerAs } from '@nestjs/config';

function requireString(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function requireSecret(name: string): string {
  const value = requireString(name);
  if (Buffer.byteLength(value, 'utf8') < 32) {
    throw new Error(`${name} must be at least 32 bytes long`);
  }
  return value;
}

function positiveInteger(name: string, fallback?: number): number {
  const raw = process.env[name]?.trim();
  if (raw === undefined || raw === '') {
    if (fallback === undefined) {
      throw new Error(`Missing required environment variable: ${name}`);
    }
    return fallback; // default is checked BEFORE any throwing lookup
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

export default registerAs('auth', () => {
  const accessTokenSecret = requireSecret('ACCESS_TOKEN_SECRET');
  const refreshTokenSecret = requireSecret('REFRESH_TOKEN_SECRET');

  if (accessTokenSecret === refreshTokenSecret) {
    throw new Error('ACCESS_TOKEN_SECRET and REFRESH_TOKEN_SECRET must differ');
  }

  return {
    accessTokenSecret,
    refreshTokenSecret,
    accessTokenTtlSeconds: positiveInteger('ACCESS_TOKEN_TTL_SECONDS', 900),
    refreshTokenTtlSeconds: positiveInteger('REFRESH_TOKEN_TTL_SECONDS', 2_592_000),
    issuer: requireString('JWT_ISSUER'),
    audience: requireString('JWT_AUDIENCE'),
  } as const;
});