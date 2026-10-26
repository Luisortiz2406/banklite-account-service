import { randomUUID } from 'crypto';
import { signTestTicket, signTestToken, TEST_CLOSURE_SECRET, TEST_JWT_SECRET } from '../testing/closure-ticket.fixture';
import { verifyClosureTicket } from './closure-ticket';

const ANA = '11111111-1111-4111-8111-111111111111';

/** El ticket de cierre nunca es intercambiable con un token de acceso. */
describe('Ticket de cierre', () => {
  it('acepta un ticket firmado por auth con el secreto de cierre', () => {
    const payload = verifyClosureTicket(signTestTicket(ANA), TEST_CLOSURE_SECRET);
    expect(payload).toMatchObject({ sub: ANA, type: 'closure_ticket', aud: 'account-service' });
  });

  it('rechaza un ticket vencido', () => {
    const issued = Date.now() - 6 * 60 * 1000;
    expect(verifyClosureTicket(signTestTicket(ANA, {}, TEST_CLOSURE_SECRET, issued), TEST_CLOSURE_SECRET)).toBeNull();
  });

  it('rechaza un ticket firmado con otro secreto (p. ej. JWT_SECRET)', () => {
    expect(verifyClosureTicket(signTestTicket(ANA, {}, TEST_JWT_SECRET), TEST_CLOSURE_SECRET)).toBeNull();
  });

  it('rechaza un token de acceso, aunque esté firmado con el secreto de cierre', () => {
    const now = Math.floor(Date.now() / 1000);
    const access = { sub: ANA, type: 'access', jti: randomUUID(), iat: now, exp: now + 900 };
    expect(verifyClosureTicket(signTestToken(access, TEST_JWT_SECRET), TEST_CLOSURE_SECRET)).toBeNull();
    expect(verifyClosureTicket(signTestToken(access, TEST_CLOSURE_SECRET), TEST_CLOSURE_SECRET)).toBeNull();
  });

  it('rechaza otra audiencia, otro tipo o un jti que no es UUID', () => {
    for (const overrides of [{ aud: 'auth-service' }, { type: 'refresh' }, { jti: 'abc' }, { jti: undefined }]) {
      expect(verifyClosureTicket(signTestTicket(ANA, overrides), TEST_CLOSURE_SECRET)).toBeNull();
    }
  });

  it('rechaza alg "none" y tickets mal formados', () => {
    const now = Math.floor(Date.now() / 1000);
    const payload = { sub: ANA, type: 'closure_ticket', aud: 'account-service', jti: randomUUID(), exp: now + 60 };
    const none = signTestToken(payload, TEST_CLOSURE_SECRET, { alg: 'none', typ: 'JWT' });
    expect(verifyClosureTicket(none, TEST_CLOSURE_SECRET)).toBeNull();
    expect(verifyClosureTicket(`${none.split('.').slice(0, 2).join('.')}.`, TEST_CLOSURE_SECRET)).toBeNull();
    expect(verifyClosureTicket('no-es-un-jwt', TEST_CLOSURE_SECRET)).toBeNull();
  });
});
