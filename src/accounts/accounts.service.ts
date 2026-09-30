import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { randomInt } from 'crypto';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { CreateAccountDto } from './dto/create-account.dto';
import { UpdateStatusDto } from './dto/update-status.dto';
import { Account } from './entities/account.entity';
import { IdentityVerification } from './entities/identity-verification.entity';

// Límites regulatorios por defecto, ajustables por país en una versión futura
// (3.3 del documento: "restricciones regulatorias específicas por país").
const LIMITE_DIARIO_DEFECTO = 5_000_000; // COP
const LIMITE_MENSUAL_DEFECTO = 50_000_000; // COP

@Injectable()
export class AccountsService {
  constructor(
    @InjectRepository(Account) private readonly accounts: Repository<Account>,
    @InjectRepository(IdentityVerification)
    private readonly verifications: Repository<IdentityVerification>,
  ) {}

  /**
   * POST /accounts/create
   * Consume el estado proyectado del evento identity.verified: solo permite
   * apertura si el usuario ya fue verificado (o abre en 'pending' si aún no,
   * y quedará 'active' automáticamente cuando llegue el evento).
   */
  async create(dto: CreateAccountDto, requesterId: string): Promise<Account> {
    if (dto.idUser !== requesterId) {
      throw new ForbiddenException('No puedes crear una cuenta para otro usuario');
    }

    const verificacion = await this.verifications.findOne({
      where: { idUser: dto.idUser },
    });

    // El cliente puede pedir límites más bajos, pero nunca superar los regulatorios.
    const dailyLimit = dto.dailyLimit ?? LIMITE_DIARIO_DEFECTO;
    const monthlyLimit = dto.monthlyLimit ?? LIMITE_MENSUAL_DEFECTO;
    if (dailyLimit > LIMITE_DIARIO_DEFECTO || monthlyLimit > LIMITE_MENSUAL_DEFECTO) {
      throw new BadRequestException(
        `Los límites máximos permitidos son ${LIMITE_DIARIO_DEFECTO} diario y ${LIMITE_MENSUAL_DEFECTO} mensual.`,
      );
    }
    if (dailyLimit > monthlyLimit) {
      throw new BadRequestException('El límite diario no puede superar el límite mensual.');
    }

    for (let attempt = 0; attempt < 5; attempt++) {
      const accountNumber = await this.generateAccountNumber();
      const account = this.accounts.create({
        idUser: dto.idUser,
        accountNumber,
        accountType: dto.accountType ?? 'savings',
        currency: dto.currency,
        status: verificacion?.verified ? 'active' : 'pending',
        dailyLimit,
        monthlyLimit,
        blockedBy: null,
      });
      try {
        return await this.accounts.save(account);
      } catch (error) {
        if ((error as any)?.code !== '23505' || attempt === 4) throw error;
      }
    }
    throw new BadRequestException('No se pudo asignar un número de cuenta. Inténtalo nuevamente.');
  }

  /** GET /accounts — cuentas del usuario autenticado (no depende del navegador). */
  async listForUser(requesterId: string) {
    const accounts = await this.accounts.find({
      where: { idUser: requesterId },
      order: { createdAt: 'ASC' },
    });
    return Promise.all(accounts.map((account) => this.ensureAccountNumber(account)));
  }

  /** GET /accounts/{account_id}/limits */
  async getLimits(accountId: string, requesterId: string) {
    const account = await this.accounts.findOne({ where: { id: accountId } });
    if (!account) {
      throw new NotFoundException('Cuenta no encontrada');
    }
    this.assertOwnership(account, requesterId);
    return {
      accountId: account.id,
      currency: account.currency,
      dailyLimit: Number(account.dailyLimit),
      monthlyLimit: Number(account.monthlyLimit),
    };
  }

  /** PUT /accounts/{account_id}/status */
  async updateStatus(accountId: string, dto: UpdateStatusDto, requesterId: string) {
    const account = await this.accounts.findOne({ where: { id: accountId } });
    if (!account) {
      throw new NotFoundException('Cuenta no encontrada');
    }
    this.assertOwnership(account, requesterId);
    if (account.status === 'closed') {
      throw new BadRequestException('No se puede modificar una cuenta cerrada');
    }
    if (account.status === dto.status) return account;

    // Reglas de transición para el titular:
    //  - 'pending' solo pasa a 'active' con el evento identity.verified (KYC), nunca a mano.
    //  - Un bloqueo solo lo levanta el titular si él mismo lo puso; un bloqueo
    //    del banco (blockedBy = 'bank') requiere un proceso interno.
    if (dto.status === 'active') {
      if (account.status === 'pending') {
        throw new ForbiddenException('La cuenta se activa automáticamente cuando se verifica tu identidad.');
      }
      // blockedBy null = bloqueo anterior a esta columna, que solo podía poner el titular.
      if (account.status === 'blocked' && account.blockedBy === 'bank') {
        throw new ForbiddenException('Esta cuenta fue bloqueada por el banco. Comunícate con soporte.');
      }
      account.blockedBy = null;
    } else if (dto.status === 'blocked') {
      if (account.status === 'pending') {
        throw new BadRequestException('Una cuenta pendiente de verificación no se puede bloquear.');
      }
      account.blockedBy = 'user';
    }
    account.status = dto.status;
    return this.accounts.save(account);
  }

  async findOne(accountId: string, requesterId: string) {
    const account = await this.accounts.findOne({ where: { id: accountId } });
    if (!account) {
      throw new NotFoundException('Cuenta no encontrada');
    }
    this.assertOwnership(account, requesterId);
    return this.ensureAccountNumber(account);
  }

  async findLedgerInfo(accountId: string) {
    const account = await this.accounts.findOne({ where: { id: accountId } });
    if (!account) throw new NotFoundException('Cuenta no encontrada');
    await this.ensureAccountNumber(account);
    return {
      id: account.id,
      accountNumber: account.accountNumber,
      accountType: account.accountType,
      idUser: account.idUser,
      currency: account.currency,
      status: account.status,
      dailyLimit: Number(account.dailyLimit),
      monthlyLimit: Number(account.monthlyLimit),
    };
  }

  async findLedgerInfoByNumber(accountNumber: string) {
    if (!/^\d{11}$/.test(accountNumber)) {
      throw new BadRequestException('El número de cuenta debe tener 11 dígitos.');
    }
    const account = await this.accounts.findOne({ where: { accountNumber } });
    if (!account) throw new NotFoundException('Cuenta destino no encontrada');
    return {
      id: account.id,
      accountNumber: account.accountNumber,
      accountType: account.accountType,
      idUser: account.idUser,
      currency: account.currency,
      status: account.status,
      dailyLimit: Number(account.dailyLimit),
      monthlyLimit: Number(account.monthlyLimit),
    };
  }

  private async ensureAccountNumber(account: Account): Promise<Account> {
    if (account.accountNumber) return account;
    for (let attempt = 0; attempt < 5; attempt++) {
      account.accountNumber = await this.generateAccountNumber();
      try {
        return await this.accounts.save(account);
      } catch (error) {
        if ((error as any)?.code !== '23505' || attempt === 4) throw error;
        account.accountNumber = null;
      }
    }
    throw new BadRequestException('No se pudo asignar un número de cuenta. Inténtalo nuevamente.');
  }

  private async generateAccountNumber(): Promise<string> {
    for (let attempt = 0; attempt < 10; attempt++) {
      const number = String(randomInt(10_000_000_000, 100_000_000_000));
      const exists = await this.accounts.exist({ where: { accountNumber: number } });
      if (!exists) return number;
    }
    throw new BadRequestException('No se pudo generar un número de cuenta único.');
  }

  /** Un usuario autenticado solo puede operar sobre sus propias cuentas. */
  private assertOwnership(account: Account, requesterId: string) {
    if (account.idUser !== requesterId) {
      throw new ForbiddenException('No puedes acceder a una cuenta de otro usuario');
    }
  }
}
