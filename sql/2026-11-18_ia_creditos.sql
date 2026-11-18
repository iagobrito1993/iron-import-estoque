-- Controle dos créditos da IA (Anthropic): registra o custo de cada uso e avisa o administrador quando o saldo estiver acabando
create table if not exists public.ia_uso(
  id bigserial primary key, criado_em timestamptz not null default now(), usuario uuid default auth.uid(),
  acao text, modelo text, entrada integer not null default 0, saida integer not null default 0,
  cache_lido integer not null default 0, cache_criado integer not null default 0, custo_usd numeric(12,6) not null default 0);
create index if not exists ia_uso_criado on public.ia_uso(criado_em);
create table if not exists public.ia_creditos(
  id integer primary key default 1 check (id=1), saldo_usd numeric(12,2), em timestamptz, alerta_usd numeric(12,2) not null default 3);
insert into public.ia_creditos(id) values (1) on conflict do nothing;

do $$declare t text; begin
  foreach t in array array['ia_uso','ia_creditos'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists ler on public.%I', t);
    execute format('create policy ler on public.%I for select using (tem_papel(array[''admin'']))', t);
    execute format('revoke insert, update, delete on public.%I from anon, authenticated', t);
  end loop;
end$$;

-- preços por milhão de tokens (US$): Haiku 5.5 e Sonnet 5.5
create or replace function public.registrar_uso_ia(p_acao text, p_modelo text, p_in integer, p_out integer, p_cr integer, p_cw integer) returns void
language plpgsql security definer set search_path=public as $$
declare pi numeric; po numeric; pr numeric; pw numeric;
begin
  if auth.uid() is null then return; end if;
  if p_modelo ilike '%haiku%' then pi:=0.10; po:=0.50; pr:=0.01; pw:=0.125;
  else pi:=2.00; po:=10.00; pr:=0.10; pw:=2.50; end if;
  insert into ia_uso(acao,modelo,entrada,saida,cache_lido,cache_criado,custo_usd)
  values (left(p_acao,40), left(p_modelo,60), greatest(coalesce(p_in,0),0), greatest(coalesce(p_out,0),0), greatest(coalesce(p_cr,0),0), greatest(coalesce(p_cw,0),0),
    (greatest(coalesce(p_in,0),0)*pi + greatest(coalesce(p_out,0),0)*po + greatest(coalesce(p_cr,0),0)*pr + greatest(coalesce(p_cw,0),0)*pw)/1000000.0);
end$$;

create or replace function public.ia_saldo() returns jsonb
language plpgsql stable security definer set search_path=public as $$
declare c ia_creditos; g numeric; gm numeric; n integer;
begin
  if not tem_papel(array['admin']) then return null; end if;
  select * into c from ia_creditos where id=1;
  select coalesce(sum(custo_usd),0), count(*) into g, n from ia_uso where c.em is null or criado_em>=c.em;
  select coalesce(sum(custo_usd),0) into gm from ia_uso where criado_em>=date_trunc('month',now());
  return jsonb_build_object('saldo_informado',c.saldo_usd,'em',c.em,'alerta',c.alerta_usd,'gasto',round(g,4),'usos',n,'gasto_mes',round(gm,4),
    'restante',case when c.saldo_usd is null then null else round(c.saldo_usd-g,2) end);
end$$;

create or replace function public.ia_informar_saldo(p_saldo numeric, p_alerta numeric) returns void
language plpgsql security definer set search_path=public as $$
begin
  if not tem_papel(array['admin']) then raise exception 'Só o administrador.'; end if;
  if p_saldo is null or p_saldo<0 then raise exception 'Informe o saldo atual em US$.'; end if;
  update ia_creditos set saldo_usd=p_saldo, em=now(), alerta_usd=coalesce(nullif(p_alerta,0),alerta_usd) where id=1;
end$$;

revoke all on function public.registrar_uso_ia(text,text,integer,integer,integer,integer), public.ia_saldo(), public.ia_informar_saldo(numeric,numeric) from public, anon;
grant execute on function public.registrar_uso_ia(text,text,integer,integer,integer,integer), public.ia_saldo(), public.ia_informar_saldo(numeric,numeric) to authenticated;
notify pgrst, 'reload schema';
