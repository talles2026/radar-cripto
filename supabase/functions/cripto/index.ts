// Radar Cripto — robô de alertas. Roda a cada 2 minutos (pg_cron):
//  - alertas de preço de cada celular (dispara uma vez e apaga o alerta)
//  - a cada 15 minutos, sinais do gráfico nas moedas da lista de cada celular
import { createClient } from "npm:@supabase/supabase-js@2.45.4";
import webpush from "npm:web-push@3.6.7";
import { analisar } from "./analise.js";
import { calcular } from "./probabilidades.js";

const SITE = "https://talles2026.github.io/radar-cripto/";
const APIS = ["https://api.binance.com", "https://data-api.binance.vision", "https://api1.binance.com", "https://api2.binance.com"];
const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-cron", "Access-Control-Allow-Methods": "GET, POST, OPTIONS" };
const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
type J = Record<string, any>;
const resp = (d: unknown, status = 200) => new Response(JSON.stringify(d), { status, headers: { ...CORS, "Content-Type": "application/json" } });

let apiOk = 0;
async function binance(caminho: string) {
  for (let k = 0; k < APIS.length; k++) {
    const i = (apiOk + k) % APIS.length;
    try {
      const r = await fetch(APIS[i] + caminho, { signal: AbortSignal.timeout(8000) });
      if (r.status === 400) return null;
      if (!r.ok) continue;
      apiOk = i; return await r.json();
    } catch (_) { /* próximo endereço */ }
  }
  throw new Error("Binance indisponível");
}
const base = (s: string) => s.replace(/(USDT|FDUSD|USDC|BRL|BTC)$/, "");
const casas = (p: number) => p >= 1000 ? 2 : p >= 1 ? 3 : p >= 0.01 ? 5 : 8;
const fP = (p: number) => p.toLocaleString("pt-BR", { minimumFractionDigits: casas(p), maximumFractionDigits: casas(p) });
const NOME_TF: J = { "1h": "1 hora", "4h": "4 horas", "1d": "diário" };

async function vapid() {
  const { data } = await db.from("estado").select("chave,valor").in("chave", ["vapid_public", "vapid_private"]);
  const E = Object.fromEntries((data ?? []).map((x: J) => [x.chave, x.valor]));
  webpush.setVapidDetails("mailto:radar-cripto@users.noreply.github.com", E.vapid_public, E.vapid_private);
}
async function enviar(s: J, payload: J) {
  try {
    await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, JSON.stringify(payload), { TTL: 1800, urgency: "high" });
    return true;
  } catch (e: any) {
    if (e?.statusCode === 404 || e?.statusCode === 410) await db.from("cripto_inscricoes").delete().eq("endpoint", s.endpoint);
    return false;
  }
}


// ---------------------------------------------------------------- histórico e probabilidades
const LIMITE: J = { "1h": 20000, "4h": 13000, "1d": 4000 };
const VALIDADE_MIN: J = { "1h": 60, "4h": 180, "1d": 720 };
const MS: J = { "1h": 36e5, "4h": 144e5, "1d": 864e5 };
const paraLinha = (k: any[]) => [k[0], +k[1], +k[2], +k[3], +k[4], +k[5]];

async function historico(par: string, tf: string) {
  const { data: h } = await db.from("cripto_hist").select("dados,ultimo").eq("par", par).eq("tf", tf).maybeSingle();
  let v: any[] = h?.dados ?? [];
  const agora = Date.now();
  const fechado = (k: any[]) => k[0] + MS[tf] <= agora;
  if (!v.length) {
    // primeira vez: busca para trás, de 1000 em 1000
    let fim = agora;
    while (v.length < LIMITE[tf]) {
      const k = await binance(`/api/v3/klines?symbol=${par}&interval=${tf}&limit=1000&endTime=${fim}`);
      if (!k?.length) break;
      v = k.filter(fechado).map(paraLinha).concat(v);
      if (k.length < 1000) break;
      fim = k[0][0] - 1;
    }
  } else {
    // atualização: só o que falta
    let ini = v[v.length - 1][0] + 1;
    for (let voltas = 0; voltas < 30; voltas++) {
      const k = await binance(`/api/v3/klines?symbol=${par}&interval=${tf}&limit=1000&startTime=${ini}`);
      const novos = (k ?? []).filter(fechado).map(paraLinha);
      if (!novos.length) break;
      v = v.concat(novos); ini = novos[novos.length - 1][0] + 1;
      if ((k ?? []).length < 1000) break;
    }
  }
  // sem duplicados, em ordem, no limite
  const vistos = new Set<number>();
  v = v.filter(x => !vistos.has(x[0]) && (vistos.add(x[0]), true)).sort((a, b) => a[0] - b[0]).slice(-LIMITE[tf]);
  if (v.length) await db.from("cripto_hist").upsert({ par, tf, dados: v, ultimo: v[v.length - 1][0], atualizado: new Date().toISOString() });
  return v;
}

async function estatisticas(par: string, tf: string, forcar = false) {
  const { data: c } = await db.from("cripto_estat").select("dados,criado").eq("par", par).eq("tf", tf).maybeSingle();
  if (c && !forcar && Date.now() - Date.parse(c.criado) < VALIDADE_MIN[tf] * 60e3) return { ...c.dados, cache: true };
  const v = await historico(par, tf);
  const r: J = calcular(v, tf);
  r.atualizado = new Date().toISOString(); r.par = par;
  if (!r.erro) await db.from("cripto_estat").upsert({ par, tf, dados: r, criado: r.atualizado });
  return r;
}

async function rodar() {
  const { data: subs } = await db.from("cripto_inscricoes").select("*");
  if (!subs?.length) return { inscricoes: 0 };
  await vapid();
  let enviados = 0;

  // 1) alertas de preço
  const comAlerta = subs.filter((s: J) => Array.isArray(s.alertas) && s.alertas.length);
  const paresAlerta = [...new Set(comAlerta.flatMap((s: J) => s.alertas.map((a: J) => String(a.par))))].filter(p => /^[A-Z0-9]{5,20}$/.test(p));
  const precos: Record<string, number> = {};
  if (paresAlerta.length) {
    const t = await binance(`/api/v3/ticker/price?symbols=${encodeURIComponent(JSON.stringify(paresAlerta))}`);
    for (const x of t ?? []) precos[x.symbol] = +x.price;
  }
  for (const s of comAlerta) {
    const restantes: J[] = [];
    for (const a of s.alertas) {
      const p = precos[a.par];
      const bateu = p != null && ((a.tipo === "acima" && p >= a.valor) || (a.tipo === "abaixo" && p <= a.valor));
      if (!bateu) { restantes.push(a); continue; }
      const ok = await enviar(s, { title: `${base(a.par)} ${a.tipo === "acima" ? "subiu acima" : "caiu abaixo"} de ${fP(+a.valor)}`, body: `Preço agora: ${fP(p)}. Este alerta foi apagado; crie outro se quiser.`, tag: `preco-${a.id}`, url: `${SITE}?par=${a.par}` });
      if (ok) enviados++; else restantes.push(a);
    }
    if (restantes.length !== s.alertas.length) await db.from("cripto_inscricoes").update({ alertas: restantes }).eq("endpoint", s.endpoint);
  }

  // 2) sinais do gráfico (a cada 15 minutos)
  const min = new Date().getUTCMinutes();
  let sinais = 0;
  if (min % 15 < 2) {
    const quer = (s: J, k: string) => (s.prefs?.auto ?? {})[k] === true;
    const tfsDe = (s: J) => (Array.isArray(s.prefs?.tfs) ? s.prefs.tfs : ["4h", "1d"]).filter((t: string) => ["1h", "4h", "1d"].includes(t));
    const pedidos = new Set<string>();
    for (const s of subs) for (const p of (s.pares ?? []).slice(0, 15)) for (const t of tfsDe(s)) pedidos.add(`${p}|${t}`);
    const precisaMov = subs.some((s: J) => quer(s, "movimento"));
    if (precisaMov) for (const s of subs) for (const p of (s.pares ?? []).slice(0, 15)) pedidos.add(`${p}|1h`);
    const leituras: Record<string, J | null> = {};
    const t0 = Date.now();
    for (const chave of pedidos) {
      if (Date.now() - t0 > 80e3) break;
      const [p, t] = chave.split("|");
      try {
        const k = await binance(`/api/v3/klines?symbol=${p}&interval=${t}&limit=300`);
        const c = (k ?? []).map((x: any[]) => ({ t: x[0], o: +x[1], h: +x[2], l: +x[3], c: +x[4], v: +x[5] }));
        const a = analisar(c);
        if (a && t === "1h" && c.length > 2) { const f = c[c.length - 2]; (a as J).mov1h = (f.c / f.o - 1) * 100; }
        leituras[chave] = a;
      } catch (_) { leituras[chave] = null; }
    }
    for (const s of subs) {
      const fila: J[] = [];
      for (const p of (s.pares ?? []).slice(0, 15)) {
        for (const t of tfsDe(s)) {
          const a = leituras[`${p}|${t}`]; if (!a) continue;
          const id = `${p}:${t}:${a.ultimoFechado}`, nome = `${base(p)} (${NOME_TF[t]})`;
          if (quer(s, "rsi") && a.rsiZona === "alto") fila.push({ chave: `rsi:${id}`, title: `${nome}: IFR em ${a.rsi.toFixed(0)}`, body: `Sobrecomprado: risco maior de correção. Preço ${fP(a.preco)}.` });
          if (quer(s, "rsi") && a.rsiZona === "baixo") fila.push({ chave: `rsi:${id}`, title: `${nome}: IFR em ${a.rsi.toFixed(0)}`, body: `Sobrevendido: chance maior de repique. Preço ${fP(a.preco)}.` });
          if (quer(s, "macd") && a.macdCruz) fila.push({ chave: `macd:${id}`, title: `${nome}: MACD virou para ${a.macdCruz === "alta" ? "cima" : "baixo"}`, body: `Possível começo de movimento de ${a.macdCruz}. Preço ${fP(a.preco)}.` });
          if (quer(s, "cruz") && a.cruz) fila.push({ chave: `cruz:${p}:${t}:${a.cruz}`, title: `${nome}: cruzamento de ${a.cruz} das médias 50/200`, body: a.cruz === "alta" ? "Média de 50 passou acima da de 200 (cruz dourada)." : "Média de 50 caiu abaixo da de 200 (cruz da morte)." });
          if (quer(s, "rompe") && a.rompe) fila.push({ chave: `rompe:${id}`, title: `${nome}: ${a.rompe === "alta" ? "rompeu a máxima" : "perdeu a mínima"} de 20 velas`, body: `Preço ${fP(a.preco)}. Confira o volume para ver se o movimento tem força.` });
          if (quer(s, "volume") && a.volForte) fila.push({ chave: `vol:${id}`, title: `${nome}: volume muito acima da média`, body: `Movimento com força no último candle. Preço ${fP(a.preco)}.` });
        }
        const h = leituras[`${p}|1h`];
        if (quer(s, "movimento") && h?.mov1h != null && Math.abs(h.mov1h) >= 3) fila.push({ chave: `mov:${p}:${h.ultimoFechado}`, title: `${base(p)} ${h.mov1h > 0 ? "subiu" : "caiu"} ${Math.abs(h.mov1h).toFixed(1).replace(".", ",")}% em 1 hora`, body: `Preço ${fP(h.preco)}.` });
      }
      if (!fila.length) continue;
      const { data: ja } = await db.from("cripto_enviados").select("chave").eq("endpoint", s.endpoint).in("chave", fila.map(f => f.chave));
      const jaSet = new Set((ja ?? []).map((x: J) => x.chave));
      for (const f of fila.filter(f => !jaSet.has(f.chave)).slice(0, 4)) {
        const par = f.chave.split(":")[1];
        if (await enviar(s, { title: f.title, body: f.body, tag: f.chave, url: `${SITE}?par=${par}` })) {
          sinais++; await db.from("cripto_enviados").upsert({ endpoint: s.endpoint, chave: f.chave });
        }
      }
    }
    await db.from("cripto_enviados").delete().lt("quando", new Date(Date.now() - 14 * 86400e3).toISOString());
  }
  return { inscricoes: subs.length, alertasPreco: enviados, sinais };
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  const u = new URL(req.url);
  if (req.method === "GET" && u.searchParams.get("acao") === "estat") {
    const par = String(u.searchParams.get("par") || "").toUpperCase(), tf = String(u.searchParams.get("tf") || "");
    if (!/^[A-Z0-9]{5,20}$/.test(par) || !LIMITE[tf]) return resp({ erro: "parâmetros inválidos" }, 400);
    try {
      const r = await estatisticas(par, tf);
      return new Response(JSON.stringify(r), { headers: { ...CORS, "Content-Type": "application/json", "Cache-Control": "public, max-age=600" } });
    } catch (e: any) { return resp({ erro: String(e?.message ?? e) }, 502); }
  }
  const corpo = await req.json().catch(() => ({}));
  try {
    if (corpo.acao === "teste") {
      const { data: s } = await db.from("cripto_inscricoes").select("*").eq("endpoint", String(corpo.endpoint || "")).maybeSingle();
      if (!s) return resp({ ok: false, erro: "inscrição não encontrada" }, 404);
      await vapid();
      return resp({ ok: await enviar(s, { title: "Radar Cripto", body: "Teste: os alertas estão funcionando neste celular. 📈", tag: "teste", url: SITE }) });
    }
    if (corpo.acao === "rodar") {
      const t = req.headers.get("x-cron");
      const { data } = await db.from("estado").select("valor").eq("chave", "cron_token").maybeSingle();
      if (!t || t !== data?.valor) return resp({ erro: "não autorizado" }, 401);
      return resp(await rodar());
    }
    return resp({ erro: "ação desconhecida" }, 400);
  } catch (e: any) {
    return resp({ erro: String(e?.message ?? e) }, 502);
  }
});
