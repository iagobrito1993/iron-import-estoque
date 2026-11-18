-- Despachos Flex e Agência: destino e rastreio do cliente
alter table public.envios_full add column if not exists destino text;
alter table public.envios_full add column if not exists rastreio text;
grant select (destino, rastreio) on public.envios_full to authenticated;
create or replace function public.salvar_despacho(p_id bigint, p_destino text, p_rastreio text) returns void
language plpgsql security definer set search_path=public as $$
begin
  if not tem_perm('full') then raise exception 'Sem permissão.'; end if;
  update envios_full set destino=nullif(trim(p_destino),''), rastreio=nullif(trim(p_rastreio),'') where id=p_id;
  if not found then raise exception 'Despacho não encontrado.'; end if;
end$$;
revoke all on function public.salvar_despacho(bigint,text,text) from public, anon;
grant execute on function public.salvar_despacho(bigint,text,text) to authenticated;
notify pgrst, 'reload schema';
