# Radar Cripto

Gráficos de candles da Binance, otimizados para celular: https://talles2026.github.io/radar-cripto/

- Lista de moedas escolhida no app (qualquer par em USDT ou BRL), preço em dólar e em reais.
- Gráfico com MME 9/21/50/200, Bollinger, volume, IFR e MACD, suportes e resistências automáticos.
- Leitura do gráfico em português nos tempos 15 min, 1 h, 4 h, diário e semanal, com viés e motivos.
- Tempo real pelo canal ao vivo da Binance; vários endereços de reserva.
- Alertas no celular: hora de comprar e hora de vender (só das regras que funcionaram em cada moeda), mais preço-alvo.

- **O que o histórico diz**: busca os momentos mais parecidos com o atual (anos de candles) e mostra o que aconteceu depois, a faixa provável de preço, um teste honesto do método no passado e o placar de cada sinal.
- **Pontos de entrada e saída**: quatro regras fixas de compra e venda (recuo na tendência, rompimento com volume, repique de sobrevenda, seguir a tendência) com entrada, stop, alvos e regra de saída; cada uma testada em todo o histórico da moeda com taxas, e só as que funcionaram geram aviso de compra e de venda no celular (inclui stop batido, realizar lucro com IFR acima de 75 e fechamento abaixo da média de 200) (`setups.js`).
- **Calculadora de risco**: tamanho da posição pelo quanto você aceita perder, stop e alvo sugeridos, relação ganho/risco.
- **Comentário do dia**: escrito por uma tarefa agendada que lê as notícias (arquivo `comentario.json`).

Ferramenta de apoio. Não é recomendação de compra ou venda.

Servidor de alertas: função `cripto` no Supabase (projeto radar-clima), código em `supabase/functions/cripto/`.
Gráficos: TradingView Lightweight Charts (Apache 2.0).
