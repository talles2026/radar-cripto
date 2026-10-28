// Radar Cripto — probabilidades a partir do histórico.
// 1) "Já aconteceu antes": busca os momentos mais parecidos com o atual e mede o que veio depois.
// 2) Faixa provável: tamanho típico do movimento no horizonte, ajustado à volatilidade de agora.
// 3) Placar dos sinais: o que aconteceu depois de cada tipo de sinal no histórico.
// 4) Teste honesto: simula o método no passado (sem olhar o futuro) e mede se ele acerta mais que o acaso.
// Candles: arrays [t, o, h, l, c, v] já fechados, em ordem.
import { ema, rsi, macd, atr, sma } from "./analise.js";
import { placarSetups } from "./setups.js";

export const HORIZONTES = {
  "1h": [[4, "4 horas"], [24, "24 horas"]],
  "4h": [[6, "24 horas"], [42, "7 dias"]],
  "1d": [[7, "7 dias"], [30, "30 dias"]],
};

const clip = (v, a, b) => Math.max(a, Math.min(b, v));
function quantil(ord, p) { if (!ord.length) return null; const i = (ord.length - 1) * p, a = Math.floor(i), b = Math.ceil(i); return ord[a] + (ord[b] - ord[a]) * (i - a); }

export function preparar(v) {
  const n = v.length;
  const c = v.map(x => x[4]), h = v.map(x => x[2]), l = v.map(x => x[3]), vol = v.map(x => x[5]);
  const cand = v.map(x => ({ t: x[0], o: x[1], h: x[2], l: x[3], c: x[4], v: x[5] }));
  const e20 = ema(c, 20), e50 = ema(c, 50), e200 = ema(c, 200), r = rsi(c), m = macd(c), a = atr(cand), vm = sma(vol, 20);
  const atrPct = a.map((x, i) => x == null ? null : x / c[i]);
  // mediana móvel simples da volatilidade (janela 200) por amostragem para ser rápida
  const volRel = new Array(n).fill(null);
  for (let i = 400; i < n; i++) {
    const amostra = []; for (let j = i - 200; j < i; j += 4) if (atrPct[j] != null) amostra.push(atrPct[j]);
    amostra.sort((x, y) => x - y); const med = amostra[amostra.length >> 1];
    if (med) volRel[i] = atrPct[i] / med;
  }
  // vetor de características de cada candle
  const F = new Array(n).fill(null);
  for (let i = 400; i < n; i++) {
    const A = a[i]; if (!A || r[i] == null || m.hist[i] == null || e200[i] == null || volRel[i] == null) continue;
    F[i] = [
      r[i] / 50 - 1,                                   // IFR
      clip((c[i] - e50[i]) / A, -6, 6) / 3,           // distância da média 50
      clip((c[i] - e200[i]) / A, -15, 15) / 7,        // distância da média 200 (tendência)
      clip(m.hist[i] / A, -2, 2),                      // momento (MACD)
      clip((c[i] - c[i - 5]) / A, -8, 8) / 4,         // movimento das últimas 5 velas
      clip(Math.log(volRel[i]), -1, 1),                // volatilidade relativa
      clip((e20[i] - e50[i]) / A, -4, 4) / 2,          // curto x médio prazo
    ];
  }
  return { n, c, h, l, vol, vm, r, m, e50, e200, a, atrPct, F, t: v.map(x => x[0]) };
}

function resultado(P, i, hz) {
  const ret = P.c[i + hz] / P.c[i] - 1;
  let min = Infinity; for (let j = i + 1; j <= i + hz; j++) if (P.l[j] < min) min = P.l[j];
  return { ret, queda: min / P.c[i] - 1 };
}

function dist(a, b) { let s = 0; for (let k = 0; k < a.length; k++) { const d = a[k] - b[k]; s += d * d; } return s; }

// vizinhos mais parecidos, espaçados no tempo para não contar o mesmo episódio várias vezes
function vizinhos(P, q, limite, hz, K, passo = 1) {
  // distâncias em vetor numérico; um corte pelo quantil evita ordenar tudo (mais rápido)
  const idx = [], d = [];
  for (let i = 400; i <= limite; i += passo) if (P.F[i]) { idx.push(i); d.push(dist(P.F[i], q)); }
  if (!idx.length) return [];
  const D = Float64Array.from(d), ord = D.slice().sort();
  const corte = ord[Math.min(ord.length - 1, K * 12)];
  const cands = [];
  for (let k = 0; k < idx.length; k++) if (D[k] <= corte) cands.push([D[k], idx[k]]);
  cands.sort((x, y) => x[0] - y[0]);
  const esc = [], esp = Math.max(1, Math.floor(hz / 2));
  for (const [, i] of cands) {
    if (esc.length >= K) break;
    let perto = false; for (const j of esc) if (Math.abs(j - i) < esp) { perto = true; break; }
    if (!perto) esc.push(i);
  }
  return esc;
}

function resumo(P, idx, hz) {
  if (!idx.length) return null;
  const rs = idx.map(i => resultado(P, i, hz));
  const ret = rs.map(x => x.ret).sort((a, b) => a - b), qd = rs.map(x => x.queda).sort((a, b) => a - b);
  return {
    casos: idx.length,
    sobe: rs.filter(x => x.ret > 0).length / idx.length,
    mediana: quantil(ret, 0.5), p10: quantil(ret, 0.1), p90: quantil(ret, 0.9),
    quedaTipica: quantil(qd, 0.5), quedaRuim: quantil(qd, 0.1),
  };
}

export function calcular(velas, tf) {
  const P = preparar(velas);
  const n = P.n, q = P.F[n - 1];
  const hzs = HORIZONTES[tf];
  if (!q || n < 800) return { erro: "Histórico curto demais para estatística confiável." };
  const desde = new Date(P.t[400]).toISOString().slice(0, 10);
  const out = { tf, desde, velas: n, preco: P.c[n - 1], horizontes: [] };

  for (const [hz, nome] of hzs) {
    const limite = n - 1 - hz;
    // base: todos os momentos (com características) do histórico
    const todos = []; for (let i = 400; i <= limite; i++) if (P.F[i]) todos.push(i);
    const base = resumo(P, todos.filter((_, k) => k % Math.max(1, Math.floor(hz / 2)) === 0), hz);
    const viz = vizinhos(P, q, limite, hz, 80);
    const par = resumo(P, viz, hz);
    // quão parecidos são (distância média): quanto menor, mais confiável
    const dm = viz.reduce((s, i) => s + Math.sqrt(dist(P.F[i], q)), 0) / Math.max(1, viz.length);
    // exemplos (datas) para o usuário conferir
    const exemplos = viz.slice(0, 5).map(i => ({ t: P.t[i], ret: resultado(P, i, hz).ret }));

    // faixa provável: retornos do histórico normalizados pela volatilidade de cada momento
    const z = [];
    for (let i = 400; i <= limite; i += 1) if (P.atrPct[i]) z.push((P.c[i + hz] / P.c[i] - 1) / P.atrPct[i]);
    z.sort((a, b) => a - b);
    const vAgora = P.atrPct[n - 1], pr = P.c[n - 1];
    const faixa = {
      p70: [pr * (1 + quantil(z, 0.15) * vAgora), pr * (1 + quantil(z, 0.85) * vAgora)],
      p90: [pr * (1 + quantil(z, 0.05) * vAgora), pr * (1 + quantil(z, 0.95) * vAgora)],
    };
    out.horizontes.push({ hz, nome, base, parecidos: par, proximidade: dm, exemplos, faixa });
  }

  // teste honesto (passado, sem olhar o futuro) no horizonte mais longo
  const [hzT, nomeT] = hzs[1];
  out.teste = testar(P, hzT, nomeT);
  out.placar = placar(P, hzs[1][0], hzs[1][1]);
  // pontos de entrada e saída: as regras de compra/venda testadas no histórico, com taxas
  try { out.setups = placarSetups(velas); } catch (_) { out.setups = null; }
  return out;
}

function testar(P, hz, nome) {
  const n = P.n, ini = Math.floor(n * 0.55), fim = n - 1 - hz;
  const pontos = 130, passo = Math.max(1, Math.floor((fim - ini) / pontos));
  const reg = [];
  for (let t = ini; t <= fim; t += passo) {
    if (!P.F[t]) continue;
    const viz = vizinhos(P, P.F[t], t - hz, hz, 60, 2);
    if (viz.length < 20) continue;
    const p = viz.filter(i => P.c[i + hz] > P.c[i]).length / viz.length;
    reg.push({ p, sobe: P.c[t + hz] > P.c[t] });
  }
  if (reg.length < 40) return null;
  const taxaBase = reg.filter(x => x.sobe).length / reg.length;
  const fortesAlta = reg.filter(x => x.p >= 0.6), fortesBaixa = reg.filter(x => x.p <= 0.4);
  const brier = reg.reduce((s, x) => s + (x.p - (x.sobe ? 1 : 0)) ** 2, 0) / reg.length;
  const brierBase = reg.reduce((s, x) => s + (taxaBase - (x.sobe ? 1 : 0)) ** 2, 0) / reg.length;
  const acertoAlta = fortesAlta.length ? fortesAlta.filter(x => x.sobe).length / fortesAlta.length : null;
  const acertoBaixa = fortesBaixa.length ? fortesBaixa.filter(x => !x.sobe).length / fortesBaixa.length : null;
  // ganho de habilidade em relação a sempre chutar a taxa base (positivo = melhor que o acaso)
  const habilidade = 1 - brier / brierBase;
  return { horizonte: nome, testes: reg.length, taxaBase, alta: { casos: fortesAlta.length, acerto: acertoAlta }, baixa: { casos: fortesBaixa.length, acerto: acertoBaixa }, habilidade };
}

// O que aconteceu depois de cada tipo de sinal no histórico
function placar(P, hz, nome) {
  const n = P.n, ev = {};
  const add = (k, i, dir) => (ev[k] ||= { dir, idx: [] }).idx.push(i);
  for (let i = 401; i < n - 1 - hz; i++) {
    const r = P.r, H = P.m.hist;
    if (r[i - 1] != null && r[i - 1] >= 30 && r[i] < 30) add("IFR entrou em sobrevenda (abaixo de 30)", i, 1);
    if (r[i - 1] != null && r[i - 1] <= 70 && r[i] > 70) add("IFR entrou em sobrecompra (acima de 70)", i, -1);
    if (H[i - 1] != null && H[i - 1] <= 0 && H[i] > 0) add("MACD virou para cima", i, 1);
    if (H[i - 1] != null && H[i - 1] >= 0 && H[i] < 0) add("MACD virou para baixo", i, -1);
    if (P.e50[i - 1] != null && P.e200[i - 1] != null) {
      if (P.e50[i - 1] <= P.e200[i - 1] && P.e50[i] > P.e200[i]) add("Cruz dourada (média 50 acima da 200)", i, 1);
      if (P.e50[i - 1] >= P.e200[i - 1] && P.e50[i] < P.e200[i]) add("Cruz da morte (média 50 abaixo da 200)", i, -1);
    }
    let mx = -Infinity, mn = Infinity; for (let j = i - 20; j < i; j++) { if (P.h[j] > mx) mx = P.h[j]; if (P.l[j] < mn) mn = P.l[j]; }
    if (P.c[i] > mx && P.c[i - 1] <= mx) add("Rompeu a máxima de 20 velas", i, 1);
    if (P.c[i] < mn && P.c[i - 1] >= mn) add("Perdeu a mínima de 20 velas", i, -1);
    if (P.vm[i] && P.vol[i] > P.vm[i] * 2.5) add(P.c[i] >= P.c[i - 1] ? "Volume forte com alta" : "Volume forte com queda", i, P.c[i] >= P.c[i - 1] ? 1 : -1);
  }
  // taxa base do horizonte, para comparar
  let up = 0, tot = 0; for (let i = 400; i < n - 1 - hz; i += Math.max(1, hz >> 1)) { tot++; if (P.c[i + hz] > P.c[i]) up++; }
  const base = tot ? up / tot : 0.5;
  const linhas = Object.entries(ev).map(([nomeS, e]) => {
    // não contar o mesmo episódio duas vezes
    const idx = []; for (const i of e.idx) if (!idx.length || i - idx[idx.length - 1] >= Math.max(1, hz >> 1)) idx.push(i);
    const rets = idx.map(i => P.c[i + hz] / P.c[i] - 1).sort((a, b) => a - b);
    const sobe = rets.filter(x => x > 0).length / Math.max(1, rets.length);
    const acerto = e.dir > 0 ? sobe : 1 - sobe;
    const baseDir = e.dir > 0 ? base : 1 - base;
    return { sinal: nomeS, espera: e.dir > 0 ? "alta" : "baixa", casos: idx.length, acerto, baseDir, vantagem: acerto - baseDir, mediana: quantil(rets, 0.5) };
  }).filter(x => x.casos >= 8).sort((a, b) => b.vantagem - a.vantagem);
  return { horizonte: nome, base, sinais: linhas };
}
