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
const MODELO = "claude-sonnet-5-5";
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
    const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!, { global: { headers: { Authorization: auth } } });
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
      const envSel = "id,transportadora,rastreio,status,etapa,rota,data_saida,previsao,origem,destino,caixas,peso_kg,remessa_etapas(etapa,data,responsavel,volumes,obs),envio_itens(produto_id,qtd_enviada,qtd_recebida,qtd_divergencia,qtd_baixada)";
      const [prod, env, full, ent, ped, sig] = await Promise.all([
        sb.from("produtos").select("id,nome,sku,ean,produtos_custo(qtd_eua,qtd_reservada_eua)").limit(2000),
        sb.from("envios").select(envSel).order("id", { ascending: false }).limit(200),
        sb.from("envios_full").select("id,marketplace,conta,cd_destino,destino,rastreio,identificador,status,data_saida,transporte,envio_full_itens(produto_id,qtd,qtd_recebida)").order("id", { ascending: false }).limit(300),
        sb.from("entradas_br").select("produto_id,qtd,qtd_alocada,warehouse_id").limit(5000),
        sb.from("pedidos").select("id,fornecedor,numero,data,status,pedido_itens(produto_id,qtd,qtd_aprovada)").order("id", { ascending: false }).limit(200),
        sb.rpc("dados_sigilosos"),
      ]);
      const verValores = perfil.papel === "admin" || perfil.papel === "socio";
      let custos: any = null;
      if (verValores) {
        const { data: ec } = await sb.from("envios_custo").select("envio_id,frete,imposto,cotacao,custos_lancados,valor_pago_brl");
        custos = { remessas: ec, ...(sig.data || {}) };
      }
      const dados = { produtos: prod.data, remessas: env.data, despachos_e_full: full.data, entradas_deposito: ent.data, compras: ped.data, valores: custos };
      const sys = `Você é o assistente do sistema de estoque da Iron Import. Responda em português do Brasil, curto e direto, com números exatos tirados dos DADOS abaixo.
Fluxo: compra nos EUA → estoque EUA → remessa (rota Paraguai: Aladin → Paraguai → freteiro → transporte SP; ou rota direta) → Depósito/Estoque Brasil → Full ou despachos Flex/Agência (Mercado Livre).
Usuário: ${perfil.nome} (perfil ${perfil.papel}). ${verValores ? "Ele pode ver valores." : "NUNCA informe valores, custos, fretes, preços, impostos ou pagamentos — este perfil não tem acesso; se perguntarem, diga que essa informação é restrita."}
Se a resposta não estiver nos dados, diga que não encontrou. Não invente.
DADOS (JSON): ${JSON.stringify(dados).slice(0, 180000)}`;
      const txt = await claude(sys, [{ type: "text", text: q }], 1500);
      return json({ resposta: txt });
    }
    return json({ erro: "Ação desconhecida." }, 400);
  } catch (e) {
    return json({ erro: (e as Error).message }, 500);
  }
});
