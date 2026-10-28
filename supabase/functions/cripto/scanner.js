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
