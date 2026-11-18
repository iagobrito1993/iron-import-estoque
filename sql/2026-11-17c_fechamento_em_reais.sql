-- Iron Import Estoque — 17/11/2026 (fechamento em reais)
-- Compra fica em US$; o custo em R$ nasce no fechamento de cada remessa, a partir do valor realmente pago (com IOF, spread, taxas).

alter table public.envios_custo add column if not exists valor_pago_brl numeric(14,2);

-- sócios também podem lançar o fechamento (preço de custo) da remessa
do $$declare d text; begin
  d:=pg_get_functiondef('public.lancar_custos_entrada(bigint,numeric,numeric,numeric,jsonb)'::regprocedure);
  if position('exigir(array[''admin'',''eua''])' in d)>0 then
    execute replace(d,'exigir(array[''admin'',''eua''])','exigir(array[''admin'',''eua'',''socio''])');
  end if;
end$$;

-- novo tipo de anexo: comprovantes do fechamento em R$ (câmbio, PIX, TED)
do $$declare d text; begin
  d:=pg_get_functiondef('public.registrar_anexo(text,bigint,text,text,text,bigint)'::regprocedure);
  if position('''fechamento''' in d)=0 then
    execute replace(d,'''aporte'',''divergencia'')','''aporte'',''divergencia'',''fechamento'')');
  end if;
end$$;
alter policy ler on public.anexos using (ativo() and (
  entidade <> all(array['lancamento','aporte','pedido','fechamento']) or tem_papel(array['admin','socio']) or criado_por=auth.uid()));

create or replace function public.salvar_valor_pago(p_envio bigint, p_valor numeric) returns void
language plpgsql security definer set search_path=public as $$
begin
  if not tem_papel(array['admin','socio']) then raise exception 'Sem permissão.'; end if;
  if tem_papel(array['socio']) and exists(select 1 from envios_custo where envio_id=p_envio and valor_pago_brl is not null) then
    raise exception 'O fechamento já foi lançado. Só o administrador pode alterar.'; end if;
  update envios_custo set valor_pago_brl=p_valor where envio_id=p_envio;
end$$;
revoke all on function public.salvar_valor_pago(bigint,numeric) from public, anon;
grant execute on function public.salvar_valor_pago(bigint,numeric) to authenticated;
notify pgrst, 'reload schema';
