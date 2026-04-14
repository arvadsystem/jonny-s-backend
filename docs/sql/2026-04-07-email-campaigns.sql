BEGIN;

-- AM: tabla maestra de campanas de correo para configuracion interna.
CREATE TABLE IF NOT EXISTS public.email_campaigns (
  id_campaign integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  title text NOT NULL,
  subject text NOT NULL,
  html_content text NOT NULL,
  audience_type text NOT NULL,
  audience_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL,
  scheduled_for timestamptz NULL,
  started_at timestamptz NULL,
  finished_at timestamptz NULL,
  created_by integer NULL,
  total_recipients integer NOT NULL DEFAULT 0,
  sent_count integer NOT NULL DEFAULT 0,
  failed_count integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT NOW(),
  updated_at timestamptz NOT NULL DEFAULT NOW()
);

-- AM: tabla de snapshot de destinatarios por campana con estado individual de envio.
CREATE TABLE IF NOT EXISTS public.email_campaign_recipients (
  id_campaign_recipient integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  id_campaign integer NOT NULL,
  id_cliente integer NULL,
  recipient_email text NOT NULL,
  recipient_name text NULL,
  send_status text NOT NULL,
  error_message text NULL,
  sent_at timestamptz NULL,
  created_at timestamptz NOT NULL DEFAULT NOW(),
  updated_at timestamptz NOT NULL DEFAULT NOW()
);

-- AM: bitacora tecnica minima por campana para diagnostico operacional.
CREATE TABLE IF NOT EXISTS public.email_campaign_logs (
  id_log integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  id_campaign integer NOT NULL,
  level text NOT NULL,
  message text NOT NULL,
  meta jsonb NULL,
  created_at timestamptz NOT NULL DEFAULT NOW()
);

-- AM: hardening de autoincrement y PK para email_campaigns en escenarios parciales legacy.
DO $$
DECLARE
  v_is_identity text;
  v_has_default boolean;
  v_max_id bigint;
BEGIN
  SELECT c.is_identity
  INTO v_is_identity
  FROM information_schema.columns c
  WHERE c.table_schema = 'public'
    AND c.table_name = 'email_campaigns'
    AND c.column_name = 'id_campaign';

  SELECT EXISTS (
    SELECT 1
    FROM pg_attrdef d
    JOIN pg_attribute a
      ON a.attrelid = d.adrelid
     AND a.attnum = d.adnum
    WHERE d.adrelid = 'public.email_campaigns'::regclass
      AND a.attname = 'id_campaign'
  )
  INTO v_has_default;

  IF COALESCE(v_is_identity, 'NO') <> 'YES' AND NOT v_has_default THEN
    CREATE SEQUENCE IF NOT EXISTS public.email_campaigns_id_campaign_seq;
    ALTER TABLE public.email_campaigns
      ALTER COLUMN id_campaign SET DEFAULT nextval('public.email_campaigns_id_campaign_seq');

    SELECT COALESCE(MAX(id_campaign), 0) INTO v_max_id
    FROM public.email_campaigns;

    PERFORM setval(
      'public.email_campaigns_id_campaign_seq',
      CASE WHEN v_max_id > 0 THEN v_max_id ELSE 1 END,
      v_max_id > 0
    );

    ALTER SEQUENCE public.email_campaigns_id_campaign_seq
      OWNED BY public.email_campaigns.id_campaign;
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'public.email_campaigns'::regclass
      AND contype = 'p'
  ) THEN
    ALTER TABLE public.email_campaigns
      ADD CONSTRAINT email_campaigns_pkey PRIMARY KEY (id_campaign);
  END IF;
END;
$$ LANGUAGE plpgsql;

-- AM: hardening de autoincrement y PK para email_campaign_recipients en escenarios parciales legacy.
DO $$
DECLARE
  v_is_identity text;
  v_has_default boolean;
  v_max_id bigint;
BEGIN
  SELECT c.is_identity
  INTO v_is_identity
  FROM information_schema.columns c
  WHERE c.table_schema = 'public'
    AND c.table_name = 'email_campaign_recipients'
    AND c.column_name = 'id_campaign_recipient';

  SELECT EXISTS (
    SELECT 1
    FROM pg_attrdef d
    JOIN pg_attribute a
      ON a.attrelid = d.adrelid
     AND a.attnum = d.adnum
    WHERE d.adrelid = 'public.email_campaign_recipients'::regclass
      AND a.attname = 'id_campaign_recipient'
  )
  INTO v_has_default;

  IF COALESCE(v_is_identity, 'NO') <> 'YES' AND NOT v_has_default THEN
    CREATE SEQUENCE IF NOT EXISTS public.email_campaign_recipients_id_campaign_recipient_seq;
    ALTER TABLE public.email_campaign_recipients
      ALTER COLUMN id_campaign_recipient SET DEFAULT nextval('public.email_campaign_recipients_id_campaign_recipient_seq');

    SELECT COALESCE(MAX(id_campaign_recipient), 0) INTO v_max_id
    FROM public.email_campaign_recipients;

    PERFORM setval(
      'public.email_campaign_recipients_id_campaign_recipient_seq',
      CASE WHEN v_max_id > 0 THEN v_max_id ELSE 1 END,
      v_max_id > 0
    );

    ALTER SEQUENCE public.email_campaign_recipients_id_campaign_recipient_seq
      OWNED BY public.email_campaign_recipients.id_campaign_recipient;
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'public.email_campaign_recipients'::regclass
      AND contype = 'p'
  ) THEN
    ALTER TABLE public.email_campaign_recipients
      ADD CONSTRAINT email_campaign_recipients_pkey PRIMARY KEY (id_campaign_recipient);
  END IF;
END;
$$ LANGUAGE plpgsql;

-- AM: hardening de autoincrement y PK para email_campaign_logs en escenarios parciales legacy.
DO $$
DECLARE
  v_is_identity text;
  v_has_default boolean;
  v_max_id bigint;
BEGIN
  SELECT c.is_identity
  INTO v_is_identity
  FROM information_schema.columns c
  WHERE c.table_schema = 'public'
    AND c.table_name = 'email_campaign_logs'
    AND c.column_name = 'id_log';

  SELECT EXISTS (
    SELECT 1
    FROM pg_attrdef d
    JOIN pg_attribute a
      ON a.attrelid = d.adrelid
     AND a.attnum = d.adnum
    WHERE d.adrelid = 'public.email_campaign_logs'::regclass
      AND a.attname = 'id_log'
  )
  INTO v_has_default;

  IF COALESCE(v_is_identity, 'NO') <> 'YES' AND NOT v_has_default THEN
    CREATE SEQUENCE IF NOT EXISTS public.email_campaign_logs_id_log_seq;
    ALTER TABLE public.email_campaign_logs
      ALTER COLUMN id_log SET DEFAULT nextval('public.email_campaign_logs_id_log_seq');

    SELECT COALESCE(MAX(id_log), 0) INTO v_max_id
    FROM public.email_campaign_logs;

    PERFORM setval(
      'public.email_campaign_logs_id_log_seq',
      CASE WHEN v_max_id > 0 THEN v_max_id ELSE 1 END,
      v_max_id > 0
    );

    ALTER SEQUENCE public.email_campaign_logs_id_log_seq
      OWNED BY public.email_campaign_logs.id_log;
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'public.email_campaign_logs'::regclass
      AND contype = 'p'
  ) THEN
    ALTER TABLE public.email_campaign_logs
      ADD CONSTRAINT email_campaign_logs_pkey PRIMARY KEY (id_log);
  END IF;
END;
$$ LANGUAGE plpgsql;

-- AM: hardening idempotente de columnas esenciales en email_campaigns para ejecuciones parciales.
ALTER TABLE public.email_campaigns
  ADD COLUMN IF NOT EXISTS title text,
  ADD COLUMN IF NOT EXISTS subject text,
  ADD COLUMN IF NOT EXISTS html_content text,
  ADD COLUMN IF NOT EXISTS audience_type text,
  ADD COLUMN IF NOT EXISTS audience_snapshot jsonb DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS status text,
  ADD COLUMN IF NOT EXISTS scheduled_for timestamptz NULL,
  ADD COLUMN IF NOT EXISTS started_at timestamptz NULL,
  ADD COLUMN IF NOT EXISTS finished_at timestamptz NULL,
  ADD COLUMN IF NOT EXISTS created_by integer NULL,
  ADD COLUMN IF NOT EXISTS total_recipients integer DEFAULT 0,
  ADD COLUMN IF NOT EXISTS sent_count integer DEFAULT 0,
  ADD COLUMN IF NOT EXISTS failed_count integer DEFAULT 0,
  ADD COLUMN IF NOT EXISTS created_at timestamptz DEFAULT NOW(),
  ADD COLUMN IF NOT EXISTS updated_at timestamptz DEFAULT NOW();

UPDATE public.email_campaigns
SET
  audience_snapshot = COALESCE(audience_snapshot, '{}'::jsonb),
  total_recipients = COALESCE(total_recipients, 0),
  sent_count = COALESCE(sent_count, 0),
  failed_count = COALESCE(failed_count, 0),
  created_at = COALESCE(created_at, NOW()),
  updated_at = COALESCE(updated_at, NOW());

ALTER TABLE public.email_campaigns
  ALTER COLUMN audience_snapshot SET DEFAULT '{}'::jsonb,
  ALTER COLUMN total_recipients SET DEFAULT 0,
  ALTER COLUMN sent_count SET DEFAULT 0,
  ALTER COLUMN failed_count SET DEFAULT 0,
  ALTER COLUMN created_at SET DEFAULT NOW(),
  ALTER COLUMN updated_at SET DEFAULT NOW();

ALTER TABLE public.email_campaigns
  ALTER COLUMN title SET NOT NULL,
  ALTER COLUMN subject SET NOT NULL,
  ALTER COLUMN html_content SET NOT NULL,
  ALTER COLUMN audience_type SET NOT NULL,
  ALTER COLUMN audience_snapshot SET NOT NULL,
  ALTER COLUMN status SET NOT NULL,
  ALTER COLUMN total_recipients SET NOT NULL,
  ALTER COLUMN sent_count SET NOT NULL,
  ALTER COLUMN failed_count SET NOT NULL,
  ALTER COLUMN created_at SET NOT NULL,
  ALTER COLUMN updated_at SET NOT NULL;

-- AM: hardening idempotente de columnas esenciales en email_campaign_recipients para ejecuciones parciales.
ALTER TABLE public.email_campaign_recipients
  ADD COLUMN IF NOT EXISTS id_campaign integer,
  ADD COLUMN IF NOT EXISTS id_cliente integer NULL,
  ADD COLUMN IF NOT EXISTS recipient_email text,
  ADD COLUMN IF NOT EXISTS recipient_name text NULL,
  ADD COLUMN IF NOT EXISTS send_status text,
  ADD COLUMN IF NOT EXISTS error_message text NULL,
  ADD COLUMN IF NOT EXISTS sent_at timestamptz NULL,
  ADD COLUMN IF NOT EXISTS created_at timestamptz DEFAULT NOW(),
  ADD COLUMN IF NOT EXISTS updated_at timestamptz DEFAULT NOW();

UPDATE public.email_campaign_recipients
SET
  created_at = COALESCE(created_at, NOW()),
  updated_at = COALESCE(updated_at, NOW());

ALTER TABLE public.email_campaign_recipients
  ALTER COLUMN created_at SET DEFAULT NOW(),
  ALTER COLUMN updated_at SET DEFAULT NOW();

ALTER TABLE public.email_campaign_recipients
  ALTER COLUMN id_campaign SET NOT NULL,
  ALTER COLUMN recipient_email SET NOT NULL,
  ALTER COLUMN send_status SET NOT NULL,
  ALTER COLUMN created_at SET NOT NULL,
  ALTER COLUMN updated_at SET NOT NULL;

-- AM: hardening idempotente de columnas esenciales en email_campaign_logs para ejecuciones parciales.
ALTER TABLE public.email_campaign_logs
  ADD COLUMN IF NOT EXISTS id_campaign integer,
  ADD COLUMN IF NOT EXISTS level text,
  ADD COLUMN IF NOT EXISTS message text,
  ADD COLUMN IF NOT EXISTS meta jsonb NULL,
  ADD COLUMN IF NOT EXISTS created_at timestamptz DEFAULT NOW();

UPDATE public.email_campaign_logs
SET created_at = COALESCE(created_at, NOW());

ALTER TABLE public.email_campaign_logs
  ALTER COLUMN created_at SET DEFAULT NOW();

ALTER TABLE public.email_campaign_logs
  ALTER COLUMN id_campaign SET NOT NULL,
  ALTER COLUMN level SET NOT NULL,
  ALTER COLUMN message SET NOT NULL,
  ALTER COLUMN created_at SET NOT NULL;

-- AM: checks de dominio y reglas de consistencia en email_campaigns.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'chk_email_campaigns_audience_type'
      AND conrelid = 'public.email_campaigns'::regclass
  ) THEN
    ALTER TABLE public.email_campaigns
      ADD CONSTRAINT chk_email_campaigns_audience_type
      CHECK (audience_type IN ('all_clients', 'selected_clients'));
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'chk_email_campaigns_status'
      AND conrelid = 'public.email_campaigns'::regclass
  ) THEN
    ALTER TABLE public.email_campaigns
      ADD CONSTRAINT chk_email_campaigns_status
      CHECK (status IN ('draft', 'scheduled', 'processing', 'sent', 'partial_failure', 'failed', 'cancelled'));
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'chk_email_campaigns_scheduled_required'
      AND conrelid = 'public.email_campaigns'::regclass
  ) THEN
    ALTER TABLE public.email_campaigns
      ADD CONSTRAINT chk_email_campaigns_scheduled_required
      CHECK (status <> 'scheduled' OR scheduled_for IS NOT NULL);
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'chk_email_campaigns_non_negative_counts'
      AND conrelid = 'public.email_campaigns'::regclass
  ) THEN
    ALTER TABLE public.email_campaigns
      ADD CONSTRAINT chk_email_campaigns_non_negative_counts
      CHECK (total_recipients >= 0 AND sent_count >= 0 AND failed_count >= 0);
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'chk_email_campaigns_counts_consistency'
      AND conrelid = 'public.email_campaigns'::regclass
  ) THEN
    ALTER TABLE public.email_campaigns
      ADD CONSTRAINT chk_email_campaigns_counts_consistency
      CHECK (sent_count + failed_count <= total_recipients);
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'chk_email_campaigns_title_not_blank'
      AND conrelid = 'public.email_campaigns'::regclass
  ) THEN
    ALTER TABLE public.email_campaigns
      ADD CONSTRAINT chk_email_campaigns_title_not_blank
      CHECK (length(btrim(title)) > 0);
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'chk_email_campaigns_subject_not_blank'
      AND conrelid = 'public.email_campaigns'::regclass
  ) THEN
    ALTER TABLE public.email_campaigns
      ADD CONSTRAINT chk_email_campaigns_subject_not_blank
      CHECK (length(btrim(subject)) > 0);
  END IF;
END;
$$ LANGUAGE plpgsql;

-- AM: checks de dominio y formato basico en email_campaign_recipients.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'chk_email_campaign_recipients_send_status'
      AND conrelid = 'public.email_campaign_recipients'::regclass
  ) THEN
    ALTER TABLE public.email_campaign_recipients
      ADD CONSTRAINT chk_email_campaign_recipients_send_status
      CHECK (send_status IN ('pending', 'sending', 'sent', 'failed', 'skipped'));
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'chk_email_campaign_recipients_email_not_blank'
      AND conrelid = 'public.email_campaign_recipients'::regclass
  ) THEN
    ALTER TABLE public.email_campaign_recipients
      ADD CONSTRAINT chk_email_campaign_recipients_email_not_blank
      CHECK (length(btrim(recipient_email)) > 3);
  END IF;
END;
$$ LANGUAGE plpgsql;

-- AM: checks de dominio en email_campaign_logs.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'chk_email_campaign_logs_level'
      AND conrelid = 'public.email_campaign_logs'::regclass
  ) THEN
    ALTER TABLE public.email_campaign_logs
      ADD CONSTRAINT chk_email_campaign_logs_level
      CHECK (level IN ('info', 'warning', 'error'));
  END IF;
END;
$$ LANGUAGE plpgsql;

-- AM: foreign keys idempotentes y seguras con nombres estables.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'fk_email_campaigns_created_by_usuario'
      AND conrelid = 'public.email_campaigns'::regclass
  ) THEN
    ALTER TABLE public.email_campaigns
      ADD CONSTRAINT fk_email_campaigns_created_by_usuario
      FOREIGN KEY (created_by)
      REFERENCES public.usuarios(id_usuario)
      ON UPDATE NO ACTION
      ON DELETE SET NULL;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'fk_email_campaign_recipients_campaign'
      AND conrelid = 'public.email_campaign_recipients'::regclass
  ) THEN
    ALTER TABLE public.email_campaign_recipients
      ADD CONSTRAINT fk_email_campaign_recipients_campaign
      FOREIGN KEY (id_campaign)
      REFERENCES public.email_campaigns(id_campaign)
      ON UPDATE NO ACTION
      ON DELETE CASCADE;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'fk_email_campaign_recipients_cliente'
      AND conrelid = 'public.email_campaign_recipients'::regclass
  ) THEN
    ALTER TABLE public.email_campaign_recipients
      ADD CONSTRAINT fk_email_campaign_recipients_cliente
      FOREIGN KEY (id_cliente)
      REFERENCES public.clientes(id_cliente)
      ON UPDATE NO ACTION
      ON DELETE SET NULL;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'fk_email_campaign_logs_campaign'
      AND conrelid = 'public.email_campaign_logs'::regclass
  ) THEN
    ALTER TABLE public.email_campaign_logs
      ADD CONSTRAINT fk_email_campaign_logs_campaign
      FOREIGN KEY (id_campaign)
      REFERENCES public.email_campaigns(id_campaign)
      ON UPDATE NO ACTION
      ON DELETE CASCADE;
  END IF;
END;
$$ LANGUAGE plpgsql;

-- AM: indices para listado por estado y scheduler por programacion.
CREATE INDEX IF NOT EXISTS idx_email_campaigns_status
  ON public.email_campaigns (status);

CREATE INDEX IF NOT EXISTS idx_email_campaigns_scheduled_for
  ON public.email_campaigns (scheduled_for);

CREATE INDEX IF NOT EXISTS idx_email_campaigns_scheduler_due
  ON public.email_campaigns (scheduled_for)
  WHERE status = 'scheduled' AND scheduled_for IS NOT NULL;

-- AM: indices para consulta de destinatarios por campana y estado individual.
CREATE INDEX IF NOT EXISTS idx_email_campaign_recipients_campaign_status
  ON public.email_campaign_recipients (id_campaign, send_status);

-- AM: unicidad case-insensitive por correo dentro de cada campana.
CREATE UNIQUE INDEX IF NOT EXISTS uq_email_campaign_recipients_campaign_email_ci
  ON public.email_campaign_recipients (id_campaign, lower(recipient_email));

-- AM: funcion reutilizable de touch updated_at para tablas del modulo.
CREATE OR REPLACE FUNCTION public.fn_email_campaign_touch_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at := NOW();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_email_campaigns_touch_updated_at ON public.email_campaigns;
CREATE TRIGGER trg_email_campaigns_touch_updated_at
BEFORE UPDATE ON public.email_campaigns
FOR EACH ROW
EXECUTE FUNCTION public.fn_email_campaign_touch_updated_at();

DROP TRIGGER IF EXISTS trg_email_campaign_recipients_touch_updated_at ON public.email_campaign_recipients;
CREATE TRIGGER trg_email_campaign_recipients_touch_updated_at
BEFORE UPDATE ON public.email_campaign_recipients
FOR EACH ROW
EXECUTE FUNCTION public.fn_email_campaign_touch_updated_at();

-- AM: insercion idempotente de permisos sin depender de unique constraint implicita.
INSERT INTO public.permisos (nombre_permiso)
SELECT p.nombre_permiso
FROM (VALUES
  ('CONFIGURACION_EMAIL_CAMPAIGNS_VER'),
  ('CONFIGURACION_EMAIL_CAMPAIGNS_GESTIONAR')
) AS p(nombre_permiso)
WHERE NOT EXISTS (
  SELECT 1
  FROM public.permisos x
  WHERE x.nombre_permiso = p.nombre_permiso
);

-- AM: asignacion segura a SUPER_ADMIN por normalizacion de nombre y evitando duplicados.
INSERT INTO public.roles_permisos (id_rol, id_permiso)
SELECT r.id_rol, p.id_permiso
FROM public.roles r
INNER JOIN public.permisos p
  ON p.nombre_permiso IN ('CONFIGURACION_EMAIL_CAMPAIGNS_VER', 'CONFIGURACION_EMAIL_CAMPAIGNS_GESTIONAR')
WHERE UPPER(REGEXP_REPLACE(TRIM(r.nombre), '[\s-]+', '_', 'g')) = 'SUPER_ADMIN'
  AND NOT EXISTS (
    SELECT 1
    FROM public.roles_permisos rp
    WHERE rp.id_rol = r.id_rol
      AND rp.id_permiso = p.id_permiso
  );

COMMIT;
