// Radar Cripto — indicadores e leitura do gráfico (usado no app e no robô de alertas).
// Candle: { t: abertura em ms, o, h, l, c, v }

export function ema(valores, n) {
  const k = 2 / (n + 1), out = new Array(valores.length).fill(null);
  let prev = null;
  for (let i = 0; i < valores.length; i++) {
    const v = valores[i];
    if (v == null) continue;
    if (prev == null) {
      if (i >= n - 1) { let s = 0; for (let j = i - n + 1; j <= i; j++) s += valores[j]; prev = s / n; out[i] = prev; }
      continue;
    }
    prev = v * k + prev * (1 - k); out[i] = prev;
  }
  return out;
}

export function sma(valores, n) {
  const out = new Array(valores.length).fill(null); let s = 0;
  for (let i = 0; i < valores.length; i++) { s += valores[i]; if (i >= n) s -= valores[i - n]; if (i >= n - 1) out[i] = s / n; }
  return out;
}

export function rsi(fech, n = 14) {
  const out = new Array(fech.length).fill(null);
  if (fech.length <= n) return out;
  let g = 0, p = 0;
  for (let i = 1; i <= n; i++) { const d = fech[i] - fech[i - 1]; if (d >= 0) g += d; else p -= d; }
  g /= n; p /= n; out[n] = p === 0 ? 100 : 100 - 100 / (1 + g / p);
  for (let i = n + 1; i < fech.length; i++) {
    const d = fech[i] - fech[i - 1];
    g = (g * (n - 1) + Math.max(d, 0)) / n; p = (p * (n - 1) + Math.max(-d, 0)) / n;
    out[i] = p === 0 ? 100 : 100 - 100 / (1 + g / p);
  }
  return out;
}

export function macd(fech, r = 12, l = 26, s = 9) {
  const er = ema(fech, r), el = ema(fech, l);
  const linha = fech.map((_, i) => er[i] != null && el[i] != null ? er[i] - el[i] : null);
  const ini = linha.findIndex(v => v != null);
  const sinalParcial = ini < 0 ? [] : ema(linha.slice(ini), s);
  const sinal = linha.map((_, i) => i < ini || ini < 0 ? null : sinalParcial[i - ini]);
  const hist = linha.map((v, i) => v != null && sinal[i] != null ? v - sinal[i] : null);
  return { linha, sinal, hist };
}

export function bollinger(fech, n = 20, k = 2) {
  const meio = sma(fech, n), sup = [], inf = [];
  for (let i = 0; i < fech.length; i++) {
    if (meio[i] == null) { sup.push(null); inf.push(null); continue; }
    let s = 0; for (let j = i - n + 1; j <= i; j++) s += (fech[j] - meio[i]) ** 2;
    const dp = Math.sqrt(s / n); sup.push(meio[i] + k * dp); inf.push(meio[i] - k * dp);
  }
  return { meio, sup, inf };
}

export function atr(c, n = 14) {
  const tr = c.map((x, i) => i === 0 ? x.h - x.l : Math.max(x.h - x.l, Math.abs(x.h - c[i - 1].c), Math.abs(x.l - c[i - 1].c)));
  const out = new Array(c.length).fill(null);
  if (c.length <= n) return out;
  let a = tr.slice(1, n + 1).reduce((s, v) => s + v, 0) / n; out[n] = a;
  for (let i = n + 1; i < c.length; i++) { a = (a * (n - 1) + tr[i]) / n; out[i] = a; }
  return out;
}

// suportes e resistências: topos e fundos (fractais) agrupados por proximidade
export function niveis(c, janela = 3, ultimos = 300) {
  const ini = Math.max(janela, c.length - ultimos), piv = [];
  for (let i = ini; i < c.length - janela; i++) {
    let topo = true, fundo = true;
    for (let j = 1; j <= janela; j++) {
      if (c[i].h <= c[i - j].h || c[i].h < c[i + j].h) topo = false;
      if (c[i].l >= c[i - j].l || c[i].l > c[i + j].l) fundo = false;
    }
    if (topo) piv.push({ p: c[i].h, t: c[i].t });
    if (fundo) piv.push({ p: c[i].l, t: c[i].t });
  }
  const a = atr(c).filter(v => v != null).pop() || (c.at(-1)?.c ?? 1) * 0.01;
  const grupos = [];
  for (const x of piv.sort((p, q) => p.p - q.p)) {
    const g = grupos.find(g => Math.abs(g.p - x.p) <= a * 0.6);
    if (g) { g.p = (g.p * g.n + x.p) / (g.n + 1); g.n++; g.ult = Math.max(g.ult, x.t); } else grupos.push({ p: x.p, n: 1, ult: x.t });
  }
  const preco = c.at(-1).c;
  const fortes = grupos.filter(g => g.n >= 2);
  const lado = (f) => { const x = fortes.filter(f); return x.length ? x : grupos.filter(f); };
  const sup = lado((g) => g.p < preco).sort((p, q) => q.p - p.p).slice(0, 3);
  const res = lado((g) => g.p > preco).sort((p, q) => p.p - q.p).slice(0, 3);
  return { suportes: sup, resistencias: res };
}

const ult = arr => { for (let i = arr.length - 1; i >= 0; i--) if (arr[i] != null) return arr[i]; return null; };
const fmt = v => v >= 1000 ? v.toLocaleString("pt-BR", { maximumFractionDigits: 0 }) : v >= 1 ? v.toLocaleString("pt-BR", { maximumFractionDigits: 2 }) : v.toLocaleString("pt-BR", { maximumSignificantDigits: 4 });

// Leitura completa de um tempo gráfico. Usa só candles fechados para os sinais
// (o último candle, ainda aberto, entra no preço atual).
export function analisar(candles) {
  if (!candles || candles.length < 60) return null;
  const c = candles.slice(0, -1); // fechados
  const fech = c.map(x => x.c), vol = c.map(x => x.v);
  const n = c.length, preco = candles.at(-1).c;
  const e9 = ema(fech, 9), e21 = ema(fech, 21), e50 = ema(fech, 50), e200 = ema(fech, 200);
  const r = rsi(fech), m = macd(fech), b = bollinger(fech), a = atr(c), vm = sma(vol, 20);
  const R = r[n - 1], H = m.hist[n - 1], H1 = m.hist[n - 2];
  const E21 = e21[n - 1], E50 = e50[n - 1], E200 = e200[n - 1];
  const motivos = []; let pts = 0;

  // tendência
  if (E200 != null) {
    if (preco > E200 && E50 > E200) { pts += 2; motivos.push({ d: 1, t: "Tendência de alta: preço e média de 50 acima da média de 200." }); }
    else if (preco < E200 && E50 < E200) { pts -= 2; motivos.push({ d: -1, t: "Tendência de baixa: preço e média de 50 abaixo da média de 200." }); }
    else motivos.push({ d: 0, t: "Tendência indefinida: preço e médias se cruzando perto da média de 200." });
  } else if (E50 != null) {
    if (preco > E50) { pts += 1; motivos.push({ d: 1, t: "Preço acima da média de 50." }); } else { pts -= 1; motivos.push({ d: -1, t: "Preço abaixo da média de 50." }); }
  }
  if (E21 != null && E50 != null) {
    if (E21 > E50 && preco > E21) { pts += 1; motivos.push({ d: 1, t: "Curto prazo forte: preço acima das médias de 21 e 50." }); }
    else if (E21 < E50 && preco < E21) { pts -= 1; motivos.push({ d: -1, t: "Curto prazo fraco: preço abaixo das médias de 21 e 50." }); }
  }
  // cruzamento recente das médias 50/200
  let cruz = null;
  for (let i = n - 1; i >= Math.max(1, n - 5); i--) {
    if (e50[i] != null && e200[i] != null && e50[i - 1] != null && e200[i - 1] != null) {
      if (e50[i - 1] <= e200[i - 1] && e50[i] > e200[i]) { cruz = "alta"; break; }
      if (e50[i - 1] >= e200[i - 1] && e50[i] < e200[i]) { cruz = "baixa"; break; }
    }
  }
  if (cruz === "alta") { pts += 1; motivos.push({ d: 1, t: "Cruzamento de alta recente: média de 50 passou acima da de 200 (\"cruz dourada\")." }); }
  if (cruz === "baixa") { pts -= 1; motivos.push({ d: -1, t: "Cruzamento de baixa recente: média de 50 caiu abaixo da de 200 (\"cruz da morte\")." }); }

  // momento
  let macdCruz = null;
  if (H != null && H1 != null) {
    if (H1 <= 0 && H > 0) macdCruz = "alta"; else if (H1 >= 0 && H < 0) macdCruz = "baixa";
    if (macdCruz === "alta") { pts += 1; motivos.push({ d: 1, t: "MACD acabou de virar para cima (momento de alta começando)." }); }
    else if (macdCruz === "baixa") { pts -= 1; motivos.push({ d: -1, t: "MACD acabou de virar para baixo (momento de baixa começando)." }); }
    else if (H > 0) { pts += 0.5; motivos.push({ d: 1, t: H > H1 ? "MACD positivo e ganhando força." : "MACD positivo, mas perdendo força." }); }
    else { pts -= 0.5; motivos.push({ d: -1, t: H < H1 ? "MACD negativo e ganhando força para baixo." : "MACD negativo, mas a queda está perdendo força." }); }
  }
  // IFR
  let rsiZona = null;
  if (R != null) {
    if (R >= 70) { rsiZona = "alto"; pts -= 1; motivos.push({ d: -1, t: `IFR em ${R.toFixed(0)}: sobrecomprado, risco maior de correção.` }); }
    else if (R <= 30) { rsiZona = "baixo"; pts += 1; motivos.push({ d: 1, t: `IFR em ${R.toFixed(0)}: sobrevendido, chance maior de repique.` }); }
    else if (R >= 55) { pts += 0.5; motivos.push({ d: 1, t: `IFR em ${R.toFixed(0)}: compradores no controle, sem exagero.` }); }
    else if (R <= 45) { pts -= 0.5; motivos.push({ d: -1, t: `IFR em ${R.toFixed(0)}: vendedores no controle, sem exagero.` }); }
    else motivos.push({ d: 0, t: `IFR em ${R.toFixed(0)}: equilíbrio.` });
  }
  // Bollinger
  const bs = b.sup[n - 1], bi = b.inf[n - 1];
  if (bs != null) {
    if (preco > bs) motivos.push({ d: 0, t: "Preço acima da banda de Bollinger superior: movimento esticado." });
    else if (preco < bi) motivos.push({ d: 0, t: "Preço abaixo da banda de Bollinger inferior: movimento esticado para baixo." });
    const largura = (bs - bi) / b.meio[n - 1];
    const largMedia = sma(b.sup.map((s, i) => s != null ? (s - b.inf[i]) / b.meio[i] : 0), 50)[n - 1];
    if (largMedia && largura < largMedia * 0.6) motivos.push({ d: 0, t: "Bandas apertadas: mercado comprimido, costuma vir um movimento forte em breve." });
  }
  // volume
  let volForte = false;
  const ultC = c[n - 1];
  if (vm[n - 1] && ultC.v > vm[n - 1] * 2) {
    volForte = true;
    const sobe = ultC.c >= ultC.o;
    pts += sobe ? 0.5 : -0.5;
    motivos.push({ d: sobe ? 1 : -1, t: `Volume ${(ultC.v / vm[n - 1]).toFixed(1)}x acima da média no último candle, ${sobe ? "com alta" : "com queda"}.` });
  }
  // rompimento da máxima/mínima das últimas 20 velas
  const max20 = Math.max(...c.slice(n - 21, n - 1).map(x => x.h)), min20 = Math.min(...c.slice(n - 21, n - 1).map(x => x.l));
  let rompe = null;
  if (ultC.c > max20) { rompe = "alta"; pts += 1; motivos.push({ d: 1, t: `Rompeu a máxima das últimas 20 velas (${fmt(max20)}).` }); }
  else if (ultC.c < min20) { rompe = "baixa"; pts -= 1; motivos.push({ d: -1, t: `Perdeu a mínima das últimas 20 velas (${fmt(min20)}).` }); }

  const nv = niveis(c);
  const A = ult(a);
  const vies = pts >= 3 ? "alta" : pts >= 1.5 ? "leve alta" : pts <= -3 ? "baixa" : pts <= -1.5 ? "leve baixa" : "neutro";
  return {
    preco, vies, pontos: Math.round(pts * 10) / 10, motivos,
    rsi: R, macdHist: H, macdCruz, rsiZona, cruz, rompe, volForte,
    ema: { e9: ult(e9), e21: E21, e50: E50, e200: E200 },
    atr: A, atrPct: A ? (A / preco) * 100 : null,
    suportes: nv.suportes.map(g => ({ p: g.p, toques: g.n })), resistencias: nv.resistencias.map(g => ({ p: g.p, toques: g.n })),
    ultimoFechado: ultC.t,
  };
}

// séries para o gráfico
export function series(candles) {
  const fech = candles.map(x => x.c);
  return {
    e9: ema(fech, 9), e21: ema(fech, 21), e50: ema(fech, 50), e200: ema(fech, 200),
    rsi: rsi(fech), macd: macd(fech), bb: bollinger(fech),
  };
}
