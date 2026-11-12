import { NotFoundException } from '@nestjs/common';
import { ClosureAlertsController } from '../closure/closure-alerts.controller';
import { ClosureAlertsService } from '../closure/closure-alerts.service';
import { ClosureController } from '../closure/closure.controller';
import { ClosureService } from '../closure/closure.service';
import { InternalKeyGuard } from '../common/guards/internal-key.guard';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { StaffAuthGuard } from '../common/staff/staff-auth.guard';
import { InternalKeysController, KeysController } from '../keys/keys.controller';
import { KeysService } from '../keys/keys.service';
import { AccountsController } from './accounts.controller';
import { AccountsService } from './accounts.service';
import { InternalAccountsController } from './internal-accounts.controller';

const guardsOf = (target: object) => Reflect.getMetadata('__guards__', target) ?? [];
const ANA = '11111111-1111-4111-8111-111111111111';
const request = { user: { idUser: ANA }, headers: { authorization: 'Bearer tok-1' } } as never;

describe('AccountsController', () => {
  const service = {
    create: jest.fn().mockResolvedValue({ id: 'a1' }),
    listForUser: jest.fn().mockResolvedValue([]),
    getLimits: jest.fn().mockResolvedValue({}),
    updateStatus: jest.fn().mockResolvedValue({}),
    findOne: jest.fn().mockResolvedValue({}),
    findLedgerInfo: jest.fn().mockResolvedValue({}),
    findLedgerInfoByNumber: jest.fn().mockResolvedValue({}),
    ensureMerchant: jest.fn().mockResolvedValue({}),
  };
  const controller = new AccountsController(service as unknown as AccountsService);

  it('exige sesión y usa siempre al cliente de la sesión (nunca uno que venga en el cuerpo)', async () => {
    expect(guardsOf(AccountsController)).toContain(JwtAuthGuard);

    await controller.create({ idUser: ANA, currency: 'COP' } as never, request);
    expect(service.create).toHaveBeenCalledWith({ idUser: ANA, currency: 'COP' }, ANA);
    await controller.list(request);
    expect(service.listForUser).toHaveBeenCalledWith(ANA);
    await controller.getLimits('a1', request);
    expect(service.getLimits).toHaveBeenCalledWith('a1', ANA);
    await controller.updateStatus('a1', { status: 'blocked' }, request);
    expect(service.updateStatus).toHaveBeenCalledWith('a1', { status: 'blocked' }, ANA);
    await controller.findOne('a1', request);
    expect(service.findOne).toHaveBeenCalledWith('a1', ANA);
  });

  it('las rutas internas (ledger, transfer, card) exigen la clave interna', async () => {
    const internal = new InternalAccountsController(service as unknown as AccountsService);
    expect(guardsOf(InternalAccountsController)).toContain(InternalKeyGuard);

    await internal.ledgerInfo('a1');
    await internal.ledgerInfoByNumber('10000000001');
    await internal.ensureMerchant({ code: 'netflix', name: 'Cineluz' });
    expect(service.findLedgerInfo).toHaveBeenCalledWith('a1');
    expect(service.findLedgerInfoByNumber).toHaveBeenCalledWith('10000000001');
    expect(service.ensureMerchant).toHaveBeenCalledWith({ code: 'netflix', name: 'Cineluz' });
  });
});

describe('KeysController', () => {
  const service = {
    list: jest.fn().mockResolvedValue({}),
    lookup: jest.fn().mockResolvedValue({}),
    register: jest.fn().mockResolvedValue({}),
    remove: jest.fn().mockResolvedValue({}),
    resolveInternal: jest.fn().mockResolvedValue({}),
  };
  const controller = new KeysController(service as unknown as KeysService);

  it('exige sesión; registrar manda el token del cliente y la clave dinámica; borrar valida el tipo', async () => {
    expect(guardsOf(KeysController)).toContain(JwtAuthGuard);

    await controller.list(request);
    expect(service.list).toHaveBeenCalledWith(ANA);
    await controller.lookup({ key: '@ana99' }, request);
    expect(service.lookup).toHaveBeenCalledWith(ANA, '@ana99');
    await controller.register({ type: 'celular', key: '3001234567', dynamicCode: '123456' }, request);
    expect(service.register).toHaveBeenCalledWith(ANA, 'tok-1', 'celular', '3001234567', '123456');
    await controller.remove('celular', { dynamicCode: '123456' }, request);
    expect(service.remove).toHaveBeenCalledWith(ANA, 'celular', '123456');
    expect(() => controller.remove('inventada', { dynamicCode: '123456' }, request)).toThrow(NotFoundException);
  });

  it('la resolución de llaves entre servicios exige la clave interna', async () => {
    expect(guardsOf(InternalKeysController)).toContain(InternalKeyGuard);
    await new InternalKeysController(service as unknown as KeysService).resolve({ key: '@ana99' });
    expect(service.resolveInternal).toHaveBeenCalledWith('@ana99');
  });
});

describe('Cancelación de la cuenta (controladores)', () => {
  it('requisitos y cierre son del cliente de la sesión', async () => {
    const closure = {
      requisitos: jest.fn().mockResolvedValue({}),
      close: jest.fn().mockResolvedValue({}),
    };
    const controller = new ClosureController(closure as unknown as ClosureService);
    expect(guardsOf(ClosureController)).toContain(JwtAuthGuard);

    await controller.requisitos(request);
    expect(closure.requisitos).toHaveBeenCalledWith(ANA);
    await controller.cerrar({ ticket: 'ticket-1', confirmacion: 'CANCELAR' }, request);
    expect(closure.close).toHaveBeenCalledWith(ANA, 'ticket-1');
  });

  it('las alertas «cuenta cerrada con saldo» son solo de cumplimiento y administración; por defecto lista las abiertas', async () => {
    const alerts = { list: jest.fn().mockResolvedValue([]), resolve: jest.fn().mockResolvedValue({}) };
    const controller = new ClosureAlertsController(alerts as unknown as ClosureAlertsService);
    expect(guardsOf(ClosureAlertsController)).toContain(StaffAuthGuard);
    expect(Reflect.getMetadata('staffRoles', ClosureAlertsController)).toEqual(['compliance', 'admin']);

    await controller.list({});
    expect(alerts.list).toHaveBeenLastCalledWith('open');
    await controller.list({ status: 'all' });
    expect(alerts.list).toHaveBeenLastCalledWith('all');

    const staff = { id: 'emp-1', username: 'laura' };
    await controller.resolve('alerta-1', { reason: '  Se devolvió al cliente  ' }, { staff });
    expect(alerts.resolve).toHaveBeenCalledWith('alerta-1', 'Se devolvió al cliente', staff);
  });
});
