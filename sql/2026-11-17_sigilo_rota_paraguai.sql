-- Iron Import Estoque — 17/11/2026
-- 1) Backup completo das tabelas  2) Sigilo: valores só para o admin  3) Rota Paraguai (etapas)

-- ========== 1. BACKUP ==========
create schema if not exists backup_20261117;
revoke all on schema backup_20261117 from public, anon, authenticated;
do $$declare t text; begin
  for t in select tablename from pg_tables where schemaname='public' loop
    execute format('drop table if exists backup_20261117.%I', t);
    execute format('create table backup_20261117.%I as table public.%I', t, t);
  end loop;
end$$;

-- ========== 2. SIGILO ==========
-- Permissões financeiras passam a ser exclusivas do admin
create or replace function public.tem_perm(p text) returns boolean
language sql stable security definer set search_path=public as $$
  select exists(select 1 from perfis f where f.user_id=auth.uid() and f.papel is not null and (
    f.papel='admin' or (
      p not in ('ver_custos','ver_financeiro','editar_financeiro','ver_aportes','editar_aportes')
      and (p=any(coalesce(f.perms,'{}')) or p=any(case f.papel
        when 'eua' then array['produtos','compras','receber_compras','remessas','alfandega']
        when 'brasil' then array['alfandega','warehouse','full']
        else array[]::text[] end)))))
$$;
update public.perfis set perms=array(select x from unnest(perms) x
  where x not in ('ver_custos','ver_financeiro','editar_financeiro','ver_aportes','editar_aportes'))
where perms is not null;

-- Tabelas 100% sigilosas: só admin lê
alter policy p_sel on public.envios_custo      using (tem_papel(array['admin']));
alter policy p_sel on public.envio_itens_custo using (tem_papel(array['admin']));
alter policy p_sel on public.compras           using (tem_papel(array['admin']));
alter policy ler   on public.contas            using (tem_papel(array['admin']));
alter policy ler   on public.participantes     using (tem_papel(array['admin']));
alter policy ler   on public.lancamentos       using (tem_papel(array['admin']));
alter policy ler   on public.movimentos_participantes using (tem_papel(array['admin']));
alter policy ler   on public.anexos using (ativo() and (
  entidade <> all(array['lancamento','aporte','pedido']) or tem_papel(array['admin']) or criado_por=auth.uid()));

-- Arquivos: só abre o arquivo quem enxerga o anexo (ou quem enviou)
alter policy anexos_ler on storage.objects using (bucket_id='anexos' and ativo() and (
  owner=auth.uid() or tem_papel(array['admin'])
  or exists(select 1 from public.anexos a where a.caminho=objects.name)));

-- Tabelas mistas: colunas de valor ficam bloqueadas para leitura direta
revoke select on public.produtos_custo, public.pedidos, public.pedido_itens,
  public.envios, public.alfandega_eventos, public.envios_full from anon, authenticated;
grant select (produto_id,qtd_eua,qtd_reservada_eua) on public.produtos_custo to authenticated;
grant select (id,chave,fornecedor,numero,data,previsao,responsavel,moeda,obs,status,perc_recebido,motivo_status,
  criado_por,criado_em,atualizado_por,atualizado_em) on public.pedidos to authenticated;
grant select (id,pedido_id,produto_id,variacao,embalagem,un_por_emb,qtd,qtd_aprovada,qtd_divergencia,qtd_baixada)
  on public.pedido_itens to authenticated;
grant select (id,envio_id,status,data,documentos,moeda,obs,criado_por,criado_em) on public.alfandega_eventos to authenticated;
grant select (id,chave,warehouse_id,marketplace,conta,empresa,cd_destino,identificador,volumes,etiquetas,responsavel,
  data_saida,transporte,moeda,status,obs,conferido_por,conferido_em,saida_por,saida_em,encerrado_motivo,criado_por,criado_em)
  on public.envios_full to authenticated;

-- ========== 3. ROTA PARAGUAI ==========
alter table public.envios add column if not exists rota text not null default 'paraguai';
alter table public.envios add column if not exists etapa text;
do $$begin
  if not exists(select 1 from pg_constraint where conname='envios_rota_check') then
    alter table public.envios add constraint envios_rota_check check (rota in ('paraguai','direta'));
  end if;
end$$;
update public.envios set rota=case when transportadora ilike 'aladin%' then 'paraguai' else 'direta' end;
update public.envios set etapa='aladin' where rota='paraguai' and etapa is null and status not in ('preparacao','cancelado');

create or replace function public._rota_padrao() returns trigger language plpgsql as $$
begin
  if tg_op='INSERT' and new.transportadora is not null and new.transportadora not ilike 'aladin%' then new.rota:='direta'; end if;
  return new;
end$$;
drop trigger if exists trg_rota_padrao on public.envios;
create trigger trg_rota_padrao before insert on public.envios for each row execute function public._rota_padrao();

grant select (id,transportadora,rastreio,caixas,peso_kg,data_saida,status,data_alfandega,obs_alfandega,data_chegada,obs_chegada,
  obs,criado_por,recebido_por,criado_em,origem,destino,previsao,moeda_despesas,responsavel,chave,saida_em,saida_por,
  warehouse_id,status_transito,encerrado_motivo,rota,etapa) on public.envios to authenticated;

create table if not exists public.remessa_etapas(
  id bigserial primary key,
  envio_id bigint not null references public.envios(id) on delete cascade,
  etapa text not null check (etapa in ('aladin','paraguai','freteiro','transporte_sp')),
  data date not null default current_date,
  responsavel text, telefone text, rastreio text, volumes integer,
  valor numeric(14,2) not null default 0, moeda text not null default 'BRL', obs text,
  criado_por uuid default auth.uid(), criado_em timestamptz not null default now());
create index if not exists remessa_etapas_envio on public.remessa_etapas(envio_id);
alter table public.remessa_etapas enable row level security;
drop policy if exists ler on public.remessa_etapas;
create policy ler on public.remessa_etapas for select using (ativo());
revoke all on public.remessa_etapas from anon, authenticated;
grant select (id,envio_id,etapa,data,responsavel,telefone,rastreio,volumes,moeda,obs,criado_por,criado_em)
  on public.remessa_etapas to authenticated;
drop trigger if exists trg_audit on public.remessa_etapas;
create trigger trg_audit after insert or delete or update on public.remessa_etapas for each row execute function public._audit();

create or replace function public.registrar_etapa(p jsonb) returns bigint
language plpgsql security definer set search_path=public as $$
declare v_id bigint; v_env envios%rowtype; v_etapa text:=p->>'etapa';
begin
  if not (tem_perm('remessas') or tem_perm('alfandega') or tem_perm('warehouse')) then
    raise exception 'Sem permissão para atualizar a remessa.'; end if;
  if v_etapa is null or v_etapa not in ('aladin','paraguai','freteiro','transporte_sp') then raise exception 'Etapa inválida.'; end if;
  select * into v_env from envios where id=(p->>'envio_id')::bigint for update;
  if not found then raise exception 'Remessa não encontrada.'; end if;
  if v_env.rota<>'paraguai' then raise exception 'Esta remessa não segue a rota Paraguai.'; end if;
  if v_env.status in ('preparacao','cancelado') then raise exception 'Confirme a saída da remessa antes de lançar as etapas.'; end if;
  insert into remessa_etapas(envio_id,etapa,data,responsavel,telefone,rastreio,volumes,valor,moeda,obs)
  values (v_env.id, v_etapa, coalesce(nullif(p->>'data','')::date,current_date), nullif(trim(p->>'responsavel'),''),
    nullif(trim(p->>'telefone'),''), nullif(trim(p->>'rastreio'),''), nullif(p->>'volumes','')::int,
    greatest(coalesce(nullif(p->>'valor','')::numeric,0),0), coalesce(nullif(p->>'moeda',''),'BRL'), nullif(trim(p->>'obs'),''))
  returning id into v_id;
  update envios set etapa=v_etapa where id=v_env.id;
  return v_id;
end$$;

create or replace function public.excluir_etapa(p_id bigint) returns void
language plpgsql security definer set search_path=public as $$
declare v_env bigint;
begin
  if not tem_papel(array['admin']) then raise exception 'Só o administrador pode excluir etapas.'; end if;
  delete from remessa_etapas where id=p_id returning envio_id into v_env;
  if v_env is not null then
    update envios set etapa=coalesce((select etapa from remessa_etapas where envio_id=v_env order by data desc, id desc limit 1),'aladin')
    where id=v_env;
  end if;
end$$;

create or replace function public.definir_rota(p_id bigint, p_rota text) returns void
language plpgsql security definer set search_path=public as $$
begin
  if not tem_perm('remessas') then raise exception 'Sem permissão.'; end if;
  if p_rota not in ('paraguai','direta') then raise exception 'Rota inválida.'; end if;
  update envios set rota=p_rota,
    etapa=case when p_rota='paraguai' and status not in ('preparacao','cancelado') then coalesce(etapa,'aladin') when p_rota='direta' then null else etapa end
  where id=p_id;
end$$;

-- Valores sigilosos: entregues só ao admin
create or replace function public.dados_sigilosos() returns jsonb
language plpgsql stable security definer set search_path=public as $$
begin
  if not tem_papel(array['admin']) then return '{}'::jsonb; end if;
  return jsonb_build_object(
    'produtos_custo',(select coalesce(jsonb_agg(jsonb_build_object('produto_id',produto_id,'custo_medio',custo_medio,'custo_medio_usd',custo_medio_usd)),'[]') from produtos_custo),
    'pedidos',(select coalesce(jsonb_agg(jsonb_build_object('id',id,'cotacao_brl',cotacao_brl,'cotacao_usd',cotacao_usd,'data_cotacao',data_cotacao,
       'subtotal',subtotal,'desconto',desconto,'impostos',impostos,'frete',frete,'total',total,'pago_por',pago_por,'conta_origem',conta_origem,
       'forma_pagamento',forma_pagamento,'situacao_pagamento',situacao_pagamento)),'[]') from pedidos),
    'pedido_itens',(select coalesce(jsonb_agg(jsonb_build_object('id',id,'valor_unit',valor_unit,'desconto',desconto,'custo_unit_final',custo_unit_final,'custo_usd',custo_usd)),'[]') from pedido_itens),
    'envios',(select coalesce(jsonb_agg(jsonb_build_object('id',id,'frete_transp',frete_transp,'seguro',seguro,'despesas',despesas)),'[]') from envios),
    'alfandega_eventos',(select coalesce(jsonb_agg(jsonb_build_object('id',id,'imposto',imposto,'taxas',taxas)),'[]') from alfandega_eventos),
    'envios_full',(select coalesce(jsonb_agg(jsonb_build_object('id',id,'custo',custo)),'[]') from envios_full),
    'remessa_etapas',(select coalesce(jsonb_agg(jsonb_build_object('id',id,'valor',valor)),'[]') from remessa_etapas));
end$$;

revoke all on function public.registrar_etapa(jsonb), public.excluir_etapa(bigint), public.definir_rota(bigint,text), public.dados_sigilosos() from public, anon;
grant execute on function public.registrar_etapa(jsonb), public.excluir_etapa(bigint), public.definir_rota(bigint,text), public.dados_sigilosos() to authenticated;
notify pgrst, 'reload schema';
