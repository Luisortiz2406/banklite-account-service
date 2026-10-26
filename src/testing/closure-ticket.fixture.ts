import { createHmac, randomUUID } from 'crypto';

/**
 * Firma tickets de cierre igual que auth-service (src/auth/cierre-ticket.ts),
 * con la posibilidad de alterar cualquier campo para las pruebas negativas.
 */
export const TEST_CLOSURE_SECRET = 'a1'.repeat(32);
export const TEST_JWT_SECRET = 'b2'.repeat(32);

const b64 = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url');

export function signTestToken(
  payload: Record<string, unknown>,
  secret: string,
  header: Record<string, unknown> = { alg: 'HS256', typ: 'JWT' },
): string {
  const unsigned = `${b64(header)}.${b64(payload)}`;
  return `${unsigned}.${createHmac('sha256', secret).update(unsigned).digest('base64url')}`;
}

export function signTestTicket(
  idUser: string,
  overrides: Record<string, unknown> = {},
  secret = TEST_CLOSURE_SECRET,
  now = Date.now(),
): string {
  const iat = Math.floor(now / 1000);
  return signTestToken(
    {
      sub: idUser,
      type: 'closure_ticket',
      aud: 'account-service',
      jti: randomUUID(),
      iat,
      exp: iat + 5 * 60,
      ...overrides,
    },
    secret,
  );
}
