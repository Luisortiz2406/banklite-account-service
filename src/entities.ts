import { Account } from './accounts/entities/account.entity';
import { IdentityVerification } from './accounts/entities/identity-verification.entity';
import { AccountClosure } from './closure/entities/account-closure.entity';
import { ClosureBalanceAlert } from './closure/entities/closure-balance-alert.entity';
import { ClosureTask } from './closure/entities/closure-task.entity';
import { ClosureTicketUse } from './closure/entities/closure-ticket-use.entity';
import { AdminAudit } from './common/staff/admin-audit.entity';
import { AccountOutbox } from './events/account-outbox.entity';
import { BrebKey } from './keys/entities/breb-key.entity';

/**
 * Todas las tablas de account_db. La usan TypeORM al arrancar y
 * scripts/verificar-esquema.js (CI), que comprueba que database/schema.sql y
 * database/backup.sql crean exactamente estas tablas.
 */
export const ENTITIES = [
  Account,
  IdentityVerification,
  AdminAudit,
  BrebKey,
  AccountClosure,
  ClosureTicketUse,
  ClosureTask,
  ClosureBalanceAlert,
  AccountOutbox,
];
