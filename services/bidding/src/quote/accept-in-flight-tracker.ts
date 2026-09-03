// Instrumentacao de teste, desligada por padrao: conta quantas execucoes de
// QuoteService.accept() (busca da cotacao, chamada ao catalog, marcacao de
// perdedoras — o corpo inteiro) estao de fato em andamento ao mesmo tempo, e
// guarda o pico observado.
//
// Existe ao lado de services/gateway/src/quotes/accept-in-flight-tracker.ts,
// nao no lugar dele — os dois medem coisas diferentes, e um nao cobre o
// outro:
//
// - O contador do GATEWAY envolve so a chamada gRPC AcceptLoad (o disparo):
//   incrementa quando a chamada e feita, decrementa quando a resposta volta.
//   gRPC sobre HTTP/2 multiplexa streams, entao ele so prova que o gateway
//   DISPAROU as tres chamadas sem esperar resposta uma da outra — o que a
//   propria estrutura do `Promise.allSettled` do teste ja garante. Ele e
//   CEGO para qualquer serializacao que aconteca depois do disparo: dentro
//   do proprio AcceptLoad no bidding, no pool de conexao do bidding, na ida
//   ao catalog, no pool do catalog. Um mutex colocado so dentro do bidding
//   (ver commit desta rodada de correcao) deixa o contador do gateway em 3
//   mesmo com o bidding processando uma aceitacao de cada vez.
// - Este contador, do BIDDING, envolve o corpo inteiro de accept() — o
//   trabalho de fato, do lado de quem decide a disputa. Ele so mostra pico
//   3 se as tres execucoes de accept() genuinamente se sobrepuserem por
//   dentro. Um mutex que serialize o metodo inteiro (a sabotagem desta
//   rodada) faz este contador cair para 1, mesmo que o contador do gateway
//   continue em 3 — e exatamente por isso os dois precisam existir: o do
//   gateway prova que o cliente nao serializou o disparo, este prova que o
//   bidding nao serializou o processamento.
//
// Limite conhecido, documentado em vez de escondido: como o incremento
// acontece no INICIO do corpo rastreado, uma lentidao que aconteca DEPOIS
// de entrar nele (ex.: uma query esperando uma conexao de um pool do
// TypeORM quase esgotado) nao derruba o pico — a chamada ja conta como "em
// andamento" antes de encontrar essa lentidao. Este contador prova ausencia
// de uma fila/mutex que impeca a ENTRADA simultanea no metodo; nao prova
// ausencia de gargalo de pool uma vez ja dentro dele.
//
// So conta quando ACCEPT_INFLIGHT_TRACKING=1: em qualquer outro valor
// (incluindo ausente, o caso de producao) trackBiddingAcceptInFlight so
// chama fn() direto, sem nenhum overhead de contador. O codigo de producao
// nunca paga custo por isto, e o comportamento real de accept() (o que ele
// retorna, o que ele lanca) nunca muda — a instrumentacao so observa.
let current = 0;
let peak = 0;

export function resetBiddingAcceptInFlightPeak(): void {
  current = 0;
  peak = 0;
}

export function peakBiddingAcceptInFlight(): number {
  return peak;
}

export function trackBiddingAcceptInFlight<T>(fn: () => Promise<T>): Promise<T> {
  if (process.env.ACCEPT_INFLIGHT_TRACKING !== "1") {
    return fn();
  }
  current += 1;
  peak = Math.max(peak, current);
  return fn().finally(() => {
    current -= 1;
  });
}
