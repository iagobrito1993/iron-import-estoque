-- Venda direta em atacado: clientes, vendas (estoque sai pelo mesmo controle do Full), preços, parcelas e recebimentos
create table if not exists public.clientes_atacado(
  id bigserial primary key, nome text not null, documento text, telefone text, email text, cidade text, endereco text, obs text,
  ativo boolean not null default true, criado_por uuid default auth.uid(), criado_em timestamptz not null default now());
create table if not exists public.vendas_atacado(
  id bigserial primary key, full_id bigint not null unique references public.envios_full(id) on delete cascade,
  cliente_id bigint references public.clientes_atacado(id), data date not null default current_date,
  forma text, condicao text, parcelas integer not null default 1, prazo_dias integer,
  desconto numeric(14,2) not null default 0, frete numeric(14,2) not null default 0, taxas numeric(14,2) not null default 0,
  total numeric(14,2) not null default 0, obs text, criado_por uuid default auth.uid(), criado_em timestamptz not null default now());
create table if not exists public.vendas_atacado_itens(
  full_item_id bigint primary key references public.envio_full_itens(id) on delete cascade,
  venda_id bigint not null references public.vendas_atacado(id) on delete cascade, preco_unit numeric(14,4) not null);
create table if not exists public.vendas_parcelas(
  id bigserial primary key, venda_id bigint not null references public.vendas_atacado(id) on delete cascade,
  numero integer not null, vencimento date, valor numeric(14,2) not null,
  recebido_em date, valor_recebido numeric(14,2), forma text, obs text, recebido_por uuid);
create index if not exists vendas_parcelas_venda on public.vendas_parcelas(venda_id);

do $$declare t text; begin
  foreach t in array array['clientes_atacado','vendas_atacado','vendas_atacado_itens','vendas_parcelas'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists ler on public.%I', t);
    execute format('create policy ler on public.%I for select using (tem_papel(array[''admin'',''socio'']))', t);
    execute format('revoke insert, update, delete on public.%I from anon, authenticated', t);
    execute format('drop trigger if exists trg_audit on public.%I', t);
    execute format('create trigger trg_audit after insert or delete or update on public.%I for each row execute function public._audit()', t);
  end loop;
end$$;

create or replace function public.salvar_cliente_atacado(p jsonb) returns bigint
language plpgsql security definer set search_path=public as $$
declare v_id bigint := nullif(p->>'id','')::bigint;
begin
  if not tem_papel(array['admin','socio']) then raise exception 'Sem permissão.'; end if;
  if coalesce(trim(p->>'nome'),'')='' then raise exception 'Informe o nome do cliente.'; end if;
  if v_id is null then
    insert into clientes_atacado(nome,documento,telefone,email,cidade,endereco,obs)
    values (trim(p->>'nome'),nullif(trim(p->>'documento'),''),nullif(trim(p->>'telefone'),''),nullif(trim(p->>'email'),''),
            nullif(trim(p->>'cidade'),''),nullif(trim(p->>'endereco'),''),nullif(trim(p->>'obs'),'')) returning id into v_id;
  else
    if not tem_papel(array['admin']) then raise exception 'Só o administrador pode editar clientes.'; end if;
    update clientes_atacado set nome=trim(p->>'nome'),documento=nullif(trim(p->>'documento'),''),telefone=nullif(trim(p->>'telefone'),''),
      email=nullif(trim(p->>'email'),''),cidade=nullif(trim(p->>'cidade'),''),endereco=nullif(trim(p->>'endereco'),''),obs=nullif(trim(p->>'obs'),'')
    where id=v_id;
  end if;
  return v_id;
end$$;

create or replace function public.salvar_venda_atacado(p jsonb) returns bigint
language plpgsql security definer set search_path=public as $$
declare v_id bigint; v_full bigint := (p->>'full_id')::bigint; it jsonb; pc jsonb;
begin
  if not tem_papel(array['admin','socio']) then raise exception 'Sem permissão.'; end if;
  if not exists(select 1 from envios_full where id=v_full and marketplace ilike 'atacado%') then raise exception 'Venda não encontrada.'; end if;
  insert into vendas_atacado(full_id,cliente_id,data,forma,condicao,parcelas,prazo_dias,desconto,frete,taxas,total,obs)
  values (v_full, nullif(p->>'cliente_id','')::bigint, coalesce(nullif(p->>'data','')::date,current_date), nullif(p->>'forma',''), nullif(p->>'condicao',''),
    greatest(coalesce(nullif(p->>'parcelas','')::int,1),1), nullif(p->>'prazo_dias','')::int,
    coalesce(nullif(p->>'desconto','')::numeric,0), coalesce(nullif(p->>'frete','')::numeric,0), coalesce(nullif(p->>'taxas','')::numeric,0),
    coalesce(nullif(p->>'total','')::numeric,0), nullif(p->>'obs',''))
  returning id into v_id;
  for it in select * from jsonb_array_elements(coalesce(p->'itens','[]')) loop
    insert into vendas_atacado_itens(full_item_id,venda_id,preco_unit)
    select (it->>'full_item_id')::bigint, v_id, coalesce((it->>'preco_unit')::numeric,0)
    where exists(select 1 from envio_full_itens where id=(it->>'full_item_id')::bigint and full_id=v_full);
  end loop;
  for pc in select * from jsonb_array_elements(coalesce(p->'parcelas_lista','[]')) loop
    insert into vendas_parcelas(venda_id,numero,vencimento,valor)
    values (v_id,(pc->>'numero')::int,nullif(pc->>'vencimento','')::date,(pc->>'valor')::numeric);
  end loop;
  return v_id;
end$$;

create or replace function public.receber_parcela(p_id bigint, p_data date, p_valor numeric, p_forma text, p_obs text) returns void
language plpgsql security definer set search_path=public as $$
begin
  if not tem_papel(array['admin','socio']) then raise exception 'Sem permissão.'; end if;
  if tem_papel(array['socio']) and exists(select 1 from vendas_parcelas where id=p_id and recebido_em is not null) then
    raise exception 'Parcela já recebida. Só o administrador pode alterar.'; end if;
  update vendas_parcelas set recebido_em=coalesce(p_data,current_date), valor_recebido=p_valor, forma=nullif(p_forma,''), obs=nullif(p_obs,''), recebido_por=auth.uid()
  where id=p_id;
  if not found then raise exception 'Parcela não encontrada.'; end if;
end$$;

create or replace function public.estornar_parcela(p_id bigint) returns void
language plpgsql security definer set search_path=public as $$
begin
  if not tem_papel(array['admin']) then raise exception 'Só o administrador pode estornar.'; end if;
  update vendas_parcelas set recebido_em=null, valor_recebido=null, recebido_por=null where id=p_id;
end$$;

-- custo real (R$) de cada item vendido, pelos lotes que saíram do depósito (custo do fechamento da remessa)
create or replace function public.custo_saidas() returns jsonb
language plpgsql stable security definer set search_path=public as $$
begin
  if not tem_papel(array['admin','socio']) then return '[]'::jsonb; end if;
  return coalesce((select jsonb_agg(jsonb_build_object('full_item_id',x.full_item_id,'custo',x.custo,'pendente',x.pendente)) from (
    select l.full_item_id, sum(l.qtd*coalesce(c.custo_br,0)) custo, bool_or(coalesce(c.custo_br,0)<=0) pendente
    from envio_full_lotes l join entradas_br e on e.id=l.entrada_br_id
    left join envio_itens_custo c on c.item_id=e.envio_item_id
    group by l.full_item_id) x),'[]'::jsonb);
end$$;

revoke all on function public.salvar_cliente_atacado(jsonb), public.salvar_venda_atacado(jsonb), public.receber_parcela(bigint,date,numeric,text,text),
  public.estornar_parcela(bigint), public.custo_saidas() from public, anon;
grant execute on function public.salvar_cliente_atacado(jsonb), public.salvar_venda_atacado(jsonb), public.receber_parcela(bigint,date,numeric,text,text),
  public.estornar_parcela(bigint), public.custo_saidas() to authenticated;

-- anexos das vendas (comprovantes de recebimento) usam a entidade 'full' já existente
notify pgrst, 'reload schema';
