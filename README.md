# Radar Cripto

Gráficos de candles da Binance, otimizados para celular: https://talles2026.github.io/radar-cripto/

- Lista de moedas escolhida no app (qualquer par em USDT ou BRL), preço em dólar e em reais.
- Gráfico com MME 9/21/50/200, Bollinger, volume, IFR e MACD, suportes e resistências automáticos.
- Leitura do gráfico em português nos tempos 15 min, 1 h, 4 h, diário e semanal, com viés e motivos.
- Tempo real pelo canal ao vivo da Binance; vários endereços de reserva.
- Alertas no celular: preço-alvo e sinais (IFR extremo, MACD, cruzamento 50/200, rompimentos, volume, movimento forte).

Ferramenta de apoio. Não é recomendação de compra ou venda.

Servidor de alertas: função `cripto` no Supabase (projeto radar-clima), código em `supabase/functions/cripto/`.
Gráficos: TradingView Lightweight Charts (Apache 2.0).
