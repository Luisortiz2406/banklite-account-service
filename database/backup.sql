-- Respaldo completo de account_db (account-service): esquema + datos de ejemplo (database/seed.sql).
-- Generado con pg_dump --no-owner --no-privileges. Restaurar en una base vacía:
--   psql "$DATABASE_URL" -f database/backup.sql

--
-- PostgreSQL database dump
--


-- Dumped from database version 16.15
-- Dumped by pg_dump version 16.15

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Name: uuid-ossp; Type: EXTENSION; Schema: -; Owner: -
--

CREATE EXTENSION IF NOT EXISTS "uuid-ossp" WITH SCHEMA public;


SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: account_closures; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.account_closures (
    id_user uuid NOT NULL,
    closed_at timestamp with time zone NOT NULL,
    account_numbers jsonb NOT NULL,
    ticket_jti uuid NOT NULL
);


--
-- Name: account_outbox; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.account_outbox (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    routing_key character varying NOT NULL,
    payload jsonb NOT NULL,
    occurred_at timestamp with time zone NOT NULL,
    published_at timestamp with time zone,
    attempts integer DEFAULT 0 NOT NULL,
    last_error character varying(500),
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: accounts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.accounts (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    id_user uuid NOT NULL,
    account_number character varying(11),
    account_type character varying DEFAULT 'savings'::character varying NOT NULL,
    merchant_code character varying(40),
    merchant_name character varying(80),
    currency character varying(3) NOT NULL,
    status character varying DEFAULT 'pending'::character varying NOT NULL,
    blocked_by character varying,
    daily_limit numeric(18,2) DEFAULT '0'::numeric NOT NULL,
    monthly_limit numeric(18,2) DEFAULT '0'::numeric NOT NULL,
    closed_at timestamp with time zone,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    updated_at timestamp without time zone DEFAULT now() NOT NULL
);


--
-- Name: admin_audit; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.admin_audit (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    staff_id character varying NOT NULL,
    staff_username character varying NOT NULL,
    action character varying NOT NULL,
    target_type character varying NOT NULL,
    target_id character varying NOT NULL,
    reason character varying(300),
    details jsonb,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    staff_role character varying
);


--
-- Name: breb_keys; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.breb_keys (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    key character varying(120) NOT NULL,
    type character varying(12) NOT NULL,
    id_user uuid NOT NULL,
    account_id uuid NOT NULL,
    holder_name character varying(80) NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: closure_balance_alerts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.closure_balance_alerts (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    id_user uuid NOT NULL,
    account_id uuid NOT NULL,
    account_number character varying(11),
    currency character varying(3) NOT NULL,
    balance numeric(18,2) NOT NULL,
    closed_at timestamp with time zone NOT NULL,
    detected_at timestamp with time zone DEFAULT now() NOT NULL,
    status character varying(10) DEFAULT 'open'::character varying NOT NULL,
    resolved_at timestamp with time zone,
    resolved_by character varying(80),
    resolution_note character varying(300)
);


--
-- Name: closure_tasks; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.closure_tasks (
    id_user uuid NOT NULL,
    kind character varying(20) NOT NULL,
    closed_at timestamp with time zone NOT NULL,
    attempts integer DEFAULT 0 NOT NULL,
    next_attempt_at timestamp with time zone NOT NULL,
    done_at timestamp with time zone,
    last_error character varying(500),
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: closure_ticket_uses; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.closure_ticket_uses (
    jti uuid NOT NULL,
    id_user uuid NOT NULL,
    result character varying(20),
    used_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: identity_verifications; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.identity_verifications (
    id_user uuid NOT NULL,
    verified boolean DEFAULT true NOT NULL,
    received_at timestamp without time zone DEFAULT now() NOT NULL
);


--
-- Data for Name: account_closures; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.account_closures (id_user, closed_at, account_numbers, ticket_jti) FROM stdin;
\.


--
-- Data for Name: account_outbox; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.account_outbox (id, routing_key, payload, occurred_at, published_at, attempts, last_error, created_at) FROM stdin;
\.


--
-- Data for Name: accounts; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.accounts (id, id_user, account_number, account_type, merchant_code, merchant_name, currency, status, blocked_by, daily_limit, monthly_limit, closed_at, created_at, updated_at) FROM stdin;
3a000000-0000-4000-8000-000000000001	11111111-1111-4111-8111-111111111111	10000000001	savings	\N	\N	COP	active	\N	5000000.00	50000000.00	\N	2026-10-01 09:02:00	2026-10-18 06:13:21.621912
3a000000-0000-4000-8000-000000000002	22222222-2222-4222-8222-222222222222	10000000002	savings	\N	\N	COP	active	\N	5000000.00	50000000.00	\N	2026-10-01 09:07:00	2026-10-18 06:13:21.621912
3a000000-0000-4000-8000-0000000000a1	00000000-0000-4000-8000-0000000000aa	90000000001	merchant	fac-acueducto	Acueducto de Bogotá	COP	active	\N	5000000.00	50000000.00	\N	2026-10-01 08:00:00	2026-10-18 06:13:21.621912
\.


--
-- Data for Name: admin_audit; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.admin_audit (id, staff_id, staff_username, action, target_type, target_id, reason, details, created_at, staff_role) FROM stdin;
\.


--
-- Data for Name: breb_keys; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.breb_keys (id, key, type, id_user, account_id, holder_name, created_at) FROM stdin;
3b000000-0000-4000-8000-000000000001	ana.perez@banklite.test	correo	11111111-1111-4111-8111-111111111111	3a000000-0000-4000-8000-000000000001	Ana Pérez	2026-10-01 14:30:00+00
\.


--
-- Data for Name: closure_balance_alerts; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.closure_balance_alerts (id, id_user, account_id, account_number, currency, balance, closed_at, detected_at, status, resolved_at, resolved_by, resolution_note) FROM stdin;
\.


--
-- Data for Name: closure_tasks; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.closure_tasks (id_user, kind, closed_at, attempts, next_attempt_at, done_at, last_error, created_at) FROM stdin;
\.


--
-- Data for Name: closure_ticket_uses; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.closure_ticket_uses (jti, id_user, result, used_at) FROM stdin;
\.


--
-- Data for Name: identity_verifications; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.identity_verifications (id_user, verified, received_at) FROM stdin;
11111111-1111-4111-8111-111111111111	t	2026-10-01 09:01:00
22222222-2222-4222-8222-222222222222	t	2026-10-01 09:06:00
\.


--
-- Name: closure_tasks PK_0c01f6e6a51a38fc2493d61c1a2; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.closure_tasks
    ADD CONSTRAINT "PK_0c01f6e6a51a38fc2493d61c1a2" PRIMARY KEY (id_user, kind);


--
-- Name: account_closures PK_24e8a46d19055720d79877a1fc7; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.account_closures
    ADD CONSTRAINT "PK_24e8a46d19055720d79877a1fc7" PRIMARY KEY (id_user);


--
-- Name: accounts PK_5a7a02c20412299d198e097a8fe; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.accounts
    ADD CONSTRAINT "PK_5a7a02c20412299d198e097a8fe" PRIMARY KEY (id);


--
-- Name: admin_audit PK_5ad48a4d9d16397ef37e28bb0be; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.admin_audit
    ADD CONSTRAINT "PK_5ad48a4d9d16397ef37e28bb0be" PRIMARY KEY (id);


--
-- Name: identity_verifications PK_5f2313c79aab1b84c8a24d525d1; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.identity_verifications
    ADD CONSTRAINT "PK_5f2313c79aab1b84c8a24d525d1" PRIMARY KEY (id_user);


--
-- Name: breb_keys PK_72f1e38768b818ca0f1d2aa5baa; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.breb_keys
    ADD CONSTRAINT "PK_72f1e38768b818ca0f1d2aa5baa" PRIMARY KEY (id);


--
-- Name: closure_ticket_uses PK_7ee4ed2f8287313cd25f65aa872; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.closure_ticket_uses
    ADD CONSTRAINT "PK_7ee4ed2f8287313cd25f65aa872" PRIMARY KEY (jti);


--
-- Name: account_outbox PK_f98565aca6d741ce801f5edbba4; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.account_outbox
    ADD CONSTRAINT "PK_f98565aca6d741ce801f5edbba4" PRIMARY KEY (id);


--
-- Name: closure_balance_alerts PK_cfa4ec76897945fe313ab332f69; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.closure_balance_alerts
    ADD CONSTRAINT "PK_cfa4ec76897945fe313ab332f69" PRIMARY KEY (id);


--
-- Name: IDX_8decd83b4b9593f5219e5f3085; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "IDX_8decd83b4b9593f5219e5f3085" ON public.admin_audit USING btree (target_id);


--
-- Name: IDX_f756b0b55a65b2a5d5bfd9d6c1; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "IDX_f756b0b55a65b2a5d5bfd9d6c1" ON public.accounts USING btree (merchant_code) WHERE (merchant_code IS NOT NULL);


--
-- Name: IDX_ffd1ae96513bfb2c6eada0f7d3; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "IDX_ffd1ae96513bfb2c6eada0f7d3" ON public.accounts USING btree (account_number);


--
-- Name: idx_account_outbox_pending; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_account_outbox_pending ON public.account_outbox USING btree (published_at, created_at);


--
-- Name: idx_accounts_user; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_accounts_user ON public.accounts USING btree (id_user);


--
-- Name: idx_admin_audit_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_admin_audit_created ON public.admin_audit USING btree (created_at);


--
-- Name: idx_closure_balance_alerts_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_closure_balance_alerts_status ON public.closure_balance_alerts USING btree (status, detected_at);


--
-- Name: idx_closure_tasks_due; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_closure_tasks_due ON public.closure_tasks USING btree (done_at, next_attempt_at);


--
-- Name: uq_account_closures_ticket; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uq_account_closures_ticket ON public.account_closures USING btree (ticket_jti);


--
-- Name: uq_breb_keys_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uq_breb_keys_key ON public.breb_keys USING btree (key);


--
-- Name: uq_breb_keys_user_type; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uq_breb_keys_user_type ON public.breb_keys USING btree (id_user, type);


--
-- Name: uq_closure_balance_alerts_account; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uq_closure_balance_alerts_account ON public.closure_balance_alerts USING btree (account_id);


--
-- PostgreSQL database dump complete
--


