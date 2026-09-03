// Instrumentacao de teste, desligada por padrao: conta quantas chamadas
// gRPC AcceptLoad (a chamada ao bidding dentro de QuotesController.accept)
// estao em voo ao mesmo tempo, e guarda o pico observado.
//
// Existe para test/full-flow.e2e.spec.ts provar que o cliente (o gateway,
// visto do lado de quem chama o bidding) disparou as tres aceitacoes sem
// esperar resposta uma da outra. Um timestamp start/end medido no lado do
// supertest (uma versao anterior deste teste) nao provava nem isso direito:
// era capturado de forma sincrona, antes de qualquer I/O, entao so media
// quando a requisicao HTTP SAIU do cliente de teste — o que a propria
// estrutura do teste (tres promises criadas sem await entre si) ja garante
// por construcao.
//
// IMPORTANTE — o que este contador NAO prova: gRPC sobre HTTP/2 multiplexa
// streams, entao ele so mede quantas chamadas AcceptLoad estao PENDENTES DE
// RESPOSTA a partir do gateway — nao quanto trabalho esta de fato em
// paralelo do outro lado. Ele e CEGO para qualquer serializacao que
// aconteca depois do disparo: dentro do proprio QuoteService.accept() no
// bidding, no pool de conexao do bidding, na ida ao catalog, no pool do
// catalog. Serializar accept() de ponta a ponta com uma fila/mutex no
// CONTROLLER do gateway derruba este contador para 1 — ele reage a
// serializacao desse lado — mas um mutex colocado so dentro do bidding
// deixa ESTE contador em 3 mesmo com o bidding processando uma aceitacao de
// cada vez. Por isso existe um segundo contador, irmao deste,
// em services/bidding/src/quote/accept-in-flight-tracker.ts, que mede o
// corpo inteiro de QuoteService.accept() — o trabalho de fato, do lado de
// quem decide a disputa. O teste de fluxo completo confere os dois picos:
// este aqui prova que o cliente nao serializou o disparo; o do bidding
// prova que o servidor nao serializou o processamento. Um so dos dois nao
// cobre o outro — nao remova nenhum achando redundante.
//
// So conta quando ACCEPT_INFLIGHT_TRACKING=1: em qualquer outro valor
// (incluindo ausente, o caso de producao) trackAcceptRpcInFlight so chama
// fn() direto, sem nenhum overhead de contador. O codigo de producao nunca
// paga custo por isto, e o comportamento da chamada real (o que ela
// retorna, o que ela lanca) nunca muda — a instrumentacao so observa.
let current = 0;
let peak = 0;

export function resetAcceptInFlightPeak(): void {
  current = 0;
  peak = 0;
}

export function peakAcceptInFlight(): number {
  return peak;
}

export function trackAcceptRpcInFlight<T>(fn: () => Promise<T>): Promise<T> {
  if (process.env.ACCEPT_INFLIGHT_TRACKING !== "1") {
    return fn();
  }
  current += 1;
  peak = Math.max(peak, current);
  return fn().finally(() => {
    current -= 1;
  });
}
