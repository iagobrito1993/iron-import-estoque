// Iron Import Estoque — assistente de IA (Claude)
// Ações: "ler_nota" (lê nota/invoice escaneada e devolve a compra estruturada)
//        "perguntar" (responde perguntas sobre o sistema usando SÓ os dados que o usuário logado pode ver)
// A chave fica no segredo ANTHROPIC_API_KEY do Supabase (nunca no site).
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const MODELO = "claude-sonnet-5-5";       // leitura de notas (precisão)
const MODELO_RAPIDO = "claude-haiku-5-5"; // perguntas (velocidade)
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...CORS, "Content-Type": "application/json" } });

async function claude(system: string, content: unknown[], max_tokens = 4000) {
  const key = Deno.env.get("ANTHROPIC_API_KEY");
  if (!key) throw new Error("A chave da IA ainda não foi configurada no Supabase (segredo ANTHROPIC_API_KEY).");
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({ model: MODELO, max_tokens, system, messages: [{ role: "user", content }] }),
  });
  const j = await r.json();
  if (!r.ok) throw new Error("IA: " + (j?.error?.message || r.status));
  return (j.content || []).filter((c: any) => c.type === "text").map((c: any) => c.text).join("\n");
}

function extrairJSON(t: string) {
  const i = t.indexOf("{"), f = t.lastIndexOf("}");
  if (i < 0 || f < i) throw new Error("A IA não conseguiu ler a nota.");
  return JSON.parse(t.slice(i, f + 1));
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  try {
    const auth = req.headers.get("Authorization") || "";
    const chave = Deno.env.get("SUPABASE_ANON_KEY") || req.headers.get("apikey") || "";
    const sb = createClient(Deno.env.get("SUPABASE_URL")!, chave, { global: { headers: { Authorization: auth } } });
    const { data: u } = await sb.auth.getUser();
    if (!u?.user) return json({ erro: "Faça login novamente." }, 401);
    const { data: perfil } = await sb.from("perfis").select("nome,papel").eq("user_id", u.user.id).maybeSingle();
    if (!perfil?.papel) return json({ erro: "Usuário sem acesso liberado." }, 403);
    const body = await req.json();

    if (body.acao === "ler_nota") {
      const a = body.arquivo || {};
      if (!a.base64 || !a.tipo) return json({ erro: "Envie a foto ou o PDF da nota." }, 400);
      const bloco = a.tipo === "application/pdf"
        ? { type: "document", source: { type: "base64", media_type: "application/pdf", data: a.base64 } }
        : { type: "image", source: { type: "base64", media_type: a.tipo, data: a.base64 } };
      const produtos = (body.produtos || []).slice(0, 800);
      const sys = `Você lê notas fiscais, invoices e recibos de compras feitas nos EUA para uma importadora brasileira.
Responda SOMENTE com um JSON válido, sem texto antes ou depois, no formato:
{"fornecedor":"","numero":"","data":"AAAA-MM-DD","moeda":"USD","itens":[{"descricao":"","codigo":"","qtd":0,"valor_unit":0,"desconto":0,"produto_id":null}],"subtotal":0,"desconto":0,"impostos":0,"frete":0,"total":0,"observacao":""}
Regras: valores numéricos com ponto decimal; "impostos" = sales tax; "codigo" = UPC/SKU/item # se aparecer;
"produto_id": use o id da lista de produtos cadastrados quando o item for claramente o mesmo produto (compare UPC/EAN/SKU primeiro, depois o nome); senão null.
Se algo não estiver legível, deixe vazio/0 e explique em "observacao".
Produtos cadastrados (id | nome | sku | ean | upc): ${produtos.map((p: any) => [p.id, p.nome, p.sku || "", p.ean || "", p.upc || ""].join(" | ")).join("\n")}`;
      const txt = await claude(sys, [bloco, { type: "text", text: "Leia esta nota e devolva o JSON." }]);
      return json({ nota: extrairJSON(txt) });
    }

    if (body.acao === "perguntar") {
      const q = String(body.pergunta || "").slice(0, 2000);
      if (!q.trim()) return json({ erro: "Escreva a pergunta." }, 400);
      // Dados lidos com o login de quem pergunta: as regras de acesso do banco valem aqui também.
      const verValores = perfil.papel === "admin" || perfil.papel === "socio";
      const [prod, env, full, ent, ped, wh, sig, ec] = await Promise.all([
        sb.from("produtos").select("id,nome,sku,ean,produtos_custo(qtd_eua,qtd_reservada_eua)").limit(2000),
        sb.from("envios").select("id,transportadora,rastreio,status,etapa,rota,data_saida,previsao,remessa_etapas(etapa,data,responsavel),envio_itens(produto_id,qtd_enviada,qtd_recebida,qtd_divergencia,qtd_baixada)").neq("status", "cancelado").order("id", { ascending: false }).limit(80),
        sb.from("envios_full").select("id,marketplace,conta,cd_destino,destino,rastreio,identificador,status,data_saida,envio_full_itens(produto_id,qtd,qtd_recebida)").neq("status", "cancelado").order("id", { ascending: false }).limit(150),
        sb.from("entradas_br").select("produto_id,qtd,qtd_alocada,warehouse_id").limit(5000),
        sb.from("pedidos").select("id,fornecedor,numero,data,status,pedido_itens(produto_id,qtd,qtd_aprovada)").order("id", { ascending: false }).limit(60),
        sb.from("warehouses").select("id,nome"),
        verValores ? sb.rpc("dados_sigilosos") : Promise.resolve({ data: null }),
        verValores ? sb.from("envios_custo").select("envio_id,frete,imposto,cotacao,custos_lancados,valor_pago_brl") : Promise.resolve({ data: null }),
      ]);
      // resumo compacto (menos texto = resposta mais rápida)
      const um = (x: any) => Array.isArray(x) ? x[0] : x;
      const dep: Record<string, number> = {};
      (ent.data || []).forEach((e: any) => { const k = e.produto_id + "@" + e.warehouse_id; dep[k] = (dep[k] || 0) + e.qtd - e.qtd_alocada; });
      const whN: Record<number, string> = {}; (wh.data || []).forEach((w: any) => whN[w.id] = w.nome);
      const cm: Record<number, any> = {}; ((sig as any).data?.produtos_custo || []).forEach((c: any) => cm[c.produto_id] = c);
      const produtos = (prod.data || []).map((p: any) => { const c = um(p.produtos_custo) || {}; const d = Object.entries(dep).filter(([k, v]) => k.startsWith(p.id + "@") && v).map(([k, v]) => whN[+k.split("@")[1]] + ":" + v).join(",");
        return [p.id, p.nome, p.sku || p.ean || "", c.qtd_eua || 0, c.qtd_reservada_eua || 0, d, verValores && cm[p.id] ? +(+cm[p.id].custo_medio_usd).toFixed(2) : undefined]; });
      const fech: Record<number, any> = {}; ((ec as any).data || []).forEach((c: any) => fech[c.envio_id] = c);
      const remessas = (env.data || []).map((r: any) => ({ id: r.id, t: r.transportadora, st: r.status, etapa: r.etapa, rota: r.rota, saida: r.data_saida, prev: r.previsao, rast: r.rastreio || undefined,
        etapas: (r.remessa_etapas || []).map((e: any) => [e.etapa, e.data, e.responsavel]),
        itens: (r.envio_itens || []).map((i: any) => [i.produto_id, i.qtd_enviada, i.qtd_recebida || 0, Math.max(i.qtd_enviada - (i.qtd_recebida || 0) - (i.qtd_divergencia || 0) - (i.qtd_baixada || 0), 0)]),
        fech: verValores && fech[r.id]?.custos_lancados ? { pago_brl: fech[r.id].valor_pago_brl, dolar: fech[r.id].cotacao, frete: fech[r.id].frete, imposto: fech[r.id].imposto } : undefined }));
      const despachos = (full.data || []).map((f: any) => [f.id, /flex/i.test(f.marketplace) ? "Flex" : /ag[eê]ncia/i.test(f.marketplace) ? "Agência" : "Full", f.conta, f.cd_destino, f.destino, f.identificador, f.status, f.data_saida, f.rastreio, (f.envio_full_itens || []).map((i: any) => [i.produto_id, i.qtd, i.qtd_recebida])]);
      const compras = (ped.data || []).map((p: any) => [p.id, p.fornecedor, p.numero, p.data, p.status, (p.pedido_itens || []).map((i: any) => [i.produto_id, i.qtd, i.qtd_aprovada])]);
      const sys = `Você é o assistente do sistema de estoque da Iron Import. Responda em português do Brasil, curto e direto, com números exatos tirados dos DADOS. Use nomes de produtos (não ids).
Fluxo: compra EUA → estoque EUA → remessa (rota Paraguai: aladin → paraguai → freteiro → transporte_sp; ou rota direta) → depósito (Estoque Brasil) → Full ou despachos Flex/Agência (Mercado Livre).
Usuário: ${perfil.nome} (perfil ${perfil.papel}). ${verValores ? "Ele pode ver valores." : "NUNCA informe valores, custos, fretes, preços, impostos ou pagamentos; se perguntarem, diga que é informação restrita."}
Se não estiver nos dados, diga que não encontrou. Não invente. Hoje: ${new Date().toISOString().slice(0, 10)}.
Formatos: produtos=[id,nome,sku,qtd_eua,reservado_eua,deposito "nome:qtd"${verValores ? ",custo_medio_usd" : ""}]; remessas.itens=[produto_id,enviado,recebido_no_deposito,pendente]; despachos=[id,tipo,conta_ML,cliente,destino,venda,status,data,rastreio,itens[[produto_id,qtd,entregue]]] (status: preparacao=a despachar, enviado=em rota/postado, recebido=entregue); compras=[id,fornecedor,nº,data,status,itens[[produto_id,qtd,recebido]]].
DADOS: ${JSON.stringify({ produtos, remessas, despachos, compras })}`;
      const key = Deno.env.get("ANTHROPIC_API_KEY");
      if (!key) return json({ erro: "A chave da IA ainda não foi configurada." }, 500);
      const r = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
        body: JSON.stringify({ model: MODELO_RAPIDO, max_tokens: 1200, stream: true, system: sys, messages: [{ role: "user", content: q }] }),
      });
      if (!r.ok || !r.body) { const t = await r.text(); return json({ erro: "IA: " + t.slice(0, 300) }, 500); }
      // repassa só o texto, em tempo real
      const enc = new TextEncoder(), dec = new TextDecoder();
      const saida = new ReadableStream({ async start(ctrl) {
        const rd = r.body!.getReader(); let buf = "";
        while (true) { const { value, done } = await rd.read(); if (done) break; buf += dec.decode(value, { stream: true });
          let i; while ((i = buf.indexOf("\n")) >= 0) { const l = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
            if (!l.startsWith("data:")) continue; try { const ev = JSON.parse(l.slice(5)); if (ev.type === "content_block_delta" && ev.delta?.text) ctrl.enqueue(enc.encode(ev.delta.text)); } catch (_) { /* ignora */ } } }
        ctrl.close(); } });
      return new Response(saida, { headers: { ...CORS, "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-cache" } });
    }
    return json({ erro: "Ação desconhecida." }, 400);
  } catch (e) {
    return json({ erro: (e as Error).message }, 500);
  }
});
