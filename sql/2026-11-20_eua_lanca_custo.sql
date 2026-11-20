-- EUA (Iron) volta a lançar preço de custo, sem ver valores e sem substituir custo já lançado.

-- 1) Só o administrador pode substituir um custo já lançado.
do $$
declare d text;
begin
  d:=pg_get_functiondef('public.lancar_custo_produto(bigint,numeric,numeric,boolean)'::regprocedure);
  if position('p_substituir:=false' in d)=0 then
    d:=replace(d,'perform public.exigir(array[''admin'',''eua'']);',
      'perform public.exigir(array[''admin'',''eua'']); if not tem_papel(array[''admin'']) then p_substituir:=false; end if;');
    execute d;
  end if;
end $$;

-- 2) Lista de produtos com custo pendente (só IDs, sem valores) para quem lança custo.
create or replace function public.produtos_custo_pendente()
returns jsonb language plpgsql stable security definer set search_path to 'public' as $$
begin
  if not tem_papel(array['admin','socio','eua']) then return '[]'::jsonb; end if;
  return (select coalesce(jsonb_agg(p.id),'[]'::jsonb) from produtos p
    left join produtos_custo pc on pc.produto_id=p.id
    where coalesce(pc.custo_medio_usd,0)=0
       or exists(select 1 from compras c where c.produto_id=p.id and coalesce(c.custo_usd,0)=0));
end $$;
grant execute on function public.produtos_custo_pendente() to authenticated;
