// Radar Cripto — robô de alertas. Roda a cada 2 minutos (pg_cron):
//  - alertas de preço de cada celular (dispara uma vez e apaga o alerta)
//  - a cada 15 minutos, momentos de COMPRA e de VENDA nas moedas da lista de cada celular
import { createClient } from "npm:@supabase/supabase-js@2.45.4";
import webpush from "npm:web-push@3.6.7";
import { calcular } from "./probabilidades.js";
import { filtrarUniverso, medir, montar, oportunidade, montarOportunidades } from "./scanner.js";
import { situacao, indicadores } from "./setups.js";
import { medirMoeda, montarCurto, regimeBTC } from "./curto.js";

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


// Venda para quem já tem a moeda: só na vela que CRUZOU (avisa uma vez, não toda vela)
function protecao(candles: J[]) {
  const c = candles.slice(0, -1), I = indicadores(c), i = c.length - 1;
  const r = I.r, e = I.e200;
  if (r[i] == null || r[i - 1] == null || e[i] == null || e[i - 1] == null) return null;
  return {
    vela: c[i].t, rsi: r[i], e200: e[i],
    lucro: r[i - 1] < 75 && r[i] >= 75,
    baixa: c[i - 1].c >= e[i - 1] && c[i].c < e[i],
  };
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
  if (c && !forcar && c.dados?.setups !== undefined && Date.now() - Date.parse(c.criado) < VALIDADE_MIN[tf] * 60e3) return { ...c.dados, cache: true };
  const v = await historico(par, tf);
  const r: J = calcular(v, tf);
  r.atualizado = new Date().toISOString(); r.par = par;
  if (!r.erro) await db.from("cripto_estat").upsert({ par, tf, dados: r, criado: r.atualizado });
  return r;
}


// ---------------------------------------------------------------- radar do mercado
async function radarMercado() {
  const { data: c } = await db.from("cripto_estat").select("dados,criado").eq("par", "*").eq("tf", "scan").maybeSingle();
  if (c && c.dados?.oportunidades && Date.now() - Date.parse(c.criado) < 14 * 60e3) return { ...c.dados, cache: true };
  const todos = await binance("/api/v3/ticker/24hr");
  const uni = filtrarUniverso(todos ?? [], 80);
  const medidas: any[] = [], ops: any[] = [];
  const falhas: J[] = [];
  const medirUm = async (t: J) => {
    try {
      const k = await binance(`/api/v3/klines?symbol=${t.s}&interval=1d&limit=1000`); if (!k) { falhas.push(t); return null; }
      try { ops.push(oportunidade(t, k)); } catch (_) { /* moeda sem dados suficientes */ }
      return medir(t, k.slice(-400));
    }
    catch (_) { falhas.push(t); return null; }
  };
  for (let i = 0; i < uni.length; i += 5) medidas.push(...await Promise.all(uni.slice(i, i + 5).map(medirUm)));
  // segunda tentativa, uma por vez, para as que falharam
  const repetir = falhas.splice(0);
  for (const t of repetir) medidas.push(await medirUm(t));
  const btc = medidas.find((x: any) => x?.s === "BTCUSDT");
  const out: J = montar(medidas, btc);
  out.oportunidades = montarOportunidades(ops);
  out.atualizado = new Date().toISOString(); out.falhas = falhas.length;
  if (medidas.filter(Boolean).length >= 20) await db.from("cripto_estat").upsert({ par: "*", tf: "scan", dados: out, criado: out.atualizado });
  return out;
}

// ---------------------------------------------------------------- curto prazo (velas de 1 hora)
// Refaz a conta uma vez por hora, 90 s depois de cada vela de 1 hora fechar.
async function klines1h(par: string) {
  const a = await binance(`/api/v3/klines?symbol=${par}&interval=1h&limit=1000`);
  if (!a?.length) return null;
  const b = await binance(`/api/v3/klines?symbol=${par}&interval=1h&limit=1000&endTime=${a[0][0] - 1}`).catch(() => null);
  return (b ?? []).concat(a);
}
async function radarCurto(soCache = false) {
  const { data: c } = await db.from("cripto_estat").select("dados,criado").eq("par", "*").eq("tf", "scan1h").maybeSingle();
  const horaFechada = Math.floor((Date.now() - 90e3) / 36e5) * 36e5 + 90e3;
  if (c?.dados && (soCache || Date.parse(c.criado) >= horaFechada)) return { ...c.dados, cache: true };
  const todos = await binance("/api/v3/ticker/24hr");
  const uni = filtrarUniverso(todos ?? [], 50).filter((t: J) => t.volQ >= 1e7);
  const kBtc = await klines1h("BTCUSDT");
  if (!kBtc) throw new Error("sem dados do BTC");
  const regime = regimeBTC(kBtc);
  const moedas: J[] = [];
  const um = async (t: J) => {
    try { const k = t.s === "BTCUSDT" ? kBtc : await klines1h(t.s); return k ? medirMoeda(t, k) : null; } catch (_) { return null; }
  };
  for (let i = 0; i < uni.length; i += 8) moedas.push(...await Promise.all(uni.slice(i, i + 8).map(um)));
  const out: J = montarCurto(moedas, regime);
  if (out.moedas >= 20) await db.from("cripto_estat").upsert({ par: "*", tf: "scan1h", dados: out, criado: out.atualizado });
  return out;
}

// ---------------------------------------------------------------- avisos das melhores do mercado
// chave de compra avisada: opc:PAR:regra:entrada:stop[:2]  (fica 90 dias, para acompanhar a saída)
// ":2" no fim = alvo já batido; o stop passa a ser a entrada (não perde dinheiro no resto)
const pctN = (x: number) => `${x >= 0 ? "+" : ""}${(x * 100).toFixed(1).replace(".", ",")}%`;
async function avisosMercado(subs: J[]) {
  const quer = (s: J, k: string) => { const a = s.prefs?.auto ?? {}; return (a[k] ?? (k === "mercado" ? true : a.entrada ?? true)) === true; };
  const ativos = subs.filter((s: J) => (quer(s, "mercado") || quer(s, "curto")) && (quer(s, "compra") || quer(s, "venda")));
  if (!ativos.length) return 0;
  const min = new Date().getUTCMinutes();
  const varrer = min % 15 < 2;                 // ranking completo a cada 15 min; stop/alvo das compras a cada 2 min
  const m: J | null = varrer ? await radarMercado().catch(() => null) : null;
  const ops: J = m?.oportunidades ?? {};
  // curto prazo: recalcula na rodada sem varredura diária (para não pesar), senão usa o guardado
  const curtoD: J | null = ativos.some((s: J) => quer(s, "curto")) ? await radarCurto(varrer).catch(() => null) : null;
  // compras já avisadas a cada celular (para acompanhar stop, alvo e saída)
  const { data: compras } = await db.from("cripto_enviados").select("endpoint,chave,quando").like("chave", "opc:%").gte("quando", new Date(Date.now() - 90 * 864e5).toISOString());
  const abertas: Record<string, J[]> = {};
  for (const c of compras ?? []) {
    const [, par, regra, ent, stop, fase] = String(c.chave).split(":");
    if (+ent > 0 && +stop > 0) (abertas[c.endpoint] ||= []).push({ par, regra, ent: +ent, stop: +stop, alvoBatido: fase === "2", chave: c.chave, quando: c.quando });
  }
  // preço agora das moedas compradas por aviso
  const paresAbertos = [...new Set(Object.values(abertas).flat().map((x) => x.par))].filter((p) => /^[A-Z0-9]{5,20}$/.test(p));
  const preco: Record<string, number> = {};
  if (paresAbertos.length) {
    const t = await binance(`/api/v3/ticker/price?symbols=${encodeURIComponent(JSON.stringify(paresAbertos))}`).catch(() => null);
    for (const x of t ?? []) preco[x.symbol] = +x.price;
  }
  let n = 0;
  for (const s of ativos) {
    const fila: J[] = [];
    const minhas = abertas[s.endpoint] ?? [];
    const vendidas = new Set<string>();
    // a) stop e alvo das compras avisadas (a cada 2 min, preço ao vivo)
    if (quer(s, "venda")) for (const a of minhas) {
      const p = preco[a.par]; if (!p) continue;
      // compra de curto prazo: regra@1h@alvoEmR@prazoEmHoras — vende tudo no alvo ou no fim do prazo
      const [, tfR, kR, prazoR] = String(a.regra).split("@");
      const curto = tfR === "1h";
      const alvo = a.ent + (curto ? +kR || 2 : 2) * (a.ent - a.stop);
      const venceu = curto && Date.now() >= Date.parse(a.quando) + (+prazoR || 48) * 36e5;
      if (curto && p > a.stop && p >= alvo) { vendidas.add(a.par); fila.push({ pri: 0, chave: `ovs:${a.chave.slice(4)}`,
        title: `🟢 VENDER AGORA ${base(a.par)}: bateu o alvo (curto prazo)`,
        body: `Preço ${fP(p)} ≥ alvo ${fP(alvo)}. Compra avisada a ~${fP(a.ent)} (${pctN(p / a.ent - 1)}). Realize o lucro inteiro.`, fim: a.chave }); }
      else if (venceu && p > a.stop) { vendidas.add(a.par); fila.push({ pri: 0, chave: `ovs:${a.chave.slice(4)}`,
        title: `⏱ VENDER AGORA ${base(a.par)}: prazo de ${+prazoR || 48} h acabou`,
        body: `A operação de curto prazo não chegou ao alvo a tempo. Preço ${fP(p)}, compra avisada a ~${fP(a.ent)} (${pctN(p / a.ent - 1)}). Sair libera o dinheiro para o próximo sinal.`, fim: a.chave }); }
      else if (p <= a.stop) { vendidas.add(a.par); fila.push({ pri: 0, chave: `ovs:${a.chave.slice(4)}`,
        title: a.alvoBatido ? `🔴 VENDER AGORA o resto de ${base(a.par)}: voltou à entrada` : `🔴 VENDER AGORA ${base(a.par)}: chegou no stop`,
        body: `Preço ${fP(p)} ≤ stop ${fP(a.stop)}. Avisei compra a ~${fP(a.ent)} (${pctN(p / a.ent - 1)}). Saia para proteger o capital.`, fim: a.chave }); }
      else if (!a.alvoBatido && p >= alvo) fila.push({ pri: 1, chave: `ova:${a.chave.slice(4)}`, title: `🟠 VENDER AGORA metade de ${base(a.par)}: bateu o alvo`,
        body: `Preço ${fP(p)} ≥ alvo ${fP(alvo)} (${pctN(p / a.ent - 1)} desde a compra). Venda metade; o resto fica com stop na entrada (${fP(a.ent)}) e eu aviso a hora de vender.`,
        fim: a.chave, novo: `opc:${a.par}:${a.regra}:${a.ent}:${a.ent}:2` });
    }
    // d) COMPRAR AGORA de curto prazo (gráfico de 1 hora): só sinais da última hora, regras que pagam agora
    if (curtoD && quer(s, "curto") && quer(s, "compra")) for (const c of (curtoD.compra ?? []).filter((x: J) => Date.now() - x.desde <= 75 * 60e3).slice(0, 3)) {
      if (minhas.some((x) => x.par === c.s)) continue;
      const ent = +(+c.entrada).toPrecision(6), stop = +(+c.stop).toPrecision(6);
      const hist = c.opsMoeda >= 3 ? ` Nesta moeda: ${c.opsMoeda} operações, acertou ${Math.round((c.acertoMoeda ?? 0) * 100)}%.` : "";
      fila.push({ pri: 2, chave: `opc:${c.s}:${c.id}@1h@${c.kAlvo}@${c.prazo}:${ent}:${stop}`, title: `⚡ COMPRAR AGORA ${c.b} (curto prazo)`,
        body: `${c.regra} no gráfico de 1 hora. Compra ~${fP(c.entrada)}, stop ${fP(c.stop)} (${pctN(-c.risco)}), alvo ${fP(c.alvo)} (${pctN(c.kAlvo * c.risco)}), prazo ${c.prazo} h.${hist} Vou avisar a hora de vender.` });
    }
    if (varrer && m) {
      // b) VENDER AGORA: moedas da lista ou compradas por aviso que entraram no ranking de venda
      const tenho = new Set<string>([...(s.pares ?? []), ...minhas.map((x) => x.par)]);
      if (quer(s, "venda")) for (const v of ops.venda ?? []) {
        if (!tenho.has(v.s) || vendidas.has(v.s)) continue;
        const lucro = v.tipo === "lucro";
        fila.push({ pri: lucro ? 1 : 0, chave: `opv:${v.s}:${String(v.motivos?.[0] ?? "").slice(0, 40)}`,
          title: lucro ? `🟠 VENDER AGORA (parte) ${v.b}: realizar lucro` : `🔴 VENDER AGORA ${v.b}`,
          body: `${(v.motivos ?? []).join(" ")} Preço ${fP(v.p)}.`, fim: lucro ? null : minhas.find((x) => x.par === v.s)?.chave });
      }
      // c) COMPRAR AGORA: só sinais confirmados (não "quase") das regras que pagam na moeda
      if (quer(s, "compra") && quer(s, "mercado")) for (const c of (ops.compra ?? []).filter((x: J) => x.estado === "comprar").slice(0, 5)) {
        if (minhas.some((x) => x.par === c.s)) continue;     // já avisada e ainda acompanhando
        const ent = +(+c.entrada).toPrecision(6), stop = +(+c.stop).toPrecision(6);
        fila.push({ pri: 2, chave: `opc:${c.s}:${c.id}:${ent}:${stop}`, title: `🟢 COMPRAR AGORA ${c.b}`,
          body: `${c.regra}. Compra ~${fP(c.entrada)}, stop ${fP(c.stop)} (${pctN(-c.risco)}), alvo ${fP(c.alvo)} (${pctN(2 * c.risco)}). Nesta moeda: ${c.ops} operações, acertou ${Math.round((c.acerto ?? 0) * 100)}%. Vou avisar a hora de vender.` });
      }
    }
    if (!fila.length) continue;
    const { data: ja } = await db.from("cripto_enviados").select("chave").eq("endpoint", s.endpoint).in("chave", fila.map((f) => f.chave));
    const jaSet = new Set((ja ?? []).map((x: J) => x.chave));
    const novos = fila.filter((f) => !jaSet.has(f.chave)).sort((a, b) => a.pri - b.pri);
    for (const f of novos.slice(0, 4)) {
      const par = f.chave.split(":")[1];
      if (await enviar(s, { title: f.title, body: f.body, tag: f.chave, url: `${SITE}?par=${par}` })) {
        n++; await db.from("cripto_enviados").upsert({ endpoint: s.endpoint, chave: f.chave });
        // saída avisada: para de acompanhar aquela compra
        if (f.fim) await db.from("cripto_enviados").delete().eq("endpoint", s.endpoint).eq("chave", f.fim);
        if (f.novo) await db.from("cripto_enviados").upsert({ endpoint: s.endpoint, chave: f.novo });
      }
    }
  }
  return n;
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

  // 2) MELHORES DO MERCADO: "COMPRAR AGORA" nas 80 maiores moedas e "VENDER AGORA" nas que a pessoa
  //    tem na lista ou recebeu aviso de compra (para não perder a saída de nenhuma compra avisada).
  try { enviados += await avisosMercado(subs); } catch (_) { /* não derruba o resto */ }

  // 2) momentos de COMPRA e de VENDA nas moedas da lista (a cada 15 minutos)
  const min = new Date().getUTCMinutes();
  let sinais = 0;
  if (min % 15 < 2) {
    // preferências novas: compra / venda (quem tinha só "entrada" continua recebendo os dois)
    const quer = (s: J, k: "compra" | "venda") => { const a = s.prefs?.auto ?? {}; return (a[k] ?? a.entrada ?? true) === true; };
    const tfsDe = (s: J) => (Array.isArray(s.prefs?.tfs) ? s.prefs.tfs : ["4h", "1d"]).filter((t: string) => ["1h", "4h", "1d"].includes(t));
    const ativos = subs.filter((s: J) => quer(s, "compra") || quer(s, "venda"));
    const pedidos = new Set<string>();
    for (const s of ativos) for (const p of (s.pares ?? []).slice(0, 15)) for (const t of tfsDe(s)) pedidos.add(`${p}|${t}`);

    // placar das regras: só avisa das que funcionaram naquela moeda/tempo
    const placares: Record<string, J | null> = {};
    const { data: est } = await db.from("cripto_estat").select("par,tf,notas:dados->setups->setups").neq("tf", "scan");
    for (const e of est ?? []) placares[`${e.par}|${e.tf}`] = (e as J).notas ?? null;
    // moeda/tempo ainda sem placar: calcula um por rodada (o primeiro cálculo é pesado)
    const t0 = Date.now();
    for (const chave of pedidos) {
      if (placares[chave]) continue;
      const [p, t] = chave.split("|");
      try { const r: J = await estatisticas(p, t); placares[chave] = r?.setups?.setups ?? null; } catch (_) { /* tenta na próxima */ }
      break;
    }

    const leituras: Record<string, J | null> = {};
    for (const chave of pedidos) {
      if (Date.now() - t0 > 100e3) break;
      const [p, t] = chave.split("|");
      try {
        const k = await binance(`/api/v3/klines?symbol=${p}&interval=${t}&limit=600`);
        const c = (k ?? []).map((x: any[]) => ({ t: x[0], o: +x[1], h: +x[2], l: +x[3], c: +x[4], v: +x[5] }));
        leituras[chave] = c.length >= 260 ? { sit: situacao(c), prot: protecao(c) } : null;
      } catch (_) { leituras[chave] = null; }
    }

    const pct = (x: number) => `${x >= 0 ? "+" : ""}${(x * 100).toFixed(1).replace(".", ",")}%`;
    for (const s of ativos) {
      const fila: J[] = [];
      for (const p of (s.pares ?? []).slice(0, 15)) {
        for (const t of tfsDe(s)) {
          const L = leituras[`${p}|${t}`]; if (!L?.sit) continue;
          const notas = placares[`${p}|${t}`];
          const nome = base(p), prazo = NOME_TF[t], preco = L.sit.preco;
          for (const x of L.sit.setups) {
            const nt = notas?.[x.id];
            if (nt?.nota?.nivel !== "bom" && nt?.nota?.nivel !== "medio") continue;   // regra não funcionou aqui: ignora
            const hist = `No histórico desta moeda: acertou ${Math.round(nt.acerto * 100)}% em ${nt.trades} operações.`;
            if (quer(s, "compra") && x.estado === "comprar")
              fila.push({ pri: 1, chave: `ent:${p}:${t}:${x.id}:${x.desde}`, title: `🟢 Hora de COMPRAR ${nome} (${prazo})`,
                body: `${x.nome}. Compra ~${fP(x.entrada)}, stop ${fP(x.stop0)}, alvo ${fP(x.alvo1)}. ${hist}` });
            if (quer(s, "venda") && x.estado === "vender")
              fila.push({ pri: 0, chave: `sai:${p}:${t}:${x.id}:${x.desde}`, title: `🔴 Hora de VENDER ${nome} (${prazo})`,
                body: `${x.nome}: ${x.motivoSaida}. Comprado pela regra a ${fP(x.entrada)}; agora ${fP(preco)} (${pct(preco / x.entrada - 1)}).` });
            if (quer(s, "venda") && x.estado === "posicao" && preco <= x.stop)
              fila.push({ pri: 0, chave: `stop:${p}:${t}:${x.id}:${x.desde}`, title: `🔴 VENDER ${nome}: chegou no stop (${prazo})`,
                body: `${x.nome}. Stop ${fP(x.stop)}, preço agora ${fP(preco)}. Comprado pela regra a ${fP(x.entrada)} (${pct(preco / x.entrada - 1)}).` });
            if (quer(s, "venda") && x.ultimaSaida && /stop/.test(x.ultimaSaida.motivo))
              fila.push({ pri: 0, chave: `stop:${p}:${t}:${x.id}:${x.ultimaSaida.desde}`, title: `🔴 VENDER ${nome}: bateu o ${x.ultimaSaida.motivo} (${prazo})`,
                body: `${x.nome}. Saída a ${fP(x.ultimaSaida.saida)}, comprado a ${fP(x.ultimaSaida.entrada)} (${pct(x.ultimaSaida.ret)}).` });
          }
          // para quem já tem a moeda, mesmo sem ter comprado pelas regras (só 4 horas e diário)
          if (quer(s, "venda") && t !== "1h" && L.prot) {
            const P = L.prot;
            if (P.lucro) fila.push({ pri: 2, chave: `luc:${p}:${t}:${P.vela}`, title: `🟠 Hora de REALIZAR LUCRO em ${nome} (${prazo})`,
              body: `IFR passou de 75 (${P.rsi.toFixed(0)}): subida esticada. Vender uma parte protege o ganho. Preço ${fP(preco)}.` });
            if (P.baixa) fila.push({ pri: 2, chave: `baixa:${p}:${t}:${P.vela}`, title: `🔴 ${nome} virou para BAIXA (${prazo})`,
              body: `Fechou abaixo da média de 200 (${fP(P.e200)}). Para quem tem a moeda: hora de vender ou usar stop curto. Preço ${fP(preco)}.` });
          }
        }
      }
      if (!fila.length) continue;
      const { data: ja } = await db.from("cripto_enviados").select("chave").eq("endpoint", s.endpoint).in("chave", fila.map(f => f.chave));
      const jaSet = new Set((ja ?? []).map((x: J) => x.chave));
      const vistos = new Set<string>();
      const novos = fila.filter(f => !jaSet.has(f.chave) && !vistos.has(f.chave) && (vistos.add(f.chave), true)).sort((a, b) => a.pri - b.pri);
      for (const f of novos.slice(0, 4)) {
        const par = f.chave.split(":")[1];
        if (await enviar(s, { title: f.title, body: f.body, tag: f.chave, url: `${SITE}?par=${par}` })) {
          sinais++; await db.from("cripto_enviados").upsert({ endpoint: s.endpoint, chave: f.chave });
        }
      }
    }
    await db.from("cripto_enviados").delete().lt("quando", new Date(Date.now() - 14 * 86400e3).toISOString()).not("chave", "like", "opc:%");
    await db.from("cripto_enviados").delete().lt("quando", new Date(Date.now() - 90 * 86400e3).toISOString());
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
  if (req.method === "GET" && u.searchParams.get("acao") === "curto") {
    try {
      const r = await radarCurto();
      return new Response(JSON.stringify(r), { headers: { ...CORS, "Content-Type": "application/json", "Cache-Control": "public, max-age=120" } });
    } catch (e: any) { return resp({ erro: String(e?.message ?? e) }, 502); }
  }
  if (req.method === "GET" && u.searchParams.get("acao") === "mercado") {
    try {
      const r = await radarMercado();
      return new Response(JSON.stringify(r), { headers: { ...CORS, "Content-Type": "application/json", "Cache-Control": "public, max-age=300" } });
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
