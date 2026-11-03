-- Datos de ejemplo de account_db (account-service). Escenario de demo compartido por todos
-- los microservicios (mismos UUID): Ana Pérez y Carlos Gómez, clientes de prueba,
-- y una cuenta de comercio. Datos inventados: no son personas ni documentos reales.
-- Cargar después del esquema:  psql "$DATABASE_URL" -f database/schema.sql -f database/seed.sql
-- (si la base ya tiene estas filas, ON CONFLICT DO NOTHING las deja como están)

BEGIN;

INSERT INTO public.identity_verifications (id_user, verified, received_at) VALUES
  ('11111111-1111-4111-8111-111111111111', true, '2026-10-01 09:01:00-05'),
  ('22222222-2222-4222-8222-222222222222', true, '2026-10-01 09:06:00-05')
ON CONFLICT DO NOTHING;

INSERT INTO public.accounts (id, id_user, account_number, account_type, merchant_code, merchant_name, currency, status, daily_limit, monthly_limit, created_at) VALUES
  ('3a000000-0000-4000-8000-000000000001', '11111111-1111-4111-8111-111111111111', '10000000001', 'savings', NULL, NULL, 'COP', 'active', 5000000, 50000000, '2026-10-01 09:02:00-05'),
  ('3a000000-0000-4000-8000-000000000002', '22222222-2222-4222-8222-222222222222', '10000000002', 'savings', NULL, NULL, 'COP', 'active', 5000000, 50000000, '2026-10-01 09:07:00-05'),
  ('3a000000-0000-4000-8000-0000000000a1', '00000000-0000-4000-8000-0000000000aa', '90000000001', 'merchant', 'fac-acueducto', 'Acueducto Montecielo', 'COP', 'active', 5000000, 50000000, '2026-10-01 08:00:00-05')
ON CONFLICT DO NOTHING;

INSERT INTO public.breb_keys (id, key, type, id_user, account_id, holder_name, created_at) VALUES
  ('3b000000-0000-4000-8000-000000000001', 'ana.perez@banklite.test', 'correo', '11111111-1111-4111-8111-111111111111', '3a000000-0000-4000-8000-000000000001', 'Ana Pérez', '2026-10-01 09:30:00-05')
ON CONFLICT DO NOTHING;

COMMIT;
