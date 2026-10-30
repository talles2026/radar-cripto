// Radar Cripto — pontos de entrada e saída (compra à vista, sem alavancagem).
// Cada "setup" é uma regra fixa e escrita: quando comprar, onde fica o stop, quando vender.
// As mesmas regras rodam no passado (com taxas) para mostrar se funcionaram naquela moeda/tempo.
// Candle: { t, o, h, l, c, v }. Só candles FECHADOS entram nos sinais.
import { ema, sma, rsi, atr } from "./analise.js";

const CUSTO = 0.0015; // por lado: 0,1% de taxa da Binance + 0,05% de escorregão

export const SETUPS = [
  { id: "recuo", nome: "Recuo na tendência de alta",
    ideia: "Compra quando uma moeda em tendência de alta dá uma respirada até a média de 21 e volta a subir.",
    saida: "Vende se bater o stop móvel (máxima desde a compra − 3× ATR) ou se fechar abaixo da média de 50." },
  { id: "rompe", nome: "Rompimento com volume",
    ideia: "Compra quando o preço fecha acima da máxima das últimas 20 velas com volume forte, a favor da tendência.",
    saida: "Vende se bater o stop móvel (máxima desde a compra − 3× ATR) ou se fechar abaixo da mínima das últimas 10 velas." },
  { id: "repique", nome: "Repique de sobrevenda",
    ideia: "Compra quando o IFR sai da sobrevenda (volta acima de 30) com a moeda ainda acima da média de 200.",
    saida: "Vende quando o preço voltar à média de 20 (meio das bandas), após 12 velas, ou no stop." },
  { id: "tendencia", nome: "Seguir a tendência",
    ideia: "Compra quando a média de 21 cruza acima da de 50 com o preço acima da de 200. Operação mais longa.",
    saida: "Vende quando a média de 21 cruzar abaixo da de 50 ou o preço fechar abaixo da média de 200." },
];

export function indicadores(c) {
  const f = c.map(x => x.c), v = c.map(x => x.v);
  return { c, n: c.length, f, e21: ema(f, 21), e50: ema(f, 50), e200: ema(f, 200), sm20: sma(f, 20), r: rsi(f), a: atr(c), vm: sma(v, 20) };
}
const maxH = (c, de, ate) => { let m = -Infinity; for (let j = Math.max(0, de); j <= ate; j++) if (c[j].h > m) m = c[j].h; return m; };
const minL = (c, de, ate) => { let m = Infinity; for (let j = Math.max(0, de); j <= ate; j++) if (c[j].l < m) m = c[j].l; return m; };

// Sinal no fechamento da vela i. Devolve { entra, armado, gatilho, stop, txt }
export function sinal(I, id, i) {
  const { c, e21, e50, e200, sm20, r, a, vm } = I;
  const x = c[i], A = a[i];
  if (i < 210 || !A || e200[i] == null || e50[i - 5] == null) return null;
  const altaLonga = x.c > e200[i] && e50[i] > e200[i];
  if (id === "recuo") {
    const sobe50 = e50[i] > e50[i - 5];
    let tocou = false, rMin = 100;
    for (let j = i - 4; j <= i; j++) { if (c[j].l <= e21[j] + 0.25 * a[j]) tocou = true; if (r[j] < rMin) rMin = r[j]; }
    const base = altaLonga && sobe50 && tocou && rMin <= 50 && x.c > e50[i];
    const stopBase = minL(c, i - 4, i) - 0.5 * A;
    const stop = Math.min(stopBase, x.c - A);
    const ok = base && x.c - stop <= 4 * A;
    const entra = ok && x.c > c[i - 1].h && x.c > e21[i];
    return { entra, armado: ok && !entra, gatilho: ok ? x.h : null, stop,
      txt: entra ? "Recuou até a média de 21 e voltou a subir: fechou acima da máxima da vela anterior." : "Em tendência de alta e recuou até a média de 21. Falta a confirmação: fechar acima da máxima da última vela." };
  }
  if (id === "rompe") {
    const max20 = maxH(c, i - 20, i - 1);
    const volOk = vm[i] && x.v > 1.5 * vm[i];
    const filtro = x.c > e50[i] && e50[i] > e200[i] && x.c - e21[i] < 3 * A;
    const stop = x.c - 2 * A;
    const entra = filtro && x.c > max20 && volOk;
    const armado = !entra && filtro && x.c < max20 && max20 - x.c <= 1.5 * A;
    return { entra, armado, gatilho: armado ? max20 : null, stop: armado ? max20 - 2 * A : stop,
      txt: entra ? `Fechou acima da máxima de 20 velas com volume ${(x.v / vm[i]).toFixed(1).replace(".", ",")}× o normal.` : "Tendência de alta e preço encostando na máxima de 20 velas. Compra só se fechar acima dela com volume forte." };
  }
  if (id === "repique") {
    const entra = x.c > e200[i] && r[i - 1] < 30 && r[i] >= 30;
    let rMin = 100; for (let j = i - 3; j <= i; j++) rMin = Math.min(rMin, r[j]);
    const armado = !entra && x.c > e200[i] && r[i] < 30;
    const stop = Math.min(minL(c, i - 3, i) - A, x.c - 1.5 * A);
    return { entra, armado, gatilho: null, stop, alvo: sm20[i],
      txt: entra ? `IFR saiu da sobrevenda (${r[i].toFixed(0)}) com a moeda acima da média de 200.` : `IFR em ${r[i].toFixed(0)} (sobrevenda) acima da média de 200. Compra quando o IFR voltar acima de 30.` };
  }
  if (id === "tendencia") {
    const cruzou = e21[i - 1] <= e50[i - 1] && e21[i] > e50[i];
    const entra = cruzou && x.c > e200[i];
    const armado = !entra && x.c > e200[i] && e21[i] < e50[i] && (e50[i] - e21[i]) < 0.3 * A;
    const stop = Math.min(minL(c, i - 9, i) - A, x.c - 2 * A);
    return { entra, armado, gatilho: null, stop,
      txt: entra ? "Média de 21 cruzou acima da de 50, com o preço acima da de 200." : "Média de 21 quase cruzando acima da de 50, preço acima da de 200." };
  }
  return null;
}

// Regra de saída avaliada no fechamento da vela j, para uma posição aberta.
// Devolve { stop (válido para a próxima vela), sairNaAbertura: bool, motivo }
function gerir(I, id, p, j) {
  const { c, e21, e50, e200, sm20, a } = I;
  const x = c[j];
  p.topo = Math.max(p.topo, x.h);
  if (id === "recuo" || id === "rompe") {
    p.stop = Math.max(p.stop, p.topo - 3 * a[j]);
    if (id === "recuo" && x.c < e50[j]) return "fechou abaixo da média de 50";
    if (id === "rompe" && x.c < minL(c, j - 10, j - 1)) return "perdeu a mínima de 10 velas";
  }
  if (id === "repique") {
    if (x.c >= sm20[j]) return "voltou à média de 20 (alvo)";
    if (j - p.iE >= 12) return "tempo esgotado (12 velas)";
  }
  if (id === "tendencia") {
    if (e21[j] < e50[j]) return "média de 21 cruzou abaixo da de 50";
    if (x.c < e200[j]) return "fechou abaixo da média de 200";
  }
  return null;
}

// Simula o setup de 'ini' até o fim. Entrada e saída por regra: na abertura da vela seguinte.
// Stop: se a mínima da vela tocar, sai no stop (ou na abertura, se abriu abaixo).
export function simular(I, id, ini = 210) {
  const { c, n } = I;
  const trades = []; let p = null;
  for (let j = ini; j < n; j++) {
    if (p) {
      const x = c[j];
      if (j > p.iE && p.sairAbertura) { fechar(p, x.o, j, p.sairAbertura); trades.push(p); p = null; }
      else if (x.l <= p.stop) { fechar(p, Math.min(x.o, p.stop), j, p.stop > p.stop0 ? "stop móvel" : "stop"); trades.push(p); p = null; }
      else { const m = gerir(I, id, p, j); if (m) p.sairAbertura = m; }
      if (p) continue;
    }
    const s = sinal(I, id, j);
    if (s?.entra && j + 1 < n) {
      const e = c[j + 1].o;
      if (s.stop >= e) continue;
      p = { id, iS: j, iE: j + 1, t: c[j + 1].t, entrada: e, stop0: s.stop, stop: s.stop, topo: e, sairAbertura: null };
      // a própria vela de entrada pode bater o stop
      const x = c[j + 1];
      if (x.l <= p.stop) { fechar(p, Math.min(x.o, p.stop), j + 1, "stop"); trades.push(p); p = null; }
      else { const m = gerir(I, id, p, j + 1); if (m) p.sairAbertura = m; }
      j++;
    }
  }
  return { trades, aberto: p };
}
function fechar(p, preco, j, motivo) {
  p.saida = preco; p.iX = j; p.motivo = motivo;
  const ent = p.entrada * (1 + CUSTO), sai = preco * (1 - CUSTO);
  p.ret = sai / ent - 1;
  p.R = (sai - ent) / (p.entrada - p.stop0);
}

export function resumir(trades, velasTotal) {
  const n = trades.length;
  if (!n) return { trades: 0 };
  const Rs = trades.map(t => t.R), rets = trades.map(t => t.ret);
  const gan = Rs.filter(r => r > 0), per = Rs.filter(r => r <= 0);
  const somaG = gan.reduce((s, v) => s + v, 0), somaP = -per.reduce((s, v) => s + v, 0);
  let eq = 0, pico = 0, dd = 0, seq = 0, seqMax = 0;
  for (const r of Rs) { eq += r; pico = Math.max(pico, eq); dd = Math.max(dd, pico - eq); seq = r <= 0 ? seq + 1 : 0; seqMax = Math.max(seqMax, seq); }
  const comp = rets.reduce((s, r) => s * (1 + r), 1) - 1;
  const duracao = trades.reduce((s, t) => s + (t.iX - t.iE + 1), 0);
  const ord = [...rets].sort((a, b) => a - b);
  return {
    trades: n, acerto: gan.length / n, mediaR: Rs.reduce((s, v) => s + v, 0) / n,
    pf: somaP ? somaG / somaP : (somaG ? 99 : 0), ganhoMedioR: gan.length ? somaG / gan.length : 0, perdaMediaR: per.length ? -somaP / per.length : 0,
    retMedio: rets.reduce((s, v) => s + v, 0) / n, retMediano: ord[n >> 1], melhor: ord[n - 1], pior: ord[0],
    composto: comp, ddR: dd, perdasSeguidas: seqMax, velasMedia: duracao / n, tempoNoMercado: velasTotal ? duracao / velasTotal : null,
  };
}

export function nota(s) {
  if (!s || s.trades < 15) return { nivel: "pouco", txt: "Poucas operações no histórico para julgar." };
  const rec = s.recente;
  if (s.mediaR >= 0.15 && s.pf >= 1.35 && (!rec || rec.trades < 6 || rec.mediaR > 0)) return { nivel: "bom", txt: "Funcionou bem nesta moeda e neste tempo gráfico." };
  if (s.mediaR > 0.03 && s.pf >= 1.1) return { nivel: "medio", txt: "Deu lucro pequeno no histórico. Use com cautela." };
  return { nivel: "ruim", txt: "Não deu lucro nesta moeda/tempo. Melhor ignorar." };
}

// Placar completo (servidor, anos de candles). velasArr: [t,o,h,l,c,v]
export function placarSetups(velasArr) {
  const c = velasArr.map(x => ({ t: x[0], o: x[1], h: x[2], l: x[3], c: x[4], v: x[5] }));
  if (c.length < 500) return null;
  const I = indicadores(c);
  const ini = 210, total = c.length - ini;
  const bh = c.at(-1).c / c[ini].o - 1;
  const out = { desde: c[ini].t, velas: total, compraESegura: bh, setups: {} };
  for (const S of SETUPS) {
    const { trades } = simular(I, S.id, ini);
    const s = resumir(trades, total);
    const corte = c[Math.floor(ini + total * 2 / 3)].t;
    s.recente = resumir(trades.filter(t => t.t >= corte), Math.floor(total / 3));
    s.nota = nota(s);
    s.ultimos = trades.slice(-6).map(t => ({ t: t.t, ent: t.entrada, sai: t.saida, ret: t.ret, R: t.R, motivo: t.motivo, velas: t.iX - t.iE + 1 }));
    out.setups[S.id] = s;
  }
  return out;
}

// Situação AGORA (app e robô). candles: incluindo a vela em andamento no final.
export function situacao(candles) {
  if (!candles || candles.length < 260) return null;
  const c = candles.slice(0, -1), preco = candles.at(-1).c;
  const I = indicadores(c), n = c.length, i = n - 1, A = I.a[i];
  const lista = [];
  for (const S of SETUPS) {
    const { aberto, trades } = simular(I, S.id, Math.max(210, n - 400));
    const s = sinal(I, S.id, i);
    let estado = "fora", d = {};
    if (aberto) {
      const novo = aberto.iS === i - 1 || aberto.iS === i;
      estado = aberto.sairAbertura ? "vender" : novo ? "comprar" : "posicao";
      d = { entrada: aberto.entrada, desde: aberto.t, stop: aberto.stop, stop0: aberto.stop0, ret: preco / aberto.entrada - 1, motivoSaida: aberto.sairAbertura };
      // nível de fechamento que dispara a venda pela regra (além do stop)
      const nf = { recuo: I.e50[i], rompe: minL(c, i - 9, i), tendencia: I.e200[i] }[S.id];
      if (nf != null && nf > aberto.stop) d.fechaAbaixo = nf;
      if (S.id === "tendencia") d.cruzamento = { e21: I.e21[i], e50: I.e50[i] };
    } else if (s?.entra) {
      estado = "comprar"; d = { entrada: preco, stop: s.stop, stop0: s.stop, desde: c[i].t + (c[i].t - c[i - 1].t) }; // compra na vela em andamento
    } else if (s?.armado) {
      estado = "armado"; d = { gatilho: s.gatilho, stop: s.stop };
    }
    if (estado === "comprar") {
      const risco = d.entrada - d.stop0;
      d.alvo1 = d.entrada + 1.5 * risco; d.alvo2 = d.entrada + 3 * risco;
      if (S.id === "repique" && I.sm20[i]) d.alvo1 = Math.max(I.sm20[i], d.entrada + 0.5 * risco);
      d.riscoPct = risco / d.entrada;
    }
    const txt = estado === "comprar" && aberto ? (sinal(I, S.id, aberto.iS)?.txt ?? "") : (s?.txt ?? "");
    // operação da regra que acabou de ser encerrada (stop batido na última vela fechada)
    const u = trades.at(-1);
    const ultimaSaida = !aberto && u && u.iX === i ? { desde: u.t, entrada: u.entrada, saida: u.saida, motivo: u.motivo, ret: u.ret } : null;
    lista.push({ id: S.id, nome: S.nome, ideia: S.ideia, saidaRegra: S.saida, estado, txt, ultimaSaida, ...d });
  }
  // proteção para quem já está comprado, independente de setup
  const topo22 = maxH(c, i - 21, i);
  const r = I.r[i], e21 = I.e21[i], e50 = I.e50[i];
  const avisos = [];
  if (r >= 75) avisos.push("IFR acima de 75: subida esticada. Bom momento para realizar parte do lucro.");
  if (preco < e50) avisos.push("Preço abaixo da média de 50: a alta perdeu força. Quem está comprado deve apertar o stop.");
  if (I.e200[i] && preco < I.e200[i]) avisos.push("Preço abaixo da média de 200: tendência de baixa. Evite comprar e segure posições só com stop curto.");
  return {
    preco, atr: A, setups: lista,
    protecao: { stopMovel: topo22 - 3 * A, media21: e21, media50: e50, avisos },
  };
}
