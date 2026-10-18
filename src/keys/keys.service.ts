import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Not, Repository } from 'typeorm';
import { Account } from '../accounts/entities/account.entity';
import { BREB_LABELS, BrebKeyType, detectKey, maskKey, maskName, phoneDigits } from './breb';
import { BrebKey } from './entities/breb-key.entity';
import { KeysClientsService } from './keys-clients.service';

@Injectable()
export class KeysService {
  constructor(
    @InjectRepository(BrebKey) private readonly keys: Repository<BrebKey>,
    @InjectRepository(Account) private readonly accounts: Repository<Account>,
    private readonly clients: KeysClientsService,
  ) {}

  /** Llaves del cliente y la cuenta a la que llegan. */
  async list(idUser: string) {
    const [rows, account] = await Promise.all([
      this.keys.find({ where: { idUser }, order: { createdAt: 'ASC' } }),
      this.receivingAccount(idUser),
    ]);
    return {
      accountNumber: account?.accountNumber ?? null,
      keys: rows.map((row) => ({
        type: row.type,
        key: row.key,
        maskedKey: maskKey(row.key, row.type),
        createdAt: row.createdAt,
      })),
    };
  }

  async register(idUser: string, accessToken: string, type: BrebKeyType, raw: string, dynamicCode: string) {
    const found = detectKey(raw);
    if (!found || found.type !== type) {
      throw new BadRequestException(`Esa no es una llave válida de tipo ${BREB_LABELS[type].toLowerCase()}.`);
    }

    const account = await this.receivingAccount(idUser);
    if (!account) throw new BadRequestException('Necesitas una cuenta Banklite activa para registrar llaves.');

    if (await this.keys.exist({ where: { idUser, type } })) {
      throw new ConflictException(
        `Ya tienes una llave de tipo ${BREB_LABELS[type].toLowerCase()}. Elimínala para registrar otra.`,
      );
    }
    const taken = await this.keys.findOne({ where: { key: found.key } });
    if (taken) {
      throw new ConflictException(
        taken.idUser === idUser ? 'Ya tienes registrada esa llave.' : 'Esa llave ya está registrada por otra persona.',
      );
    }

    // Solo puedes registrar TU celular, TU correo y TU cédula (datos verificados en KYC).
    const profile = await this.clients.kycProfile(idUser, accessToken);
    if (type === 'celular' && phoneDigits(profile.telefono) !== found.key) {
      throw new ForbiddenException('Solo puedes registrar el celular que verificaste en Banklite.');
    }
    if (type === 'correo' && String(profile.email ?? '').toLowerCase() !== found.key) {
      throw new ForbiddenException('Solo puedes registrar el correo que verificaste en Banklite.');
    }
    if (type === 'documento' && String(profile.numeroDocumento ?? '').replace(/\D/g, '') !== found.key) {
      throw new ForbiddenException('Solo puedes registrar tu propio número de documento.');
    }

    // Como en los bancos: registrar una llave exige la clave dinámica.
    await this.clients.verifyDynamicKey(idUser, dynamicCode);

    try {
      await this.keys.save(
        this.keys.create({
          idUser,
          type,
          key: found.key,
          accountId: account.id,
          holderName: maskName(`${profile.nombres ?? ''} ${profile.apellidos ?? ''}`),
        }),
      );
    } catch (error) {
      if ((error as any)?.code === '23505')
        throw new ConflictException('Esa llave acaba de ser registrada. Revisa tus llaves.');
      throw error;
    }
    return this.list(idUser);
  }

  async remove(idUser: string, type: BrebKeyType, dynamicCode: string) {
    const row = await this.keys.findOne({ where: { idUser, type } });
    if (!row) throw new NotFoundException('No tienes una llave de ese tipo.');
    await this.clients.verifyDynamicKey(idUser, dynamicCode);
    await this.keys.delete({ id: row.id, idUser });
    return this.list(idUser);
  }

  /** Consulta pública (con sesión): a nombre de quién está una llave, enmascarado. */
  async lookup(idUser: string, raw: string) {
    const found = detectKey(raw);
    if (!found) throw new BadRequestException('Escribe un celular, correo, cédula o una llave que empiece por @.');
    const row = await this.keys.findOne({ where: { key: found.key } });
    if (!row || !(await this.activeAccount(row.accountId))) {
      throw new NotFoundException('No encontramos esa llave en Banklite.');
    }
    return {
      type: row.type,
      key: row.key,
      maskedKey: maskKey(row.key, row.type),
      holderName: row.holderName,
      entity: 'Banklite',
      own: row.idUser === idUser,
    };
  }

  /** Uso interno (transfer-service): cuenta destino de una llave. Nunca sale al cliente. */
  async resolveInternal(raw: string) {
    const found = detectKey(raw);
    if (!found) throw new BadRequestException('La llave no tiene un formato válido.');
    const row = await this.keys.findOne({ where: { key: found.key } });
    const account = row ? await this.activeAccount(row.accountId) : null;
    if (!row || !account) throw new NotFoundException('No encontramos esa llave en Banklite.');
    return {
      key: row.key,
      type: row.type,
      idUser: row.idUser,
      accountId: account.id,
      accountNumber: account.accountNumber,
      holderName: row.holderName,
    };
  }

  // Cuenta donde llegan las llaves: la primera cuenta activa del cliente.
  private receivingAccount(idUser: string) {
    return this.accounts.findOne({
      where: { idUser, status: 'active', accountType: Not(In(['merchant'])) },
      order: { createdAt: 'ASC' },
    });
  }

  private activeAccount(accountId: string) {
    return this.accounts.findOne({ where: { id: accountId, status: 'active' } });
  }
}
