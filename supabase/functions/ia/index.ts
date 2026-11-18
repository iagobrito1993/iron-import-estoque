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
const MODELO_PERGUNTAS = "claude-haiku-5-5"; // perguntas: rápido; os números já chegam calculados
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...CORS, "Content-Type": "application/json" } });

async function claude(system: unknown, content: unknown[], max_tokens = 4000, modelo = MODELO) {
  const key = Deno.env.get("ANTHROPIC_API_KEY");
  if (!key) throw new Error("A chave da IA ainda não foi configurada no Supabase (segredo ANTHROPIC_API_KEY).");
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({ model: modelo, max_tokens, system, messages: [{ role: "user", content }] }),
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
      const [prod, env, full, ent, ped, wh, sig, ec, vat, cso, fit] = await Promise.all([
        sb.from("produtos").select("id,nome,sku,ean,produtos_custo(qtd_eua,qtd_reservada_eua)").limit(2000),
        sb.from("envios").select("id,transportadora,rastreio,status,etapa,rota,data_saida,previsao,remessa_etapas(etapa,data,responsavel),envio_itens(produto_id,qtd_enviada,qtd_recebida,qtd_divergencia,qtd_baixada)").neq("status", "cancelado").order("id", { ascending: false }).limit(80),
        sb.from("envios_full").select("id,marketplace,conta,cd_destino,destino,rastreio,identificador,status,data_saida,envio_full_itens(produto_id,qtd,qtd_recebida)").neq("status", "cancelado").order("id", { ascending: false }).limit(150),
        sb.from("entradas_br").select("produto_id,qtd,qtd_alocada,warehouse_id").limit(5000),
        sb.from("pedidos").select("id,fornecedor,numero,data,status,pedido_itens(produto_id,qtd,qtd_aprovada)").order("id", { ascending: false }).limit(60),
        sb.from("warehouses").select("id,nome"),
        verValores ? sb.rpc("dados_sigilosos") : Promise.resolve({ data: null }),
        verValores ? sb.from("envios_custo").select("envio_id,frete,imposto,cotacao,custos_lancados,valor_pago_brl") : Promise.resolve({ data: null }),
        verValores ? sb.from("vendas_atacado").select("id,full_id,data,forma,condicao,parcelas,desconto,frete,taxas,total,clientes_atacado(nome,cidade),vendas_atacado_itens(full_item_id,preco_unit),vendas_parcelas(numero,vencimento,valor,recebido_em,valor_recebido)").order("id", { ascending: false }).limit(300) : Promise.resolve({ data: null }),
        verValores ? sb.rpc("custo_saidas") : Promise.resolve({ data: null }),
        verValores ? sb.from("envio_full_itens").select("id,full_id,produto_id,qtd").limit(10000) : Promise.resolve({ data: null }),
      ]);
      // resumo já calculado (a IA só lê, não precisa fazer contas)
      const um = (x: any) => Array.isArray(x) ? x[0] : x;
      const whN: Record<number, string> = {}; (wh.data || []).forEach((w: any) => whN[w.id] = w.nome);
      const cm: Record<number, any> = {}; ((sig as any).data?.produtos_custo || []).forEach((c: any) => cm[c.produto_id] = c);
      const fech: Record<number, any> = {}; ((ec as any).data || []).forEach((c: any) => fech[c.envio_id] = c);
      const nomeP: Record<number, string> = {}; (prod.data || []).forEach((p: any) => nomeP[p.id] = p.nome);
      const NA_ALF = ["alfandega", "fiscalizacao", "aguardando_doc", "aguardando_pag", "retida"];
      const EM_TRANS = ["transito", "liberada", "parcial", ...NA_ALF];
      const ETQ: Record<string, string> = { aladin: "Aladin a caminho do Paraguai", paraguai: "No Paraguai", freteiro: "Com o freteiro", transporte_sp: "Transporte até SP", direta: "Rota direta (DHL/etiquetas)", alfandega: "Na alfândega" };
      const P: Record<number, any> = {};
      const pp = (id: number) => P[id] ||= { produto: nomeP[id] || ("#" + id), eua_disponivel: 0, eua_reservado: 0, em_transito: {} as Record<string, number>, deposito_livre: {} as Record<string, number>, deposito_reservado: 0, a_caminho_do_full: 0, no_full: 0, despachos_abertos: 0 };
      (prod.data || []).forEach((p: any) => { const c = um(p.produtos_custo) || {}; const x = pp(p.id); x.sku = p.sku || p.ean || undefined; x.eua_disponivel = c.qtd_eua || 0; x.eua_reservado = c.qtd_reservada_eua || 0;
        if (verValores && cm[p.id]) x.custo_medio_usd = +(+cm[p.id].custo_medio_usd).toFixed(2); });
      (ent.data || []).forEach((e: any) => { const l = e.qtd - e.qtd_alocada; if (!l) return; const x = pp(e.produto_id); const w = whN[e.warehouse_id] || "Depósito"; x.deposito_livre[w] = (x.deposito_livre[w] || 0) + l; });
      (env.data || []).forEach((r: any) => { if (!EM_TRANS.includes(r.status)) return;
        const k = NA_ALF.includes(r.status) ? "alfandega" : r.rota === "paraguai" ? (r.etapa || "aladin") : "direta";
        (r.envio_itens || []).forEach((i: any) => { const pend = Math.max(i.qtd_enviada - (i.qtd_recebida || 0) - (i.qtd_divergencia || 0) - (i.qtd_baixada || 0), 0); if (!pend) return; const x = pp(i.produto_id); x.em_transito[ETQ[k]] = (x.em_transito[ETQ[k]] || 0) + pend; }); });
      (full.data || []).forEach((f: any) => { const desp = /flex|ag[eê]ncia/i.test(f.marketplace);
        (f.envio_full_itens || []).forEach((i: any) => { const x = pp(i.produto_id); const pend = Math.max(i.qtd - (i.qtd_recebida || 0), 0);
          if (["preparacao", "conferido"].includes(f.status)) { x.deposito_reservado += i.qtd; if (desp) x.despachos_abertos += i.qtd; }
          else if (["enviado", "parcial", "divergencia"].includes(f.status)) { if (desp) x.despachos_abertos += pend; else x.a_caminho_do_full += pend; }
          if (!desp) x.no_full += i.qtd_recebida || 0; }); });
      const estoque = Object.values(P).filter((x: any) => x.eua_disponivel || x.eua_reservado || Object.keys(x.em_transito).length || Object.keys(x.deposito_livre).length || x.deposito_reservado || x.a_caminho_do_full || x.no_full || x.despachos_abertos);
      const soma = (f: (x: any) => number) => estoque.reduce((s: number, x: any) => s + f(x), 0);
      const transTot: Record<string, number> = {}; estoque.forEach((x: any) => Object.entries(x.em_transito).forEach(([k, v]) => transTot[k] = (transTot[k] || 0) + (v as number)));
      const depTot: Record<string, number> = {}; estoque.forEach((x: any) => Object.entries(x.deposito_livre).forEach(([k, v]) => depTot[k] = (depTot[k] || 0) + (v as number)));
      const totais = { eua_disponivel: soma(x => x.eua_disponivel), eua_reservado_em_remessas: soma(x => x.eua_reservado), em_transito_por_etapa: transTot, em_transito_total: Object.values(transTot).reduce((a, b) => a + b, 0),
        deposito_disponivel: depTot, deposito_reservado: soma(x => x.deposito_reservado), a_caminho_do_full: soma(x => x.a_caminho_do_full), no_full: soma(x => x.no_full), unidades_em_despachos_abertos: soma(x => x.despachos_abertos) };
      const remessas = (env.data || []).map((r: any) => ({ remessa: r.id, transportadora: r.transportadora, situacao: r.status, rota: r.rota, etapa_atual: r.rota === "paraguai" ? ETQ[r.etapa || "aladin"] : undefined, saida: r.data_saida, previsao: r.previsao || undefined, rastreio: r.rastreio || undefined,
        etapas_lancadas: (r.remessa_etapas || []).map((e: any) => `${ETQ[e.etapa] || e.etapa} em ${e.data}${e.responsavel ? " (" + e.responsavel + ")" : ""}`),
        produtos: (r.envio_itens || []).map((i: any) => `${nomeP[i.produto_id]}: enviado ${i.qtd_enviada}, conferido no depósito ${i.qtd_recebida || 0}`),
        fechamento_em_reais: verValores ? (fech[r.id]?.custos_lancados ? { pago_brl: fech[r.id].valor_pago_brl, dolar_efetivo: fech[r.id].cotacao, fretes_brl: fech[r.id].frete, impostos_brl: fech[r.id].imposto } : "pendente") : undefined }));
      const SD: Record<string, string> = { preparacao: "a despachar", conferido: "separado", enviado: "em rota/postado", parcial: "entregue em parte", recebido: "entregue", divergencia: "com ocorrência" };
      const despachos = (full.data || []).map((f: any) => ({ id: f.id, tipo: /flex/i.test(f.marketplace) ? "Flex" : /ag[eê]ncia/i.test(f.marketplace) ? "Agência" : "Full", conta: f.conta || undefined, cliente: f.cd_destino || undefined, destino: f.destino || undefined, venda: f.identificador || undefined, situacao: SD[f.status] || f.status, data: f.data_saida || undefined, rastreio: f.rastreio || undefined,
        produtos: (f.envio_full_itens || []).map((i: any) => `${nomeP[i.produto_id]} x${i.qtd}`) }));
      const compras = (ped.data || []).map((p: any) => ({ compra: p.id, fornecedor: p.fornecedor, numero: p.numero || undefined, data: p.data, situacao: p.status, produtos: (p.pedido_itens || []).map((i: any) => `${nomeP[i.produto_id]}: comprado ${i.qtd}, recebido ${i.qtd_aprovada}`) }));
      const hojeS = new Date().toISOString().slice(0, 10);
      const custoItem: Record<number, any> = {}; (((cso as any).data) || []).forEach((c: any) => custoItem[c.full_item_id] = c);
      const itensFull: Record<number, any[]> = {}; (((fit as any).data) || []).forEach((i: any) => (itensFull[i.full_id] ||= []).push(i));
      const stFull: Record<number, string> = {}; (full.data || []).forEach((f: any) => stFull[f.id] = f.status);
      const atacado = (((vat as any).data) || []).filter((v: any) => stFull[v.full_id] !== "cancelado").map((v: any) => {
        const pr: Record<number, number> = {}; (v.vendas_atacado_itens || []).forEach((i: any) => pr[i.full_item_id] = +i.preco_unit);
        const its = itensFull[v.full_id] || []; let custo = 0, pend = false;
        const produtos = its.map((i: any) => { const c = custoItem[i.id]; if (!c || c.pendente) pend = true; custo += c ? +c.custo : 0; return `${nomeP[i.produto_id]} x${i.qtd} a R$ ${pr[i.id] ?? "?"}`; });
        const ps = v.vendas_parcelas || []; const rec = ps.reduce((s: number, x: any) => s + (x.recebido_em ? +(x.valor_recebido ?? x.valor) : 0), 0);
        const aberto = ps.filter((x: any) => !x.recebido_em); const desp = (+v.frete || 0) + (+v.taxas || 0); const margem = +v.total - custo - desp;
        return { venda: v.id, cliente: v.clientes_atacado?.nome, data: v.data, condicao: v.condicao, forma: v.forma, total: +v.total, custo_produtos: +custo.toFixed(2), custo_pendente: pend || undefined,
          frete_e_taxas: desp, margem: +margem.toFixed(2), margem_pct: v.total > 0 ? +(margem / +v.total * 100).toFixed(1) : 0, recebido: +rec.toFixed(2), recebido_pct: v.total > 0 ? +(rec / +v.total * 100).toFixed(1) : 0,
          a_receber: aberto.reduce((s: number, x: any) => s + +x.valor, 0), vencido: aberto.filter((x: any) => x.vencimento && x.vencimento < hojeS).reduce((s: number, x: any) => s + +x.valor, 0), produtos };
      });
      const sys = `Você é o assistente do sistema de estoque da Iron Import. Responda em português do Brasil, de forma clara e organizada, usando APENAS os DADOS abaixo — copie os números exatamente, não recalcule nem estime.
Fluxo: compra nos EUA → estoque EUA → remessa (rota Paraguai: Aladin → Paraguai → freteiro → transporte até SP; ou rota direta DHL/etiquetas) → depósito (Estoque Brasil) → Full ou despachos Flex/Agência do Mercado Livre.
Para perguntas gerais como "como está meu estoque", comece pelos TOTAIS por localização (EUA, em trânsito por etapa, depósito, Full, despachos) e depois destaque os principais produtos.
Usuário: ${perfil.nome} (perfil ${perfil.papel}). ${verValores ? "Ele pode ver valores." : "NUNCA informe valores, custos, fretes, preços, impostos ou pagamentos; se perguntarem, diga que é informação restrita."}
Se a informação não estiver nos dados, diga que não encontrou — nunca invente. Hoje: ${new Date().toISOString().slice(0, 10)}.
DADOS:
TOTAIS = ${JSON.stringify(totais)}
ESTOQUE_POR_PRODUTO = ${JSON.stringify(estoque)}
REMESSAS = ${JSON.stringify(remessas)}
DESPACHOS_E_FULL = ${JSON.stringify(despachos)}
COMPRAS = ${JSON.stringify(compras)}${verValores ? "\nVENDAS_ATACADO (valores em R$; margem = total − custo dos produtos − frete e taxas; recebimento líquido = recebido − frete e taxas) = " + JSON.stringify(atacado) : ""}`;
      const key = Deno.env.get("ANTHROPIC_API_KEY");
      if (!key) return json({ erro: "A chave da IA ainda não foi configurada." }, 500);
      const modeloQ = (perfil.papel === "admin" && body.modelo) ? String(body.modelo) : MODELO_PERGUNTAS;
      const sistema = [{ type: "text", text: sys, cache_control: { type: "ephemeral" } }];
      if (body.stream === false) {
        const txt = await claude(sistema as any, [{ type: "text", text: q }], 1500, modeloQ);
        return json({ resposta: txt });
      }
      const r = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
        body: JSON.stringify({ model: modeloQ, max_tokens: 1500, stream: true, system: sistema, messages: [{ role: "user", content: q }] }),
      });
      if (!r.ok || !r.body) { const t = await r.text(); return json({ erro: "IA: " + t.slice(0, 300) }, 500); }
      // repassa só o texto, em tempo real; "\u0004" no fim = resposta completa
      let buf = "";
      const tr = new TransformStream<string, string>({
        transform(chunk, ctrl) {
          buf += chunk; let i;
          while ((i = buf.indexOf("\n")) >= 0) {
            const l = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
            if (!l.startsWith("data:")) continue;
            try { const ev = JSON.parse(l.slice(5));
              if (ev.type === "content_block_delta" && ev.delta?.text) ctrl.enqueue(ev.delta.text);
              else if (ev.type === "message_stop") ctrl.enqueue("\u0004");
              else if (ev.type === "error") ctrl.enqueue("\n\n(A IA teve um problema: " + (ev.error?.message || "erro") + ")");
            } catch (_) { /* linha incompleta */ }
          }
        },
      });
      const saida = r.body.pipeThrough(new TextDecoderStream()).pipeThrough(tr).pipeThrough(new TextEncoderStream());
      return new Response(saida, { headers: { ...CORS, "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-cache", "X-Accel-Buffering": "no" } });
    }
    return json({ erro: "Ação desconhecida." }, 400);
  } catch (e) {
    return json({ erro: (e as Error).message }, 500);
  }
});
