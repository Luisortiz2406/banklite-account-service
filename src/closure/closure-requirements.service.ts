import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Not, Repository } from 'typeorm';
import { Account } from '../accounts/entities/account.entity';
import { ClosureClientsService } from './closure-clients.service';

export type PendingCode =
  | 'saldo'
  | 'bolsillos'
  | 'metas'
  | 'cdt'
  | 'ahorro_en_proceso'
  | 'recargas_pendientes'
  | 'recargas_en_revision'
  | 'revision_seguridad'
  | 'bloqueo_banco'
  | 'operacion_en_proceso';

export interface ClosurePending {
  codigo: PendingCode;
  mensaje: string;
  // Solo en 'saldo' y 'bloqueo_banco': la cuenta a la que se refiere.
  cuentaId?: string;
  numeroCuenta?: string | null;
  saldo?: number;
}

export interface ClosureRequirements {
  puedeCancelar: boolean;
  cuentas: { id: string; numeroCuenta: string | null; estado: Account['status']; moneda: string; saldo: number }[];
  pendientes: ClosurePending[];
}

const plural = (n: number, singular: string, plural: string) => `${n} ${n === 1 ? singular : plural}`;
const money = (value: number, currency: string) =>
  new Intl.NumberFormat('es-CO', { style: 'currency', currency, maximumFractionDigits: 2 }).format(value);
const masked = (accountNumber: string | null) => (accountNumber ? `····${accountNumber.slice(-4)}` : 'sin número');

/**
 * Lo que tiene que cumplir el cliente para cancelar su cuenta: saldo en $0 en
 * todas sus cuentas, nada en bolsillos, metas ni CDT, sin recargas en curso, sin
 * revisiones de seguridad abiertas y sin bloqueos del banco. Se revisa al
 * mostrar la pantalla y otra vez justo antes de cerrar.
 */
@Injectable()
export class ClosureRequirementsService {
  constructor(
    @InjectRepository(Account) private readonly accounts: Repository<Account>,
    private readonly clients: ClosureClientsService,
  ) {}

  /** Cuentas del cliente que la cancelación cierra (todas menos las ya cerradas). */
  openAccounts(idUser: string) {
    return this.accounts.find({
      where: { idUser, status: Not('closed'), accountType: Not('merchant') },
      order: { createdAt: 'ASC' },
    });
  }

  async check(idUser: string): Promise<ClosureRequirements> {
    const open = await this.openAccounts(idUser);
    const [balances, savings, deposits, fraud] = await Promise.all([
      Promise.all(open.map((account) => this.clients.balance(account.id))),
      this.clients.savingsSummary(idUser),
      this.clients.depositsSummary(idUser),
      this.clients.fraudSummary(idUser),
    ]);

    const pendientes: ClosurePending[] = [];
    open.forEach((account, i) => {
      if (account.status === 'blocked' && account.blockedBy === 'bank') {
        pendientes.push({
          codigo: 'bloqueo_banco',
          mensaje: `El banco bloqueó tu cuenta ${masked(account.accountNumber)}. Comunícate con soporte para cancelarla.`,
          cuentaId: account.id,
          numeroCuenta: account.accountNumber,
        });
      }
      if (balances[i] !== 0) {
        pendientes.push({
          codigo: 'saldo',
          mensaje:
            balances[i] > 0
              ? `Tu cuenta ${masked(account.accountNumber)} tiene ${money(balances[i], account.currency)}. Envía ese saldo antes de cancelar.`
              : `Tu cuenta ${masked(account.accountNumber)} tiene un saldo en contra de ${money(-balances[i], account.currency)}. Comunícate con soporte.`,
          cuentaId: account.id,
          numeroCuenta: account.accountNumber,
          saldo: balances[i],
        });
      }
    });

    if (savings.bolsillosConDinero > 0) {
      pendientes.push({
        codigo: 'bolsillos',
        mensaje: `Tienes ${plural(savings.bolsillosConDinero, 'bolsillo', 'bolsillos')} con dinero. Pásalo a tu cuenta antes de cancelar.`,
      });
    }
    if (savings.metasConDinero > 0) {
      pendientes.push({
        codigo: 'metas',
        mensaje: `Tienes ${plural(savings.metasConDinero, 'meta de ahorro', 'metas de ahorro')} con dinero. Retíralo a tu cuenta antes de cancelar.`,
      });
    }
    if (savings.cdtsVigentes > 0) {
      pendientes.push({
        codigo: 'cdt',
        mensaje: `Tienes ${plural(savings.cdtsVigentes, 'CDT vigente', 'CDT vigentes')}. Podrás cancelar cuando se paguen a tu cuenta.`,
      });
    }
    if (savings.operacionesEnProceso > 0) {
      pendientes.push({
        codigo: 'ahorro_en_proceso',
        mensaje: 'Hay un movimiento de ahorro en proceso. Espera unos minutos y vuelve a intentarlo.',
      });
    }
    if (deposits.recargasPendientes > 0) {
      pendientes.push({
        codigo: 'recargas_pendientes',
        mensaje: `Tienes ${plural(deposits.recargasPendientes, 'recarga pendiente', 'recargas pendientes')}. Espera a que termine o venza.`,
      });
    }
    if (deposits.recargasEnRevision > 0) {
      pendientes.push({
        codigo: 'recargas_en_revision',
        mensaje: `Tienes ${plural(deposits.recargasEnRevision, 'recarga en revisión', 'recargas en revisión')}. Te avisaremos cuando se resuelva.`,
      });
    }
    // Nunca se dice que es una alerta de fraude: solo que hay una revisión abierta.
    if (fraud.alertasAbiertas > 0) {
      pendientes.push({
        codigo: 'revision_seguridad',
        mensaje: 'Tienes una revisión de seguridad abierta. Escríbenos a ayuda@banklite.co para resolverla.',
      });
    }

    // Si un servicio dice que algo impide cancelar pero no es nada de lo anterior
    // (un campo nuevo en su resumen), igual se bloquea: nunca se asume que está bien.
    if (!pendientes.length && !(savings.sinPendientes && deposits.sinPendientes && fraud.sinPendientes)) {
      pendientes.push({
        codigo: 'operacion_en_proceso',
        mensaje: 'Hay una operación en proceso. Espera unos minutos y vuelve a intentarlo.',
      });
    }

    return {
      puedeCancelar: pendientes.length === 0,
      cuentas: open.map((account, i) => ({
        id: account.id,
        numeroCuenta: account.accountNumber,
        estado: account.status,
        moneda: account.currency,
        saldo: balances[i],
      })),
      pendientes,
    };
  }
}
