// Radar Cripto — CURTO PRAZO (velas de 1 hora).
// Varre as moedas mais negociadas, roda as 4 regras de entrada de setups.js no gráfico de 1 hora
// e testa, nos ~80 dias anteriores, exatamente o plano que os avisos vão seguir:
//   compra na abertura da vela seguinte ao sinal, stop da regra, venda TUDO no alvo,
//   e venda no fechamento se o prazo acabar (24 ou 48 h). Taxas e escorregão incluídos.
// O próprio teste escolhe o alvo e o prazo de cada regra, desliga a regra que não está pagando
// e descobre se ela só funciona com o BTC em alta (filtro de mercado).
import { indicadores, sinal, SETUPS } from "./setups.js";

const CUSTO = 0.0015;              // por lado: 0,1% de taxa + 0,05% de escorregão
const ALVOS = [1.5, 2, 3];         // alvo em múltiplos do risco (R)
const PRAZOS = [24, 48];           // horas máximas na operação
const K_ENCOLHE = 12;              // peso (em operações) da média geral da regra na nota de cada moeda
const INI = 210;
const RISCO_MIN = 0.004, RISCO_MAX = 0.06;
const MIN_OPS_REGRA = 40;          // operações somando todas as moedas para confiar na regra
const MIN_MEDIA_R = 0.06;          // regra precisa render ao menos 0,06 R por operação, já com taxas

export const NOMES = Object.fromEntries(SETUPS.map((s) => [s.id, s.nome]));

const velas = (k) => k.map((x) => ({ t: x[0], o: +x[1], h: +x[2], l: +x[3], c: +x[4], v: +x[5] }));

// Mercado (BTC em 1h): em alta quando preço e média de 50 estão acima da de 200.
export function regimeBTC(kBtc) {
  const c = velas(kBtc).slice(0, -1);
  const I = indicadores(c), mapa = new Map();
  for (let i = 0; i < c.length; i++) if (I.e200[i] != null && I.e50[i] != null) mapa.set(Math.floor(c[i].t / 36e5), c[i].c > I.e200[i] && I.e50[i] > I.e200[i]);
  const i = c.length - 1;
  const ok = mapa.get(Math.floor(c[i].t / 36e5)) ?? null;
  const r24 = c.length > 24 ? c[i].c / c[i - 24].c - 1 : null;
  return { mapa, agora: { ok, preco: c[i].c, e200: I.e200[i], e50: I.e50[i], r24 } };
}

// Sinais de entrada já calculados vela a vela (só candles fechados).
function sinaisDe(I, id) {
  const out = new Array(I.n).fill(null);
  for (let j = INI; j < I.n; j++) { const s = sinal(I, id, j); if (s?.entra) out[j] = s; }
  return out;
}

// Simula o plano dos avisos. Sem operações sobrepostas. Stop e alvo na mesma vela: conta o stop.
function plano(I, sig, kAlvo, maxV) {
  const { c, n } = I, trades = [];
  let aberto = null;
  for (let j = INI; j < n - 1; j++) {
    const s = sig[j]; if (!s) continue;
    const e = c[j + 1].o, stop = s.stop, risco = e - stop;
    if (!(risco > 0) || risco / e < RISCO_MIN || risco / e > RISCO_MAX) continue;
    const alvo = e + kAlvo * risco, fim = j + maxV;
    let saida = null, k = j + 1, motivo = "";
    for (; k < n; k++) {
      const x = c[k];
      if (x.l <= stop) { saida = Math.min(x.o, stop); motivo = "stop"; break; }
      if (x.h >= alvo) { saida = Math.max(x.o, alvo); motivo = "alvo"; break; }
      if (k >= fim) { saida = x.c; motivo = "prazo"; break; }
    }
    if (saida == null) { aberto = { iS: j, t: c[j + 1].t, entrada: e, stop, alvo, fim: c[j + 1].t + maxV * 36e5 }; break; }
    const ent = e * (1 + CUSTO), sai = saida * (1 - CUSTO);
    trades.push({ tS: c[j].t, t: c[j + 1].t, tX: c[k].t + 36e5, entrada: e, saida, motivo, ret: sai / ent - 1, R: (sai - ent) / risco });
    j = k; // próxima entrada só depois da saída
  }
  return { trades, aberto };
}

const acum = () => ({ n: 0, somaR: 0, ganhos: 0, somaRet: 0 });
function soma(a, t) { a.n++; a.somaR += t.R; a.somaRet += t.ret; if (t.R > 0) a.ganhos++; }
const media = (a) => (a.n ? a.somaR / a.n : 0);

// Uma moeda: sinais + simulação de todas as combinações de alvo/prazo de cada regra.
export function medirMoeda(t, k) {
  if (!k || k.length < 600) return null;
  const todas = velas(k), c = todas.slice(0, -1), preco = todas.at(-1).c;
  const I = indicadores(c), i = c.length - 1;
  if (!I.a[i] || I.e200[i] == null) return null;
  const regras = {};
  for (const S of SETUPS) {
    const sig = sinaisDe(I, S.id);
    const combos = {};
    for (const kA of ALVOS) for (const mV of PRAZOS) combos[`${kA}|${mV}`] = plano(I, sig, kA, mV);
    // sinal agora: na última vela fechada (ou na anterior, se o preço ainda está perto da entrada)
    let agora = null;
    for (const j of [i, i - 1]) {
      const s = sig[j]; if (!s) continue;
      const ent = j === i ? preco : c[j + 1].o;
      if (s.stop >= preco || s.stop >= ent) continue;
      // máxima e mínima desde a entrada (para saber se o plano já terminou)
      let hi = preco, lo = preco; for (let q = j + 1; q <= i; q++) { hi = Math.max(hi, c[q].h); lo = Math.min(lo, c[q].l); }
      if (lo <= s.stop) continue;
      agora = { j, entrada: ent, stop: s.stop, txt: s.txt, desde: j === i ? c[i].t + 36e5 : c[j + 1].t, hi };
      break;
    }
    regras[S.id] = { combos, agora };
  }
  return { s: t.s, b: t.b, p: preco, var24: t.var24, volQ: t.volQ, atrPct: I.a[i] / preco, regras };
}

const pct = (v) => `${v >= 0 ? "+" : ""}${(v * 100).toFixed(1).replace(".", ",")}%`;

// Junta todas as moedas: escolhe o melhor plano de cada regra, liga/desliga regras,
// decide o filtro de mercado e monta a lista de compra de agora.
export function montarCurto(moedas, regime) {
  moedas = moedas.filter((m) => m && m.atrPct >= 0.002);
  const bom = (t) => regime.mapa.get(Math.floor(t.tS / 36e5));
  const regras = [];
  for (const S of SETUPS) {
    let melhor = null;
    for (const kA of ALVOS) for (const mV of PRAZOS) {
      const chave = `${kA}|${mV}`, tudo = acum(), alta = acum(), baixa = acum();
      for (const m of moedas) for (const t of m.regras[S.id].combos[chave].trades) {
        soma(tudo, t); const b = bom(t); if (b === true) soma(alta, t); else if (b === false) soma(baixa, t);
      }
      // filtro de mercado só quando ele claramente ajuda (com BTC em baixa a regra perde)
      const filtro = baixa.n >= 15 && media(baixa) < 0 && media(alta) > media(tudo);
      const usado = filtro ? alta : tudo;
      // nota conservadora: média menos meio erro-padrão aproximado (R oscila ~1,1 por operação)
      const nota = media(usado) - 0.5 * 1.1 / Math.sqrt(Math.max(1, usado.n));
      if (!melhor || nota > melhor.nota) melhor = { id: S.id, nome: S.nome, kAlvo: kA, prazo: mV, filtro, nota, tudo, alta, baixa, usado };
    }
    const u = melhor.usado;
    melhor.ativa = u.n >= MIN_OPS_REGRA && media(u) >= MIN_MEDIA_R;
    regras.push(melhor);
  }
  const mercadoOk = regime.agora.ok;

  // compras de agora
  const compra = [];
  for (const m of moedas) {
    for (const r of regras) {
      const a = m.regras[r.id].agora; if (!a) continue;
      const risco = (a.entrada - a.stop) / a.entrada;
      if (risco < RISCO_MIN || risco > RISCO_MAX) continue;
      if (a.hi >= a.entrada * (1 + r.kAlvo * risco)) continue;   // já bateu o alvo: passou
      const proprio = acum();
      for (const t of m.regras[r.id].combos[`${r.kAlvo}|${r.prazo}`].trades) if (!r.filtro || bom(t) === true) soma(proprio, t);
      const eR = (proprio.somaR + K_ENCOLHE * media(r.usado)) / (proprio.n + K_ENCOLHE);
      const bloqueio = !r.ativa ? "regra" : r.filtro && mercadoOk === false ? "mercado" : eR < MIN_MEDIA_R ? "moeda" : (m.p - a.entrada) / (a.entrada - a.stop) > 0.3 ? "subiu" : null;
      compra.push({
        s: m.s, b: m.b, p: m.p, var24: m.var24, id: r.id, regra: r.nome, txt: a.txt,
        entrada: a.entrada, stop: a.stop, alvo: a.entrada * (1 + r.kAlvo * risco), kAlvo: r.kAlvo, prazo: r.prazo,
        desde: a.desde, risco, eR, esperado: eR * risco, opsMoeda: proprio.n, acertoMoeda: proprio.n ? proprio.ganhos / proprio.n : null,
        bloqueio, estado: bloqueio ? "observar" : "comprar",
      });
    }
  }
  const uma = new Map();
  for (const x of compra.sort((p, q) => (!!p.bloqueio - !!q.bloqueio) || q.esperado - p.esperado)) if (!uma.has(x.s)) uma.set(x.s, x);
  const lista = [...uma.values()];

  // resultado de seguir todos os avisos (regras ativas, respeitando o filtro), em ordem de tempo
  const hist = [];
  for (const m of moedas) for (const r of regras) {
    if (!r.ativa) continue;
    for (const t of m.regras[r.id].combos[`${r.kAlvo}|${r.prazo}`].trades) if (!r.filtro || bom(t) === true) hist.push({ b: m.b, s: m.s, regra: r.nome, ...t });
  }
  hist.sort((p, q) => p.t - q.t);
  // carteira simulada: arrisca 1% do capital em cada aviso, no máximo 5 operações ao mesmo tempo
  let cap = 1, pico = 1, dd = 0; const abertas = [];
  let usados = 0;
  for (const t of hist) {
    for (let k = abertas.length - 1; k >= 0; k--) if (abertas[k] <= t.t) abertas.splice(k, 1);
    if (abertas.length >= 5) continue;
    abertas.push(t.tX); usados++;
    cap *= 1 + 0.01 * t.R; pico = Math.max(pico, cap); dd = Math.max(dd, 1 - cap / pico);
  }
  const g = acum(); for (const t of hist) soma(g, t);
  const dias = hist.length ? Math.max(1, (Date.now() - hist[0].t) / 864e5) : 0;

  return {
    atualizado: new Date().toISOString(), moedas: moedas.length,
    mercado: { ok: mercadoOk, btc: regime.agora.preco, btc24: regime.agora.r24,
      txt: mercadoOk === true ? "BTC em alta no gráfico de 1 hora: ambiente bom para compras curtas."
        : mercadoOk === false ? "BTC em baixa no gráfico de 1 hora: as regras que só funcionam com o mercado subindo ficam em espera."
        : "Sem leitura do BTC agora." },
    regras: regras.map((r) => ({ id: r.id, nome: r.nome, kAlvo: r.kAlvo, prazo: r.prazo, filtro: r.filtro, ativa: r.ativa,
      ops: r.usado.n, acerto: r.usado.n ? r.usado.ganhos / r.usado.n : null, mediaR: +media(r.usado).toFixed(3), retMedio: r.usado.n ? r.usado.somaRet / r.usado.n : null,
      altaR: +media(r.alta).toFixed(3), baixaR: +media(r.baixa).toFixed(3), opsAlta: r.alta.n, opsBaixa: r.baixa.n })),
    compra: lista.filter((x) => !x.bloqueio).slice(0, 8),
    observar: lista.filter((x) => x.bloqueio).slice(0, 6),
    placar: { ops: g.n, acerto: g.n ? g.ganhos / g.n : null, mediaR: g.n ? g.somaR / g.n : 0, retMedio: g.n ? g.somaRet / g.n : 0,
      dias: Math.round(dias), porDia: dias ? g.n / dias : 0, carteira: cap - 1, quedaMax: dd, usados },
    ultimos: hist.slice(-12).reverse().map((t) => ({ b: t.b, s: t.s, regra: t.regra, t: t.t, entrada: t.entrada, saida: t.saida, motivo: t.motivo, ret: t.ret })),
    resumo: `${g.n} operações em ~${Math.round(dias)} dias, acerto ${g.n ? Math.round(100 * g.ganhos / g.n) : 0}%, média ${pct(g.n ? g.somaRet / g.n : 0)} por operação`,
  };
}
