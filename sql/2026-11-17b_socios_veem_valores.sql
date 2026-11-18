-- Iron Import Estoque — 17/11/2026 (ajuste)
-- Sócios (Edson, Eduardo) veem todos os valores e lançam gastos/aportes; EUA (Iron) lança valores mas não vê.
create or replace function public.tem_perm(p text) returns boolean
language sql stable security definer set search_path=public as $$
  select exists(select 1 from perfis f where f.user_id=auth.uid() and f.papel is not null and (
    f.papel='admin'
    or (p in ('ver_custos','ver_financeiro','editar_financeiro','ver_aportes','editar_aportes') and f.papel='socio')
    or (p not in ('ver_custos','ver_financeiro','editar_financeiro','ver_aportes','editar_aportes')
      and (p=any(coalesce(f.perms,'{}')) or p=any(case f.papel
        when 'eua' then array['produtos','compras','receber_compras','remessas','alfandega']
        when 'brasil' then array['alfandega','warehouse','full']
        else array[]::text[] end)))))
$$;

alter policy p_sel on public.envios_custo      using (tem_papel(array['admin','socio']));
alter policy p_sel on public.envio_itens_custo using (tem_papel(array['admin','socio']));
alter policy p_sel on public.compras           using (tem_papel(array['admin','socio']));
alter policy ler   on public.contas            using (tem_papel(array['admin','socio']));
alter policy ler   on public.participantes     using (tem_papel(array['admin','socio']));
alter policy ler   on public.lancamentos       using (tem_papel(array['admin','socio']));
alter policy ler   on public.movimentos_participantes using (tem_papel(array['admin','socio']));
alter policy ler   on public.anexos using (ativo() and (
  entidade <> all(array['lancamento','aporte','pedido']) or tem_papel(array['admin','socio']) or criado_por=auth.uid()));
alter policy anexos_ler on storage.objects using (bucket_id='anexos' and ativo() and (
  owner=auth.uid() or tem_papel(array['admin','socio'])
  or exists(select 1 from public.anexos a where a.caminho=objects.name)));

create or replace function public.dados_sigilosos() returns jsonb
language plpgsql stable security definer set search_path=public as $$
begin
  if not tem_papel(array['admin','socio']) then return '{}'::jsonb; end if;
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
notify pgrst, 'reload schema';
