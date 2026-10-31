// Radar Cripto — radar do mercado: varre as maiores moedas da Binance (em USDT) e separa
// as que estão mais fortes, rompendo, com volume fora do normal, recuando dentro de tendência de alta
// e as mais fracas. Tudo pelo gráfico diário; nada aqui é recomendação.
import { ema, rsi, atr } from "./analise.js";

const ESTAVEIS = new Set(["USDC", "FDUSD", "TUSD", "BUSD", "DAI", "USDP", "EUR", "AEUR", "USDE", "PYUSD", "XUSD", "USD1", "EURI", "BFUSD", "RLUSD", "USDS", "PAXG", "XAUT", "WBTC", "WBETH", "BNSOL"]);
const alavancado = (b) => /(UP|DOWN|BULL|BEAR)$/.test(b) && b.length > 4;

export function filtrarUniverso(tickers, max = 80) {
  return tickers
    .filter((t) => t.symbol.endsWith("USDT"))
    .map((t) => ({ s: t.symbol, b: t.symbol.slice(0, -4), p: +t.lastPrice, var24: +t.priceChangePercent, volQ: +t.quoteVolume, n: +t.count }))
    .filter((t) => !ESTAVEIS.has(t.b) && !alavancado(t.b) && t.volQ >= 2e6 && t.p > 0)
    .sort((a, b) => b.volQ - a.volQ)
    .slice(0, max);
}

// k: klines diárias da Binance (array de arrays)
export function medir(t, k) {
  if (!k || k.length < 60) return null;
  const c = k.map((x) => ({ t: x[0], o: +x[1], h: +x[2], l: +x[3], c: +x[4], v: +x[5], q: +x[7] }));
  const n = c.length, f = c.map((x) => x.c), ult = n - 1;   // o último candle é o dia em andamento
  const e50 = ema(f, 50), e200 = ema(f, 200), r = rsi(f), a = atr(c);
  const ret = (d) => (n > d ? f[ult] / f[ult - d] - 1 : null);
  const qMedia = c.slice(Math.max(0, n - 21), n - 1).reduce((s, x) => s + x.q, 0) / Math.min(20, n - 1);
  const max20 = Math.max(...c.slice(Math.max(0, n - 21), n - 1).map((x) => x.h));
  const min20 = Math.min(...c.slice(Math.max(0, n - 21), n - 1).map((x) => x.l));
  const max365 = Math.max(...c.slice(Math.max(0, n - 366), n - 1).map((x) => x.h));
  const A = a[ult] || a[ult - 1];
  return {
    s: t.s, b: t.b, p: f[ult], var24: t.var24, volQ: t.volQ,
    r7: ret(7), r30: ret(30), r90: ret(90),
    rsi: r[ult - 1] ?? r[ult],
    acima50: e50[ult] != null ? f[ult] > e50[ult] : null,
    acima200: e200[ult] != null ? f[ult] > e200[ult] : null,
    e50acima200: e50[ult] != null && e200[ult] != null ? e50[ult] > e200[ult] : null,
    distE50: e50[ult] && A ? (f[ult] - e50[ult]) / A : null,
    volRel: qMedia ? t.volQ / qMedia : null,
    rompeu: f[ult] > max20, perdeu: f[ult] < min20,
    doTopo: max365 ? f[ult] / max365 - 1 : null,
    atrPct: A ? A / f[ult] : null,
    dias: n,
  };
}

const pct = (v) => (v == null ? "–" : (v > 0 ? "+" : "") + (v * 100).toFixed(1).replace(".", ",") + "%");

export function montar(lista, btc) {
  // fora: moedas que quase não oscilam (atreladas ao dólar ou ao ouro)
  const ok = lista.filter((x) => x && (x.atrPct == null || x.atrPct >= 0.004));
  // força relativa: desempenho ajustado pela volatilidade, comparado ao BTC
  const rk = (k) => { const ord = ok.filter((x) => x[k] != null).map((x) => x[k]).sort((a, b) => a - b); return (v) => (v == null ? 0.5 : ord.findIndex((y) => y >= v) / Math.max(1, ord.length - 1)); };
  const R7 = rk("r7"), R30 = rk("r30"), R90 = rk("r90");
  for (const x of ok) {
    x.forca = 0.35 * R30(x.r30) + 0.25 * R7(x.r7) + 0.25 * R90(x.r90) + (x.acima200 ? 0.1 : 0) + (x.e50acima200 ? 0.05 : 0);
    x.vsBtc30 = btc && x.r30 != null && btc.r30 != null ? x.r30 - btc.r30 : null;
  }
  const item = (x, motivo) => ({ s: x.s, b: x.b, p: x.p, var24: x.var24, r7: x.r7, r30: x.r30, rsi: x.rsi, motivo });
  const fortes = ok.filter((x) => x.acima200 && x.e50acima200 && x.acima50 && x.dias >= 200 && (x.r30 ?? 0) > 0)
    .sort((a, b) => b.forca - a.forca).slice(0, 8)
    .map((x) => item(x, `Tendência de alta; 30 dias ${pct(x.r30)}${x.vsBtc30 != null ? ` (${x.vsBtc30 >= 0 ? "à frente" : "atrás"} do BTC em ${pct(Math.abs(x.vsBtc30)).replace("+", "")})` : ""}.${x.rsi >= 75 ? " IFR alto: subida esticada." : ""}`));
  const rompendo = ok.filter((x) => x.rompeu && (x.volRel ?? 0) >= 1.3)
    .sort((a, b) => (b.volRel ?? 0) - (a.volRel ?? 0)).slice(0, 8)
    .map((x) => item(x, `Passou da máxima dos últimos 20 dias com volume ${x.volRel.toFixed(1).replace(".", ",")}x o normal.${x.acima200 ? "" : " Ainda abaixo da média de 200 dias."}`));
  const volume = ok.filter((x) => (x.volRel ?? 0) >= 2.5)
    .sort((a, b) => b.volRel - a.volRel).slice(0, 8)
    .map((x) => item(x, `Volume ${x.volRel.toFixed(1).replace(".", ",")}x a média de 20 dias, com ${x.var24 >= 0 ? "alta" : "queda"} de ${pct(x.var24 / 100).replace("+", "").replace("-", "")} em 24h.`));
  const recuos = ok.filter((x) => x.acima200 && x.e50acima200 && x.dias >= 200 && ((x.rsi ?? 50) <= 45 || (x.distE50 != null && Math.abs(x.distE50) <= 1)))
    .sort((a, b) => b.forca - a.forca).slice(0, 8)
    .map((x) => item(x, `Tendência de alta, mas recuou${x.rsi <= 45 ? ` (IFR ${x.rsi.toFixed(0)})` : ""} para perto da média de 50 dias. Recuo pode continuar; confira o suporte.`));
  const fracas = ok.filter((x) => x.acima200 === false && x.e50acima200 === false)
    .sort((a, b) => a.forca - b.forca).slice(0, 8)
    .map((x) => item(x, `Tendência de baixa; 30 dias ${pct(x.r30)}${x.doTopo != null ? `, ${pct(x.doTopo)} da máxima de 1 ano` : ""}.${x.rsi <= 25 ? " Muito sobrevendida: repiques violentos são comuns." : ""}`));
  // clima geral
  const com200 = ok.filter((x) => x.acima200 != null), com50 = ok.filter((x) => x.acima50 != null);
  const amplitude = {
    moedas: ok.length,
    acima200: com200.length ? com200.filter((x) => x.acima200).length / com200.length : null,
    acima50: com50.length ? com50.filter((x) => x.acima50).length / com50.length : null,
    subindo24h: ok.filter((x) => x.var24 > 0).length / Math.max(1, ok.length),
    btc30: btc?.r30 ?? null,
  };
  const a2 = amplitude.acima200 ?? 0.5, a5 = amplitude.acima50 ?? 0.5;
  amplitude.leitura = a2 >= 0.6 && a5 >= 0.6 ? "Mercado forte: a maioria das moedas está em tendência de alta."
    : a2 <= 0.35 && a5 <= 0.35 ? "Mercado fraco: a maioria das moedas está em tendência de baixa. Cuidado redobrado."
    : a5 > a2 + 0.15 ? "Recuperação de curto prazo: muitas moedas voltaram acima da média de 50 dias, mas ainda abaixo da de 200."
    : a5 < a2 - 0.15 ? "Correção de curto prazo dentro de um mercado que ainda está em alta no longo prazo."
    : "Mercado misto: sem direção clara para a maioria das moedas.";
  return { amplitude, fortes, rompendo, volume, recuos, fracas };
}

// ---------------------------------------------------------------- oportunidades de compra e venda
// Para cada moeda: roda as 4 regras de setups.js em todo o histórico diário disponível (com taxas),
// vê qual está dando sinal agora e estima quanto a regra costuma render naquela moeda.
// A média de cada moeda é puxada para a média da regra em todas as moedas quando há poucas
// operações (encolhimento), para não premiar sorte de 3 ou 4 trades.
import { indicadores, simular, resumir, sinal, SETUPS } from "./setups.js";

const K_ENCOLHE = 10;      // peso (em operações) da média geral da regra
const FWD = 10;            // dias à frente para medir "o que veio depois" nas saídas por exagero

export function oportunidade(t, k) {
  if (!k || k.length < 320) return null;
  const todas = k.map((x) => ({ t: x[0], o: +x[1], h: +x[2], l: +x[3], c: +x[4], v: +x[5] }));
  const c = todas.slice(0, -1), preco = todas.at(-1).c;
  const I = indicadores(c), n = c.length, i = n - 1, A = I.a[i];
  if (!A || !I.e200[i]) return null;
  const ini = 210, total = n - ini;
  const regras = [];
  for (const S of SETUPS) {
    const { trades, aberto } = simular(I, S.id, ini);
    const st = resumir(trades, total);
    const sg = sinal(I, S.id, i);
    let estado = "fora", d = {};
    if (aberto) {
      estado = aberto.sairAbertura ? "vender" : aberto.iS >= i - 1 ? "comprar" : "posicao";
      d = { entrada: aberto.entrada, stop: aberto.stop, stop0: aberto.stop0, desde: aberto.t, motivoSaida: aberto.sairAbertura };
    } else if (sg?.entra && sg.stop < preco) {
      estado = "comprar"; d = { entrada: preco, stop: sg.stop, stop0: sg.stop };
    } else if (sg?.armado) {
      estado = "armado"; d = { gatilho: sg.gatilho, stop: sg.stop };
    }
    const u = trades.at(-1);
    const saiuAgora = !aberto && u && u.iX >= i - 1 ? { motivo: u.motivo, ret: u.ret } : null;
    regras.push({ id: S.id, nome: S.nome, estado, txt: sg?.txt ?? "", saiuAgora, ...d,
      ops: st.trades || 0, somaR: (st.mediaR || 0) * (st.trades || 0), acerto: st.acerto ?? null, retMedio: st.retMedio ?? null, dias: st.velasMedia ?? null });
  }
  // exagero de alta: o que aconteceu nos 10 dias seguintes a situações parecidas nesta moeda
  const esticada = (j) => I.r[j] >= 75 && I.e21[j] && (c[j].c - I.e21[j]) / I.a[j] >= 2.5;
  let nEst = 0, caiu = 0, somaFwd = 0;
  for (let j = ini; j < n - FWD; j++) {
    if (!esticada(j) || esticada(j - 1)) continue;   // só o primeiro dia de cada episódio
    const r = c[j + FWD].c / c[j].c - 1; nEst++; somaFwd += r; if (r < 0) caiu++;
  }
  const e200 = I.e200[i], e50 = I.e50[i], e21 = I.e21[i];
  let perdeu200 = false; for (let j = i - 2; j <= i; j++) if (c[j - 1].c > I.e200[j - 1] && c[j].c < I.e200[j]) perdeu200 = true;
  let cruzBaixa = false; for (let j = i - 2; j <= i; j++) if (I.e21[j - 1] >= I.e50[j - 1] && I.e21[j] < I.e50[j]) cruzBaixa = true;
  return {
    s: t.s, b: t.b, p: preco, var24: t.var24, volQ: t.volQ, atrPct: A / preco, rsi: I.r[i], regras,
    esticada: esticada(i), estHist: nEst ? { n: nEst, caiu: caiu / nEst, media: somaFwd / nEst } : null,
    esticamento: (preco - e21) / A, perdeu200, cruzBaixa, abaixo200: preco < e200, abaixo50: preco < e50,
  };
}

const fp = (v) => (v >= 1000 ? v.toLocaleString("pt-BR", { maximumFractionDigits: 0 }) : v >= 1 ? v.toLocaleString("pt-BR", { maximumFractionDigits: 2 }) : v.toLocaleString("pt-BR", { maximumSignificantDigits: 4 }));
const p1 = (v) => (v * 100).toFixed(1).replace(".", ",") + "%";

export function montarOportunidades(ops) {
  ops = ops.filter((x) => x && x.atrPct >= 0.004);
  // média de cada regra em todas as moedas (R por operação)
  const geral = {};
  for (const S of SETUPS) {
    let somaR = 0, n = 0;
    for (const o of ops) { const r = o.regras.find((g) => g.id === S.id); somaR += r.somaR; n += r.ops; }
    geral[S.id] = { mediaR: n ? somaR / n : 0, ops: n };
  }
  const edge = (r) => (r.somaR + K_ENCOLHE * geral[r.id].mediaR) / (r.ops + K_ENCOLHE);

  const compra = [];
  for (const o of ops) {
    for (const r of o.regras) {
      // "posicao": a regra comprou há poucos dias e o preço ainda está perto da entrada
      const recente = r.estado === "posicao" && Date.now() - r.desde <= 7 * 864e5 && o.p > r.stop && o.p <= r.entrada + 0.75 * (r.entrada - r.stop0);
      if (r.estado !== "comprar" && r.estado !== "armado" && !recente) continue;
      const eR = edge(r);
      if (eR < 0.08 || r.ops < 3) continue;                   // regra que não paga nesta moeda: fora
      const ent = r.estado === "armado" ? r.gatilho ?? o.p : o.p;
      const risco = (ent - (recente ? r.stop : r.stop0 ?? r.stop)) / ent;
      if (!(risco > 0.003 && risco < 0.35)) continue;
      const esperado = eR * risco;                             // % esperado por operação, já com taxas
      const alvo = ent * (1 + 2 * risco), stop = ent * (1 - risco);
      compra.push({ s: o.s, b: o.b, p: o.p, var24: o.var24, regra: r.nome, id: r.id,
        entrada: ent, stop, alvo, risco, esperado, eR, ops: r.ops, acerto: r.acerto, retMedio: r.retMedio, dias: r.dias,
        pont: esperado * (r.estado === "comprar" ? 1 : recente ? 0.7 : 0.6),
        estado: recente ? "recente" : r.estado,
        txt: r.estado === "comprar" ? r.txt : recente ? `A regra deu compra há ${Math.max(1, Math.round((Date.now() - r.desde) / 864e5))} dia(s) e o preço ainda está perto da entrada (${fp(r.entrada)}).` : `Quase no ponto: ${r.txt}` });
    }
  }
  // uma linha por moeda (a regra de maior pontuação)
  const melhorPorMoeda = (lista) => { const m = new Map(); for (const x of lista.sort((a, b) => b.pont - a.pont)) if (!m.has(x.s)) m.set(x.s, x); return [...m.values()]; };
  const compraFinal = melhorPorMoeda(compra).slice(0, 10);

  const venda = [];
  for (const o of ops) {
    const mot = []; let pont = 0;
    for (const r of o.regras) {
      if (edge(r) < 0.05) continue;
      if (r.estado === "vender") { pont += 3; mot.push(`Regra "${r.nome}" mandou vender: ${r.motivoSaida}.`); }
      else if (r.saiuAgora && r.saiuAgora.motivo.startsWith("stop")) { pont += 2.5; mot.push(`Regra "${r.nome}" bateu o stop ontem/hoje.`); }
    }
    if (o.esticada) {
      const h = o.estHist;
      pont += 2 + Math.min(2, (o.rsi - 75) / 5) + (h && h.n >= 3 && h.caiu >= 0.55 ? 1.5 : 0);
      mot.push(`Subida esticada (IFR ${o.rsi.toFixed(0)}, ${o.esticamento.toFixed(1).replace(".", ",")}× ATR acima da média de 21): bom ponto para realizar lucro.` +
        (h && h.n >= 3 ? ` Em ${h.n} vezes parecidas, caiu nos 10 dias seguintes em ${Math.round(h.caiu * 100)}% (média ${h.media >= 0 ? "+" : ""}${p1(h.media)}).` : ""));
    }
    if (o.perdeu200) { pont += 2; mot.push("Fechou abaixo da média de 200 dias: tendência virando para baixo."); }
    if (o.cruzBaixa && o.abaixo50) { pont += 1.5; mot.push("Média de 21 cruzou abaixo da de 50: alta de curto prazo acabou."); }
    if (!mot.length) continue;
    if (o.abaixo200 && !o.perdeu200) pont += 0.5;
    venda.push({ s: o.s, b: o.b, p: o.p, var24: o.var24, rsi: o.rsi, pont, motivos: mot,
      tipo: o.esticada && !o.perdeu200 ? "lucro" : "proteger" });
  }
  venda.sort((a, b) => b.pont - a.pont);
  return {
    compra: compraFinal, venda,
    geral: Object.fromEntries(Object.entries(geral).map(([k, v]) => [k, { mediaR: +v.mediaR.toFixed(3), ops: v.ops }])),
  };
}
