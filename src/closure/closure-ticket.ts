import { createHmac, timingSafeEqual } from 'crypto';

/**
 * Ticket de cierre de cuenta: lo firma auth-service cuando el cliente confirma
 * con su clave y el código por WhatsApp (auth-service/src/auth/cierre-ticket.ts).
 * Aquí solo se verifica; que sea de un solo uso lo garantiza closure_ticket_uses.
 *
 * Nunca es intercambiable con un token de acceso: otro secreto
 * (CLOSURE_TICKET_SECRET), otro tipo (closure_ticket) y otra audiencia
 * (account-service).
 */
export const CLOSURE_TICKET_TYPE = 'closure_ticket';
export const CLOSURE_TICKET_AUDIENCE = 'account-service';

export interface ClosureTicketPayload {
  sub: string;
  type: typeof CLOSURE_TICKET_TYPE;
  aud: typeof CLOSURE_TICKET_AUDIENCE;
  jti: string;
  iat: number;
  exp: number;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const sign = (data: string, secret: string) => createHmac('sha256', secret).update(data).digest();

/** null si no es un ticket de cierre válido (alg, firma, tipo, audiencia, jti o vencimiento). */
export function verifyClosureTicket(token: string, secret: string, now = Date.now()): ClosureTicketPayload | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  try {
    const header = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'));
    if (header?.alg !== 'HS256') return null;
    const expected = sign(`${parts[0]}.${parts[1]}`, secret);
    const received = Buffer.from(parts[2], 'base64url');
    if (expected.length !== received.length || !timingSafeEqual(expected, received)) return null;
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    if (payload?.type !== CLOSURE_TICKET_TYPE || payload?.aud !== CLOSURE_TICKET_AUDIENCE) return null;
    if (typeof payload.sub !== 'string' || typeof payload.jti !== 'string' || !UUID.test(payload.jti)) return null;
    if (typeof payload.exp !== 'number' || payload.exp * 1000 <= now) return null;
    return payload as ClosureTicketPayload;
  } catch {
    return null;
  }
}
