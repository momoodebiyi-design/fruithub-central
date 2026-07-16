
ALTER TYPE public.inventory_category ADD VALUE IF NOT EXISTS 'semi_finished';
ALTER TYPE public.movement_type ADD VALUE IF NOT EXISTS 'opening_balance';
ALTER TYPE public.movement_type ADD VALUE IF NOT EXISTS 'receipt';
ALTER TYPE public.movement_type ADD VALUE IF NOT EXISTS 'sale';
ALTER TYPE public.movement_type ADD VALUE IF NOT EXISTS 'adjustment_in';
ALTER TYPE public.movement_type ADD VALUE IF NOT EXISTS 'adjustment_out';

DO $$ BEGIN CREATE TYPE public.sales_order_status AS ENUM ('draft','confirmed','fulfilled','void'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE public.purchase_order_status AS ENUM ('draft','ordered','partial','received','cancelled'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE public.recipe_status AS ENUM ('draft','pending_approval','approved','retired'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE public.customer_type AS ENUM ('retail','wholesale','outlet','online'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
